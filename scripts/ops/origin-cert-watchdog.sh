#!/usr/bin/env bash
# origin-cert-watchdog.sh —— 源站证书看门狗（跑在 ECS 机内，deploy 用户 cron，不需要 root）
#
# 【为什么在机内】2026-08-20 起源站 :443/:80 只对 Cloudflare 网段开放（阿里云安全组），
# GitHub Actions 从公网握不进来了 —— cert-expiry.yml 已设 ORIGIN_HOST="" 跳过源站层。
# 于是"certbot 续期看门狗"搬进机内：对 127.0.0.1:443 带 SNI 握手，看 nginx 实际在发的
# 那张 Let's Encrypt 证书。语义与原 [源站] 层完全一致，实现也是同一份
# （scripts/cert-expiry-check.sh，铁律六：检查逻辑不复制第二遍）。
# deploy.sh 每次发布 git reset --hard origin/main —— 本脚本随发布自动更新，不会腐烂。
#
# 【告警链路 —— 三种死法都出声】结果打给 healthchecks.io（死人开关）：
#   检查通过 → ping $URL        按时到 = 正常；没到 = 看门狗自己死了（cron 掉/机器挂/出网断）→ late 告警
#   检查失败 → ping $URL/fail   立刻告警，正文附检查输出（healthchecks 存进 ping 日志，邮件里能看到原因）
#   连 healthchecks 都 ping 不动 → 什么都没送到 → late 告警兜底
#
# 【ping URL 为什么放文件、不放仓库】仓库是公开的，而拿到 ping URL 就能伪造"一切正常"、
# 把真故障静默掉。URL 存 ~/.config/ideahub/origin-cert-hc-url（chmod 600），
# 安装步骤见 DEPLOYMENT_NOTES.md 2026-08-20（第二条）。
#
# cron（deploy 用户，服务器时区 CST；用 bash 显式调用，不依赖执行位）：
#   47 8 * * * bash /var/www/ideahub-server/scripts/ops/origin-cert-watchdog.sh
# 本地日志只留最近一次（历史在 healthchecks 的 ping 日志里）——不滚动就不会无限膨胀。

set -uo pipefail

REPO_DIR="${REPO_DIR:-/var/www/ideahub-server}"
HC_URL_FILE="${HC_URL_FILE:-$HOME/.config/ideahub/origin-cert-hc-url}"
LOG_DIR="$HOME/.cache/ideahub"
LOG="$LOG_DIR/origin-cert-watchdog.log"

main() {
  echo "=== origin-cert-watchdog $(date '+%F %T %z') ==="

  # 机内握手打 127.0.0.1：不经安全组，也绕开"从机内连自己公网 IP"的 hairpin 不确定性。
  # ORIGIN_HOST 留覆盖口只为开发机自测；线上不要设。
  local out rc
  out=$(LAYERS=origin ORIGIN_HOST="${ORIGIN_HOST:-127.0.0.1}" \
        bash "$REPO_DIR/scripts/cert-expiry-check.sh" 2>&1)
  rc=$?
  printf '%s\n' "$out"

  local url=""
  [ -r "$HC_URL_FILE" ] && url=$(head -n1 "$HC_URL_FILE" | tr -d '[:space:]')
  if [ -z "$url" ]; then
    echo "⚠️ 读不到 healthchecks ping URL（$HC_URL_FILE）—— 本次结果无处上报。"
    echo "   只要 healthchecks 上的 check 已建好，它会以 late 告警兜底；否则现在是监控裸奔。"
    return 1
  fi

  # --data-raw 把检查输出作为 POST 正文送上去：告警邮件里直接能看到"为什么"，
  # 不用先上机翻日志。healthchecks 对成功 ping 同样接受 POST。
  if [ "$rc" -eq 0 ]; then
    if curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$out" "$url"; then
      echo "✅ 心跳已送达 healthchecks"
    else
      echo "❌ 检查通过但心跳没送出去（出网故障？）—— healthchecks 将以 late 告警"
      return 1
    fi
  else
    if curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$out" "$url/fail"; then
      echo "🔴 检查失败（exit $rc），已上报 /fail —— 原因见 healthchecks ping 日志与上方输出"
    else
      echo "🔴 检查失败（exit $rc），且 /fail 也没送出去 —— healthchecks 将以 late 告警"
    fi
    return 1
  fi
}

mkdir -p "$LOG_DIR"
main 2>&1 | tee "$LOG"
exit "${PIPESTATUS[0]}"
