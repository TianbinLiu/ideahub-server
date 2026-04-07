Deployment notes — IdeaHub (ECS / Cloudflare / CI)

Last updated: 2026-04-02

Purpose
- Centralize recent operational facts for ECS deployment so an engineer or an AI agent reading the repo can quickly find where runtime artifacts and deployment automation live.
- Do NOT store secret values here; list only file paths and secret variable names.

Quick facts
- ECS public IP: 39.106.7.215
- ECS private IP: 172.26.139.58
- Instance ID: IdeaHub
- Region: 华北2 (北京)
- Specs: 2 vCPU, 2 GiB, Ubuntu 22.04
- Bandwidth: 3 Mbps (note: limited — serve large media via Cloudinary + Cloudflare)

Domains & DNS
- Root domain: ideahubs.org
- API domain: api.ideahubs.org
- Cloudflare Zone ID: c7374c41b78b42cfadbf697863e2988b
- Cloudflare TLS mode: Full (using Origin CA on origin)

Key server paths (on ECS)
- Backend repo root: /var/www/ideahub
- Backend env file (server): /var/www/ideahub/server/.env (permission: chmod 600)
- Deploy script: /var/www/ideahub/server/deploy.sh
- Frontend static files (nginx): /var/www/ideahub/client-dist
- Cloudflare Origin CA cert: /etc/ssl/certs/cloudflare-origin.pem (chmod 644)
- Cloudflare Origin CA key: /etc/ssl/private/cloudflare-origin.key (chmod 600)
- Nginx site config: /etc/nginx/sites-available/ideahub (enabled in sites-enabled)

Runtime
- Process manager: pm2 (process name: ideahub-server)
- Backend listens on: http://localhost:4000
- Nginx acts as reverse proxy for 80/443 → 127.0.0.1:4000
- Logs: pm2 logs ideahub-server ; nginx logs in /var/log/nginx/

GitHub Actions & deployment automation
- Workflow file (in repo): .github/workflows/deploy.yml
- Behavior: on push to main, Actions SSH to DEPLOY_HOST and runs /var/www/ideahub/server/deploy.sh

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
- Add 39.106.7.215/32 to MongoDB Atlas Network Access whitelist so the server can connect to the DB.
- DNS: create A records in Cloudflare: `@` → 39.106.7.215 (ideahubs.org) and `api` → 39.106.7.215 (api.ideahubs.org); enable Cloudflare proxy (orange cloud) for CDN.
- For TLS: Cloudflare Origin CA is used on origin; cert & key are stored on server at the paths above.

Where to look next
- For deploy script and build steps: /var/www/ideahub/server/deploy.sh (on server) and server/deploy.sh in repo
- For CI workflow: .github/workflows/deploy.yml
- For runtime troubleshooting: pm2 list; journalctl -u nginx; tail -f /var/log/nginx/error.log

Change log
- 2026-04-02: Initial migration summary added; GitHub Actions workflow `.github/workflows/deploy.yml` added; front-end env updated to VITE_API_BASE=https://api.ideahubs.org

---

## 部署与运维状态（2026-04-07 摘要）

简要记录当前部署与运维的关键信息与建议，便于运维/支持快速定位问题。

- ECS / 服务:
	- 公网 IP: 39.106.7.215
	- 部署用户: `deploy`
	- 部署脚本: `/var/www/ideahub/server/deploy.sh`
	- 后端（pm2）: `ideahub-server`，监听 `127.0.0.1:4000`
	- 前端构建输出: `/var/www/ideahub/client-dist`

- nginx / TLS / Cloudflare:
	- nginx 配置示例: `/etc/nginx/sites-available/api.ideahubs.org`
	- Cloudflare Origin CA 证书: `/etc/ssl/certs/cloudflare-origin.pem`
	- 私钥: `/etc/ssl/private/cloudflare-origin.key`
	- 当前问题: Cloudflare 代理到 origin 时有 HTTP 525（TLS handshake failed），nginx error log 包含 `SSL_do_handshake() failed ... bad key share`；直连 origin（`curl --resolve api.ideahubs.org:443:39.106.7.215`）返回 200，表明 origin 可用但 Cloudflare edge→origin TLS 存在互操作问题。
	- 已尝试修复/排查项：移除重复 server block、添加 `ssl_ecdh_curve X25519:secp384r1:secp256r1`、抓包（tcpdump）、openssl s_client 测试、临时切换为 DNS-only 验证直连。

- SSH / Deploy keys / Actions secrets:
	- 主私钥指纹（`/home/deploy/.ssh/id_ed25519`）: `SHA256:lcOMYf69NFJs1+CbaEiZh4NNbo3efdQXRz96eAm32rc`。
	- 已从私钥派生公钥并保存在 `/tmp/pub_from_priv.pub`，可用于添加为 GitHub Deploy key。
	- `/home/deploy/.ssh/authorized_keys` 已备份为 `/home/deploy/.ssh/authorized_keys.bak` 并去重；当前包含两把公钥条目。
	- 因 GitHub 不允许同一 deploy key 被重复用于多个仓库，已为 `ideahub-client` 生成单独的 keypair (`/home/deploy/.ssh/id_ed25519_client*`) 并将公钥追加到 `authorized_keys`。请将该公钥添加为 `ideahub-client` 的 Deploy key（只读），并把对应私钥上传为该仓库的 Actions secret（例如 `DEPLOY_SSH_KEY` 或 `DEPLOY_SSH_KEY_CLIENT`）。

- CI / 工作流:
	- 本地已准备 `.github/workflows/deploy.yml`，需要 commit & push；Workflow 使用 `secrets.DEPLOY_SSH_KEY` 将私钥写入 `~/.ssh/id_ed25519` 并通过 SSH 执行 `server/deploy.sh`。

- 证据与日志位置（服务器）:
	- nginx error log: `/var/log/nginx/api.ideahubs.error.log`（包含 `bad key share` 日志）
	- tcpdump pcap: `/tmp/cf_after_fix.pcap`, `/tmp/cf_after_curve_fix.pcap`

- 优先建议：
	1. 准备 Cloudflare 支持包（CF‑RAY、nginx error log 片段、pcap、openssl 输出），并联系 Cloudflare 支持或请其检查受影响 POP。  
	2. 在仓库里 push workflow，并把对应私钥作为 `DEPLOY_SSH_KEY` 上传到仓库 Secrets，触发一次 Actions 流程验证部署链路。  
	3. 中长期：计划升级 origin 的 OpenSSL/nginx 或采用受控回退策略以改善 TLS1.3 互操作性。

