#!/usr/bin/env bash
# cert-expiry-check.sh —— ideahubs.org 三域名 TLS 证书外部监控（边缘 + 源站两层）
#
# 【为什么是两层】2026-08-07 安全加固时三域名开了 Cloudflare 橙云代理，从此"按域名握手"
# 摸到的是 Cloudflare 边缘证书（SAN 形如 ideahubs.org + *.ideahubs.org，Cloudflare 自动轮换），
# 而不再是源站 nginx 上那张 Let's Encrypt 证书。但真正会静默腐烂的恰恰是源站那张：
# certbot 续期失败没有任何外部症状 —— Cloudflare 回源模式是 Full（非 strict）时连过期的
# 源站证书都照收，等哪天切成 Full (strict) 或 DNS only 才当场全断。所以分两层各查各的：
#   [边缘] 按域名握手 —— 用户/App 实际握到的证书：握手通、没临期、SAN 覆盖（认通配符）。
#   [源站] 按 IP + SNI 握手 —— certbot 维护的那张。★ 这层才是"续期看门狗"，是本脚本的本职。
#
# 【2026-08-08 ~ 08-20 连红 13 天的教训】当时只有"按域名"一层：代理一开，
#   ① 边缘证书的 *.ideahubs.org 被逐域名精确匹配（grep -qx）误判成"SAN 缺失"——假阳性；
#   ② 源站证书从此彻底看不见 —— 假阴性，比假阳性更危险，只是恰好被 ① 的红灯盖住了。
#
# 退出码：0 = 两层全部健康；1 = 至少一个问题。CI 里非 0 → job 变红 → 自动邮件。
#
# 环境变量：
#   WARN_DAYS        源站剩余天数阈值，默认 21（LE 证书 90 天一张、剩 30 天时 certbot 开始续；
#                    21 = 续期失败后有 9 天的告警窗）
#   EDGE_WARN_DAYS   边缘阈值，默认 7。★ 故意比源站松：边缘证书的轮换时点由 Cloudflare 决定，
#                    用 21 天会对"Cloudflare 还没轮"报假警；剩 7 天还没轮换才值得人看一眼
#   HOSTS            空格分隔的待查域名，默认三个
#   EXPECT_SANS      每张证书都必须覆盖的域名，默认三个（查 SAN 漂移）
#   ORIGIN_HOST      源站地址，默认 ECS 公网 IP（与 DEPLOYMENT_NOTES.md 记录一致；换机器要改这里）。
#                    显式设成空串 = 跳过源站层（将来若 :443 只对 Cloudflare 网段开放、GitHub 连不进来
#                    时用）——跳过会打醒目提示但不算失败；源站层握手失败则是响的（算失败），
#                    这样"源站看不见了"永远不会无声无息

set -uo pipefail

WARN_DAYS="${WARN_DAYS:-21}"
EDGE_WARN_DAYS="${EDGE_WARN_DAYS:-7}"
read -r -a HOSTS       <<< "${HOSTS:-ideahubs.org www.ideahubs.org api.ideahubs.org}"
read -r -a EXPECT_SANS <<< "${EXPECT_SANS:-ideahubs.org www.ideahubs.org api.ideahubs.org}"
# 用 ${VAR-默认} 而不是 ${VAR:-默认}：设成空串是"明确要求跳过"，不设才落默认值
ORIGIN_HOST="${ORIGIN_HOST-8.217.8.225}"
PORT=443
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-15}"

fail=0
problems=()

# SAN 覆盖判定：精确命中，或命中"去掉第一个标签后的通配符"。
# 通配符按 RFC 6125 只吃一层：*.ideahubs.org 覆盖 www.ideahubs.org，
# 不覆盖 ideahubs.org 本身，也不覆盖 a.b.ideahubs.org —— "want 去掉第一个标签再拼 *."
# 天然就是这个语义，不需要额外判层数。
san_covers() {   # $1 = 证书 SAN 列表（换行分隔） $2 = 要求覆盖的域名
  printf '%s\n' "$1" | grep -qxF "$2" && return 0
  local parent="${2#*.}"
  [ "$parent" != "$2" ] && printf '%s\n' "$1" | grep -qxF "*.$parent"
}

# 对一个端点做三查：握手取证 → 到期判定 → SAN 覆盖。
# $1 = 展示标签  $2 = connect 目标（域名或 IP）  $3 = SNI  $4 = 到期阈值（天）
check_endpoint() {
  local label="$1" target="$2" sni="$3" warn_days="$4"
  local warn_secs=$(( warn_days * 86400 ))

  # 握一次手，把服务端证书取成 PEM。SNI 必须带（同一 IP 上多张证书时选路靠它）。
  # timeout 防挂死握手；第二个 openssl 把 s_client 的多行输出裁成纯证书。
  local pem
  pem=$(echo | timeout "$CONNECT_TIMEOUT" openssl s_client -connect "$target:$PORT" -servername "$sni" 2>/dev/null \
        | openssl x509 2>/dev/null)

  if [ -z "$pem" ]; then
    echo "❌ $label  握手失败 / 取不到证书（DNS？连接超时？:443 不通？）"
    problems+=("$label: TLS 握手失败，取不到证书")
    fail=1
    return
  fi

  local not_after
  not_after=$(printf '%s\n' "$pem" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

  # 到期判定用 -checkend（秒）——它内部做时间比较，绕开手工解析 "Sep  7 ... GMT" 的时区/locale 坑。
  # checkend N：0 = N 秒后仍有效；非 0 = N 秒内会到期（含已过期）。
  local endstate
  if printf '%s\n' "$pem" | openssl x509 -noout -checkend "$warn_secs" >/dev/null 2>&1; then
    endstate="ok"
  elif printf '%s\n' "$pem" | openssl x509 -noout -checkend 0 >/dev/null 2>&1; then
    endstate="soon"      # 尚未过期，但已进入 <warn_days 窗口
  else
    endstate="expired"   # 已经过期
  fi

  local san
  san=$(printf '%s\n' "$pem" | openssl x509 -noout -text 2>/dev/null | grep -oE 'DNS:[^,]+' | sed 's/DNS://; s/[[:space:]]//g')
  local missing=() want
  for want in "${EXPECT_SANS[@]}"; do
    san_covers "$san" "$want" || missing+=("$want")
  done

  local icon line
  case "$endstate" in
    ok)      icon="✅"; line="$label  有效期至 $not_after" ;;
    soon)    icon="⚠️";  line="$label  有效期至 $not_after —— 剩余不足 ${warn_days} 天"
             problems+=("$label: 证书将在 ${warn_days} 天内到期（$not_after）"); fail=1 ;;
    expired) icon="🔴"; line="$label  已过期（$not_after）"
             problems+=("$label: 证书已过期（$not_after）"); fail=1 ;;
  esac

  if [ "${#missing[@]}" -gt 0 ]; then
    # 只在证书本身 ok 时用 ⚠️；已 soon/expired 的更严重图标不被降级
    [ "$endstate" = "ok" ] && icon="⚠️"
    line="$line ；SAN 缺失 ${missing[*]}"
    problems+=("$label: 证书 SAN 不再覆盖 ${missing[*]}")
    fail=1
  fi

  echo "$icon $line"
}

for h in "${HOSTS[@]}"; do
  check_endpoint "[边缘] $h" "$h" "$h" "$EDGE_WARN_DAYS"
done

echo
if [ -n "$ORIGIN_HOST" ]; then
  for h in "${HOSTS[@]}"; do
    check_endpoint "[源站] $h" "$ORIGIN_HOST" "$h" "$WARN_DAYS"
  done
else
  echo "⚠️ ORIGIN_HOST 为空 —— 源站层被显式跳过，certbot 续期失败期间将没有任何监控出声！"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "=== 需要处理（共 ${#problems[@]} 项）==="
  printf '  - %s\n' "${problems[@]}"
  echo
  echo "排查（按出问题的层）："
  echo "  [源站] → certbot 续期链路。服务器 root 下：certbot certificates ;"
  echo "           certbot renew --dry-run ; journalctl -u certbot -n50"
  echo "  [边缘] → Cloudflare 侧。Dashboard → SSL/TLS → Edge Certificates 看 Universal SSL 状态，"
  echo "           DNS 页确认代理（橙云）没被误关；边缘证书我们改不了内容，只能核对配置。"
  exit 1
fi
echo "✅ 边缘 + 源站两层证书均正常（源站阈值 ${WARN_DAYS} 天 / 边缘 ${EDGE_WARN_DAYS} 天）"
exit 0
