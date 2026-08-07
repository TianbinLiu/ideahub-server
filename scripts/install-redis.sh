#!/usr/bin/env bash
# 安装并加固 Redis，用于跨进程限流。需要 sudo：
#     sudo bash /tmp/install-redis.sh
#
# 幂等：可反复运行；每次都用标记块整体替换自己写的那段配置，不会越堆越多。
# 安全：★配置先在临时端口试跑验证，通过才落盘并重启★。
#       验证不通过则原样还原，Redis 保持原状。
#
# ── 为什么需要 Redis ────────────────────────────────────────────
# 限流原本是进程内 Map，只在单进程下准确。切到 pm2 cluster（多实例）后，
# 每个实例各有一份计数器，实际放行量 = 配置值 × 实例数 —— 登录限流被稀释。
#
# ── 加固要点 ────────────────────────────────────────────────────
# 公网可达且无密码的 Redis 会被直接接管：攻击者用 CONFIG SET dir/dbfilename
# 把内容写进 ~/.ssh/authorized_keys 或 crontab 即可拿到 shell。所以：
#   1. 只监听 127.0.0.1（本机 Node 访问足够）
#   2. requirepass（纵深防御）
#   3. protected-mode yes
#   4. 禁用 CONFIG / FLUSHALL / FLUSHDB
set -euo pipefail

REDIS_CONF=/etc/redis/redis.conf
ENV_FILE=/var/www/ideahub-server/.env
BEGIN_MARK="# >>> ideahub install-redis.sh BEGIN (勿手工编辑本块) >>>"
END_MARK="# <<< ideahub install-redis.sh END <<<"

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

REDIS_VER=$(redis-server --version | grep -oP 'v=\K[0-9]+\.[0-9]+' | head -1)
echo "Redis 主版本: ${REDIS_VER}"

BACKUP="${REDIS_CONF}.bak.$(date +%F-%H%M%S)"
cp -a "$REDIS_CONF" "$BACKUP"
echo "✅ 已备份 → $BACKUP"

# ── 2. 取或生成密码 ───────────────────────────────────────────
# 复用已有密码，避免重跑脚本把正在用的密码换掉导致应用连不上。
EXISTING=$(grep -oP '^requirepass \K\S+' "$REDIS_CONF" 2>/dev/null | head -1 || true)
if [[ -n "$EXISTING" ]]; then
    echo "ℹ️  复用已有 requirepass"
    PASS="$EXISTING"
else
    PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
    echo "✅ 已生成新密码（值不会输出到任何地方）"
fi

# ── 3. 生成候选配置（先不落盘）────────────────────────────────
CANDIDATE=$(mktemp)
TESTDIR=$(mktemp -d)
trap 'rm -f "$CANDIDATE"; rm -rf "$TESTDIR"' EXIT

# 先剥掉本脚本上一次写入的标记块，再剥掉会与我们冲突的原生指令
python3 - "$REDIS_CONF" "$CANDIDATE" "$BEGIN_MARK" "$END_MARK" <<'PY'
import io, re, sys
src, dst, begin, end = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = io.open(src, encoding="utf-8", errors="surrogateescape").read()

# 移除本脚本上一次追加的整块（幂等的关键：否则每跑一次就多一段）
s = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", s, flags=re.S)

# 注释掉会与我们的设置冲突的原生指令（保留原文便于回溯，不直接删）
keys = ["bind", "protected-mode", "port", "requirepass", "save",
        "appendonly", "maxmemory", "maxmemory-policy", "rename-command"]
out = []
for line in s.split("\n"):
    stripped = line.lstrip()
    if any(stripped.startswith(k + " ") for k in keys):
        out.append("# [ideahub] " + line)
    else:
        out.append(line)
io.open(dst, "w", encoding="utf-8", errors="surrogateescape", newline="").write("\n".join(out))
PY

{
    echo ""
    echo "$BEGIN_MARK"
    echo "# 生成于 $(date -Is)"
    # ★ 只写 bind 127.0.0.1，不写 ::1。
    #   原因：`bind 127.0.0.1 -::1` 里的 `-` 前缀（绑定失败则忽略）是 Redis 6.2+ 才有的语法，
    #   Ubuntu 22.04 装的是 6.0.16，会直接启动失败。而应用通过 REDIS_URL 用 127.0.0.1 连接，
    #   IPv6 回环本来就用不上，写 IPv4 一个地址最简单也最不会出错。
    echo "bind 127.0.0.1"
    echo "protected-mode yes"
    echo "port 6379"
    echo "requirepass ${PASS}"
    # 限流数据丢了无所谓（重新计数即可），关持久化省 IO 与磁盘
    echo 'save ""'
    echo "appendonly no"
    # 限流键都带 TTL，正常不会涨；设上限防意外把机器内存吃满
    echo "maxmemory 128mb"
    echo "maxmemory-policy allkeys-lru"
    # 高危命令禁用：CONFIG SET dir 是 Redis 未授权入侵写 SSH key 的关键一步
    echo 'rename-command CONFIG ""'
    echo 'rename-command FLUSHALL ""'
    echo 'rename-command FLUSHDB ""'
    echo "$END_MARK"
} >> "$CANDIDATE"

# ── 4. ★ 落盘前先验证 ★ ──────────────────────────────────────
# Redis 没有 `nginx -t` 那样的语法检查命令，所以用「在临时端口试跑」代替：
# 配置有问题时 redis-server 会立刻打印错误并退出，能起来就说明配置可用。
# 上一版脚本【缺了这一步】，直接 restart，结果配置写错就把 Redis 打挂了。
echo
echo "=== 落盘前验证配置 ==="
TEST_LOG="${TESTDIR}/test.log"
set +e
timeout 5 redis-server "$CANDIDATE" \
    --port 63799 \
    --dir "$TESTDIR" \
    --requirepass "$PASS" \
    --daemonize no > "$TEST_LOG" 2>&1 &
TEST_PID=$!
sleep 2
if kill -0 "$TEST_PID" 2>/dev/null; then
    OK=1
    kill "$TEST_PID" 2>/dev/null
    wait "$TEST_PID" 2>/dev/null
else
    OK=0
fi
set -e

if [[ "$OK" != "1" ]]; then
    echo "❌ 配置验证失败，不落盘。redis-server 的报错："
    grep -viE "^$" "$TEST_LOG" | tail -12
    echo
    echo "现有配置保持不变（备份在 $BACKUP）"
    exit 1
fi
echo "✅ 配置可用（临时端口试跑通过）"

# ── 5. 落盘并重启 ─────────────────────────────────────────────
install -m 0640 -o redis -g redis "$CANDIDATE" "$REDIS_CONF" 2>/dev/null \
    || install -m 0640 "$CANDIDATE" "$REDIS_CONF"
echo "✅ 已写入 $REDIS_CONF"

systemctl enable redis-server >/dev/null 2>&1 || true
if ! systemctl restart redis-server; then
    echo "❌ 重启失败，还原备份"
    cp -a "$BACKUP" "$REDIS_CONF"
    systemctl restart redis-server || true
    exit 1
fi
sleep 2

# ── 6. 写进应用的 .env ────────────────────────────────────────
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

# ── 7. 验证 ───────────────────────────────────────────────────
echo
echo "=== 验证 ==="
if redis-cli -a "$PASS" --no-auth-warning ping 2>/dev/null | grep -q PONG; then
    echo "✅ 带密码可连通（PONG）"
else
    echo "❌ 连不通：systemctl status redis-server"
    exit 1
fi

if redis-cli ping 2>&1 | grep -qiE "NOAUTH|Authentication"; then
    echo "✅ 无密码被拒绝"
else
    echo "⚠️  无密码居然能连通，requirepass 未生效"
fi

LISTEN=$(ss -tln 2>/dev/null | grep ':6379' | awk '{print $4}' | tr '\n' ' ')
echo "监听地址: ${LISTEN:-（无）}"
if grep -qE '0\.0\.0\.0:6379|\*:6379' <<<"$LISTEN"; then
    echo "❌ 危险：Redis 在监听所有网卡"
    exit 1
fi
echo "✅ 仅监听本机"

echo
echo "完成。接下来在应用侧重启读取 REDIS_URL："
echo "  pm2 restart ideahub-server --update-env"
