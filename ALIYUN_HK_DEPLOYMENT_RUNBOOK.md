# IdeaHub Aliyun HK Deployment Runbook

Last updated: 2026-04-10

## Scope

This runbook is for the confirmed V1 deployment topology:

- Primary origin on Alibaba Cloud ECS in Hong Kong
- Frontend and backend kept as two separate GitHub repositories
- Frontend served from `ideahubs.org`
- Backend API served from `api.ideahubs.org`
- Phase 1 keeps Cloudinary and MongoDB
- Phase 2 may move media to OSS and database to Alibaba Cloud MongoDB

Current completion status (2026-04-10)

- Hong Kong ECS host is provisioned and reachable.
- `server` repository is deployed at `/var/www/ideahub-server`.
- `client` repository publishes built assets to `/var/www/ideahub-client-dist` through GitHub Actions.
- PM2 runs `ideahub-server` successfully under the `deploy` user.
- nginx serves `https://ideahubs.org` and proxies `https://api.ideahubs.org`.
- Let's Encrypt certificate for `ideahubs.org`, `www.ideahubs.org`, and `api.ideahubs.org` is active.

## Why Hong Kong for V1

Hong Kong is the lowest-risk origin choice for the current stack because the backend still depends on:

- OpenAI
- Cloudinary
- MongoDB Atlas or other external MongoDB service

Putting the primary backend in mainland China before replacing those dependencies would introduce avoidable cross-border failures.

## Target layout on ECS

```text
/var/www/ideahub-server       # server Git repo
/var/www/ideahub-client-dist  # deployed frontend static files
/var/log/ideahub/deploy.log   # server deploy log
/etc/nginx/sites-available/
/etc/nginx/sites-enabled/
```

## Host preparation

Install base packages on Ubuntu 22.04:

```bash
sudo apt update
sudo apt install -y nginx git rsync curl build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
node -v
npm -v
pm2 -v
```

Create deploy directories:

```bash
sudo mkdir -p /var/www/ideahub-server
sudo mkdir -p /var/www/ideahub-client-dist
sudo mkdir -p /var/log/ideahub
sudo chown -R deploy:deploy /var/www/ideahub-server /var/www/ideahub-client-dist /var/log/ideahub
```

## Repository model

### Server repo

Clone the server repository into:

```bash
cd /var/www
git clone <server-repo-url> ideahub-server
```

The server repository should own:

- application source
- `.env`
- PM2 process
- API deployment workflow
- `deploy.sh`

### Client repo

The client repository does not need to live permanently on the ECS host for V1.

GitHub Actions builds the frontend and synchronizes `dist/` directly into:

```bash
/var/www/ideahub-client-dist
```

## Environment variables

Create the server environment file:

```bash
cd /var/www/ideahub-server
cp .env.example .env
chmod 600 .env
```

Required V1 values:

```env
CLIENT_BASE_URL=https://ideahubs.org
SERVER_BASE_URL=https://api.ideahubs.org
OAUTH_SUCCESS_REDIRECT=https://ideahubs.org/oauth/callback
PORT=4000
MONGO_URI=...
OPENAI_API_KEY=...
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
JWT_SECRET=...
COOKIE_SESSION_KEY=...
```

## DNS strategy

Recommended records:

- `ideahubs.org` -> ECS public IP
- `api.ideahubs.org` -> ECS public IP

Recommended entry strategy:

- `ideahubs.org`: Cloudflare proxied if global CDN is desired
- `api.ideahubs.org`: start with DNS only during initial validation, then enable proxy only after origin TLS is confirmed healthy

If mainland routing quality is inconsistent later, add a separate mainland-facing entry such as `cn.ideahubs.org` instead of moving the origin first.

## TLS strategy

For the Hong Kong origin, prefer a public certificate on nginx so both of these work cleanly:

- direct browser access
- Cloudflare proxied access

That keeps fallback paths open and avoids relying on a Cloudflare-only origin certificate.

Example with Certbot after DNS resolves:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ideahubs.org -d www.ideahubs.org -d api.ideahubs.org
```

If you still choose Cloudflare Origin CA, keep it only after direct TLS validation passes and confirm that Cloudflare proxy mode does not reproduce the previous 525 handshake issue.

## nginx layout

Example origin configuration:

```nginx
server {
    listen 80;
    server_name ideahubs.org www.ideahubs.org;
    return 301 https://$host$request_uri;
}

server {
    listen 80;
    server_name api.ideahubs.org;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ideahubs.org www.ideahubs.org;

    ssl_certificate /etc/letsencrypt/live/ideahubs.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ideahubs.org/privkey.pem;

    root /var/www/ideahub-client-dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}

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
```

Enable and validate:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Backend deployment

The server repository deploys independently.

```bash
cd /var/www/ideahub-server
bash ./deploy.sh
pm2 status
pm2 logs ideahub-server
```

Current deployment model:

- `deploy.sh` fetches latest server code
- installs production dependencies
- restarts `ideahub-server`

## Frontend deployment

The client repository deploys independently through GitHub Actions.

Expected secrets in the client repository:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PORT`

The workflow should:

1. install dependencies
2. build `dist/`
3. `rsync --delete` to `/var/www/ideahub-client-dist`

Current workflow note:

- The client workflow opts into GitHub Actions Node 24 runtime compatibility and builds the frontend with Node.js 22.

## OAuth checklist

After changing domains, update both the environment file and provider consoles.

### Server env

- `CLIENT_BASE_URL=https://ideahubs.org`
- `SERVER_BASE_URL=https://api.ideahubs.org`
- `OAUTH_SUCCESS_REDIRECT=https://ideahubs.org/oauth/callback`

### Google and GitHub consoles

Update callback URLs to:

- `https://api.ideahubs.org/api/auth/oauth/google/callback`
- `https://api.ideahubs.org/api/auth/oauth/github/callback`

## Validation checklist

### Origin health

```bash
curl -I https://ideahubs.org
curl -I https://api.ideahubs.org/api/health
curl -I --resolve ideahubs.org:443:<ecs_public_ip> https://ideahubs.org
curl -I --resolve api.ideahubs.org:443:<ecs_public_ip> https://api.ideahubs.org/api/health
```

### Application flows

- homepage loads from `ideahubs.org`
- API requests go to `api.ideahubs.org`
- email/password login succeeds
- OAuth login succeeds
- image upload succeeds
- AI review succeeds

### Completed baseline checks on 2026-04-10

- `curl -I https://ideahubs.org` returned `200`
- `curl -I https://api.ideahubs.org/api/health` returned `200`
- PM2 reports `ideahub-server` as `online`
- nginx configuration test passed

### Process checks

```bash
pm2 status
pm2 logs ideahub-server --lines 100
sudo nginx -t
sudo journalctl -u nginx -n 100 --no-pager
```

## Mainland risk notes for Phase 1

### OpenAI

OpenAI access may be inconsistent from mainland networks. Keep the origin in Hong Kong and plan an application-layer provider switch later.

Recommended Phase 2 direction:

- add provider abstraction in the backend
- support OpenAI and domestic providers such as Doubao
- persist user or region preference per account

### Cloudinary

Cloudinary is acceptable for V1 but may be slow in mainland China.

Recommended Phase 2 direction:

- migrate media to Alibaba Cloud OSS
- put CDN in front of OSS
- optionally keep Cloudinary only for processing workflows if needed

### MongoDB

MongoDB remains acceptable for V1 as long as the Hong Kong ECS can connect reliably.

Recommended Phase 2 direction:

- move to Alibaba Cloud MongoDB if mainland availability or compliance becomes a blocker

## Secrets hygiene

- Never commit `.env`
- Rotate any secret that has ever been exposed outside a locked-down secrets store
- Restrict MongoDB network access to the ECS public IP or VPC path you actually use
- Keep SSH deploy keys separate per repository

## Immediate post-cutover tasks

- Verify browser-side login, image upload, and AI flows from the public domain.
- Update Google and GitHub OAuth console callback URLs if they still point to older hosting platforms.
- Keep `api.ideahubs.org` on DNS only until Cloudflare proxy behavior is re-validated against the Hong Kong origin.
