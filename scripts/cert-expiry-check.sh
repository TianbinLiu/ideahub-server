#!/usr/bin/env bash
# cert-expiry-check.sh —— ideahubs.org 三域名 TLS 证书外部到期监控
#
# 【为什么是"外部"、为什么不看 certbot 日志】
# 续期失败的典型形态是【静默】的：certbot.timer 可能压根没跑、或跑了但 http-01 挑战失败，
# 它自己的日志此时未必有任何记录。唯一可信的判据是【浏览器实际会握到的那张证书】——
# 所以本脚本从 :443 真握手取证书，只看服务端事实，不读服务器上任何续期状态。
#
# 退出码：0 = 三域名都健康；1 = 至少一个问题（<阈值到期 / 已过期 / 握手失败 / SAN 漂移）。
# 在 CI（GitHub Actions）里跑：非 0 会让 job 变红 → 自动邮件；无需自备 SMTP。
#
# 环境变量：
#   WARN_DAYS   剩余天数阈值，默认 21
#   HOSTS       空格分隔的待查域名，默认三个
#   EXPECT_SANS 每张证书都必须覆盖的域名，默认三个（查 SAN 漂移）

set -uo pipefail

WARN_DAYS="${WARN_DAYS:-21}"
read -r -a HOSTS       <<< "${HOSTS:-ideahubs.org www.ideahubs.org api.ideahubs.org}"
read -r -a EXPECT_SANS <<< "${EXPECT_SANS:-ideahubs.org www.ideahubs.org api.ideahubs.org}"
PORT=443
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-15}"
WARN_SECS=$(( WARN_DAYS * 86400 ))

fail=0
problems=()

for h in "${HOSTS[@]}"; do
  # 握一次手，把服务端证书取成 PEM。SNI = 该域名（同一 IP 上多证书时必须带）。
  # timeout 防挂死握手；两个 openssl 之间用管道，第二个把 s_client 的多行输出裁成纯证书。
  pem=$(echo | timeout "$CONNECT_TIMEOUT" openssl s_client -connect "$h:$PORT" -servername "$h" 2>/dev/null \
        | openssl x509 2>/dev/null)

  if [ -z "$pem" ]; then
    echo "❌ $h  握手失败 / 取不到证书（DNS？连接超时？:443 不通？）"
    problems+=("$h: TLS 握手失败，取不到证书")
    fail=1
    continue
  fi

  not_after=$(printf '%s\n' "$pem" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

  # 到期判定用 -checkend（秒）——它内部做时间比较，绕开手工解析 "Sep  7 ... GMT" 的时区/locale 坑。
  # checkend N：0 = N 秒后仍有效；非 0 = N 秒内会到期（含已过期）。
  if printf '%s\n' "$pem" | openssl x509 -noout -checkend "$WARN_SECS" >/dev/null 2>&1; then
    endstate="ok"
  elif printf '%s\n' "$pem" | openssl x509 -noout -checkend 0 >/dev/null 2>&1; then
    endstate="soon"      # 尚未过期，但已进入 <WARN_DAYS 窗口
  else
    endstate="expired"   # 已经过期
  fi

  # SAN 漂移：证书是否仍覆盖每个必需域名。三名共用一张证书，漏一个 → 那一名将来续期就会断。
  san=$(printf '%s\n' "$pem" | openssl x509 -noout -text 2>/dev/null | grep -oE 'DNS:[^,]+' | sed 's/DNS://; s/[[:space:]]//g')
  missing=()
  for want in "${EXPECT_SANS[@]}"; do
    printf '%s\n' "$san" | grep -qx "$want" || missing+=("$want")
  done

  case "$endstate" in
    ok)      icon="✅"; line="$h  有效期至 $not_after" ;;
    soon)    icon="⚠️";  line="$h  有效期至 $not_after —— 剩余不足 ${WARN_DAYS} 天"
             problems+=("$h: 证书将在 ${WARN_DAYS} 天内到期（$not_after）"); fail=1 ;;
    expired) icon="🔴"; line="$h  已过期（$not_after）"
             problems+=("$h: 证书已过期（$not_after）"); fail=1 ;;
  esac

  if [ "${#missing[@]}" -gt 0 ]; then
    # 只在证书本身 ok 时用 ⚠️；已 soon/expired 的更严重图标不被降级
    [ "$endstate" = "ok" ] && icon="⚠️"
    line="$line ；SAN 缺失 ${missing[*]}"
    problems+=("$h: 证书 SAN 不再覆盖 ${missing[*]}")
    fail=1
  fi

  echo "$icon $line"
done

echo
if [ "$fail" -ne 0 ]; then
  echo "=== 需要处理（共 ${#problems[@]} 项）==="
  printf '  - %s\n' "${problems[@]}"
  echo
  echo "排查：证书由 Let's Encrypt 自动续期；失败通常是 certbot.timer 没跑或 http-01 挑战被挡。"
  echo "在服务器 root 下：certbot certificates ; certbot renew --dry-run ; journalctl -u certbot -n50"
  exit 1
fi
echo "✅ 三域名证书均正常（阈值 ${WARN_DAYS} 天）"
exit 0
