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
