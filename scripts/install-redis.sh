#!/usr/bin/env bash
# 安装并加固 Redis，用于跨进程限流。需要 sudo：
#     sudo bash /tmp/install-redis.sh
#
# 幂等：已安装则只校对配置，不重复装。
#
# ── 为什么需要 Redis ────────────────────────────────────────────
# 限流原本是进程内 Map，只在单进程下准确。切到 pm2 cluster（多实例）后，
# 每个实例各有一份计数器，实际放行量 = 配置值 × 实例数 —— 登录限流会被稀释。
# Redis 提供跨进程的共享计数。
#
# ── 加固要点（Redis 是历史上被入侵最多的服务之一）────────────────
# 公网可达且无密码的 Redis 会被直接接管：攻击者可用 CONFIG SET dir/dbfilename
# 把内容写进 ~/.ssh/authorized_keys 或 crontab 拿到 shell。所以：
#   1. 只监听 127.0.0.1（本机 Node 访问足够，绝不对外）
#   2. 设 requirepass（纵深防御：即便将来误开了监听也还有一道）
#   3. protected-mode yes
#   4. 重命名/禁用 CONFIG 等高危命令
set -euo pipefail

REDIS_CONF=/etc/redis/redis.conf
ENV_FILE=/var/www/ideahub-server/.env

command -v apt-get >/dev/null || { echo "❌ 需要 apt 系发行版"; exit 1; }

# ── 1. 安装 ───────────────────────────────────────────────────
if command -v redis-server >/dev/null 2>&1; then
    echo "ℹ️  Redis 已安装：$(redis-server --version | head -1)"
else
    echo "安装 redis-server…"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redis-server
    echo "✅ 安装完成：$(redis-server --version | head -1)"
fi

[[ -f "$REDIS_CONF" ]] || { echo "❌ 找不到 $REDIS_CONF"; exit 1; }
cp -a "$REDIS_CONF" "${REDIS_CONF}.bak.$(date +%F-%H%M%S)"

# ── 2. 生成密码并写入两处（值不经过屏幕，也不进任何日志）────────
# 已配过就复用，避免重装脚本把正在用的密码换掉、导致应用连不上。
EXISTING=$(grep -oP '^requirepass \K\S+' "$REDIS_CONF" 2>/dev/null || true)
if [[ -n "$EXISTING" ]]; then
    echo "ℹ️  已存在 requirepass，复用（不重新生成）"
    PASS="$EXISTING"
else
    PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
    echo "✅ 已生成新的 Redis 密码"
fi

# ── 3. 写配置 ─────────────────────────────────────────────────
# 用 conf.d 式的独立片段不可行（Redis 不支持 include 通配），故直接改主配置，
# 但每一项都用「先删后加」保证幂等。
set_conf() {
    local key="$1" val="$2"
    sed -i "/^${key} /d; /^# *${key} /d" "$REDIS_CONF"
    echo "${key} ${val}" >> "$REDIS_CONF"
}

{
    echo ""
    echo "# ── 由 install-redis.sh 加固（$(date -Is)）──"
} >> "$REDIS_CONF"

set_conf "bind" "127.0.0.1 -::1"
set_conf "protected-mode" "yes"
set_conf "port" "6379"
set_conf "requirepass" "$PASS"
# 限流数据丢了无所谓（大不了重新计数），关掉持久化省 IO 与磁盘
set_conf "save" '""'
set_conf "appendonly" "no"
# 内存上限 + 淘汰策略：限流键都有 TTL，正常不会涨，但设上限防意外把机器吃满
set_conf "maxmemory" "128mb"
set_conf "maxmemory-policy" "allkeys-lru"
# 高危命令改名（等于禁用）：CONFIG SET dir 是 Redis 未授权入侵写 SSH key 的关键一步
set_conf "rename-command" "CONFIG \"\""
set_conf "rename-command" "FLUSHALL \"\""

# rename-command 需要多行，上面的 set_conf 会互相覆盖，这里显式重写
sed -i '/^rename-command /d' "$REDIS_CONF"
{
    echo 'rename-command CONFIG ""'
    echo 'rename-command FLUSHALL ""'
    echo 'rename-command FLUSHDB ""'
} >> "$REDIS_CONF"

echo "✅ 已写入加固配置"

# ── 4. 写进应用的 .env ────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
    cp -a "$ENV_FILE" "${ENV_FILE}.bak.redis.$(date +%F-%H%M%S)"
    python3 - "$ENV_FILE" "$PASS" <<'PY'
import io, re, sys
path, pw = sys.argv[1], sys.argv[2]
url = f"redis://:{pw}@127.0.0.1:6379"
s = io.open(path, encoding="utf-8").read()
if re.search(r"^REDIS_URL=", s, re.M):
    s = re.sub(r"^REDIS_URL=.*$", f"REDIS_URL={url}", s, count=1, flags=re.M)
else:
    s = s.rstrip("\n") + f"\nREDIS_URL={url}\n"
io.open(path, "w", encoding="utf-8", newline="").write(s)
print("✅ 已写入 REDIS_URL 到 .env（值未输出）")
PY
    chown deploy:deploy "$ENV_FILE" 2>/dev/null || true
    chmod 600 "$ENV_FILE"
else
    echo "⚠️  找不到 $ENV_FILE，请手动设置 REDIS_URL"
fi

# ── 5. 启动并验证 ─────────────────────────────────────────────
systemctl enable redis-server >/dev/null 2>&1 || true
systemctl restart redis-server
sleep 2

echo
echo "=== 验证 ==="
if redis-cli -a "$PASS" --no-auth-warning ping 2>/dev/null | grep -q PONG; then
    echo "✅ 带密码可连通（PONG）"
else
    echo "❌ 连不通，检查：systemctl status redis-server"
    exit 1
fi

if redis-cli ping 2>&1 | grep -qi "NOAUTH\|Authentication"; then
    echo "✅ 无密码被拒绝"
else
    echo "⚠️  无密码居然能连通，requirepass 可能未生效"
fi

LISTEN=$(ss -tln 2>/dev/null | grep 6379 | awk '{print $4}' | tr '\n' ' ')
echo "监听地址: $LISTEN"
if grep -qE '0\.0\.0\.0:6379|\*:6379' <<<"$LISTEN"; then
    echo "❌ 危险：Redis 在监听所有网卡，请检查 bind 配置"
    exit 1
else
    echo "✅ 仅监听本机"
fi

echo
echo "完成。接下来在应用侧重启即可读取 REDIS_URL："
echo "  pm2 restart ideahub-server --update-env"
