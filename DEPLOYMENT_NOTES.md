Deployment notes — IdeaHub (ECS / Cloudflare / CI)

Last updated: 2026-09-19

Purpose
- Centralize recent operational facts for ECS deployment so an engineer or an AI agent reading the repo can quickly find where runtime artifacts and deployment automation live.
- Do NOT store secret values here; list only file paths and secret variable names.

Target architecture for V1 rebuild (confirmed 2026-04-08)
- Primary node: Alibaba Cloud ECS in Hong Kong.
- Frontend and backend remain in two separate GitHub repositories and deploy independently.
- Domain split: `ideahubs.org` serves the frontend; `api.ideahubs.org` serves the backend API.
- Phase 1 keeps Cloudinary and MongoDB as-is; Phase 2 may migrate media to OSS and database to Alibaba Cloud MongoDB if mainland performance requires it.
- Recommended origin TLS for Hong Kong ECS: use a public certificate on nginx so the same origin can serve both Cloudflare-proxied traffic and direct fallback traffic if needed.

Recommended server layout for the Hong Kong ECS
- Backend repo root: `/var/www/ideahub-server`
- Frontend build output: `/var/www/ideahub-client-dist`
- Backend env file: `/var/www/ideahub-server/.env`
- Backend deploy script: `/var/www/ideahub-server/deploy.sh`
- Frontend deploy target: `/var/www/ideahub-client-dist`

Recommended deployment model for separate repos
- `server` repository workflow: SSH to ECS and run `/var/www/ideahub-server/deploy.sh`.
- `client` repository workflow: build on GitHub Actions, then `rsync --delete` the generated `dist/` to `/var/www/ideahub-client-dist`.
- Do not let the server deploy script build the client. The two repositories should be released independently.

Mainland access strategy for V1
- Keep the primary origin in Hong Kong for compatibility with OpenAI, Cloudinary, and MongoDB.
- Use Cloudflare for the main public entry, but retain the option of a direct or alternate mainland-facing entry later if Cloudflare routing quality is inconsistent from mainland networks.
- If Cloudinary delivery is slow in mainland China, add a dedicated media domain and reverse-proxy or cache media before migrating to OSS.
- If MongoDB access becomes unstable from the Hong Kong origin, whitelist the ECS IP first; if mainland acceleration is still insufficient, move to Alibaba Cloud MongoDB in Phase 2.
- AI provider choice should be abstracted at the application layer later so mainland users can switch from OpenAI to providers such as Doubao without changing deployment topology.

Quick facts
- ECS public IP: 8.217.8.225
- Instance hostname: iZj6cag6svq9fmf42vkh61Z
- Region: 中国香港
- OS: Ubuntu 22.04.5 LTS
- Node.js: v20.20.2
- PM2: 6.0.14

Domains & DNS
- Root domain: ideahubs.org
- API domain: api.ideahubs.org
- WWW domain: www.ideahubs.org
- Cloudflare Zone ID: c7374c41b78b42cfadbf697863e2988b
- Current validation mode: direct origin with Let's Encrypt certificate on nginx

Key server paths (on ECS)
- Backend repo root: /var/www/ideahub-server
- Backend env file (server): /var/www/ideahub-server/.env (permission: chmod 600)
- Deploy script: /var/www/ideahub-server/deploy.sh
- Frontend static files (nginx): /var/www/ideahub-client-dist
- TLS certificate: /etc/letsencrypt/live/ideahubs.org/fullchain.pem
- TLS private key: /etc/letsencrypt/live/ideahubs.org/privkey.pem
- Nginx site config: /etc/nginx/sites-available/ideahub (enabled in sites-enabled)

Runtime
- Process manager: pm2 (process name: ideahub-server)
- Backend listens on: http://localhost:4000
- Nginx serves ideahubs.org/www.ideahubs.org from /var/www/ideahub-client-dist
- Nginx acts as reverse proxy for api.ideahubs.org → 127.0.0.1:4000
- Logs: pm2 logs ideahub-server ; nginx logs in /var/log/nginx/ ; rotation: see "Log rotation" below

Log rotation (since 2026-09-19)
- pm2 日志（`~/.pm2/logs/*.log` 与 `~/.pm2/pm2.log`）由 pm2 模块 **pm2-logrotate 3.0.0** 负责，
  装在 **deploy 用户的 pm2** 下（代码 `~/.pm2/modules/pm2-logrotate`，配置 `~/.pm2/module_conf.json`）。
  - 配置：`max_size 20M`（每 30s 检查一次，超了立刻切）、`rotateInterval '0 0 * * *'`
    （每天 00:00 CST 不论大小都切，空文件除外）、`retain 14`、`compress true`。
    ⚠ `retain` 是「每个日志保留的份数」不是天数：日志暴涨时 14 份可能撑不到 14 天。
  - 切出来的文件与原文件同目录：`ideahub-server-error__YYYY-MM-DD_HH-mm-ss.log.gz`。
  - 查看 / 修改：`pm2 conf pm2-logrotate`；`pm2 set pm2-logrotate:<key> <value>`
    （只重启这个模块，不碰 ideahub-server）。重装 / 升级 `pm2 install pm2-logrotate`（配置保留），
    卸载 `pm2 uninstall pm2-logrotate`。注意它的依赖写的是 `pm2: latest` / `pmx: latest`，重装拉当天最新版。
  - 实现是「复制 → 原地 truncate」：不改名、不发信号、不调 `reloadLogs`、不重启任何进程。
    代价：复制结束到 truncate 之间（毫秒级）写入的行会丢。
- **与 deploy.sh 的零停机 reload 无交互**（上线前核对过，上线后 ideahub-server 的 pid / ↺ 均未变）：
  - `pm2 reload ecosystem.config.js` 只作用于 ecosystem 里声明的 app，模块不在其中（`pm2 reload all` 也跳过模块）。
  - `pm2 save` 不把模块写进 `dump.pm2`；开机时 pm2 daemon 从 `~/.pm2/modules` 自己拉起模块
    （`pm2-deploy.service` → resurrect）。
  - pm2 daemon 以追加模式写日志，truncate 后的写入从文件头开始，reload 期间发生切割也不会产生空洞文件。
  - 唯一可见变化：`pm2 ls` 多出一个 Module 区块（deploy.sh 失败分支写进 deploy.log 的 `pm2 list` 同样会带上）。
  - 内存：模块常驻约 65 MB（本机 1.6 GB、无 swap）。
- `/var/log/ideahub/deploy.log`：deploy 没有免密 sudo，所以不走 `/etc/logrotate.d`，
  而是 **deploy 用户自己的 cron 跑用户级 logrotate**：
  - 配置 `~/.config/logrotate/ideahub.conf`：monthly、maxsize 10M、rotate 12、compress + delaycompress、
    missingok、notifempty、create 0664。
  - 状态文件 `~/.local/state/logrotate/status`；cron 输出 `~/.local/state/logrotate/cron.log`（成功时为空）。
  - cron：`30 3 * * * /usr/sbin/logrotate -s /home/deploy/.local/state/logrotate/status /home/deploy/.config/logrotate/ideahub.conf >> /home/deploy/.local/state/logrotate/cron.log 2>&1`
  - 用「改名 + 新建」而不是 copytruncate 是安全的：deploy.sh 每一行都用 `>>` 重新打开日志，不长期持有句柄。
  - 演练（只打印不动文件）：`logrotate -d -s ~/.local/state/logrotate/status ~/.config/logrotate/ideahub.conf`
- 历史归档：上线前的 error log（116 MiB / 65 万行，2026-04-10 ~ 2026-09-09；绝大多数是 main 上已修掉的
  Mongoose `new` 选项弃用警告，末尾是 Live2D 模型包 401/502、ark-transfer 403 等真实事件）已归档到
  `~/log-archive/ideahub-server-error.upto-2026-09-09.log.gz`（1.9 MB；sha256 校验与原文件逐字节一致后才原地清空原文件）。
  单独目录，pm2-logrotate 的 retain 清理碰不到。查阅：
  `zcat ~/log-archive/ideahub-server-error.upto-2026-09-09.log.gz | grep -v -e MONGOOSE -e trace-warnings | less`

Access model for remote ops (humans & AI agents)
- 入口：`ssh deploy@8.217.8.225`（密钥登录，BatchMode 可用；私钥不入库）。
- deploy 用户**无需额外授权**就能做：pm2（**只用 deploy 的 pm2**，`PM2_HOME=/home/deploy/.pm2`；
  root 的 pm2 会另起一个空的 God daemon）、跑 deploy.sh、读写 `~/.pm2/logs` 与 `/var/log/ideahub`、
  deploy 自己的 crontab。`/var/www/ideahub-server` 也可读，但它是 `git reset --hard origin/main` 的工作树，
  改动必须走 PR —— 直接改会在下次部署被抹掉。
- deploy **没有免密 sudo**。需要 root 的：`/etc/*`（nginx 配置、`/etc/logrotate.d`、sudoers）、
  用 `systemctl` 管系统服务、`apt`、certbot。目前由人工在阿里云控制台操作：
  ECS 实例 → 远程连接 → Workbench（以 root 登录）。安全组同样只能在控制台改。
- 若要让 agent 直接做某一类 root 操作：按需在 `/etc/sudoers.d/` 加**精确到参数**的 NOPASSWD 条目。例：
  1. Workbench 以 root 登录，`visudo -f /etc/sudoers.d/deploy-nginx`，写入
     `deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -t, /usr/bin/systemctl reload nginx`
     （visudo 保存时做语法校验；报错时选 `e` 重新编辑或 `x` 放弃，**别选 `Q` 强存**——坏的 sudoers 会让 sudo 整体失效）；
  2. `chmod 440 /etc/sudoers.d/deploy-nginx`；
  3. 以 deploy 验证：`sudo -n /usr/sbin/nginx -t`；
  4. 在本节记下新增了哪条、为什么。
  ⚠ 不要给 `deploy ALL=(ALL) NOPASSWD: ALL`：GitHub Actions 也用 `DEPLOY_SSH_KEY` 以 deploy 身份登录，
  全量 sudo 等于「CI 被攻破 = 服务器 root 被拿走」。也不要放行能逃逸成 root shell 的命令：会调分页器 /
  编辑器的（`journalctl`、`systemctl status`、`less`、`vi`），以及能写 `/etc/logrotate.d`、`/etc/cron.d` 的
  （这两处的配置本身就能以 root 执行任意命令）。

GitHub Actions & deployment automation
- Server workflow file: server/.github/workflows/deploy.yml
- Server workflow behavior: on push to main, Actions SSH to DEPLOY_HOST and runs /var/www/ideahub-server/deploy.sh
- Client workflow file: client/.github/workflows/deploy.yml
- Client workflow behavior: on push to main, Actions build dist/ and rsync it to /var/www/ideahub-client-dist

Required deployment secrets (names only)
- DEPLOY_HOST
- DEPLOY_USER
- DEPLOY_SSH_KEY
- DEPLOY_PORT (optional)

Application environment secrets (stored as GitHub repository Actions secrets — NAMES ONLY)
- AI_JOB_MAX_ATTEMPTS
- AI_WORKER_POLL_MS
- CLIENT_BASE_URL
- CLOUDINARY_API_KEY
- CLOUDINARY_API_SECRET
- CLOUDINARY_CLOUD_NAME
- COOKIE_SESSION_KEY
- EMAIL_FROM
- EMAIL_PROVIDER
- ENABLE_AI_WORKER
- GITHUB_CLIENT_ID
- GITHUB_CLIENT_SECRET
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- JWT_EXPIRES_IN
- JWT_SECRET
- MONGO_URI
- OAUTH_SUCCESS_REDIRECT
- OPENAI_API_KEY
- OPENAI_MODEL
- OTP_MAX_ATTEMPTS
- OTP_PEPPER
- OTP_RESEND_COOLDOWN_SECONDS
- OTP_TTL_MINUTES
- PORT
- RESEND_API_KEY
- SERVER_BASE_URL

Notes and next steps
- Do NOT commit any secret values into the repo. Use GitHub Actions repository secrets for CI and/or store secrets on the server with strict file permissions.
- Ensure the public key for the `DEPLOY_SSH_KEY` is present in /home/DEPLOY_USER/.ssh/authorized_keys on the ECS instance.
- Add 8.217.8.225/32 to MongoDB network access whitelist if IP allowlisting is required.
- DNS currently resolves `@`, `www`, and `api` to 8.217.8.225.
- TLS currently terminates at nginx using Let's Encrypt; do not switch api.ideahubs.org to Cloudflare proxy until post-cutover verification is complete.

Where to look next
- For server deploy script and build steps: /var/www/ideahub-server/deploy.sh (on server) and server/deploy.sh in repo
- For client deployment workflow: client/.github/workflows/deploy.yml
- For server deployment workflow: server/.github/workflows/deploy.yml
- For runtime troubleshooting: pm2 list; journalctl -u nginx; tail -f /var/log/nginx/error.log

Change log
- 2026-04-02: Initial migration summary added; GitHub Actions workflow `.github/workflows/deploy.yml` added; front-end env updated to VITE_API_BASE=https://api.ideahubs.org
- 2026-04-08: Confirmed V1 rebuild target as Alibaba Cloud Hong Kong with separate client/server deployments and `ideahubs.org` + `api.ideahubs.org` split.
- 2026-04-10: Hong Kong ECS cutover completed; TLS now uses Let's Encrypt on nginx, backend runs from /var/www/ideahub-server, and frontend publishes to /var/www/ideahub-client-dist.
- 2026-08-20: cert-expiry 监控升级为两层（边缘按域名 + 源站按 IP+SNI）。起因：2026-08-07 三域名（含 api）开启 Cloudflare 橙云代理后，旧脚本按域名握到的是 Cloudflare 边缘证书 —— 其 `*.ideahubs.org` 通配符被精确匹配误判为「SAN 缺失」（08-08 起连红 13 天，纯假阳性），同时源站 Let's Encrypt 证书对监控完全不可见（假阴性风险）。核查结论：源站证书三 SAN 齐全、有效期至 2026-11-06，certbot.timer 正常，08-08 的续期已在代理开启状态下成功（http-01 穿代理可用），服务器侧零改动。上文「api 先保持 DNS only」的建议自 08-07 起已不再是现状。
- 2026-08-20（第二条）: 定案「源站只对 Cloudflare 开放」并完成仓库侧改造。
  背景：本仓与 client 仓均为公开仓，源站 IP 已进 git 历史与 passive DNS/全网扫描库
  （实测：对 8.217.8.225 无 SNI 握手即返回 CN=ideahubs.org 证书）——「藏 IP」既不可行
  也不必要，改为让「流量必须经过 Cloudflare」成为网络层事实，防护从此不依赖 IP 保密。
  - **安全组（控制台人工操作）**：入方向 443 与 80 的授权对象从 0.0.0.0/0 收紧为
    Cloudflare 官方 IPv4 段（https://www.cloudflare.com/ips-v4 ，当前 15 段；nginx 只监听
    IPv4、CF 回源走 A 记录，故 v6 段不需要）。先加 CF 规则、验证后再删全网规则，避免中间
    出现拒绝窗口。22 本次不动（GitHub Actions 部署走公网 22，受限来源是单独议题）。
  - **监控拓扑**：cert-expiry.yml 只跑 [边缘] 层（`ORIGIN_HOST=""` 显式跳过源站层）。
    （原计划再加「经 Cloudflare 回源探活」捕捉「CF 新增回源网段而安全组没跟上 → 间歇 522」
    与源站宕机 —— 首跑即被本 zone 对数据中心来源的拦截打了 403：GH runner 与 ECS 出公网
    绕一圈都被拦，住宅 IP 的 curl 反而 200。已撤下；在 CF 给 /api/health 加 WAF Skip
    规则后恢复，若拦截来自免费版 Bot Fight Mode 则 Skip 无效、需权衡关 BFM。）
    [源站] 层（certbot 看门狗）搬进 ECS 机内：`scripts/ops/origin-cert-watchdog.sh`
    （deploy 用户 cron 日跑，对 127.0.0.1:443 带 SNI 握手，同一份 cert-expiry-check.sh，
    `LAYERS=origin`），结果上报 healthchecks.io 死人开关 —— 证书临期、检查失败、看门狗自身
    死掉三种情况都会出声。
  - **机内安装（deploy 用户，一次性）**：
    1. healthchecks.io 建 check（Period = 1 day，Grace = 6 hours），拿到 ping URL；
    2. `mkdir -p ~/.config/ideahub && printf '%s\n' '<ping URL>' > ~/.config/ideahub/origin-cert-hc-url && chmod 600 ~/.config/ideahub/origin-cert-hc-url`
    3. 手动跑一次 `bash /var/www/ideahub-server/scripts/ops/origin-cert-watchdog.sh`，确认
       healthchecks 面板收到 ping；
    4. `(crontab -l 2>/dev/null; echo '47 8 * * * bash /var/www/ideahub-server/scripts/ops/origin-cert-watchdog.sh') | crontab -`
  - ⚠ **由此作废**：从公网直连源站的一切诊断（`curl --resolve …:8.217.8.225`、
    `openssl s_client -connect 8.217.8.225:443`）—— 收紧后一律上机对 127.0.0.1 做等价操作。
  - ⚠ **新增巡检耦合**：Cloudflare 网段变更时，`/etc/nginx/conf.d/cloudflare-realip.conf` 与
    安全组两条规则必须**一起刷**（同一份清单的两份拷贝，安全组无法代码收口）。
  - certbot 不受影响：authenticator=nginx 的 http-01 验证按域名解析到 CF 边缘再回源，来源
    属于 CF 网段（08-08 已在橙云状态下续期成功为证）。
- 2026-09-19: 上线日志轮转（见上文「Log rotation」）。起因：`ideahub-server-error.log` 无轮转已涨到 116 MiB
  （磁盘 40G 只用 17%，不紧急）。pm2 日志交给 pm2-logrotate（deploy 用户的 pm2），deploy.log 交给 deploy
  用户 cron 跑的用户级 logrotate（deploy 无免密 sudo）；旧 error log 校验后归档到 `~/log-archive/`。
  同时补了「Access model for remote ops」一节。

---

## 部署与运维状态（2026-04-10 摘要）

简要记录当前部署与运维的关键信息与建议，便于运维/支持快速定位问题。

- ECS / 服务:
	- 公网 IP: 8.217.8.225
	- 部署用户: `deploy`
	- 部署脚本: `/var/www/ideahub-server/deploy.sh`
	- 后端（pm2）: `ideahub-server`，监听 `127.0.0.1:4000`
	- 前端构建输出: `/var/www/ideahub-client-dist`

- nginx / TLS / Cloudflare:
	- nginx 配置位置: `/etc/nginx/sites-available/ideahub`
	- Let's Encrypt 证书: `/etc/letsencrypt/live/ideahubs.org/fullchain.pem`
	- 私钥: `/etc/letsencrypt/live/ideahubs.org/privkey.pem`
	- 当前状态: `https://ideahubs.org` 与 `https://api.ideahubs.org/api/health` 已公网验证通过。
	- Cloudflare 策略: 现阶段建议主站可按需接入代理，`api.ideahubs.org` 先保持 DNS only，待确认不会复现 525/TLS1.3 互操作问题后再评估开启代理。

- SSH / Deploy keys / Actions secrets:
	- 主私钥指纹（`/home/deploy/.ssh/id_ed25519`）: `SHA256:lcOMYf69NFJs1+CbaEiZh4NNbo3efdQXRz96eAm32rc`。
	- 已从私钥派生公钥并保存在 `/tmp/pub_from_priv.pub`，可用于添加为 GitHub Deploy key。
	- `/home/deploy/.ssh/authorized_keys` 已备份为 `/home/deploy/.ssh/authorized_keys.bak` 并去重；当前包含两把公钥条目。
	- 因 GitHub 不允许同一 deploy key 被重复用于多个仓库，已为 `ideahub-client` 生成单独的 keypair (`/home/deploy/.ssh/id_ed25519_client*`) 并将公钥追加到 `authorized_keys`。请将该公钥添加为 `ideahub-client` 的 Deploy key（只读），并把对应私钥上传为该仓库的 Actions secret（例如 `DEPLOY_SSH_KEY` 或 `DEPLOY_SSH_KEY_CLIENT`）。

- CI / 工作流:
	- `server` 仓库通过 SSH 执行 `/var/www/ideahub-server/deploy.sh` 发布后端。
	- `client` 仓库通过 GitHub Actions 构建并 rsync 到 `/var/www/ideahub-client-dist` 发布前端。

- 证据与日志位置（服务器）:
	- nginx error log: `/var/log/nginx/error.log`
	- pm2 log: `/home/deploy/.pm2/logs/ideahub-server-*.log`

- 优先建议：
	1. 为 Google / GitHub OAuth 控制台同步最新地址回调：`https://api.ideahubs.org/api/auth/oauth/.../callback`。  
	2. 在浏览器侧完整验证登录、上传图片、AI 调用和管理页链路。  
	3. 中长期：按大陆访问质量评估是否迁移媒体到 OSS、数据库到阿里云 MongoDB，并在应用层接入 OpenAI / 豆包等多 AI provider。

	## 前端验收与检查（2026-04-07）

	- 前端静态文件位于 `/var/www/ideahub-client-dist`，由 nginx 提供服务。
	- 建议的快速验证步骤（在本地或服务器上运行）：

	```bash
	curl -I https://ideahubs.org
	curl -I --resolve ideahubs.org:443:8.217.8.225 https://ideahubs.org
	```

	- 当前阶段优先以直连源站完成业务验收；若后续重新启用 Cloudflare 代理并再次出现 `525`，再按历史流程收集支持包。

	---

	已做 / 建议的下一步：
	- 已确认 origin 成功响应并且公网直连返回 200。
	- 若后续为主站开启 Cloudflare Proxy，请先仅对 `ideahubs.org` 启用并验证静态资源与登录流程，再决定是否代理 `api.ideahubs.org`。

	- 当前正式 TLS 证书路径（生产有效配置）:
		- 证书路径: `/etc/letsencrypt/live/ideahubs.org/fullchain.pem`
		- 私钥路径: `/etc/letsencrypt/live/ideahubs.org/privkey.pem`
	- 历史说明：旧北京 ECS 曾使用 Cloudflare Origin CA；相关文件路径仅在排查历史 `525` 问题时参考，不再作为当前生产配置。


