#!/usr/bin/env bash
set -euo pipefail

# Simple deploy script for IdeaHub
# - runs on the server (deploy user)
# - fetches latest, installs server deps, builds client, copies static files, restarts pm2
# - appends stdout/stderr to /var/log/ideahub/deploy.log (ensure directory exists and owned by deploy)

LOGFILE="/var/log/ideahub/deploy.log"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

echo "$(ts) [deploy] starting deploy" >> "$LOGFILE" 2>&1

cd "$(dirname "$0")/.." || exit 1
echo "$(ts) [deploy] cwd: $(pwd)" >> "$LOGFILE" 2>&1

echo "$(ts) [deploy] fetching latest from origin/main" >> "$LOGFILE" 2>&1
git fetch --all --prune >> "$LOGFILE" 2>&1
git reset --hard origin/main >> "$LOGFILE" 2>&1

echo "$(ts) [deploy] installing server dependencies" >> "$LOGFILE" 2>&1
npm ci --omit=dev >> "$LOGFILE" 2>&1 || npm install --omit=dev >> "$LOGFILE" 2>&1

if [ -d "client" ]; then
  echo "$(ts) [deploy] building frontend" >> "$LOGFILE" 2>&1
  cd client
  npm ci --omit=dev >> "$LOGFILE" 2>&1 || npm install --omit=dev >> "$LOGFILE" 2>&1
  npm run build >> "$LOGFILE" 2>&1
  mkdir -p ../client-dist
  rsync -a --delete dist/ ../client-dist/ >> "$LOGFILE" 2>&1
  chown -R www-data:www-data ../client-dist >> "$LOGFILE" 2>&1 || true
  cd ..
fi

echo "$(ts) [deploy] restarting pm2 process ideahub-server" >> "$LOGFILE" 2>&1
if pm2 describe ideahub-server >/dev/null 2>&1; then
  pm2 restart ideahub-server >> "$LOGFILE" 2>&1
else
  pm2 start npm --name ideahub-server -- run start >> "$LOGFILE" 2>&1
fi

pm2 save >> "$LOGFILE" 2>&1 || true

echo "$(ts) [deploy] deploy finished" >> "$LOGFILE" 2>&1

exit 0
