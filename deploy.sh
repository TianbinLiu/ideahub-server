#!/usr/bin/env bash
set -euo pipefail

# Simple deploy script for IdeaHub
# - runs on the server (deploy user)
# - fetches latest, installs server deps, builds client, copies static files, restarts pm2
# - appends stdout/stderr to /var/log/ideahub/deploy.log (ensure directory exists and owned by deploy)

LOGFILE="/var/log/ideahub/deploy.log"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

echo "$(ts) [deploy] starting deploy" >> "$LOGFILE" 2>&1

# determine directories
SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SERVER_DIR")"

mkdir -p "$(dirname "$LOGFILE")" || true
chown -R $(whoami):$(whoami) "$(dirname "$LOGFILE")" 2>/dev/null || true

echo "$(ts) [deploy] server dir: $SERVER_DIR" >> "$LOGFILE" 2>&1
echo "$(ts) [deploy] project dir: $PROJECT_DIR" >> "$LOGFILE" 2>&1

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

if [ -d "$PROJECT_DIR/client" ]; then
  echo "$(ts) [deploy] building frontend" >> "$LOGFILE" 2>&1
  (cd "$PROJECT_DIR/client" && git fetch --all --prune) >> "$LOGFILE" 2>&1 || true
  (cd "$PROJECT_DIR/client" && git reset --hard origin/main) >> "$LOGFILE" 2>&1 || true
  (cd "$PROJECT_DIR/client" && npm ci --omit=dev) >> "$LOGFILE" 2>&1 || (cd "$PROJECT_DIR/client" && npm install --omit=dev) >> "$LOGFILE" 2>&1
  (cd "$PROJECT_DIR/client" && npm run build) >> "$LOGFILE" 2>&1
  mkdir -p "$PROJECT_DIR/client-dist"
  rsync -a --delete "$PROJECT_DIR/client/dist/" "$PROJECT_DIR/client-dist/" >> "$LOGFILE" 2>&1 || rsync -a --delete "$PROJECT_DIR/client/dist/" "$PROJECT_DIR/client-dist/" >> "$LOGFILE" 2>&1
  chown -R deploy:deploy "$PROJECT_DIR/client-dist" >> "$LOGFILE" 2>&1 || true
fi

echo "$(ts) [deploy] restarting pm2 process ideahub-server" >> "$LOGFILE" 2>&1
if pm2 describe ideahub-server >/dev/null 2>&1; then
  pm2 restart ideahub-server >> "$LOGFILE" 2>&1
else
  (cd "$SERVER_DIR" && pm2 start npm --name ideahub-server -- start) >> "$LOGFILE" 2>&1
fi

pm2 save >> "$LOGFILE" 2>&1 || true

echo "$(ts) [deploy] deploy finished" >> "$LOGFILE" 2>&1

exit 0
