# IdeaHub 生产上线安全清单（server / client / app）

> 最后更新：2026-08-06
> 参照：Xerofocus Production Launch Checklist + OWASP ASVS / Top 10
> 覆盖三个仓库：`server`（Express 5 + MongoDB）、`client`（React + Vercel）、`app`（React + Capacitor Android）

本清单分两部分：**A. 本轮已完成的代码级加固**（可直接验收），**B. 待人工执行的部署与运维项**（需要控制台/服务器权限，代码里做不到）。

Xerofocus 那份清单是按 AWS 写的；我们的实际拓扑是**阿里云香港 ECS + Cloudflare + Vercel + MongoDB + 火山方舟/OpenAI**，所以下面按我们的栈做了等价映射（例：AWS WAF → Cloudflare WAF，Secrets Manager → 阿里云 KMS 或 ECS 上的受限 .env）。

---

## A. 本轮已完成的代码级加固

### A1. 高危漏洞修复（均已验证）

| # | 问题 | 位置 | 影响 | 状态 |
|---|---|---|---|---|
| 1 | **OAuth state 签名可绕过 → 任意账号接管** | `src/routes/oauth.routes.js` | 无需登录即可接管任何未绑第三方登录的账号并取得其 JWT | ✅ 已修 |
| 2 | **正则转义失效 → 未授权 ReDoS** | `users.controller.js:33`、`ideas.controller.js:1097` | 未登录请求即可让单次查询耗时 **41.7 秒** CPU，并转嫁给 mongod | ✅ 已修 |
| 3 | **SSRF：任意 URL 服务端抓取并回显** | `scraper.controller.js`、`branchVideo.controller.js` | 可读云元数据（实例临时凭证）、扫描内网 | ✅ 已修 |
| 4 | **Live2D zip 解压无类型白名单 → 存储型 XSS** | `components.controller.js` | 上传 `evil.html`+`payload.js` 落到同源且 `ACAO:*` 的目录，可窃取 localStorage 里的 JWT | ✅ 已修 |
| 5 | **tagRank 匿名写 + 越权级联删除** | `tagRank.routes.js`、`tagRank.controller.js` | 匿名覆盖他人榜单；"投票→重建→删除"链可抹掉全站该 tag 下所有用户的帖子 | ✅ 已修 |
| 6 | **登录/注册零限流** | `auth.routes.js` | 撞库零成本；bcrypt 校验同时构成 CPU 放大 DoS | ✅ 已修 |
| 7 | **iframe `allow-scripts`+`allow-same-origin`** | `client/IdeaDetailPage.tsx` | 被嵌页面若指向本站可脱离沙箱、劫持顶层导航钓鱼 | ✅ 已修 |
| 8 | **网站零安全响应头** | `client/vercel.json` | 无 CSP / HSTS / XFO，XSS 无兜底 | ✅ 已修 |

**关于 #1 的说明**：`decodeState()` 原本在验签失败时回退到无签名的 base64 解码，使 `signOauthState` 的签名完全失效。攻击链是：自造 `state={mode:"link", linkUserId:<受害者 ObjectId>}` → 走一遍 `/oauth/google/link`（该端点是浏览器顶层跳转，带不了 Authorization 头，身份完全依赖 state）→ 回调信任 `linkUserId`，把攻击者的 Google 绑到受害者账号，**并直接签发受害者的 JWT**。受害者 ObjectId 在 `/api/users/:id`、作者字段等公开面上唾手可得。现已：删除 base64 回退、绑定入口先验签再进 passport、绑定成功不再下发 token（前端已有 `refreshMe()` 兜底路径）。

**关于 #2 的说明**：字符类 `[.*+?^${}()|[\\]\\]` 多写了一个反斜杠，导致字符类在 `]` 处提前闭合，整个 `replace` 成为 no-op —— 用户输入原样变成正则。实测 `?q=(a+)+$` 单次 `.test()` 耗时 41.7 秒。现已统一收口到 `src/utils/regex.js`。

### A2. 纵深防御与配置加固

**Server**
- CORS 从全开改为白名单（`CORS_ORIGINS` / `CLIENT_BASE_URL`）
- 全局 JSON body 限 1MB；`/api/branch` 的大 body（50MB）**只对持有效签名 token 的请求开放**，匿名请求走 1MB
- `/uploads` 静态目录加 `Content-Security-Policy: ...; sandbox` + `nosniff` + `dotfiles: deny`
- JWT 校验固定 `algorithms: ["HS256"]`（防 alg 混淆）
- OTP 重置密码现在会递增 `tokenVersion`（此前重置后旧 token 仍有效 —— 账号被盗时重置形同虚设）
- 限流器重写：惰性清理过期桶（原实现 Map 永不清理 = 内存泄漏）、支持按账号维度、返回 `Retry-After`、不再采信可伪造的 `x-forwarded-for`
- 所有 LLM 端点按**用户**限流（`aiRateLimit`），防账单放大
- `aiClient` 补 `timeout` + `max_tokens`
- 启动自检 `assertProductionConfig()`：生产环境缺 `JWT_SECRET`(≥32 字符) / `OTP_PEPPER` / 真实 `SMS_PROVIDER` / CORS 配置时**拒绝启动**
- 优雅退出：`SIGTERM/SIGINT` → drain in-flight → 断开 mongoose（部署不再硬切请求）
- AI worker 移入 `connectDB()` 之后（原先不等数据库就开始轮询）
- 开放重定向：`safeNextPath` 补 `/\` 与控制字符

**Client（网站）**
- `vercel.json` 全套安全头：CSP、HSTS(preload)、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy`、`Permissions-Policy`、COOP
- 缓存策略：`/assets/*` 一年 immutable；`index.html` `must-revalidate`（避免发版后旧 HTML 指向已删 chunk）
- 删除随构建发布的 `public/live2d-widget/waifu-tips.js.map`
- 外链统一过 `normalizeSafeUrl`（`javascript:` / `data:` 一律拦截）

**App（Capacitor Android）**
- 生产构建注入 CSP `<meta>`（dev 不注入，否则打挂 HMR）
- `allowBackup="false"`（登录 token 在 WebView localStorage，开备份等于允许 `adb backup` 搬走登录态）
- 新增 `network_security_config.xml`：禁明文 HTTP + **只信系统 CA**（抓包代理装的用户级证书解不出流量）
- 构建分包：3D 引擎（2.9MB）与业务代码（210KB）分离，改业务代码不再让用户重下 3D 块

### A3. 依赖漏洞

| 仓库 | 修复前 | 修复后 |
|---|---|---|
| server | 19 项（12 高危） | **3 项**（全部 moderate，且**仅 devDependencies** 的测试工具 `mongodb-memory-server`） |
| client | 14 项（11 高危） | **0 项** |
| app | 5 项（2 高危） | **3 项**（全部 moderate，仅 `@capacitor/cli` 构建工具链） |

关键升级：
- `adm-zip 0.5 → 0.6`（"构造 ZIP 触发 4GB 内存分配" —— 我们正好有 zip 上传路径，直接相关）
- `multer 1.4.5-lts → 2.2.0`（1.x 已 EOL，存在多个 DoS 通告）
- `mongoose → 9.9.1`（`sanitizeFilter` 的 `$nor` NoSQL 注入 + 原型污染）
- `axios → 1.19.0`（NO_PROXY 绕过导致 SSRF、原型污染绕过 `validateStatus`）
- `react-router-dom → react-router 8.3.0`（两个仓库均迁移，RCE / XSS / CSRF 三个通告）

### A4. 回归测试

新增 **56 项**安全回归测试，全部通过：

- `server/tests/security.spec.js`（37 项）：正则转义与 ReDoS、SSRF 的 14 类攻击载荷、OAuth state 伪造/用途混用/`alg:none`、Live2D 文件类型白名单、限流器行为
- `client/src/utils/security.test.ts`（19 项）：开放重定向 6 种变体、URL 协议白名单

现有测试全绿：server 97/97，client 45/45。

> 这些测试的共同点：**改回去也不会有任何报错**。删掉一行鉴权、把正则的反斜杠写多一个，功能测试全绿，只有攻击者会发现。所以必须有回归测试钉住。

---

## A5. 线上核查结果（2026-08-07 实际登录 ECS 核对）

对着生产环境逐项验证，结果与纸面推测有出入，以下为**实情**：

### 已当场修复

- 🔴 **`JWT_SECRET` 是 `.env.example` 里的占位符**（33 字符，以 `replace` 开头）。
  这个字符串就写在公开仓库里 —— 任何人都能据此签发任意用户（含 admin）的 JWT，
  是完全的认证绕过，比代码里那几个漏洞更致命，且当时正在线上。
  **已轮换为 64 字符随机值**（服务器上 `secrets.token_urlsafe(48)` 生成并直接写入
  `.env`，值未经过屏幕也未进任何记录），`pm2 restart --update-env` 后
  `check:config` 通过、`/api/health` 200、旧 token 已返回 401。
  副作用：全员需重新登录（已知并接受）。
  原 `.env` 备份在服务器 `/var/www/ideahub-server/.env.bak.2026-08-07-131207`。

### 与纸面推测不符、需修正的认知

- **前端不在 Vercel 上**：GitHub Actions 构建后 rsync 到 ECS 的
  `/var/www/ideahub-client-dist`，由 nginx 提供服务。`vercel.json` 对生产不生效，
  安全响应头必须走 nginx（见 `client/deploy/`）。
- **缓存策略服务器上已配好**（index.html no-cache、/assets/ immutable），无需再加。
- **`api.ideahubs.org` 已被 helmet 完整覆盖**（CSP/HSTS/nosniff/XFO/Referrer-Policy
  实测均在），nginx 层无需重复。只有前端域名缺安全头。
- **`.env` 权限是 600、属主 deploy**，且 `OTP_PEPPER`、`SMS_PROVIDER`、
  `CLIENT_BASE_URL` 均已正确配置 —— 这几项原先担心的问题实际不存在。

### 生产环境实测证据（代码确实在跑，不只是部署了）

- **限流生效**：连续 25 次 `POST /api/auth/login` → 第 25 次返回 `HTTP 429`。
- **优雅退出生效**：pm2 重启时日志出现 `SIGINT 收到，开始优雅退出… 已断开数据库连接，退出`，
  说明在途请求会被 drain 而不是硬切。
- **启动自检生效**：`npm run check:config` 在 production 模式下通过；
  轮换 JWT_SECRET 前它准确报出了「JWT_SECRET 仍是示例值」。
- **鉴权正常**：无 token 访问 `/api/auth/me` → 401；旧 token（轮换前签发）→ 401；
  不存在的路由 → 404；`/api/health` → 200。

### 新发现、尚未处理

- ✅ ~~生产环境没有设置 `NODE_ENV`~~ **已修复（2026-08-07）**。原先的后果是：
  启动自检只告警不拦截、500 错误的内部细节原样回给客户端、Express 跑 development 模式。
  已在 `.env` 首行加入 `NODE_ENV=production` 并重启，验证：应用读到的
  `process.env.NODE_ENV === "production"`、500 消息脱敏为 `"Server error"`、
  启动自检转为强制且通过。
  **注意验证方法**：`/proc/<pid>/environ` 看不到这个值 —— 那是进程 exec 时的环境快照，
  而 dotenv 是在 Node 运行时设置 `process.env`。要验证得在应用的加载路径里查
  （`node -e 'require("dotenv").config(); console.log(process.env.NODE_ENV)'`）。
- ✅ ~~`deploy` 用户无免密 sudo，nginx 安全头待应用~~ **已完成（2026-08-07）**。
  前端 `ideahubs.org` 现返回 CSP / HSTS / X-Content-Type-Options / X-Frame-Options:DENY /
  Referrer-Policy / Permissions-Policy / COOP / X-DNS-Prefetch-Control。
  关键验证：`/assets/*.js` **同时**带 `Cache-Control: immutable` 与全套安全头 ——
  证明 nginx「子 location 有 add_header 就丢弃父块全部 add_header」的坑已绕过
  （include 插在了 server 块 + `location = /index.html` + `location /assets/` 三处）。
  浏览器实测首页与 `/tag-rank`：全部请求 200、零 CSP 违规、跨域调 `api.ideahubs.org` 正常。
  ⚠️ 脚本首次运行时验证步骤误报「未看到安全头」——`systemctl reload nginx` 是异步的，
  紧接着 curl 会打到旧 worker。脚本已改为重试 5 次，但**若日后再见到这条提示，
  先手动 `curl -I` 确认，不要贸然回滚一个可能本来就正确的改动**。
- ✅ ~~两个域名均未走 Cloudflare 代理，源站 IP 暴露~~ **已完成（2026-08-07）**。
  三条 A 记录（`ideahubs.org` / `www` / `api`）全部改为 Proxied，源站 IP 已从 DNS 消失。
  Bot Fight Mode 已开启。

  **为什么必须三条全开**：三条记录指向同一 IP，只代理前端的话，攻击者
  `nslookup api.ideahubs.org` 即得源站 IP，再用 `curl -H "Host: ideahubs.org" https://<IP>/`
  就绕过了 WAF —— 只代理前端等于承担改动风险却拿不到保护。改完 www 之后 Cloudflare
  自己也弹出了 "Your origin IP address is partially exposed" 的告警，独立印证了这点。

  **没有复现历史上的 525**：SSL/TLS 模式早已是 `Full (strict)` 且源站有有效
  Let's Encrypt 证书，当初踩坑的条件已不存在。

  实测：主域 200（8/8 安全头完整穿透 Cloudflare）、www 301 跳转正常、
  API 200 且 `cf-cache-status: DYNAMIC`（未被缓存）、POST 写操作正常、鉴权仍 401。
  Bot Fight Mode 开启后用 okhttp UA（安卓 App 的典型客户端）实测 API 仍 200，
  未影响非浏览器客户端。浏览器加载全站零 CSP 违规。

- ⚠️ **接入代理后引入并已修复的回归**：nginx 会把 Cloudflare 边缘 IP 追加进
  `X-Forwarded-For`，`trust proxy=1` 于是让 `req.ip` 取到边缘 IP，
  **同一边缘后的所有用户共用一个限流桶**（登录限流从「按用户」退化成「按全站」）。
  已改为优先取 `CF-Connecting-IP`。
  实测发现 **Cloudflare 会拦截伪造该头的请求（返回 403）**，故经代理来的该头可信。
  仍建议后续在 nginx 配 `real_ip` 模块 + `set_real_ip_from <Cloudflare IP 段>`
  并拒绝非 Cloudflare 来源的连接（需 sudo），以封死直连源站伪造头的残余路径。

- ⚠️ **nginx 访问日志的客户端 IP 现在是 Cloudflare 边缘 IP**（同一根因）。
  排查问题时看到的不是真实用户 IP，配 `real_ip` 模块可一并解决。
- ✅ **DMARC 已加报告地址**：`v=DMARC1; p=none; rua=mailto:...; fo=1; adkim=r; aspf=r`。
  仍保持 `p=none` 不拦截 —— 同时用了 SES 与 Resend 两个发信通道，
  在拿到聚合报告确认 SPF/DKIM 对齐之前收紧到 `p=quarantine` 有可能把自己的正常邮件
  打进垃圾箱。收几天报告后再决定。

- ⚠️ **`ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` 明文存在 `.env`**。
  应确认该 AK 是按最小权限授权的 RAM 子账号（只给短信发送所需权限），而非主账号 AK。
- GitHub 三仓的 Dependabot（alerts + security updates + dependency graph）**已开启**，
  Secret scanning 与 Push protection 原本就是开的。当前 2 条告警均为 `uuid` 的
  moderate 问题，来自测试/构建工具链，不进生产运行时。

## B. 待人工执行（需控制台/服务器权限）

以下按 Xerofocus 清单的章节顺序组织，映射到我们的实际栈。**代码层做不到，必须人工操作。**

### B1. 生产环境部署

- [ ] `.env` 中 `JWT_SECRET` 换成 ≥32 字符的随机值（`openssl rand -base64 48`），并与开发环境**不同**
- [ ] `OTP_PEPPER` 设为随机值（当前默认 `dev_pepper_change_me`，不改则 6 位验证码的 sha256 可离线秒破）
- [ ] `SMS_PROVIDER` 配真实短信通道（dev 通道会把验证码写进日志 → 有日志权限即可登录任意手机账号）
- [ ] `CORS_ORIGINS` 配置为 `https://ideahubs.org,https://www.ideahubs.org`
- [ ] 上述四项配好后，`NODE_ENV=production` 启动会自检；**自检不过会拒绝启动**，这是预期行为
- [ ] Node 进程绑 `127.0.0.1`（当前绑 `0.0.0.0`，与 nginx 并存时 4000 端口对公网暴露）
- [ ] 生产与开发环境完全隔离（独立数据库、独立密钥、独立 Cloudinary 目录）
- [ ] 密钥集中管理：阿里云 KMS / 参数仓库，或至少 `chmod 600 .env` 且属主为 deploy 用户
- [ ] 数据库每日/每周/每月自动备份 + **恢复演练**（备份没验证过 = 没有备份）
- [ ] MongoDB 放私有子网 / 开启 IP 白名单，启用 at-rest 加密与 TLS 连接
- [ ] MongoDB 密码轮换计划

### B2. 全球加速与可用性

- [ ] Cloudflare CDN 缓存规则（静态资源长缓存，API 不缓存）
- [ ] DNS Failover / 健康检查
- [ ] 大陆访问质量实测；不达标时评估阿里云 CDN 或独立媒体域名
- [ ] （对应 Xerofocus 的 AWS Global Accelerator / Latency Routing —— 我们单节点香港，暂用 Cloudflare 替代；多区域是 Phase 2）

### B3. 系统安全

- [ ] Cloudflare WAF 开启（对应 AWS WAF）：SQL 注入 / XSS / 速率规则
- [ ] Cloudflare Bot Management 或 Turnstile 保护注册与登录（**限流只是粗粒度兜底，防批量注册的主力应该是验证码 + 邮箱/短信验证**）
- [ ] 所有管理员账号开启 MFA（云控制台 + GitHub + Cloudflare）
- [ ] 云账号最小权限；Root/主账号禁止日常使用
- [ ] 开启操作审计日志（阿里云 ActionTrail，对应 CloudTrail），保留 ≥90 天
- [ ] ECS 安全组：只放行 80/443 与受限来源的 22
- [ ] 定期 `npm audit` 与系统包更新（建议接入 Dependabot / Renovate）
- [ ] 服务器登录改密钥认证，禁用密码登录

### B4. 支付系统

> 当前代码库**未接入 Stripe 或任何真实支付**（`points` / `bounty` 是站内虚拟点数，已用原子更新防双花，见 `bounty.controller.js:612-685`）。以下在真正接支付时才适用：

- [ ] 银行卡信息绝不入库（用 Stripe Elements / Checkout，卡号不经过我们服务器）
- [ ] Stripe Webhook 签名校验
- [ ] 支付重试与退款流程测试
- [ ] 月度账单发送
- [ ] 点数扣除/退款/返还的对账

### B5. 性能测试

- [ ] 100 / 500 / 1000 并发压测（k6 或 Artillery）
- [ ] API 响应时间基线（P50/P95/P99）
- [ ] AI 处理并发测试（注意：LLM 端点现已按用户限流 20 次/分，压测需用多账号或临时调高 `AI_*` 阈值）
- [ ] 慢查询分析与索引优化
- [ ] **限流阈值实测校准**：当前 `LOGIN_RATE_IP_MAX=60/分`、`REGISTER_RATE_MAX=30/时`。若用户走运营商 CGNAT（大量真实用户共用一个公网 IP），需据实调高，否则会误伤

### B6. 数据库

- [ ] 删除冗余表/字段（审计发现 `cookie-session` 是死依赖、`COOKIE_SESSION_KEY` 环境变量无用，可清理）
- [ ] 外键/索引复查（重点：`users.username`、`ideas.tags`、`TagLeaderboard.tagsKey`）
- [ ] 慢查询优化（审计发现多处 `find().populate()` 先拉全量再在 JS 里分页，见 B8 遗留项）

### B7. 代码仓库与发布

- [ ] Git secret scan（GitHub Secret Scanning 或 gitleaks）—— 本轮已确认 `.env` 从未进过 git 历史，但应常态化
- [ ] 删除仓库根目录的散件：`debug-db.js`、`debug-replies.js`、`test-*.js`（已确认无敏感信息，但会随部署上线）
- [ ] **删除或 gitignore `server/ideahub-server/`** —— 这是整个 server 的过期副本，自带 `.git`，会污染搜索与依赖审计，且其鉴权中间件是无 `tokenVersion` 校验的旧版，容易误读误用
- [ ] Release Tag + Release Notes + 回滚预案
- [ ] 冒烟测试脚本
- [ ] 上线审批记录

### B8. 监控告警

- [ ] 云监控 CPU / 内存 / 磁盘告警
- [ ] API 错误率告警（5xx 突增）
- [ ] **限流触发告警** —— 429 突增往往是攻击的第一信号
- [ ] AI 调用量与费用告警（方舟 / OpenAI 配额监控）
- [ ] 日志集中收集，保留 ≥90 天
- [ ] 告警通道：邮件 / 飞书 / Slack

### B9. 灾难恢复

- [ ] 定义 RPO / RTO 并写进 runbook
- [ ] 备份恢复演练（至少一次全量恢复到独立环境）
- [ ] DR Runbook（谁在什么情况下做什么）

### B10. 合规

- [ ] 隐私政策 / 服务条款页面
- [ ] Cookie 横幅（当前站点不用 cookie 存登录态，走 Bearer header，合规面较简单）
- [ ] GDPR / CCPA 评估（有欧美用户时）
- [ ] 账号注销的数据删除承诺与实现对齐（当前 `deleteAccount` 是硬删且无级联清理，见遗留项）

---

## C. 已知遗留项（本轮未做，按优先级排序）

审计发现但本轮未处理的问题，多数需要接口签名变更或产品决策：

**中优先级**
1. `express-mongo-sanitize` 已装但从未挂载。Express 5 的 `req.query` 是只读 getter，v2 全局挂载会**每个请求 500**，不能直接 `app.use()`。正确做法是只 sanitize body/params，或全站改用 zod schema。当前 body 侧的 `$ne` 注入在 `messages.controller.js:94` 等处仍可达。
2. OAuth 登录成功后 token 放在 URL query 里回传（`oauth.routes.js` 的 `redirectSuccess`）→ 会进浏览器历史、Referer、nginx access log。改 fragment 或一次性 code 需前后端同步改。
3. `meme.controller.js:135` 的 `getMeme` 缺 `shared`/owner 门禁（同类接口 `getPersona`、`getScenarioDetail` 都有），匿名可读私有 meme。
4. 多处列表接口 `find().populate()` 先拉全量再在 JS 里 `.slice()` 分页 —— 数据量上来会 OOM。涉及 `workshop:418`、`tagRank:311`、`users:141` 等。
5. `deleteAccount` 用硬删，与全站 `deactivatedAt` 软删语义冲突，且无级联清理、无二次认证。
6. `components.controller.js` 的 `buildPublicUrl` 用 `req.get("host")` 构造并**持久化** URL → Host 头注入可把攻击者域名写进用户资料。应改用 `SERVER_BASE_URL`。

**低优先级**
7. 限流器是进程内存储 —— PM2 cluster / 多实例下实际放行量 = 配置值 × 进程数。要严格配额需换 Redis。
8. `client/src/utils/workshopTheme.ts` 用字符串拼接 `innerHTML` 渲染模板内容。当前有 `escapeHtml`/`escapeAttr`/`normalizeSafeUrl`/`sanitizeCssBlock` 四道防线且未发现可利用点，但 `escapeHtml` 不转义引号，是"再改一行就会破"的结构。建议改 DOM API 重写。
9. Live2D 的 cubism core 从 `cubism.live2d.com` 动态加载且无 SRI；`waifu-tips.js` 内含对 `v1.hitokoto.cn` 的调用（把访问者 IP 暴露给第三方）。自托管后可把 CSP 的 `script-src`/`connect-src` 进一步收窄。
10. `scripts/migrateCommentParentId.js` 读 `MONGODB_URI`，而全站用的是 `MONGO_URI` → 该迁移脚本会静默连到 localhost 而非目标库。

---

## D. 验收方式

```bash
# server：全部测试（含 37 项安全回归）
cd server && npm test

# client：全部测试（含 19 项安全回归）
cd client && npm test && npm run build

# app：类型检查与构建
cd app && npx tsc --noEmit && npm run build

# 三个仓库的依赖漏洞
cd server && npm audit
cd client && npm audit
cd app && npm audit
```

生产配置自检（会在 `NODE_ENV=production` 下拒绝带着弱配置启动）：

```bash
cd server && NODE_ENV=production node src/index.js
```
