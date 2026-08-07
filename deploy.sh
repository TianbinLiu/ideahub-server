#!/usr/bin/env bash
set -euo pipefail

# Simple deploy script for IdeaHub server repository
# - runs on the server (deploy user)
# - fetches latest server code, installs dependencies, zero-downtime reload via pm2 cluster
# - appends stdout/stderr to /var/log/ideahub/deploy.log (ensure directory exists and owned by deploy)

LOGFILE="/var/log/ideahub/deploy.log"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

echo "$(ts) [deploy] starting deploy" >> "$LOGFILE" 2>&1

# determine directories
SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$(dirname "$LOGFILE")" || true
chown -R $(whoami):$(whoami) "$(dirname "$LOGFILE")" 2>/dev/null || true

echo "$(ts) [deploy] server dir: $SERVER_DIR" >> "$LOGFILE" 2>&1

# Update server repository
if [ -d "$SERVER_DIR/.git" ]; then
  echo "$(ts) [deploy] fetching latest server from origin/main" >> "$LOGFILE" 2>&1
  (cd "$SERVER_DIR" && git fetch --all --prune) >> "$LOGFILE" 2>&1
  (cd "$SERVER_DIR" && git reset --hard origin/main) >> "$LOGFILE" 2>&1
else
  echo "$(ts) [deploy] warning: $SERVER_DIR is not a git repo" >> "$LOGFILE" 2>&1
fi

echo "$(ts) [deploy] installing server dependencies" >> "$LOGFILE" 2>&1
(cd "$SERVER_DIR" && npm ci --omit=dev) >> "$LOGFILE" 2>&1 || (cd "$SERVER_DIR" && npm install --omit=dev) >> "$LOGFILE" 2>&1

# ── 部署前配置自检 ────────────────────────────────────────────
# 在【重启之前】就发现配置问题。否则新实例起不来，才发现 .env 少了一项，
# 而那时旧实例可能已经被换掉了。check:config 不启动服务，只做检查。
echo "$(ts) [deploy] preflight config check" >> "$LOGFILE" 2>&1
if ! (cd "$SERVER_DIR" && NODE_ENV=production npm run check:config) >> "$LOGFILE" 2>&1; then
  echo "$(ts) [deploy] ABORT: 配置自检未通过，未做任何重启（详见上方输出）" >> "$LOGFILE" 2>&1
  exit 1
fi

# ── 用 ecosystem.config.js 做零停机 reload ────────────────────
#
# ★ 必须用 reload 而不是 restart：
#   restart = 停旧进程再起新进程，中间端口没人监听，nginx 返回 502。
#   实测该空档约 3 秒。reload 在 cluster 模式下逐个替换实例 ——
#   新实例就绪（wait_ready + process.send("ready")）后才关旧的，实测零停机。
#
# ★ 兜底分支必须也用 ecosystem.config.js：
#   这里原本是 `pm2 start npm --name ideahub-server -- start`。进程一旦丢失
#   （例如机器重启后 pm2 resurrect 失败），部署就会把它重建成【fork 模式 + npm 入口】——
#   cluster 配置、多实例、零停机全部悄无声息地回退，而且不会有任何报错。
#   这类"回退到旧行为且不报错"的路径比直接失败更危险。
#
# ★ --update-env：不加的话 pm2 会沿用进程创建时的环境变量，.env 的改动读不到。
echo "$(ts) [deploy] reloading pm2 (cluster, zero-downtime)" >> "$LOGFILE" 2>&1
if pm2 describe ideahub-server >/dev/null 2>&1; then
  (cd "$SERVER_DIR" && pm2 reload ecosystem.config.js --update-env) >> "$LOGFILE" 2>&1
else
  echo "$(ts) [deploy] pm2 进程不存在，按 ecosystem 配置重新拉起" >> "$LOGFILE" 2>&1
  (cd "$SERVER_DIR" && pm2 start ecosystem.config.js) >> "$LOGFILE" 2>&1
fi

pm2 save >> "$LOGFILE" 2>&1 || true

# ── 部署后健康检查 ────────────────────────────────────────────
# reload 声称成功不等于服务真的能用。探不通就让部署以非零码结束，
# CI 才会标红，而不是"部署成功但站点是挂的"。
echo "$(ts) [deploy] health check" >> "$LOGFILE" 2>&1
HEALTH_OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT:-4000}/api/health" --max-time 3 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then HEALTH_OK=1; break; fi
  sleep 1
done
if [ "$HEALTH_OK" != "1" ]; then
  echo "$(ts) [deploy] FAILED: 健康检查未通过（最后状态码 $CODE）" >> "$LOGFILE" 2>&1
  pm2 list >> "$LOGFILE" 2>&1 || true
  exit 1
fi
echo "$(ts) [deploy] health check ok" >> "$LOGFILE" 2>&1

echo "$(ts) [deploy] deploy finished" >> "$LOGFILE" 2>&1

exit 0
