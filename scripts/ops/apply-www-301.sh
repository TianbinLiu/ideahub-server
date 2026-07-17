#!/bin/bash
# 在 root shell 里整段粘贴。改 www.ideahubs.org → 301 → ideahubs.org
# 任一门禁不过就【自动停下且不 reload】，配置维持原样。

set -o pipefail

ts=$(date +%Y%m%d-%H%M%S)
BAK=/root/ideahub.$ts.bak

echo "=== 1/5 备份 + 记录基线 ==="
cp -a /etc/nginx/sites-available/ideahub "$BAK" || exit 1
nginx -T > /root/nginx-T-before.$ts.txt 2>&1
{
  echo "--- baseline $ts ---"
  echo -n "IP 直连:        "; curl -skI https://8.217.8.225/ | head -1
  echo -n "未知 Host:      "; curl -skI https://8.217.8.225/ -H 'Host: nope.example' | head -1
  echo -n "裸域:           "; curl -sI  https://ideahubs.org/ | head -1
  echo -n "www(改前应200): "; curl -sI  https://www.ideahubs.org/ | head -1
} | tee /root/baseline.$ts.txt
echo "备份在: $BAK"
echo

echo "=== 2/5 落盘新配置 ==="
cat > /etc/nginx/sites-available/ideahub <<'NGINX'
# /etc/nginx/sites-available/ideahub
# 2026-07-17 变更：www.ideahubs.org 从 SPA 块拆出，单独 301 到裸域。
#
# 【为什么】www 和裸域是两个 origin，localStorage 按 origin 隔离 ——
# 在 www 上登录的用户切到裸域即显示未登录；且浏览器插件只信任裸域一个 origin
# （精确比对），/arena 的插件门禁在 www 上会把用户挡在外面。收敛成一个 origin 是根因修复。
#
# 【两处别在 review 时"简化"掉】
#   1. 显式 default_server：原配置【没有任何】default_server（已实测：conf.d 为空，
#      sites-enabled 只有本文件，全文无 default_server），故 :443 的兜底块是
#      "文件里第一个 listen 443 的块"。显式钉死后，块的顺序不再影响 IP 直连 /
#      未知 Host 的兜底行为。
#   2. www 块用 $request_uri，不是 $uri$is_args$args。$uri 是归一化后的值
#      （%XX 解码、合并斜杠、解析 ./..），会把 /a%2Fb 跳成 /a/b 指向另一个资源。
#      $request_uri 原样保留客户端字节且自带查询串。

# ---------- :80 ----------
# 本次唯一改动是显式标注 default_server（行为 no-op：它本来就是第一个 :80 块）。
# 其余一字未改 —— ACME http-01 按 RFC 8555 从 80 端口发起，保持这里不动是
# "续期不受影响"最省事的依据。
server {
    listen 80 default_server;
    server_name ideahubs.org www.ideahubs.org;
    return 301 https://$host$request_uri;
}

server {
    listen 80;
    server_name api.ideahubs.org;
    return 301 https://$host$request_uri;
}

# ---------- :443 ----------

# 新增：www 规范化。
# ★刻意放在 SPA 块【之前】：nginx 对重复的精确 server_name 是 warn + 忽略后者
# （先声明者胜），不是报错。放前面 ⇒ 万一将来有人漏删了下面 SPA 块 server_name
# 里的 www，本块仍然先匹配、301 照常生效，而不是静默退化成 no-op。
# 配合上面已钉死的 default_server，顺序不再有副作用。
server {
    listen 443 ssl http2;
    server_name www.ideahubs.org;

    ssl_certificate /etc/letsencrypt/live/ideahubs.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ideahubs.org/privkey.pem;

    return 301 https://ideahubs.org$request_uri;
}

# 裸域 SPA（原块，只改两处：server_name 去掉 www、listen 加 default_server）
server {
    listen 443 ssl http2 default_server;
    server_name ideahubs.org;

    ssl_certificate /etc/letsencrypt/live/ideahubs.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ideahubs.org/privkey.pem;

    root /var/www/ideahub-client-dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # 【本次不启用，故意留着不加】裸域目前【没有】HSTS —— 已实测：
    #   curl -sI https://ideahubs.org/  → 无 Strict-Transport-Security
    #   curl -sI https://api.ideahubs.org/ → 有（那是 Express 的 helmet() 发的）
    # RFC 6797 的 includeSubDomains 向下不向上，api 那个头覆盖的是 *.api.ideahubs.org，
    # 既不覆盖裸域也不覆盖 www。要补 HSTS 请【单独一次变更】做，且先用短 max-age 观察 ——
    # HSTS 一旦下发无法召回，把长 max-age 和一个刚改完、还没跑过一次续期的配置绑在一起
    # 是不可逆的赌。
    # add_header Strict-Transport-Security "max-age=300" always;
}

# api 反代（一字未改）
server {
    listen 443 ssl http2;
    server_name api.ideahubs.org;

    ssl_certificate /etc/letsencrypt/live/ideahubs.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ideahubs.org/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINX
echo "已写入"
echo

echo "=== 3/5 门禁（★最重要的一步）==="
# nginx -t 对【重名冲突】只报 warn 且 exit 0，"test is successful" 照出、reload 照成功。
# 且本机 systemd 的 ExecStartPre 用的是 nginx -t -q（-q 会吞掉 warn），
# ExecReload 压根不跑 -t。所以必须在这里显式 grep，不能靠肉眼、更不能靠 systemd。
out=$(nginx -t 2>&1); echo "$out"
echo "$out" | grep -q "test is successful" || { echo "❌ FAIL: nginx -t 未通过 —— 未 reload，配置可用备份还原"; exit 1; }
echo "$out" | grep -qi "conflicting server name" && { echo "❌ FAIL: 重名未清理"; exit 1; }
echo "$out" | grep -qi "duplicate default server" && { echo "❌ FAIL: 别处已有 default_server"; exit 1; }

# ★只数 server_name【指令行】，不数整份 dump：nginx -T 会把配置里的【注释】也 dump 出来，
#   而本文件落盘的配置顶部注释就含 "www.ideahubs.org"，笼统 grep 会把注释也数进去（实测多出 1，
#   于是 SPA 块其实已删净、却报「期望 2 实得 3」的假 FAIL）。真正该数的只有 server_name 指令。
n=$(nginx -T 2>/dev/null | grep -E '^[[:space:]]*server_name' | grep -c 'www\.ideahubs\.org')
echo "server_name 指令里含 www 的行数: $n （必须正好 2 = :80 块那行 + 新 :443 www 块那行；SPA 块应不含 www）"
[ "$n" -eq 2 ] || { echo "❌ FAIL: 期望 2，实得 $n（3=SPA 块没删干净 / 1=新块没进来）"; exit 1; }
echo "✅ GATE PASS"
echo

echo "=== 4/5 reload ==="
systemctl reload nginx || { echo "❌ reload 失败"; exit 1; }
systemctl is-active nginx
echo

echo "=== 5/5 立即验证 ==="
echo -n "www 首行（期望 301）:      "; curl -sI https://www.ideahubs.org/ | head -1
echo -n "www Location（期望裸域）:  "; curl -sI https://www.ideahubs.org/ | grep -i '^location:'
echo -n "编码保真（期望 %2F 不变）: "; curl -sI 'https://www.ideahubs.org/arena/x%2Fy?q=a%26b&r=1' | grep -i '^location:'
echo -n "裸域（期望 200）:          "; curl -s -o /dev/null -w '%{http_code}\n' https://ideahubs.org/
echo -n "SPA 路由（期望 200）:      "; curl -s -o /dev/null -w '%{http_code}\n' https://ideahubs.org/arena/simulate
echo -n "api（期望 200）:           "; curl -s -o /dev/null -w '%{http_code}\n' https://api.ideahubs.org/api/health
echo
echo "--- 兜底行为应与基线一致 ---"
echo -n "IP 直连:   "; curl -skI https://8.217.8.225/ | head -1
echo -n "未知 Host: "; curl -skI https://8.217.8.225/ -H 'Host: nope.example' | head -1
echo "（对比 /root/baseline.$ts.txt）"
echo
echo "--- 只应有：新 www 块、SPA 少了 www、两处 default_server ---"
diff /root/nginx-T-before.$ts.txt <(nginx -T 2>&1)
echo
echo "回滚命令： cp -a $BAK /etc/nginx/sites-available/ideahub && nginx -t && systemctl reload nginx"
