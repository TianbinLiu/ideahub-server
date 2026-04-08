# IdeaHub 项目架构文档

> 最后更新: 2026-03-29  
> 版本: 4.34

> 部署笔记（ECS / Cloudflare / CI）请参见：`server/DEPLOYMENT_NOTES.md` — 包含 ECS IP、证书路径、部署脚本与 GitHub Actions secrets 名称索引（不包含明文 secret）。
> 
> ---
> 
> ## 🤖 AI开发者必读
> 
> **在对本项目进行任何修改之前，你必须：**
> 
> 1. **📖 首先阅读 `.ai-instructions.md`** - AI开发工作流程和规则清单
> 2. **📚 然后阅读本文档相关章节** - 了解文件关系和现有实现
> 3. **✅ 遵循所有必备功能规范** - 国际化、错误处理、UI样式等
> 4. **🔄 修改后同步更新本文档** - 更新对应章节和更新记录表
> 
> > 💡 **快速链接**: [查看AI工作流程图](.ai-instructions.md#⚙️-ai工作流程) | [新页面必备清单](.ai-instructions.md#✅-新建页面必备功能清单)
> 
> ---

## 📋 目录

1. [项目概述](#项目概述)
2. [OpenClaw 团队快速上手](#openclaw-团队快速上手)
3. [项目结构树](#项目结构树)
4. [核心文件详解](#核心文件详解)
5. [更新记录](#更新记录)

---

## AI 启动默认读取范围（研发最小集）

为降低上下文占用，默认只读取 `PROJECT_STRUCTURE.md` 的以下研发相关章节：

- `项目结构树`
- `核心文件详解`
- `更新记录`（仅最近与当前任务相关条目）

默认跳过以下与具体研发改动无直接关系的段落（除非任务明确要求）：

- `OpenClaw 团队快速上手`
- `⚠️ AI开发提示`
- `所有页面必备功能`
- `开发指南`
- `功能完整性自查` 等通用流程性重复说明

执行建议：进入 `PROJECT_STRUCTURE.md` 时优先按标题锚点跳转到目标章节，不顺序通读整篇文档。

---

## OpenClaw 团队快速上手

本节用于让新同学在本项目中快速跑通 OpenClaw。按顺序执行即可。

### 1) 安装 OpenClaw（首次）

```bash
npm install -g openclaw@latest
openclaw --version
```

### 2) 初始化并安装后台服务（首次）

```bash
openclaw onboard --install-daemon
```

### 2.5) 使用 sandbox 前先安装 Docker（推荐）

本项目如果启用 `agents.defaults.sandbox.mode=all`，要求本机有可用 Docker。

- 下载入口：https://www.docker.com/products/docker-desktop/
- Windows x64（Intel/AMD）统一安装：**Docker Desktop 最新稳定版 - Windows - AMD64**
- 安装向导中建议勾选/启用 **Use WSL 2 based engine（WSL2 backend）**
- 安装完成后验证：

```bash
docker --version
```

- 若安装后提示 WSL 未启用，可在管理员 PowerShell 执行：

```powershell
wsl --install
shutdown /r /t 0
```

### 3) 克隆仓库并准备项目记忆文件

仓库中以下文件/目录是本项目 OpenClaw 工作流的关键上下文，请确保存在：

- `AGENTS.md`
- `BOOT.md`
- `CLAUDE.md`
- `HEARTBEAT.md`
- `MEMORY.md`
- `memory.md`
- `memory/`（含 `memory/YYYY-MM-DD.md`）

如果你是从同组成员处同步，请把以上文件与目录一并复制到仓库根目录。

### 4) 绑定本地工作区并启用项目 hook（推荐）

```bash
openclaw config set agents.defaults.workspace "C:\\Users\\<你的用户名>\\ideahub"

openclaw hooks enable boot-md
openclaw hooks enable bootstrap-extra-files
openclaw hooks enable session-memory
openclaw hooks enable command-logger

openclaw config set hooks.internal.enabled true
openclaw config set hooks.internal.entries.bootstrap-extra-files.paths '["MEMORY.md","memory.md"]' --strict-json
openclaw config set hooks.internal.entries.session-memory.messages 4
```

### 5) 同步当前项目的安全策略（推荐）

```bash
openclaw config set tools.allow '["read","write","edit","exec","process","web_search","web_fetch","memory_search","memory_get","sessions_list","sessions_history","sessions_send","sessions_spawn","sessions_yield","subagents","session_status"]' --strict-json
openclaw config set tools.deny '["gateway.*","nodes.*","browser.*"]' --strict-json
openclaw config set tools.fs.workspaceOnly true

# 需要 Docker 的团队成员：
openclaw config set agents.defaults.sandbox.mode all

# 没有 Docker 的团队成员（Windows 常见）：
openclaw config set agents.defaults.sandbox.mode off

openclaw config set gateway.nodes.denyCommands '["camera.snap","camera.clip","screen.record","contacts.add","calendar.add","reminders.add","sms.send","file.delete","file.move","process.kill","network.request","system.shutdown"]' --strict-json
```

> 注意：如果出现 `Sandbox mode requires Docker`，说明本机没有可用 Docker，请改用 `agents.defaults.sandbox.mode=off`。

### 6) 验证配置并启动

```bash
openclaw config validate
openclaw gateway restart
openclaw gateway status
openclaw dashboard ##openclaw tui
```

### 7) 日常使用建议（团队统一）

- 开新任务前先确认已读取 `AGENTS.md`、`CLAUDE.md`、`MEMORY.md`、`memory.md`。
- 完成非平凡任务后更新 `memory/YYYY-MM-DD.md`。
- 若修改了结构/路由/API/规则，同步更新本文档的对应章节和更新记录。

### 8) Dashboard 稳定编辑模式（避免 EPERM/批量改写冲突）

在 dashboard 中执行代码修改时，团队统一使用以下串行策略：

- 一次只改一个文件，不并发批量修改同一目录。
- 同一文件一次只下达一个编辑指令，等待成功后再发下一条。
- 每条编辑指令提供唯一上下文（函数名 + 前后几行），避免纯关键词替换。
- 涉及大改动时，临时关闭 VS Code 自动保存和保存时格式化，完成后恢复。
- 每完成 1-2 个文件，先读回文件确认结果，再继续下一个文件。

推荐在仓库级 `.vscode/settings.json` 临时切换：

```json
{
  "files.autoSave": "off",
  "editor.formatOnSave": false
}
```

改动完成后恢复为团队默认设置。

---

## 项目概述

**IdeaHub** 是一个全栈创意管理平台，支持用户发布、管理和分享创意，包含AI评审、社交互动、排行榜、管理后台等功能。

### 技术栈
- **前端**: React 18 + TypeScript + Vite + Tailwind CSS
- **路由**: React Router v6
- **国际化**: i18next + react-i18next（中英双语）
- **后端**: Node.js + Express + MongoDB + Mongoose + Cloudinary
- **认证**: Passport.js (Local + OAuth)
- **任务队列**: Bull + Redis
- **网页抓取**: axios + cheerio

### 核心特性
✅ 完整认证系统（邮箱/OAuth）  
✅ 创意CRUD + AI智能评审  
✅ 社交互动（点赞/评论/收藏）  
✅ 标签排行榜系统  
✅ 通知系统  
✅ 管理后台  
✅ **完整国际化（持续更新）**  
✅ 公司兴趣表达功能  
✅ **外部来源导入功能（12个预设平台）**
✅ **Creative Workshop 模板市场、布局编辑与热力图**
✅ **全站模板编辑（节点改样式/拖拽位移/页面背景/组件挂件）**

---

## 项目结构树

```
ideahub/
│
├── AGENTS.md                        # OpenClaw 工作区总规则与记忆流程
├── BOOT.md                          # OpenClaw 启动强制引导文件
├── CLAUDE.md                        # OpenClaw/Claude 入口说明（桥接到 server 文档规范）
├── MAINTENANCE.md                   # OpenClaw 长时自维护模式单一来源规则
├── start-openclaw-maintenance.cmd   # OpenClaw Windows 一键自维护启动脚本
├── continue-latest-maintenance.cmd  # OpenClaw Windows 继续最近维护会话脚本
├── open-latest-maintenance-log.cmd  # OpenClaw Windows 最近一次维护日志快速打开脚本
├── show-latest-maintenance-summary.cmd # OpenClaw Windows 最近一次维护结果摘要查看脚本
├── check-latest-maintenance-status.cmd # OpenClaw Windows 最近维护状态查看脚本
├── HEARTBEAT.md                     # 心跳维护清单（任务记忆/文档一致性）
├── MEMORY.md                        # OpenClaw 长期项目记忆
├── SOUL.md                          # OpenClaw 角色与行为边界
├── USER.md                          # 用户偏好与长期协作信息
├── memory/                          # OpenClaw 每日任务日志
├── memory.md                        # OpenClaw 项目知识库（框架/约定/坑点）
├── client/                           # 前端应用
│   ├── .env.example                 # 前端环境变量示例（API 子域）
│   ├── .github/workflows/deploy.yml # 前端仓库独立发布工作流
│   ├── src/
│   │   ├── main.tsx                  # 应用入口 + i18n初始化
│   │   ├── App.tsx                   # 根组件 + 路由配置
│   │   ├── index.css                 # 全局样式
│   │   │
│   │   ├── api.ts                    # HTTP请求封装
│   │   ├── auth.ts                   # 认证API
│   │   ├── authContext.tsx           # 认证上下文
│   │   ├── config.ts                 # 环境配置
│   │   ├── errorToast.ts            # 错误提示
│   │   │
│   │   ├── components/               # 通用组件（12个）
│   │   │   ├── AdminRoute.tsx        # 管理员路由守卫
│   │   │   ├── Navbar.tsx            # 导航栏
│   │   │   ├── NotificationsDropdown.tsx # 通知下拉面板
│   │   │   ├── OAuthButtons.tsx      # OAuth按钮
│   │   │   ├── ProtectedRoute.tsx    # 路由守卫
│   │   │   ├── SiteGlobalAiAssistant.tsx # 全站编辑 AI 助手面板
│   │   │   ├── SiteTemplateEditOverlay.tsx # 全站编辑覆盖层
│   │   │   ├── UserHoverCard.tsx     # 用户卡片
│   │   │   └── WorkshopLayoutCanvas.tsx # 工坊布局画布
│   │   │
│   │   ├── pages/                    # 页面组件（28个）
│   │   │   ├── HomePage.tsx
│   │   │   ├── LoginPage.tsx
│   │   │   ├── RegisterPage.tsx
│   │   │   ├── ResetPasswordPage.tsx
│   │   │   ├── OAuthCallbackPage.tsx
│   │   │   ├── PhoneLoginPage.tsx
│   │   │   ├── NewIdeaTypePage.tsx
│   │   │   ├── NewIdeaPage.tsx
│   │   │   ├── EditIdeaPage.tsx
│   │   │   ├── IdeaDetailPage.tsx
│   │   │   ├── MePage.tsx
│   │   │   ├── UserProfilePage.tsx
│   │   │   ├── CompanyPage.tsx
│   │   │   ├── LeaderboardDetailPage.tsx
│   │   │   ├── TagRankPage.tsx
│   │   │   ├── TagMapPage.tsx
│   │   │   ├── NotificationsPage.tsx
│   │   │   ├── MessagesPage.tsx
│   │   │   ├── MessageRequestsPage.tsx
│   │   │   ├── BlacklistPage.tsx
│   │   │   ├── AdminUsersPage.tsx
│   │   │   ├── FeedbackAdminPage.tsx
│   │   │   ├── DocsAdminPage.tsx
│   │   │   ├── AdminScraperPage.tsx
│   │   │   ├── WorkshopEditorPage.tsx
│   │   │   ├── WorkshopPage.tsx
│   │   │   ├── WorkshopTagMapPage.tsx
│   │   │   └── WorkshopTemplateDetailPage.tsx
│   │   │
│   │   ├── locales/                  # 国际化资源
│   │   │   ├── en.json               # 英文翻译（持续更新）
│   │   │   └── zh.json               # 中文翻译（持续更新）
│   │   │
│   │   └── utils/                    # 工具函数
│   │       ├── humanizeError.ts      # 错误国际化
│   │       ├── safeNext.ts           # URL安全处理
│   │       ├── localIdeas.ts         # 本地存储
│   │       ├── platformConfig.ts     # 外部平台配置
│   │       ├── siteDraft.ts          # 全站模板草稿类型与安全归一化
│   │       ├── workshopLayout.ts     # 工坊默认布局与克隆工具
│   │       ├── workshopTheme.ts      # 工坊主题与 siteDraft 渲染应用
│   │       └── workshopVersion.ts    # 工坊版本兼容工具
│   │
│   ├── package.json                  # 依赖管理
│   ├── vite.config.ts               # Vite配置
│   └── tailwind.config.js           # Tailwind配置
│
└── server/                           # 后端应用与文档中心
  ├── .env.example                  # 服务端环境变量示例（阿里云香港 / API 子域）
  ├── .ai-instructions.md           # AI开发指南（权威版本）
  ├── .ai-file-header-templates.md  # 文件头模板（权威版本）
  ├── ALIYUN_HK_DEPLOYMENT_RUNBOOK.md # 阿里云香港双仓库部署手册
  ├── AI-WORKFLOW-SYSTEM.md         # AI工作流总说明
  ├── PROJECT_STRUCTURE.md          # 本文档
  ├── README.md                     # 服务端/文档入口说明
  ├── deploy.sh                     # 服务端仓库独立部署脚本
    ├── src/
    │   ├── index.js                  # 服务器入口
    │   ├── app.js                    # Express配置
    │   │
    │   ├── config/                   # 配置
    │   │   ├── db.js                 # MongoDB连接
    │   │   ├── passport.js           # 认证策略
    │   │   ├── cloudinary.js         # Cloudinary配置与启动校验
    │   │   ├── workshopLayout.js     # 默认工坊布局配置
    │   │   └── workshopVersion.js    # 工坊模板版本常量
    │   │
    │   ├── models/                   # 数据模型（25个）
    │   │   ├── User.js
    │   │   ├── Idea.js
    │   │   ├── IdeaRecommendationFeedback.js
    │   │   ├── Comment.js
    │   │   ├── Like.js
    │   │   ├── Bookmark.js
    │   │   ├── Notification.js
    │   │   ├── Interest.js
    │   │   ├── OtpToken.js
    │   │   ├── AiJob.js
    │   │   ├── ScraperJob.js
    │   │   ├── WorkshopTemplate.js
    │   │   ├── WorkshopTemplateBookmark.js
    │   │   ├── WorkshopTemplateComment.js
    │   │   └── WorkshopTemplateLike.js
    │   │
    │   ├── controllers/              # 控制器（16个）
    │   ├── routes/                   # 路由（16个）
    │   ├── middleware/               # 中间件（5个）
    │   ├── schemas/                  # 验证模式（2个）
    │   ├── services/                 # 业务服务（5个）
    │   ├── workers/                  # 后台任务（2个）
    │   └── utils/                    # 工具（6个）
    │
    ├── scripts/                      # 文档/维护脚本
    │   ├── add-file-headers.js
    │   ├── cleanupEmptyLeaderboards.js
    │   ├── copyProjectDocs.js
    │   ├── migrateCommentParentId.js
    │   ├── seedAdmin.js
    │   └── validate-project.js
    │
    └── package.json                  # 依赖管理
```

---

## 核心文件详解

### 🧠 0. OpenClaw 工作区记忆层

#### `AGENTS.md`
**功能**: OpenClaw 工作区总规则与自动启动流程  
**职责**:
- 规定每次会话启动时要先读取身份、用户与记忆文件
- 要求每个新任务自动读取 `CLAUDE.md` 和仓库文档，而不是等待用户粘贴开工模板
- 规定非平凡任务完成后写入每日记忆文件

---

#### `CLAUDE.md`
**功能**: IdeaHub 仓库级 OpenClaw 入口  
**职责**:
- 桥接到 `server/.ai-instructions.md`、`server/PROJECT_STRUCTURE.md` 和 `server/AI-WORKFLOW-SYSTEM.md`
- 规定自动任务开始流程、文档同步规则和长期记忆规则
- 让仓库任务具备“AI 员工”式的持续上下文

---

#### `BOOT.md`
**功能**: OpenClaw 启动强制引导文件  
**职责**:
- 配合 `boot-md` hook 在 gateway 启动时注入默认工作契约
- 强制 agent 先确认 workspace、读取记忆与仓库规则文件
- 规定每个任务默认先做影响范围分析，再进入改动执行

---

#### `MAINTENANCE.md`
**功能**: OpenClaw 长时自维护模式单一来源规则  
**职责**:
- 定义全仓巡检/修复时的执行优先级、批次策略与停止条件
- 约束长时 unattended 维护时的 token 控制、验证粒度与编辑纪律
- 作为 `AGENTS.md` 与 `CLAUDE.md` 在“Autonomous Maintenance Mode”下的唯一规则源

---

#### `MEMORY.md`
**功能**: OpenClaw 长期项目记忆
**职责**: 

---

## 部署与运维状态（2026-04-07）

简短记录当前线上部署与运维相关的关键信息与进展，供日常维护与对外支持使用。

- **ECS / 服务**:
  - 公网 IP: 39.106.7.215
  
**部署/验收（2026-04-07）**

- 前端部署位置: `/var/www/ideahub/client-dist`，由 `nginx` 提供静态服务。
- 快速验收命令（在本地或服务器上运行）:
  - `curl -I https://ideahubs.org`
  - `curl -I --resolve ideahubs.org:443:39.106.7.215 https://ideahubs.org`
- 若遇到 Cloudflare 返回 `525`（TLS handshake failed）：
  1. 在服务器上收集 nginx 错误日志（`/var/log/nginx/error.log` 或相应 site log）并摘取包含 `bad key share` 的片段。
  2. 使用 `tcpdump` 抓包并生成 pcap（示例: `sudo tcpdump -i any -w /tmp/cf_tls.pcap host 39.106.7.215 and port 443`）。
  3. 准备 Cloudflare 支持包（CF‑RAY、pcap、nginx error log、openssl s_client 输出）并联系 Cloudflare 支持。

  - 部署用户: `deploy`
  - 部署脚本: `/var/www/ideahub/server/deploy.sh`
  - 后端（pm2）: 进程名 `ideahub-server`，监听 `127.0.0.1:4000`
  - 前端构建输出: `/var/www/ideahub/client-dist`

- **nginx / TLS / Cloudflare**:
  - nginx 配置位置示例: `/etc/nginx/sites-available/api.ideahubs.org`
  - Cloudflare Origin CA 证书: `/etc/ssl/certs/cloudflare-origin.pem`
  - 私钥: `/etc/ssl/private/cloudflare-origin.key`
  - 当前问题: Cloudflare 代理到 origin 时出现 HTTP 525（TLS handshake failed），nginx error log 中有多条 `SSL_do_handshake() failed ... bad key share`。通过直连（`curl --resolve api.ideahubs.org:443:39.106.7.215`）可以正常返回 200，说明 origin 可用但存在 Cloudflare edge → origin TLS 互操作问题。
  - 已尝试项：去重重复 server block、添加 `ssl_ecdh_curve X25519:secp384r1:secp256r1`、抓包（tcpdump pcap）、openssl s_client 测试、临时切换灰云（DNS-only）验证直连。

- **SSH / Deploy keys / Actions secrets**:
  - 生产用主私钥指纹（deploy 私钥 `/home/deploy/.ssh/id_ed25519`）: `SHA256:lcOMYf69NFJs1+CbaEiZh4NNbo3efdQXRz96eAm32rc`。
  - 从私钥派生的公钥已写到 `/tmp/pub_from_priv.pub`（内容可直接用于 GitHub Deploy key）。
  - `/home/deploy/.ssh/authorized_keys` 已备份为 `/home/deploy/.ssh/authorized_keys.bak` 并去重；当前只含两把公钥条目。
  - 因 GitHub 不允许同一 deploy key 同时作为两个仓库的 deploy key 使用，已为 `ideahub-client` 生成一把新的 keypair: `/home/deploy/.ssh/id_ed25519_client`（私钥）和 `/home/deploy/.ssh/id_ed25519_client.pub`（公钥），并将公钥追加到 `authorized_keys`。建议把新公钥作为 `ideahub-client` 的 Deploy key（只读），并把对应私钥上传为该仓库 Actions secret（示例名 `DEPLOY_SSH_KEY` 或 `DEPLOY_SSH_KEY_CLIENT`）。
  - GitHub Actions 的 secret 值不可被读取；确保 CI 能 SSH 的办法是把 `/home/deploy/.ssh/id_ed25519` 的私钥内容作为 `DEPLOY_SSH_KEY` secret 上传到需要的仓库（`ideahub-server`），并把 `/home/deploy/.ssh/id_ed25519_client` 的私钥上传到 `ideahub-client` 的 secret（若你选择分离密钥）。

- **CI / 工作流**:
  - 已在仓库侧准备 `.github/workflows/deploy.yml`（本地），需要 commit & push。workflow 示例使用 `secrets.DEPLOY_SSH_KEY` 将私钥写入 `~/.ssh/id_ed25519` 并通过 SSH 登录 `deploy@39.106.7.215` 执行 `server/deploy.sh`。

- **日志与证据归档位置（服务器）**:
  - nginx 错误日志示例: `/var/log/nginx/api.ideahubs.error.log`（包含 `bad key share` 条目）
  - tcpdump 捕获文件: `/tmp/cf_after_fix.pcap`, `/tmp/cf_after_curve_fix.pcap`
  - openssl / curl 测试命令输出已保存于运维会话记录（memory/ 与 maintenance-logs/ 中的对应文件）。

- **下一步建议（优先级）**:
  1. 若需恢复 Cloudflare 代理（orange cloud），准备支持包（CF‑RAY、nginx error log、pcap、openssl 输出）并联系 Cloudflare 支持或请求他们检查受影响 POP。  
  2. 在仓库中 commit 并 push `deploy.yml`，并把对应私钥上传到 `DEPLOY_SSH_KEY` secret，然后触发一次 Actions 验证自动部署链路。  
  3. 中长期：计划升级 origin 的 OpenSSL/nginx 至更高版本以改善 TLS1.3 互操作性，或考虑通过 Cloudflare Workers/Load Balancer 做受控回退。 

> 记录人: 运维/开发联调会话（自动摘要）

**证书部署已记录**：若你已将 Cloudflare Origin Certificate 与私钥部署到服务器，请确保文件位置与权限如下并记录到运维文档：

- `/etc/ssl/certs/cloudflare-origin.pem`  (证书，建议 `644`)
- `/etc/ssl/private/cloudflare-origin.key` (私钥，必须 `600`，root:root)

在 Cloudflare 仪表盘生成私钥后请立即保存并仅保留服务器上那一份私钥副本；若私钥遗失或泄露，请在 Cloudflare 重新生成并替换。

- 记录稳定的用户偏好、仓库规则和项目框架事实
- 为后续任务提供跨会话延续能力
- 承接从每日记忆文件提炼出的长期知识

---

#### `memory.md`
**功能**: OpenClaw 项目知识库  
**职责**:
- 记录 IdeaHub 的框架结构、接口约定、工作流不变量和常见坑点
- 与 `MEMORY.md` 分层：前者偏项目知识，后者偏长期协作事实
- 配合 `bootstrap-extra-files` hook 在 agent bootstrap 时自动注入

---

#### `memory/YYYY-MM-DD.md`
**功能**: OpenClaw 每日任务日志  
**职责**:
- 记录当天完成的任务、重要决策和后续事项
- 作为短期工作记忆，为新会话提供最近上下文
- 定期沉淀到 `MEMORY.md`

### 🎯 1. 应用入口和配置

#### `client/src/main.tsx`
**功能**: React应用入口，i18n初始化配置  
**组件**: ReactDOM.createRoot, i18next配置  
**关联文件**:
- `App.tsx` - 渲染根组件
- `locales/*.json` - 加载翻译资源
- `index.css` - 导入全局样式

**关键逻辑**:
```typescript
// i18n初始化
i18n.use(initReactI18next).init({
  resources: { en, zh },
  lng: localStorage.getItem('language') || 'zh'
});
```

---

#### `client/src/App.tsx`
**功能**: 根组件，路由配置  
**组件**: BrowserRouter, Routes, Route, AuthContext Provider  
**关联文件**:
- `authContext.tsx` - 提供认证上下文
- `pages/*.tsx` - 所有页面组件
- `components/ProtectedRoute.tsx` - 路由守卫

**路由表** (关键路由):
```
/ → HomePage
/login → LoginPage
/register → RegisterPage
/reset → ResetPasswordPage
/oauth/callback → OAuthCallbackPage
/login/phone → PhoneLoginPage
/ideas/new → NewIdeaTypePage
/ideas/new/:mode → NewIdeaPage (business/feedback/external/daily)
/ideas/:id → IdeaDetailPage
/ideas/:id/edit → EditIdeaPage
/me → MeRedirect
/users/:id → UserProfilePage
/company → CompanyPage
/leaderboard/:id → LeaderboardDetailPage
/tag-rank → TagRankPage
/tag-map → TagMapPage
/notifications → NotificationsPage
/messages → MessagesPage
/message-requests → MessageRequestsPage
/blacklist → BlacklistPage
/admin/users → AdminUsersPage
/feedback → FeedbackAdminPage
/admin/docs → DocsAdminPage
/admin/scraper → AdminScraperPage
/workshop → WorkshopPage
/workshop/new → WorkshopEditorPage（支持 ?fromSiteEdit=1 发布信息模式）
/workshop/tag-map → WorkshopTagMapPage
/workshop/templates/:id → WorkshopTemplateDetailPage
/workshop/templates/:id/edit → WorkshopEditorPage
```

---

### 🔐 2. 认证和状态管理

#### `client/src/authContext.tsx`
**功能**: 全局认证状态管理  
**组件**: Context, Provider, custom hook (useAuth)  
**关联文件**:
- `auth.ts` - 认证API调用
- `api.ts` - HTTP请求封装
- `App.tsx` - Context Provider包裹
- 所有页面 - 通过useAuth()获取用户状态

**导出API**:
```typescript
{
  user: User | null,
  loading: boolean,
  login: (email, password) => Promise<void>,
  loginWithToken: (token) => Promise<void>,
  logout: () => void,
  refreshUser: () => Promise<void>
}
```

---

#### `client/src/api.ts`
**功能**: 统一HTTP请求封装  
**关联文件**:
- `config.ts` - API_BASE_URL配置
- `authContext.tsx` - 自动携带JWT token
- 所有页面/组件 - 通过apiFetch()调用API

**核心函数**:
```typescript
apiFetch<T>(url: string, options?: RequestInit): Promise<T>
// 自动添加Authorization header
// 统一错误处理

apiUploadImage(file: File, scope?: "idea" | "comment" | "leaderboard")
// multipart/form-data 上传内容图片
// 服务端统一大小与格式校验
```

---

#### `client/src/auth.ts`
**功能**: 认证相关API封装  
**关联文件**:
- `api.ts` - 使用apiFetch发送请求
- `authContext.tsx` - 被Context调用

**API列表**:
- `loginApi(email, password)` - 登录
- `fetchCurrentUser()` - 获取当前用户信息

---

### 🧩 3. 通用组件（被多个页面复用）

#### `client/src/components/Navbar.tsx`
**功能**: 全局导航栏，语言切换，通知提示  
**使用页面**: 所有页面（通过App.tsx统一引入）  
**关联文件**:
- `authContext.tsx` - 获取用户状态
- `api.ts` - 获取未读通知数
- `locales/*.json` - nav模块翻译

**功能模块**:
- 导航链接（Home, Tag Rank, Notifications, Company, Admin, Feedback）
- 语言切换器（中文/English）
- 未读通知徽章
- 登录/注册/登出按钮
- 移动端响应式菜单

**国际化**: ✅ 完整支持（nav模块 9个键）

---

#### `client/src/components/OAuthButtons.tsx`
**功能**: OAuth登录按钮（Google/GitHub）  
**使用页面**: `LoginPage.tsx`, `RegisterPage.tsx`  
**关联文件**:
- `config.ts` - API_BASE_URL配置
- `api.ts` - 读取 `/api/auth/capabilities` 后按可用 provider 动态渲染

**功能**:
- 重定向到后端OAuth端点
- 传递next参数（用于回调后跳转）
- 支持按后端能力配置仅显示可用 provider（google/github 子集）

**国际化**: ✅ 完整支持（auth模块）

---

#### `client/src/components/ProtectedRoute.tsx`
**功能**: 路由守卫，保护需要登录的页面  
**使用页面**: `App.tsx`路由配置中使用  
**关联文件**:
- `authContext.tsx` - 获取用户状态
- `locales/*.json` - auth.unauthorized翻译

**逻辑**:
```typescript
if (!user) return <div>请先登录</div>;
if (loading) return <div>Loading...</div>;
return <>{children}</>;
```

---

#### `client/src/components/UserHoverCard.tsx`
**功能**: 用户悬浮卡片，显示用户预览信息  
**使用页面**: `IdeaDetailPage.tsx`, `NotificationsPage.tsx`, `HomePage.tsx`  
**关联文件**:
- `api.ts` - 获取用户信息、关注操作、点赞点踩、黑名单操作
- `locales/*.json` - profile模块翻译

**显示内容**:
- 用户头像和基本信息（用户名、简介）
- 粉丝/关注数
- 信誉徽章（热门用户/恶意用户）
- 点赞/点踩数量
- 关注/取消关注按钮
- 私信按钮（支持黑名单状态检测）
- 黑名单切换按钮
- 点赞/点踩按钮

**技术实现**:
- **React Portal 渲染**: 使用 `createPortal` 将悬浮卡片渲染到 `document.body`，避免被父容器遮挡
- **智能定位**: 基于触发元素位置动态计算坐标，支持边界检测防止超出视口
- **高 z-index**: z-[99999] 确保始终在最上层显示
- **延迟加载**: 鼠标悬停 500ms 后才加载用户数据，减少不必要的请求

**国际化**: ✅ 完整支持（profile模块）

---

#### `client/src/components/NotificationsDropdown.tsx`
**功能**: 通知下拉菜单，显示各类通知的计数和菜单项  
**使用页面**: `Navbar.tsx`（导航栏中集成）  
**关联文件**:
- `api.ts` - 获取未读通知按类型统计
- `authContext.tsx` - 用户认证状态
- `React Router` - 菜单项导航

**菜单项** (7个):
1. My Messages → /message-requests
2. System Messages → /notifications?tab=system
3. @Mentions → /notifications?tab=mentions
4. **⭐ Likes/Downvotes Overview → /notifications?tab=reactions** [新增]
5. Likes Received → /notifications?tab=likes
6. Downvotes Received → /notifications?tab=dislikes
7. **⭐ Replies → /notifications?tab=replies**

**功能**:
- **动态计数显示**
  - 按类型统计未读通知数
  - System：顶级评论 + 收藏 + 公司兴趣（不包含回复）
  - Replies：只统计回复评论通知（parentCommentId存在）
  - @Mentions、Likes/Dislikes：按通知类型统计
- **点击导航** - 点击菜单项跳转到对应类别的通知页面
- **加载态提示** - 获取计数时显示加载状态

**关键逻辑** [新增]:
- 通过 `payload?.parentCommentId` 字段区分System和Replies
- System过滤条件：`(n.type === "COMMENT" && !n.payload?.parentCommentId)`
- Replies过滤条件：`(n.type === "COMMENT" && n.payload?.parentCommentId)`

**国际化**: ✅ 完整支持（nav和notifications模块）

---

### 📄 4. 页面组件（按功能分组）

#### 认证页面组（5个）

##### `LoginPage.tsx`
**功能**: 用户登录  
**关联文件**:
- `authContext.tsx` - 调用login()
- `OAuthButtons.tsx` - OAuth登录
- `api.ts` - 获取 `/api/auth/capabilities`
- `locales/*.json` - auth模块

**表单字段**: 邮箱/用户名、密码  
**功能**: 本地登录、按地区能力动态显示OAuth登录、跳转注册/重置密码  
**国际化**: ✅ 完整支持

---

##### `RegisterPage.tsx`
**功能**: 用户注册（邮箱验证码）  
**关联文件**:
- `api.ts` - 发送验证码、注册
- `authContext.tsx` - 注册后自动登录
- `OAuthButtons.tsx` - OAuth注册

**注册流程**:
1. 输入邮箱、用户名、密码、角色
2. 发送验证码
3. 输入验证码
4. 创建账户并自动登录

**补充**:
- 页面会读取 `/api/auth/capabilities`，按地区能力动态显示/隐藏 OAuth 入口
- 保留前端兜底开关（环境变量与 query 参数）

**国际化**: ✅ 完整支持

---

##### `ResetPasswordPage.tsx`
**功能**: 密码重置（邮箱验证码）  
**关联文件**:
- `api.ts` - 发送重置码、验证并重置密码
- `authContext.tsx` - 重置后自动登录

**重置流程**:
1. 输入邮箱
2. 发送重置码
3. 输入验证码和新密码
4. 重置成功并自动登录

**国际化**: ✅ 完整支持

---

##### `OAuthCallbackPage.tsx`
**功能**: OAuth回调处理  
**关联文件**:
- `authContext.tsx` - 使用token登录

**逻辑**:
- 从URL获取token
- 调用loginWithToken()
- 跳转到next参数指定页面

**国际化**: ✅ 完整支持

---

##### `PhoneLoginPage.tsx`
**功能**: 手机登录占位页（未实现）  
**状态**: 🔲 待开发  
**国际化**: ✅ 完整支持

---

#### 创意管理页面组（4个）

##### `HomePage.tsx`
**功能**: 创意列表首页  
**关联文件**:
- `api.ts` - 获取创意列表
- `authContext.tsx` - 获取用户状态
- `utils/platformConfig.ts` - 平台图标获取

**显示内容**:
- 创意卡片列表
- 标题、摘要、作者
- **⭐ 外部来源标签** [v3.3新增]: 
  - 紫色标签显示平台图标 + 平台名
  - 替代普通作者显示（如有externalSource）
- 点赞、评论、收藏数
- 标签、可见性
- AI摘要（如有）

**功能**:
- 浏览所有公开创意
- **默认推荐流** [v4.1新增]: 默认排序从“最新”调整为“推荐”，基于用户最近搜索过的 tags（localStorage 中的 recentSearchTags）进行个性化推荐
- **冷启动兜底** [v4.2新增]: 当用户没有搜索记录时，推荐流优先展示“近期高互动” idea，避免新用户首页质量不稳定
- **已看过降权** [v4.3新增]: 推荐流会读取 `IdeaView` 浏览记录，对近期已看过的 idea 自动降权，减少首页重复曝光
- **推荐反馈机制** [v4.3新增]: 登录用户可在推荐卡片上直接反馈“不感兴趣 / 已推荐过”，当前卡片立即移除，后端写入偏好用于后续降权或过滤
- **推荐反馈可撤销** [v4.4新增]: 反馈提交后会弹出可撤销提示，用户可在短时间内一键撤销误点并恢复卡片展示
- 支持三种排序：推荐 / 最新 / 热门
- **多 tag 搜索增强** [v4.1新增]: 搜索多个 tag 时不再要求 `$all` 完全匹配，只要 idea 与任一 tag 相关即可进入结果集
- 搜索结果按“tag 相关性 + 文本相关性 + idea 热度 + 新鲜度”综合排序
- 搜索框显示显式的多 tag 相关搜索提示，命中的 tag 在结果卡片中高亮显示
- 点击跳转详情页
- 显示AI评审状态

**国际化**: ✅ 完整支持（idea模块）

---

##### `NewIdeaTypePage.tsx`
**功能**: 新建创意类型选择页（分流入口）  
**关联文件**:
- `App.tsx` - 路由入口（`/ideas/new`）
- `NewIdeaPage.tsx` - 按模式跳转到具体表单

**显示内容**:
- 4个创建类型卡片：
  - 商业想法（business）
  - 反馈bug/网站建议（feedback）
  - 引用其它网站（external）
  - 日常想法（daily）

**功能**:
- 用户先选模式再进入创建表单
- 降低单页复杂度，避免冲突勾选

**国际化**: ✅ 完整支持（idea模块）

---

##### `NewIdeaPage.tsx`
**功能**: 按模式创建新创意（v3.5重构）  
**关联文件**:
- `api.ts` - 提交创意与图片上传（`apiUploadImage`）
- `utils/localIdeas.ts` - 本地私密创意存储
- `utils/platformConfig.ts` - 外部平台配置
- `App.tsx` - 模式路由（`/ideas/new/:mode`）
- `NewIdeaTypePage.tsx` - 模式入口页

**模式与字段控制**:
- business（商业想法）:
  - 保留Request AI review
  - 不显示Monetizable / Submit As Feedback / 外链来源开关
- feedback（反馈bug/网站建议）:
  - 隐藏勾选项
  - 隐藏tags输入框
  - 自动固定标签：`反馈bug/网站建议`
- external（引用其它网站）:
  - 显示外链来源信息表单（平台、链接、原作者、自动抓取）
  - 选择“其他/Other”时显示“具体平台名称”输入框（必填）
  - 提交时具体平台名称会写入`externalSource.platform`并自动加入tags（不会使用“其他”标签）
- daily（日常想法）:
  - 轻量普通表单，无额外模式勾选

**功能**:
- 创建服务器创意（公开/未列出）
- 创建本地创意（私密）
- 支持本地图片上传（idea场景），单图大小限制5MB，最多8张
- 上传后支持预览和单张移除，提交时写入`imageUrls`
- **⭐ business/daily/feedback 内容优先AI草稿** [新增]: 用户先输入内容，再一键由AI生成并回填标题/摘要/标签，后续可手动微调（feedback 提交时会与固定反馈标签合并）
- business模式可请求AI评审
- external模式支持URL自动检测和内容自动抓取
- 新建页移除手动 `licenseType` 输入框，提交时默认写入 `default`
- 顶部新增“当前模式徽章 + 一键切换模式”条
- 平台“其他/Other”选项支持中英文显示切换

**国际化**: ✅ 完整支持

---

##### `EditIdeaPage.tsx`
**功能**: 编辑现有创意  
**关联文件**:
- `api.ts` - 获取和更新创意
- `authContext.tsx` - 权限验证（作者或管理员）
- `utils/platformConfig.ts` - 外部平台配置

**功能**:
- 加载现有创意数据（包括externalSource）
- 更新创意信息
- **⭐ 编辑外部来源信息** [v3.3新增]: 保留外部来源表单（与NewIdeaPage相同）
- **⭐ 商业想法编辑页与新建页对齐** [v4.30]: business 模式隐藏 `licenseType`、`isMonetizable`、外部来源开关，避免出现与模式不一致的多余字段
- 权限检查
- 请求AI重新评审

**国际化**: ✅ 完整支持

---

##### `IdeaDetailPage.tsx`
**功能**: 创意详情页，最复杂的页面，包含完整评论嵌套回复系统和多处图片上传  
**关联文件**:
- `api.ts` - 获取创意、点赞、收藏、评论、回复、兴趣表达、图片上传
- `authContext.tsx` - 用户状态
- `UserHoverCard.tsx` - 作者信息卡片
- `utils/localIdeas.ts` - 本地创意操作
- `utils/platformConfig.ts` - 平台图标获取

**显示内容**:
- 创意完整信息
- **⭐ 外部来源信息** [v3.3新增]:
  - 如果有externalSource: {平台图标} {平台名} · [查看原帖](链接) · 原作者: {名称}
  - 如果没有: by {用户名} · 时间
- **⭐ 外部来源链接卡片** [v3.7调整]:
  - 仅当创意包含外部链接（externalSource.url）时显示
  - 显示来源说明与“Open Website”按钮
  - 点击后在新标签页打开原网站
- AI评审结果（可行性、盈利潜力）
- 互动统计（浏览、点赞、评论、收藏）
- 创意图片展示（`idea.imageUrls`）
- **⭐ 评论列表（包含嵌套回复）** [v3.1增强]:
  - 顶级评论显示
  - 回复计数和展开按钮
  - 展开的回复列表（按创建时间排序）
  - 缩进样式及视觉区分
- 作者信息

**功能**:
- 点赞/取消点赞
- 收藏/取消收藏
- 发表评论（成为回复时自动展开回复列表）
- **⭐ 评论/回复图片上传** [v3.6新增]:
  - 评论和回复支持本地图片上传，单图大小限制5MB，最多8张
  - 上传后可预览和移除，提交后在评论区渲染图片
- **⭐ 评论回复系统** [v3.1新增]:
  - 在任何评论上点击"💬 回复"
  - 输入回复内容（缩进显示，视觉区分）
  - 提交回复后自动加载并展开回复列表
  - 支持展开/收起回复（显示回复计数）
  - 刷新后回复保持正确的嵌套结构
  - 系统自动发送"被回复者"通知
- 删除评论/回复（作者或管理员）
- 公司表达兴趣
- 编辑/删除创意（作者或管理员）
- 本地创意操作（移动到服务器、删除）

**国际化**: ✅ 完整支持（idea, comment, aiReview模块）

---

#### 用户相关页面组（3个）

##### `MePage.tsx`
**功能**: 个人中心  
**关联文件**:
- `api.ts` - 获取我的创意、点赞、收藏、收到的兴趣
- `utils/localIdeas.ts` - 加载本地创意

**显示内容**:
- 我的创意（服务器+本地）
- 我的点赞
- 我的收藏（创意+排行榜）
- 收到的公司兴趣
- 公开创意配额提示

**功能**:
- 查看所有个人数据
- 跳转到创意详情
- Scroll到指定部分（管理创意）

**国际化**: ✅ 完整支持（me模块 24个键）

---

##### `UserProfilePage.tsx`
**功能**: 用户公开主页（含搜索和共同关注功能）  
**关联文件**:
- `api.ts` - 获取用户信息、创意、关注/粉丝、搜索用户
- `authContext.tsx` - 判断是否自己

**显示内容**:
- **⭐ 全局用户搜索栏** [新增]
  - 页面顶部搜索栏
  - 支持按用户名搜索所有用户
  - 下拉显示搜索结果（头像、昵称、用户名）
  - 点击结果跳转到用户主页
  - 实时搜索，加载状态提示
- 用户头像、用户名、简介
- 关注/粉丝数
- 用户的公开创意列表
- 关注/粉丝列表（标签页，含搜索栏）

**功能**:
- 关注/取消关注
- **⭐ 全局用户搜索** [新增]
  - 在页面顶部提供全局搜索功能
  - 搜索全平台用户（非限于当前关注列表）
  - 支持快速访问任意用户主页
- **⭐ 关注列表搜索** [已有]
  - 在自己和他人的关注/粉丝列表中添加搜索栏
  - 支持按用户名和昵称搜索
  - 搜索时快速过滤结果
- **⭐ 共同关注标注** [已有]
  - 查看他人关注/粉丝时，标注"共同关注"
  - 共同关注显示在列表前列
  - 仅在查看他人列表时显示
- 编辑个人资料（自己）
- **⭐ 账号注销** [新增]
  - 仅在自己的资料页面显示"Delete Account"按钮
  - 点击后显示确认对话框，警示操作不可撤销
  - 确认删除后：清除token并重定向到登录页
  - 账号和所有相关数据被永久删除

**国际化**: ✅ 完整支持（profile模块 43个键 - v3.0: 39键 → v3.2: 43键）

---

##### `CompanyPage.tsx`
**功能**: 公司账户页面  
**关联文件**:
- `api.ts` - 获取已表达兴趣的创意
- `authContext.tsx` - 角色验证（company）

**权限**: 仅公司账户可访问  
**显示内容**: 已表达兴趣的创意列表  
**国际化**: ✅ 完整支持（company模块 4个键）

---

#### 排行榜和通知页面组（4个）

##### `TagRankPage.tsx`
**功能**: 标签排行榜发现页  
**关联文件**:
- `api.ts` - 搜索标签、获取排行榜

**功能**:
- 搜索标签
- 显示标签建议
- 创建新排行榜
- 浏览现有排行榜（热门/最新）

**国际化**: ✅ 完整支持（tagRank模块 15个键）

---

##### `TagMapPage.tsx`
**功能**: 标签地图可视化页面（聚类 + 散点 + 下钻）  
**关联文件**:
- `api.ts` - 获取 ideas 数据并驱动地图渲染
- `App.tsx` - 路由入口（`/tag-map`）

**功能**:
- 按时间窗口（7/30/90/180/365 天）过滤创意
- 顶层按标签聚类展示，支持点击 cluster 下钻
- 面包屑回退查看上层聚类
- 点击 idea 小点跳转详情页
- 桌面端：鼠标 hover 小点弹出 tooltip（显示标题 + tags）
- 移动端：长按小点弹出 tooltip，抑制长按后的误触跳转

**国际化**: ✅ 完整支持（tagMap模块）

---

##### `LeaderboardDetailPage.tsx`
**功能**: 排行榜详情页  
**关联文件**:
- `api.ts` - 获取排行榜、提名创意、投票、删除提名、图片上传
- `authContext.tsx` - 用户状态

**功能**:
- 显示排行榜信息
- 提名新创意
- 提名时支持本地图片上传（leaderboard场景），单图大小限制5MB，最多8张
- 提名列表渲染图片（`imageUrls`）
- 创意排序（最新/多数投票/点赞/收藏）
- 删除提名（自己的或管理员）
- 收藏排行榜

**国际化**: ✅ 完整支持（leaderboard模块 21个键）

---

##### `NotificationsPage.tsx`
**功能**: 统一通知中心（包含系统/回复/提及/点赞/私信/请求各类通知）  
**关联文件**:
- `api.ts` - 获取通知、标记已读、私信对话、请求、删除对话
- `UserHoverCard.tsx` - 显示相关用户
- `BlacklistPage.tsx` - 黑名单管理链接

**通知类型** (共6类):
- 系统通知（收藏、公司兴趣、顶级评论）
- **⭐ 回复通知** [新增] - 有人回复你的评论
- @提及通知
- 点赞通知
- 私信
- 私信请求

**功能**:
- **All选项卡**: 显示所有通知
  - 标记单个/全部已读
  - 跳转到相关创意或对话
- **System选项卡**: 系统事件通知
  - 收藏、公司兴趣、顶级评论
  - 排除回复评论（单独在Replies选项卡）
- **@Mentions选项卡**: @提及通知
- **⭐ Replies选项卡** [新增]: 评论回复通知
  - 显示有人回复你的评论的通知
  - 标记已读后语气提示消失
  - 点击跳转到对应创意的回复位置
- **⭐ Likes/Downvotes Overview选项卡** [新增]: 赞/踩总览
  - 同时展示点赞与点踩通知，便于快速总览互动反馈
- **Likes选项卡**: 点赞通知
- **Dislikes选项卡**: 点踩通知
- **Messages选项卡**: 私信对话列表
  - 显示对话列表（最新消息优先）
  - 删除对话（带可选黑名单操作）
  - 模态框确认：删除&黑名单、删除&取消黑名单、打开对话、取消
  - 成功toast通知
- **Requests选项卡**: 待处理私信请求
  - 待处理/已处理分类
  - 初始消息隐藏直到接受

**国际化**: ✅ 完整支持（notifications + messages模块）

---

#### 私信系统页面组（2个）

##### `MessagesPage.tsx`
**功能**: 私信对话列表和聊天界面  
**关联文件**:
- `api.ts` - 获取对话、消息、发送消息
- `UserHoverCard.tsx` - 用户信息卡片

**功能**:
- 左侧栏显示对话列表（最新消息优先）
- 主区域显示选中对话的消息
- 实时消息加载（5秒刷新）
- 发送消息功能
- 用户头像、昵称显示
- 消息时间戳
- 自动滚动到最新消息

**国际化**: ✅ 完整支持（messages模块 34个键）

**实现**:
- 双面板布局（Sidebar + Chat）
- 消息按发送者颜色区分
- 支持未读消息计数

---

##### `MessageRequestsPage.tsx`
**功能**: 私信请求管理页面（已关联到 NotificationsPage 的 Requests 选项卡）  
**关联文件**:
- `api.ts` - 获取/查看/接受/拒绝请求
- `UserHoverCard.tsx` - 用户信息卡片

**功能**:
- 分类显示（待处理/已处理）
- 查看按钮（显示隐藏的初始消息）
- 接受/拒绝按钮
- 请求时间显示
- 用户信息显示（头像、昵称、@用户名）
- 消息内容预览
- 自动刷新（5秒）

**国际化**: ✅ 完整支持（messages模块）

**实现**:
- 初始消息在接受前为隐藏状态
- 状态徽章（待处理/已接受/已拒绝）
- 已处理请求折叠显示

---

##### `BlacklistPage.tsx` ⭐ **新增**
**功能**: 黑名单管理专用页面  
**关联文件**:
- `api.ts` - 获取/解除黑名单
- `UserHoverCard.tsx` - 用户卡片

**功能**:
- 列表显示所有被黑名单的用户
- 每个用户卡片包含：头像、昵称、@用户名、黑名单时间
- 解除黑名单按钮（带加载状态）
- 空状态提示（无黑名单用户）
- 自动刷新功能
- 操作后实时更新列表

**国际化**: ✅ 完整支持（messages模块 3个新键）
  - `blacklistManage` - 黑名单管理
  - `blacklistEmpty` - 您的黑名单为空
  - `unblockedUser` - 已将用户从黑名单移除

**入口点**:
- Navbar 用户悬浮卡片菜单（自己资料时显示）
- UserProfilePage 自己资料的黑名单管理链接
- NotificationsPage 模态框中的黑名单入口

---

#### 管理后台页面组（2个）

##### `AdminUsersPage.tsx`
**功能**: 内容管理后台  
**关联文件**:
- `api.ts` - 获取/删除用户、创意、排行榜
- `authContext.tsx` - 管理员权限验证

**权限**: 仅管理员可访问  
**标签页**: 用户、创意、排行榜  
**功能**:
- 搜索（用户名/邮箱/标题/标签）
- 删除（确认对话框）
- 分页

**国际化**: ✅ 完整支持（admin模块）

---

##### `FeedbackAdminPage.tsx`
**功能**: 反馈管理后台  
**关联文件**:
- `api.ts` - 获取反馈、更新状态

**权限**: 仅管理员可访问  
**功能**:
- 按类型筛选（Bug/建议）
- 按状态筛选（待处理/审核中/已采纳/已解决/已拒绝）
- 更新反馈状态
- 查看AI摘要
- 分页

**国际化**: ✅ 完整支持（admin模块）

---

### 🌍 5. 国际化资源

#### `client/src/locales/en.json`
**功能**: 英文翻译资源  
**使用**: 所有页面和组件  
**模块数**: 13个  
**翻译键**: 540个（v3.6）

**模块结构**:
```json
{
  "common": {...},        // 16键 - 通用词汇
  "nav": {...},           // 9键 - 导航
  "auth": {...},          // 76键 - 认证
  "idea": {...},          // 创意（含外链来源与图片上传相关文案）
  "comment": {...},       // 评论
  "aiReview": {...},      // 5键 - AI评审
  "admin": {...},         // 50键 - 管理
  "leaderboard": {...},   // 21键 - 排行榜
  "tagRank": {...},       // 15键 - 标签排行
  "notifications": {...}, // 19键 - 通知
  "profile": {...},       // 43键 - 用户资料
  "me": {...},            // 24键 - 个人中心
  "messages": {...},      // 34键 - 私信系统
  "company": {...}        // 4键 - 公司
}
```

**v3.1新增键** (2个):
- `comment.reply` - 回复按钮文本
- `comment.replyPlaceholder` - 回复输入框占位符
- `notifications.tabReplies` - "Replies"标签页
- `notifications.reply` - 回复通知文本

**v3.2新增键** (4个):
- `profile.deleteAccount` - 删除账号按钮文本
- `profile.deleteAccountConfirm` - 确认删除对话框标题
- `profile.deleteAccountWarning` - 删除警示文本
- `profile.deleteAccountButton` - 删除确认按钮文本
- `profile.accountDeleted` - 删除成功提示

**v3.3新增键** (10个):
- `idea.fromExternalSource` - "From External Source"复选框
- `idea.selectPlatform` - "Select Platform"下拉框
- `idea.platformUrl` - "External URL"输入框
- `idea.platformDetected` - "Detected: {name}"检测提示
- `idea.autoFetch` - "Auto Fetch"按钮
- `idea.autoFetchSuccess` - "Content fetched"成功提示
- `idea.autoFetchFailed` - "Failed to fetch"失败提示
- `idea.originalAuthor` - "Original Author"输入框
- `idea.viewOriginal` - "View Original"链接
- `idea.externalAuthor` - "Author:"标签

---

#### `client/src/locales/zh.json`
**功能**: 中文翻译资源  
**结构**: 与en.json完全对应  
**翻译键**: 540个（v3.6）

---

### 🛠️ 6. 工具函数

#### `client/src/utils/humanizeError.ts`
**功能**: 错误信息国际化和人性化  
**使用**: 所有页面的错误处理  
**关联文件**:
- `locales/*.json` - 错误码映射

**错误码处理**:
- `INVALID_CREDENTIALS` → "用户名或密码错误"
- `OTP_RESEND_COOLDOWN` → "请等待 X 秒后再重新发送"
- `UNAUTHORIZED` → "请先登录"
- `FORBIDDEN` → "您没有权限执行此操作"

---

#### `client/src/utils/safeNext.ts`
**功能**: 安全的URL重定向处理  
**使用**: 登录、注册、OAuth回调页面  
**逻辑**: 防止开放重定向漏洞，只允许相对路径

---

#### `client/src/utils/localIdeas.ts`
**功能**: 本地创意存储（IndexedDB）  
**使用**: `NewIdeaPage.tsx`, `IdeaDetailPage.tsx`, `MePage.tsx`  
**API**:
- `saveLocalIdea(idea)` - 保存本地创意
- `listLocalIdeas()` - 列出所有本地创意
- `deleteLocalIdea(id)` - 删除本地创意

---

#### `client/src/utils/platformConfig.ts`
**功能**: 外部平台配置和图标管理  
**使用**: `NewIdeaPage.tsx`, `EditIdeaPage.tsx`, `IdeaDetailPage.tsx`, `HomePage.tsx`  
**平台数**: 12个预设平台

**预设平台**:
```typescript
[
  { name: "Tieba", icon: "🏮", urlPattern: "tieba.baidu.com" },
  { name: "Zhihu", icon: "📘", urlPattern: "zhihu.com" },
  { name: "Xiaohongshu", icon: "📕", urlPattern: "xiaohongshu.com" },
  { name: "Weibo", icon: "🐦", urlPattern: "weibo.com" },
  { name: "Facebook", icon: "👥", urlPattern: "facebook.com" },
  { name: "Twitter", icon: "🐤", urlPattern: "twitter.com|x.com" },
  { name: "Reddit", icon: "🤖", urlPattern: "reddit.com" },
  { name: "Instagram", icon: "📷", urlPattern: "instagram.com" },
  { name: "YouTube", icon: "📹", urlPattern: "youtube.com" },
  { name: "TikTok", icon: "🎵", urlPattern: "tiktok.com|douyin.com" },
  { name: "LinkedIn", icon: "💼", urlPattern: "linkedin.com" },
  { name: "Other", icon: "🌐", urlPattern: "" }
]
```

**API**:
- `detectPlatformFromUrl(url)` - URL自动检测平台（正则匹配）
- `getPlatformIcon(platformName)` - 获取平台emoji图标
- `getPlatformByName(name)` - 按名称获取平台配置

**应用场景**:
1. NewIdeaPage/EditIdeaPage: 平台下拉选择器数据源
2. URL输入时自动检测平台并更新选择器
3. 详情页/列表页显示平台图标

---

### 🔧 7. 后端核心文件

#### `server/src/app.js`
**功能**: Express应用配置  
**中间件链**:
```
CORS → Body Parser → Session → Passport → 路由 → 错误处理
```

---

#### `server/src/models/`
**19个数据模型**（核心如下）:
- `User.js` - 用户（邮箱、用户名、角色、密码哈希）
- `Idea.js` - 创意（标题、内容、可见性、标签、AI评审、外部来源、链接备注、imageUrls）
- `Comment.js` - 评论（支持回复、imageUrls）
- `Like.js` - 点赞
- `Bookmark.js` - 收藏
- `Notification.js` - 通知
- `Interest.js` - 公司兴趣表达
- `OtpToken.js` - 邮箱验证码
- `AiJob.js` - AI评审任务队列

---

#### `server/src/controllers/`
**16个控制器**（核心如下）:
- `auth.controller.js` - 登录、注册
- `authOtp.controller.js` - 邮箱验证码
- `ideas.controller.js` - 创意CRUD
- `ideaInteractions.controller.js` - 点赞、评论、收藏（含评论图片）
- `interest.controller.js` - 公司兴趣
- `notifications.controller.js` - 通知
- `messages.controller.js` - 私信与请求处理
- `aiReview.controller.js` - AI评审
- `aiJobs.controller.js` - AI任务查询
- `admin.controller.js` - 管理后台
- `scraper.controller.js` - 外部内容抓取
- `workshop.controller.js` - 工坊模板、评论、AI 改版与应用

---

#### `server/src/routes/`
**16个路由模块**:
- `health.routes.js` - 健康检查
- `auth.routes.js` - 认证
- `authOtp.routes.js` - OTP验证
- `oauth.routes.js` - OAuth
- `ideas.routes.js` - 创意
- `me.routes.js` - 个人中心
- `company.routes.js` - 公司
- `messages.routes.js` - 私信与会话请求
- `notifications.routes.js` - 通知
- `aiJobs.routes.js` - AI任务
- `admin.routes.js` - 管理
- `tagRank.routes.js` - 标签排行榜
- `scraper.routes.js` - 外部内容抓取
- `uploads.routes.js` - 内容图片上传
- `users.routes.js` - 用户资料与关注关系
- `workshop.routes.js` - 工坊模板市场、编辑与全站 AI 改版

---

#### `server/src/middleware/`
- `auth.js` - 认证中间件（requireAuth, requireRole）
- `error.js` - 错误处理中间件
- `validate.js` - 请求验证中间件
- `upload.js` - 图片上传中间件（内存上传 + Cloudinary转存、格式与大小限制）

---

#### `server/src/services/`
- `email.service.js` - 邮件发送
- `otp.service.js` - OTP生成/验证
- `notification.service.js` - 通知创建
- `aiReview.service.js` - AI评审队列
- `workshopAi.service.js` - 工坊模板与全站编辑 AI 草案生成

---

#### `server/src/controllers/scraper.controller.js`
**功能**: 外部内容抓取与批量导入控制器  
**路由**: `POST /api/scraper/fetch`、`POST /api/scraper/import-cover`、`GET /api/scraper/admin/platforms`、`GET /api/scraper/admin/history`、`POST /api/scraper/admin/crawl`  
**依赖**: axios, cheerio, AppError, Idea, ScraperJob

**核心能力**:
1. **Auto Fetch** (`/api/scraper/fetch`)
   - 支持通用网页 OpenGraph/Twitter/JSON-LD 提取（title/content/author/platform）
   - **BiliBili 视频特殊处理**:
     - 视频信息走官方接口 `/x/web-interface/view`（获取标题、描述、作者、封面等）
     - **标签信息走独立 API** `/x/tag/archive/tags`（因视频接口不返回 tags 字段）
     - 合并视频信息 + 标签信息返回完整数据
   - 返回 `coverImageUrl`（视频平台场景）用于新建页自动预填封面
   - 返回 `tags` 数组（包含视频标签 + 分区名 + 平台名）

2. **封面转存** (`/api/scraper/import-cover`)
  - 下载远程封面图片并转存到 Cloudinary（`ideahub/cover-images`）
  - 解决外链图片（如 B站）防盗链与临时文件系统图片丢失问题

3. **管理员批量导入** (`/api/scraper/admin/crawl`)
   - 平台：当前支持 BiliBili
   - 条件：关键词、最小播放量、抓取页数、扫描上限、创建上限
   - 自动创建 Quote External Website 的 Idea（填充 externalSource）
   - **详细日志**: 记录每个步骤的执行状态（用户角色、参数解析、候选获取、创意创建等）

4. **任务历史** (`/api/scraper/admin/history`)
   - 按时间倒序返回批量导入任务
   - 包含参数快照、执行状态、统计结果、错误信息

**错误处理**:
- URL/平台/参数非法 → 400
- 第三方请求失败 → 回退策略 + 错误信息
- 批量导入异常 → 任务状态写入 `failed` 并记录 errorMessage
- **调试支持**: 所有关键步骤输出 `[Admin Crawl]` 前缀日志便于排查

---

#### `server/src/routes/scraper.routes.js`
**功能**: 外部内容抓取与批量导入路由配置  
**端点**:
- `POST /api/scraper/fetch`（需登录）
- `POST /api/scraper/import-cover`（需登录）
- `GET /api/scraper/admin/platforms`（管理员）
- `GET /api/scraper/admin/history`（管理员）
- `POST /api/scraper/admin/crawl`（管理员）
**中间件**: `requireAuth`、`requireRole("admin")`  
**关联文件**: `scraper.controller.js`

---

#### `server/src/routes/workshop.routes.js`
**功能**: Creative Workshop 模板市场、模板编辑与应用路由  
**端点**:
- `GET /api/workshop/templates` - 浏览模板市场
- `GET /api/workshop/templates/mine` - 获取我的模板
- `GET /api/workshop/tag-insights` - 获取热门标签与热力图数据
- `GET /api/workshop/templates/:id` - 获取模板详情
- `GET /api/workshop/templates/:id/comments` - 获取模板评论
- `POST /api/workshop/templates/:id/comments` - 发表评论
- `POST /api/workshop/templates` - 创建模板
- `PUT /api/workshop/templates/:id` - 更新模板
- `POST /api/workshop/templates/:id/like` - 点赞模板
- `POST /api/workshop/templates/:id/bookmark` - 收藏模板
- `POST /api/workshop/templates/:id/apply` - 应用模板
- `POST /api/workshop/ai/edit` - 获取 AI 安全改版草稿
- `POST /api/workshop/ai/site-edit` - 获取全站编辑 AI 操作草案（节点/组件/页面背景）
- `GET /api/workshop/active-template` - 获取当前用户正在使用的模板
**中间件**: `optionalAuth`、`requireAuth`  
**关联文件**: `workshop.controller.js`

---

#### `server/src/models/WorkshopTemplate.js`
**功能**: 工坊模板主模型  
**职责**:
- 存储模板标题、摘要、预览图与 tags
- 存储模板主题配置（颜色、背景、卡片样式、自定义 CSS）
- 存储可拖拽首页布局 JSON（canvas + block items）
- 存储 `siteDraft`（按路由页面分组的节点样式、背景和挂件组件）
- 记录模板统计（浏览、点赞、收藏、评论、应用次数）
- 维护作者更新日志与模板版本兼容信息

---

#### `server/src/models/WorkshopTemplateComment.js`
**功能**: 模板评论模型  
**职责**:
- 记录模板下的评论内容与作者
- 支持模板详情页评论区
- 与模板 `stats.commentCount` 联动

---

#### `server/src/services/workshopAi.service.js`
**功能**: 工坊 AI 改版草稿服务（模板编辑 + 全站编辑）  
**职责**:
- 将模板主题、布局与用户指令组合为 AI 提示
- 对 AI 输出进行白名单解析与清洗
- 返回可预览的安全 draft，而不是直接写库
- 生成全站编辑操作集（`updateNodes`、`createWidgets`、`removeWidgetIds`、`pageBackground`）

---

#### `client/src/pages/WorkshopPage.tsx`
**功能**: Creative Workshop 模板市场页  
**职责**:
- 展示推荐、最新、热门模板列表
- 在搜索框旁展示热门 tags 与最近搜索 tags
- 跳转到 workshop heat map 页面
- 展示“我的模板”和模板市场入口
- “新建模板”入口直接启动全站编辑模式（`/?siteEdit=1`）

---

#### `client/src/pages/WorkshopEditorPage.tsx`
**功能**: 工坊模板编辑器  
**职责**:
- 编辑模板基础信息、tags、主题和分享状态
- 使用 `WorkshopLayoutCanvas` 进行可视化拖拽布局
- 支持 AI 改版草稿预览与应用
- 支持从全站编辑流程接收 `siteDraft` 并与模板一起保存
- 当 `?fromSiteEdit=1` 时提供发布元信息页面（标题/摘要/标签/封面）
- 写入作者更新日志

---

#### `client/src/components/SiteTemplateEditOverlay.tsx`
**功能**: 全站模板编辑覆盖层（挂载于 `App.tsx`）  
**职责**:
- 在任意页面启用节点选中高亮、右键样式编辑
- 支持 `Alt` 拖拽移动与 `Alt+Shift` 调整尺寸
- 维护页面级背景（image/video/gradient）上传与清理
- 管理本地草稿、撤销/重做（按钮 + 快捷键）和退出重置
- 对接全局 AI 助手并将草稿交接到模板发布页

---

#### `client/src/components/SiteGlobalAiAssistant.tsx`
**功能**: 全站编辑 AI 助手独立面板  
**职责**:
- 发送自然语言指令到 `/api/workshop/ai/site-edit`
- 预览 AI 返回的多操作差异摘要
- 用户确认后应用操作，支持一次修改多个节点并创建挂件
- 支持挂件类型：`text`、`button`、`badge`、`image`、`card`、`link-list`、`form`

---

#### `client/src/pages/WorkshopTemplateDetailPage.tsx`
**功能**: 工坊模板详情页  
**职责**:
- 展示模板预览图、主题、布局摘要与兼容状态
- 支持点赞、收藏、应用模板
- 展示作者更新日志与评论区

---

#### `client/src/pages/WorkshopTagMapPage.tsx`
**功能**: 工坊模板热力图页  
**职责**:
- 按 tags 聚合共享模板
- 以热力图/聚类形式展示模板分布
- 支持从标签点位跳转模板详情

---

#### `server/src/workers/`
- `aiReview.worker.js` - AI评审队列消费者（Bull）

---

## 更新记录

| 日期 | 版本 | 更新内容 |
|------|------|---------|
| 2026-02-27 | 1.0 | 初始版本 |
| 2026-02-27 | 1.1 | 添加国际化模块说明 |
| 2026-02-27 | 1.2 | 添加所有页面必备功能章节 |
| 2026-02-27 | 2.0 | **重构精简版**：核心到边缘，文件详解，关联关系 |
| 2026-02-27 | 2.1 | **添加AI开发工作流程**：创建.ai-instructions.md，在关键文件添加规范注释 |
| 2026-02-27 | 2.2 | 修复管理端文档读取：兼容不同部署目录结构 |
| 2026-02-27 | 2.3 | 启动时自动同步 PROJECT_STRUCTURE.md 到 server 根目录 |
| 2026-02-27 | 2.4 | 构建时自动复制文档到 server 根目录，修复登录表单提示 |
| 2026-02-27 | 2.5 | 文档读取支持远程URL，Docs页面支持配置GitHub链接 |
| 2026-02-27 | 2.6 | 设置默认GitHub仓库与文档URL（server仓库） |
| 2026-02-28 | 2.7 | **私信系统**：新增MessagesPage、MessageRequestsPage，3个后端模型(UserReputation/MessageRequest/DirectMessage)，2个控制器(messages/reputation)，1个路由(messages) |
| 2026-02-28 | 2.8 | **黑名单管理系统**：新增BlacklistPage，新增DmRequestBlock后端模型，新增/修改4个后端API (blockDmUser/unblockDmUser/listDmBlacklist/getDmBlockStatus)，修改NotificationsPage支持私信对话删除+可选黑名单，修改UserHoverCard支持黑名单切换，前端新增15个i18n键（messages模块），更新翻译资源从355/353键→370/368键 |
| 2026-03-01 | 2.9 | **关注列表搜索和共同关注功能**：修改UserProfilePage，在关注/粉丝列表添加搜索栏，支持按用户名搜索；查看他人关注/粉丝时标注"共同关注"并显示在列表前列；新增5个i18n键，更新翻译资源从370/368键→375/373键 |
| 2026-03-01 | 3.0 | **全局用户搜索功能**：在UserProfilePage顶部添加全局用户搜索栏，支持按用户名搜索全平台用户；实时显示搜索结果（头像、昵称、用户名），点击跳转到用户主页；新增2个i18n键，更新翻译资源从375/373键→377/375键 |
| 2026-03-05 | 3.1 | **评论回复嵌套系统和通知优化**：修改Comment模型添加parentCommentId和replyCount字段；IdeaDetailPage支持评论回复（展开/收起、自动展开、嵌套显示）；NotificationsPage添加Replies tab分离回复通知；NotificationsDropdown菜单项添加Replies选项，修正System/Replies的计数逻辑；后端API新增POST /ideas/:id/comments支持parentCommentId、GET /ideas/:id/comments/:commentId/replies；验证模式添加parentCommentId字段；新增i18n键（tabReplies、reply），翻译资源保持377/375键 |
| 2026-03-05 | 3.2 | **账号注销功能**：在UserProfilePage添加"Delete Account"按钮（仅自己的资料页显示）；确认对话框警示操作不可撤销；后端新增DELETE /api/users/:id接口，删除用户及关联数据；删除成功后清除token并重定向登录页；新增4个i18n键（deleteAccount、deleteAccountConfirm、deleteAccountWarning、deleteAccountButton、accountDeleted），更新翻译资源从377/375键→381/379键 |
| 2026-03-06 | 3.3 | **外部来源导入功能**：支持从其他平台（贴吧、知乎、Twitter等）导入创意；新增Idea.externalSource字段（platform/url/originalAuthor/sourceCreatedAt）；新增platformConfig.ts工具（12个预设平台+图标+URL自动检测）；NewIdeaPage/EditIdeaPage添加外部来源表单（平台下拉选择、URL自动检测、平台图标）；IdeaDetailPage/HomePage显示外部来源标签并支持跳转原帖；后端新增scraper.controller.js+scraper.routes.js，使用axios+cheerio实现智能内容抓取（OpenGraph/Twitter Cards/多重选择器）；新增POST /api/scraper/fetch API（需登录）；安装axios+cheerio依赖；新增14个i18n键（selectPlatform/platformDetected/autoFetch/autoFetchSuccess等），更新翻译资源从381/379键→391/389键 |
| 2026-03-07 | 3.4 | **外部链接备注窗口（Linked Content Window）**：支持在创意的外部链接中添加位置备注和评价；在IdeaDetailPage添加链接小窗口（iframe嵌入预览+全屏模式）；仅在全屏模式下允许查看和添加位置备注（最小化响应式布局影响）；位置备注使用百分比坐标（x/y 0-100%）；备注自动同步到评论区并附带跳转链接；评论中点击"跳转到备注"自动进入全屏并闪烁高亮标记（1.6秒动画）；后端新增Idea.externalSource.linkNotes数组（externalLinkNoteSchema含x/y/content/user/timestamps）；Comment模型添加externalLinkNote元数据（noteId/x/y）实现双向关联；新增GET/POST /api/ideas/:id/link-notes API（optionalAuth/requireAuth）；ideas.controller.js新增listExternalLinkNotes和addExternalLinkNote函数（自动创建关联评论+通知）；client/src/api.ts添加ExternalLinkNote类型；client/src/pages/IdeaDetailPage.tsx新增完整链接小窗口UI（iframe、标记覆盖层、备注表单、备注列表、全屏状态管理、闪烁动画逻辑）；新增19个i18n键（linkWidgetTitle/linkWidgetSubtitle/linkWidgetFullscreenRequired等），更新翻译资源从391/389键→410/408键 |
| 2026-03-07 | 3.5 | **新建创意流程拆分与模式化表单**：新增`NewIdeaTypePage`作为`/ideas/new`入口，先选择创建类型（business/feedback/external/daily）再进入`/ideas/new/:mode`；`NewIdeaPage`改为按模式控制字段显示与提交逻辑，避免互斥功能冲突（如Request AI review与Submit As Feedback）；feedback模式隐藏tags输入并固定标签为“反馈bug/网站建议”；external模式支持“Other/其他”双语选项，选择后可填写具体平台名，提交时具体平台名写入`externalSource.platform`并自动加入tags（不使用“其他”tag）；新增顶部“当前模式徽章 + 一键切换模式”条；同步更新中英翻译键。 |
| 2026-03-07 | 3.6 | **截图标注与统一图片上传系统**：外链标注升级为“截图+备注”流程（全屏下先捕获屏幕再保存标注），标注数据新增`screenshotUrl`和`panelY`；全屏标注列表精简为“仅右侧半透明面板展示”，支持拖拽并通过`PATCH /api/ideas/:id/link-notes/:noteId/position`持久化位置；标注保存后继续同步到评论区，评论可展示截图。新增统一内容图片上传接口`POST /api/uploads/image`（`uploads.routes.js`），上传中间件重构为头像/内容双通道并统一5MB限制（`middleware/upload.js`）。`Idea/Comment/LeaderboardPost`新增`imageUrls`字段，创意创建/编辑、评论/回复、排行榜提名均支持图片上传与渲染；`api.ts`新增`apiUploadImage`封装；`IdeaDetailPage/NewIdeaPage/LeaderboardDetailPage`补齐前端上传交互与预览；中英文翻译资源新增截图标注文案，键总数更新到540/540。 |
| 2026-03-08 | 3.7 | **下线 annotation 功能并清理后端**：`IdeaDetailPage`移除截图标注/跳转备注 UI，外链区域简化为来源卡片 + Open Website。后端删除 `GET/POST /api/ideas/:id/link-notes` 与 `PATCH /api/ideas/:id/link-notes/:noteId/position` 路由；`ideas.controller.js` 移除 link-note 相关控制器与输入校验；`Idea.externalSource` 删除 `linkNotes` 子结构；`Comment` 删除 `externalLinkNote` 字段；`client/src/api.ts` 删除 `ExternalLinkNote` 类型并移除 `apiUploadImage` 的 `annotation` scope。同步更新文档章节描述。 |
| 2026-03-10 | 3.8 | **外部导入与封面能力增强**：新增 `TagMapPage` 与 `AdminScraperPage` 路由（`/tag-map`, `/admin/scraper`）；`scraper.controller.js` 扩展 BiliBili 批量导入、任务历史、封面转存与 Auto Fetch 平台/作者/封面返回；新增 `ScraperJob` 模型记录导入历史；`scraper.routes.js` 新增 `import-cover` 与 admin crawler/history API；`Idea` 新增 `coverImageUrl` 字段并在 `NewIdeaPage` 支持封面上传、Auto Fetch 预填与平台不在列表时自动切换 Other；`HomePage` 卡片支持半透明封面背景显示。 |
| 2026-03-10 | 3.9 | **BiliBili 标签抓取修复与 UI 层级优化**：修复 BiliBili 标签抓取功能，使用独立标签 API (`/x/tag/archive/tags`) 替代不返回标签的视频信息 API，解决标签自动填充失败问题；创建 `test-tags-api.js` 测试脚本验证 API 可用性；UserHoverCard 组件重构为 React Portal 渲染模式（`createPortal`），添加智能边界检测（防止超出视口），提升 z-index 至 99999，彻底解决被其他元素遮挡问题；IdeaDetailPage iframe 安全权限优化，移除 `allow-top-navigation` 防止自动劫持父窗口导航，保留 `allow-top-navigation-by-user-activation` 支持用户点击跳转；为 scraper 和 auth 中间件添加详细调试日志便于排查 412 错误；前端 AdminScraperPage 添加针对性错误提示（412/401/403）。 |
| 2026-03-10 | 4.0 | **Cloudinary 持久化与 TagMap 交互升级**：后端图片链路统一迁移到 Cloudinary（`config/cloudinary.js` + `middleware/upload.js`），`me.routes.js`、`uploads.routes.js`、`ideas.controller.js`、`scraper.controller.js` 的头像/内容图/封面转存改为云端持久化；`index.js` 启动新增 Cloudinary 配置校验；补充 `server/.env.example` 云存储环境变量。`TagMapPage.tsx` 新增 idea 小点 tooltip，支持桌面端 hover 显示 tags、移动端长按显示并防止误触跳转。 |
| 2026-03-15 | 4.1 | **推荐流与多 Tag 搜索排序升级**：`HomePage.tsx` 默认排序新增“推荐（For You）”，基于用户最近搜索 tags 生成个性化 idea 列表，同时保留最新与热门排序。`ideas.controller.js` 的 `GET /api/ideas` 列表逻辑升级为打分排序：当存在搜索词时，多个 tag 改为“任一相关即召回”，并按 tag 相关性、文本相关性、互动热度（点赞/评论/收藏/浏览）和新鲜度综合排序；当排序为推荐时，使用 recentTags 参与个性化推荐打分。同步更新中英文首页文案。 |
| 2026-03-15 | 4.2 | **推荐流冷启动与搜索命中高亮**：`ideas.controller.js` 为推荐流新增冷启动兜底，当用户尚无搜索记录时，优先推送近期高互动 idea；`HomePage.tsx` 搜索框新增多 tag 相关搜索提示，搜索结果中的命中 tag 使用高亮样式突出显示，帮助用户理解“任一相关即可召回”的排序机制。 |
| 2026-03-15 | 4.3 | **推荐流去重与用户反馈**：新增 `IdeaRecommendationFeedback` 模型记录用户对推荐内容的负反馈；`GET /api/ideas` 在推荐模式下接入 `IdeaView` 浏览记录与推荐反馈，对近期已看过 idea 自动降权，对“不感兴趣”内容直接过滤，对“已推荐过”内容显著降权。`HomePage.tsx` 为登录用户新增“不感兴趣 / 已推荐过”反馈按钮，点击后当前推荐卡片立即移除，并通过新接口 `POST /api/ideas/:id/recommendation-feedback` 持久化用户偏好。 |
| 2026-03-15 | 4.4 | **推荐反馈撤销能力**：新增 `DELETE /api/ideas/:id/recommendation-feedback` 用于撤销推荐反馈；`HomePage.tsx` 在用户点击“不感兴趣 / 已推荐过”后显示带“撤销”按钮的交互提示，允许快速纠正误点并恢复当前卡片展示。 |
| 2026-03-19 | 4.5 | **文档与 Workshop 结构同步**：补回仓库根目录 AI 文档入口；修正文档中的实际目录位置与数量；新增 Creative Workshop 页面、布局画布、模板模型、评论、AI 改版、热门标签与 Heat Map 说明。 |
| 2026-03-20 | 4.6 | **全站模板编辑与全局 AI 流程文档同步**：更新结构树（新增 `SiteTemplateEditOverlay`、`SiteGlobalAiAssistant`、`siteDraft`）；补充 `/api/workshop/ai/site-edit` 端点与操作模型；补充 `WorkshopTemplate.siteDraft` 存储说明；更新 `WorkshopPage` 全站编辑入口与 `WorkshopEditorPage` 的 `fromSiteEdit` 发布信息流程。 |
| 2026-03-20 | 4.7 | **OpenClaw 仓库入口接入**：在仓库根目录新增 `CLAUDE.md`，将 OpenClaw/Claude 风格代理统一桥接到 `server/.ai-instructions.md`、`server/PROJECT_STRUCTURE.md` 与 `server/AI-WORKFLOW-SYSTEM.md`，避免规则源分叉。 |
| 2026-03-21 | 4.8 | **OpenClaw AI 员工记忆层接入**：新增 `MEMORY.md` 与 `memory/2026-03-21.md`，强化 `AGENTS.md`、`CLAUDE.md`、`USER.md` 与 `HEARTBEAT.md` 的自动启动、任务记忆与长期知识沉淀规则，让 OpenClaw 默认按仓库文档和记忆体系工作。 |
| 2026-03-21 | 4.9 | **OpenClaw 强化 hook 与知识分层接入**：新增 `BOOT.md` 与 `memory.md`，将记忆拆分为长期协作事实、项目知识库与每日任务日志；启用 `boot-md`、`bootstrap-extra-files`、`session-memory`、`command-logger` hook，使 OpenClaw 启动时更强制地读取规则与记忆，并在会话重置时自动沉淀上下文。 |
| 2026-03-21 | 4.10 | **OpenClaw 深度安全加固**：启用 `tools.fs.workspaceOnly`、`tools.deny`、`agents.defaults.sandbox.mode=all`，并将 `gateway.nodes.denyCommands` 扩展到 12 项，形成工具层/沙箱层/网关层三层防线。 |
| 2026-03-21 | 4.11 | **补充 OpenClaw 团队上手教程**：在本文新增“OpenClaw 团队快速上手”章节，提供安装、onboard、复制记忆文件、启用 hooks、同步安全策略、启动与验证命令，便于组员快速接入现有工作流。 |
| 2026-03-21 | 4.12 | **修复无 Docker 启动失败指引**：在上手教程中补充 sandbox 双路径（Docker=all / 无Docker=off），并明确 `Sandbox mode requires Docker` 的处理方式，避免 boot 阶段失败。 |
| 2026-03-21 | 4.13 | **补充 Docker 安装版本要求**：在 OpenClaw 上手教程中明确要求安装 Docker Desktop 最新稳定版 `Windows - AMD64`，并给出 `docker --version` 验证命令。 |
| 2026-03-21 | 4.14 | **补充 Docker 安装细节**：新增 Docker Desktop 官方下载入口，并在安装步骤中明确建议启用 `WSL 2 based engine`，减少新同学安装后二次排障。 |
| 2026-03-21 | 4.15 | **补充 WSL 修复命令**：在 Docker 安装小节新增“WSL 未启用”处理命令（`wsl --install` + 重启），减少安装后卡住问题。 |
| 2026-03-21 | 4.16 | **补充 Dashboard 稳定编辑规约**：新增“单文件串行编辑”规则（单文件、单指令、唯一上下文、临时关闭自动保存/保存格式化、1-2 文件回读确认），降低 OpenClaw 编辑失败与冲突风险。 |
| 2026-03-21 | 4.17 | **OpenClaw 启动降耗优化**：将 bootstrap 默认注入文件收敛为 `MEMORY.md` 与 `memory.md`，`session-memory.messages` 下调至 `4`，并同步 `tools.allow` 去除 `cron`，降低重复读取与上下文占用。 |
| 2026-03-21 | 4.18 | **新增 OpenClaw 自维护模式**：新增仓库根目录 `MAINTENANCE.md` 作为长时 unattended 巡检/修复的单一规则源，并让 `AGENTS.md`/`CLAUDE.md` 只保留入口引用，便于让 OpenClaw 长时间自主维护项目。 |
| 2026-03-21 | 4.19 | **新增一键自维护启动脚本**：新增仓库根目录 `start-openclaw-maintenance.cmd`，可直接创建独立 maintenance 会话并发送启动指令，把输出写入 `memory/maintenance-logs/`，省去手动打开 dashboard 和粘贴首条消息。 |
| 2026-03-22 | 4.20 | **增强一键自维护可用性**：`start-openclaw-maintenance.cmd` 新增“自动打开对应 dashboard 会话”能力，并新增 `open-latest-maintenance-log.cmd` 用于一键查看最新维护结果。 |
| 2026-03-22 | 4.21 | **增强运行可观测性与稳定跳转**：`start-openclaw-maintenance.cmd` 新增运行/完成状态标记（`*.status.txt`、`*.running`、`*.done`）与窗口状态提示，dashboard chat 解析改为独立 `scripts/openclaw/open-dashboard-chat.ps1`，并新增 `check-latest-maintenance-status.cmd`。 |
| 2026-03-22 | 4.22 | **优化维护入口与续跑体验**：`start-openclaw-maintenance.cmd` 取消启动时自动打开默认 dashboard，仅保留结束后 chat 跳转；新增 `continue-latest-maintenance.cmd` 复用最近 session 一键续跑，并在启动脚本结束时给出续跑提示。 |
| 2026-03-22 | 4.23 | **增强续跑容错与文档指引**：`continue-latest-maintenance.cmd` 续跑提示词新增 read offset 越界自愈策略（检测到 `Offset beyond end of file` 时改为新边界重读并继续）；`MAINTENANCE.md` 新增对应 runtime noise 说明与处置步骤。 |
| 2026-03-22 | 4.24 | **增强续跑编辑容错**：`continue-latest-maintenance.cmd` 续跑提示词新增“Found N occurrences”歧义编辑自愈策略（改为重读文件并使用函数名/唯一上下文的小范围编辑）；`MAINTENANCE.md` 新增对应 runtime noise 说明与处置步骤。 |
| 2026-03-22 | 4.25 | **同步首跑容错并新增摘要 helper**：`start-openclaw-maintenance.cmd` 同步 read offset / 歧义 edit 自愈提示，避免首跑与续跑规则分叉；新增 `show-latest-maintenance-summary.cmd`，可直接查看最近维护结果摘要而不打开整段 JSON 日志。 |
| 2026-03-26 | 4.26 | **评论互动增强**：新增评论/回复评论点踩能力（与点赞互斥并展示点踩数）；`IdeaDetailPage` 在回复列表中新增“引用原评论”块，展示被回复评论内容及其点赞/点踩计数，便于直观对比观点反馈。 |
| 2026-03-26 | 4.27 | **点踩评论接入通知中心**：后端新增 `DISLIKE_COMMENT` 通知类型并在评论点踩时触发；通知中心新增“收到的踩”分类（`/notifications?tab=dislikes`），支持单独筛选和下拉菜单未读计数展示。 |
| 2026-03-26 | 4.28 | **通知中心赞/踩总览补充**：`NotificationsPage` 新增“收到的赞/踩总览”分类（`/notifications?tab=reactions`）聚合点赞与点踩通知；同时保留 likes/dislikes 子分类用于精细筛选，`NotificationsDropdown` 同步新增总览入口与未读计数。 |
| 2026-03-29 | 4.29 | **新建想法内容优先AI草稿**：新增 `POST /api/ideas/draft`，支持根据用户输入内容生成标题/摘要/标签草稿；`NewIdeaPage` 在 business/daily 模式新增“一键AI预填”并自动回填可编辑字段；移除新建页手动 `licenseType` 输入，统一提交 `default`。 |
| 2026-03-29 | 4.30 | **商业想法AI评审兜底与编辑页字段对齐**：`requestAiReview` 增加 worker 未启用时的同步执行兜底，避免“请求后无效果”；`EditIdeaPage` 按 `ideaType` 对齐模式表单，business 模式隐藏 `licenseType`、`isMonetizable`、外部来源开关，消除与新建页不一致字段。 |
| 2026-03-29 | 4.31 | **移除新建想法 licenseType 字段**：`NewIdeaPage` 新建请求不再发送 `licenseType`；后端 `createIdeaBody` 移除创建时 `licenseType` 校验字段，`createIdea` 统一按默认值写入，确保所有新建想法流程都不再暴露或依赖该输入。 |
| 2026-03-29 | 4.32 | **隐藏详情页 licenseType 展示**：`IdeaDetailPage` 详情元信息区移除 `licenseType` 标签显示，仅保留可见性展示，前端不再向用户暴露该字段。 |
| 2026-03-29 | 4.33 | **反馈模式接入AI草稿**：`NewIdeaPage` 的 feedback 模式新增 AI 生成标题/摘要/标签能力；生成标签在提交时会与固定反馈标签合并写入，兼顾自动补全与反馈分类稳定性。 |
| 2026-03-29 | 4.34 | **地区化认证能力开关**：后端新增 `GET /api/auth/capabilities`，基于请求国家头（如 `cf-ipcountry` / `x-vercel-ip-country`）返回 OAuth 可用性与 provider 列表；`LoginPage`/`RegisterPage` 按返回结果动态显示 OAuth，并保留前端环境变量与 query 参数兜底开关。 |
| 2026-04-08 | 4.35 | **阿里云香港 V1 部署基线**：明确主站节点为阿里云香港，保留 Cloudinary 与 MongoDB 的第一阶段方案；新增阿里云香港部署手册、前后端环境变量示例，并将 `server/deploy.sh` 收敛为仅部署服务端仓库，为双 GitHub 仓库独立发布做准备。 |

---

## ⚠️ AI开发提示

**每次对项目进行修改时，必须同步更新本文档：**

1. **新增页面/组件** → 更新"项目结构树"和"核心文件详解"
2. **修改路由** → 更新App.tsx的路由表
3. **添加翻译** → 更新国际化资源的模块结构和键数统计
4. **修改文件关联** → 更新对应文件的"关联文件"部分
5. **添加新功能** → 在对应页面的"功能"部分添加说明
6. **重构代码** → 更新相关文件的"关键逻辑"说明

**文档更新格式**:
- 在"更新记录"表格添加新行，注明日期、版本号、更新内容
- 保持文档简洁，避免冗余信息
- 确保所有关联关系准确无误

---

**📌 文档使用建议**:
- 开发前：查看对应文件的功能和关联关系
- 开发中：参考相似页面的实现模式
- 开发后：更新文档相关章节
- 代码审查：验证文档与代码一致性

---

## 项目概述

**IdeaHub** 是一个创意管理平台，支持用户发布、管理创意，包含AI评审、排行榜、反馈管理等功能。

### 核心特性
- ✅ 用户认证系统（邮箱、OAuth）
- ✅ 创意管理（创建、编辑、删除、可见性控制）
- ✅ AI智能评审（可行性分析、盈利潜力评估）
- ✅ 社交互动（点赞、评论、收藏）
- ✅ 标签排行榜系统
- ✅ 通知系统
- ✅ 管理后台（用户/创意/排行榜管理、反馈管理）
- ✅ **完整国际化支持（中英双语）**
- ✅ 公司账户功能（对创意表达兴趣）

---

## 技术栈

### 前端 (Client)
```
核心框架: React 18 + TypeScript
路由: React Router v6
状态管理: React Context API
UI样式: Tailwind CSS
国际化: i18next + react-i18next
HTTP请求: Fetch API (封装在 api.ts)
构建工具: Vite
部署: Vercel
```

### 后端 (Server)
```
运行时: Node.js
框架: Express.js
数据库: MongoDB + Mongoose
认证: Passport.js (Local + OAuth)
任务队列: Bull + Redis
邮件服务: Nodemailer
验证: Joi
```

---

## 项目结构树

```
ideahub/
│
├── client/                          # 前端应用
│   ├── public/                      # 静态资源
│   ├── src/
│   │   ├── main.tsx                 # 应用入口（包含i18n初始化）
│   │   ├── App.tsx                  # 根组件（路由配置）
│   │   ├── index.css                # 全局样式
│   │   │
│   │   ├── api.ts                   # API请求封装（apiFetch函数）
│   │   ├── auth.ts                  # 认证相关API调用
│   │   ├── authContext.tsx          # 认证上下文（用户状态、登录/登出）
│   │   ├── config.ts                # 环境配置（API_BASE_URL）
│   │   ├── errorToast.ts            # 错误提示工具
│   │   │
│   │   ├── assets/                  # 静态资源（图片、图标等）
│   │   │
│   │   ├── components/              # 通用组件
│   │   │   ├── Navbar.tsx           # 导航栏【✅ i18n】
│   │   │   ├── OAuthButtons.tsx     # OAuth登录按钮【✅ i18n】
│   │   │   ├── ProtectedRoute.tsx   # 路由守卫
│   │   │   └── UserHoverCard.tsx    # 用户悬浮卡片【✅ i18n】
│   │   │
│   │   ├── pages/                   # 页面组件（所有页面已完成i18n✅）
│   │   │   ├── HomePage.tsx                    # 首页【✅ i18n】
│   │   │   ├── LoginPage.tsx                   # 登录页【✅ i18n】
│   │   │   ├── RegisterPage.tsx                # 注册页【✅ i18n】
│   │   │   ├── ResetPasswordPage.tsx           # 密码重置页【✅ i18n】
│   │   │   ├── PhoneLoginPage.tsx              # 手机号登录（占位）【✅ i18n】
│   │   │   ├── OAuthCallbackPage.tsx           # OAuth回调页【✅ i18n】
│   │   │   ├── NewIdeaPage.tsx                 # 创建创意【✅ i18n】
│   │   │   ├── IdeaDetailPage.tsx              # 创意详情【✅ i18n】
│   │   │   ├── EditIdeaPage.tsx                # 编辑创意【✅ i18n】
│   │   │   ├── MePage.tsx                      # 个人中心【✅ i18n】
│   │   │   ├── UserProfilePage.tsx             # 用户资料页【✅ i18n】
│   │   │   ├── CompanyPage.tsx                 # 公司页面【✅ i18n】
│   │   │   ├── LeaderboardDetailPage.tsx       # 排行榜详情【✅ i18n】
│   │   │   ├── TagRankPage.tsx                 # 标签排行【✅ i18n】
│   │   │   ├── NotificationsPage.tsx           # 通知页【✅ i18n】
│   │   │   ├── AdminUsersPage.tsx              # 管理后台-内容【✅ i18n】
│   │   │   └── FeedbackAdminPage.tsx           # 管理后台-反馈【✅ i18n】
│   │   │
│   │   ├── locales/                 # 国际化资源【✅ 完整配置】
│   │   │   ├── en.json              # 英文翻译（355行）
│   │   │   └── zh.json              # 中文翻译（353行）
│   │   │
│   │   └── utils/                   # 工具函数
│   │       ├── humanizeError.ts     # 错误信息人性化（包含i18n错误码映射）
│   │       ├── safeNext.ts          # 安全的重定向URL处理
│   │       └── localIdeas.ts        # 本地创意存储（IndexedDB）
│   │
│   ├── eslint.config.js             # ESLint配置
│   ├── tsconfig.json                # TypeScript配置
│   ├── vite.config.ts               # Vite构建配置
│   ├── tailwind.config.js           # Tailwind CSS配置
│   ├── postcss.config.js            # PostCSS配置
│   ├── vercel.json                  # Vercel部署配置
│   └── package.json                 # 依赖管理
│
├── server/                          # 后端应用
│   ├── src/
│   │   ├── index.js                 # 服务器入口
│   │   ├── app.js                   # Express应用配置
│   │   │
│   │   ├── config/                  # 配置文件
│   │   │   ├── db.js                # MongoDB连接配置
│   │   │   └── passport.js          # Passport认证策略
│   │   │
│   │   ├── models/                  # Mongoose数据模型
│   │   │   ├── User.js              # 用户模型（邮箱、用户名、角色）
│   │   │   ├── Idea.js              # 创意模型（标题、内容、可见性、标签、外部来源+链接备注）
│   │   │   ├── Comment.js           # 评论模型（支持回复、外部链接备注关联）
│   │   │   ├── Like.js              # 点赞模型
│   │   │   ├── Bookmark.js          # 收藏模型
│   │   │   ├── Notification.js      # 通知模型
│   │   │   ├── Interest.js          # 兴趣表达模型（公司对创意）
│   │   │   ├── OtpToken.js          # OTP令牌模型（邮箱验证码）
│   │   │   └── AiJob.js             # AI任务模型（评审队列）
│   │   │
│   │   ├── controllers/             # 业务逻辑控制器
│   │   │   ├── auth.controller.js           # 认证控制器（登录、注册）
│   │   │   ├── authOtp.controller.js        # OTP邮箱验证控制器
│   │   │   ├── ideas.controller.js          # 创意CRUD控制器（含外部链接备注）
│   │   │   ├── ideaInteractions.controller.js # 创意互动（点赞、评论、收藏）
│   │   │   ├── interest.controller.js       # 公司兴趣控制器
│   │   │   ├── notifications.controller.js  # 通知控制器
│   │   │   ├── aiReview.controller.js       # AI评审控制器
│   │   │   ├── aiJobs.controller.js         # AI任务查询控制器
│   │   │   └── admin.controller.js          # 管理后台控制器
│   │   │
│   │   ├── routes/                  # 路由定义
│   │   │   ├── health.routes.js     # 健康检查路由
│   │   │   ├── auth.routes.js       # 认证路由
│   │   │   ├── authOtp.routes.js    # OTP验证路由
│   │   │   ├── oauth.routes.js      # OAuth路由
│   │   │   ├── ideas.routes.js      # 创意路由
│   │   │   ├── me.routes.js         # 个人中心路由
│   │   │   ├── company.routes.js    # 公司路由
│   │   │   ├── notifications.routes.js # 通知路由
│   │   │   ├── aiJobs.routes.js     # AI任务路由
│   │   │   └── admin.routes.js      # 管理后台路由
│   │   │
│   │   ├── middleware/              # 中间件
│   │   │   ├── auth.js              # 认证中间件（requireAuth、requireRole）
│   │   │   ├── error.js             # 错误处理中间件
│   │   │   └── validate.js          # 请求验证中间件
│   │   │
│   │   ├── schemas/                 # Joi验证模式
│   │   │   ├── idea.schemas.js      # 创意验证模式
│   │   │   └── comment.schemas.js   # 评论验证模式
│   │   │
│   │   ├── services/                # 业务服务层
│   │   │   ├── email.service.js     # 邮件发送服务
│   │   │   ├── otp.service.js       # OTP生成/验证服务
│   │   │   ├── notification.service.js # 通知创建服务
│   │   │   └── aiReview.service.js  # AI评审服务（队列任务）
│   │   │
│   │   ├── workers/                 # 后台任务处理器
│   │   │   └── aiReview.worker.js   # AI评审队列消费者
│   │   │
│   │   └── utils/                   # 工具函数
│   │       ├── AppError.js          # 自定义错误类
│   │       ├── errorCodes.js        # 错误码定义
│   │       ├── http.js              # HTTP工具
│   │       ├── jwt.js               # JWT工具
│   │       └── permissions.js       # 权限检查工具
│   │
│   ├── scripts/                     # 脚本工具
│   │   └── seedAdmin.js             # 创建管理员账户脚本
│   │
│   └── package.json                 # 依赖管理
│
└── PROJECT_STRUCTURE.md             # 本文档

```

---

## 功能模块清单

### 1. 认证系统 (Authentication)

#### 功能列表
- ✅ 邮箱密码登录
- ✅ 邮箱验证码注册
- ✅ OAuth登录（Google、GitHub）
- ✅ 密码重置（邮箱验证码）
- ✅ JWT令牌认证
- ✅ 角色权限控制（creator、company、admin）
- 🔲 手机号登录（占位功能，待开发）

#### 相关文件
**前端:**
- `client/src/pages/LoginPage.tsx` - 登录页面【✅ i18n】
- `client/src/pages/RegisterPage.tsx` - 注册页面【✅ i18n】
- `client/src/pages/ResetPasswordPage.tsx` - 密码重置【✅ i18n】
- `client/src/pages/OAuthCallbackPage.tsx` - OAuth回调【✅ i18n】
- `client/src/pages/PhoneLoginPage.tsx` - 手机登录占位【✅ i18n】
- `client/src/components/OAuthButtons.tsx` - OAuth按钮组件【✅ i18n】
- `client/src/authContext.tsx` - 认证上下文
- `client/src/auth.ts` - 认证API调用

**后端:**
- `server/src/routes/auth.routes.js`
- `server/src/routes/authOtp.routes.js`
- `server/src/routes/oauth.routes.js`
- `server/src/controllers/auth.controller.js`
- `server/src/controllers/authOtp.controller.js`
- `server/src/config/passport.js`
- `server/src/models/User.js`
- `server/src/models/OtpToken.js`
- `server/src/services/otp.service.js`
- `server/src/services/email.service.js`
- `server/src/middleware/auth.js`

**国际化资源:**
- `client/src/locales/en.json` - auth模块（76个键）
- `client/src/locales/zh.json` - auth模块（76个键）

---

### 2. 创意管理系统 (Idea Management)

#### 功能列表
- ✅ 创建创意（公开/私密/未列出）
- ✅ 编辑创意
- ✅ 删除创意
- ✅ 查看创意详情
- ✅ 创意浏览（首页列表）
- ✅ 标签系统
- ✅ 可见性控制
- ✅ 本地私密创意（IndexedDB存储）
- ✅ 创意统计（浏览、点赞、评论、收藏数）
- ✅ 反馈类型（Bug报告、功能建议）

#### 相关文件
**前端:**
- `client/src/pages/HomePage.tsx` - 创意列表【✅ i18n】
- `client/src/pages/NewIdeaPage.tsx` - 创建创意【✅ i18n】
- `client/src/pages/EditIdeaPage.tsx` - 编辑创意【✅ i18n】
- `client/src/pages/IdeaDetailPage.tsx` - 创意详情【✅ i18n】
- `client/src/utils/localIdeas.ts` - 本地创意工具

**后端:**
- `server/src/routes/ideas.routes.js`
- `server/src/controllers/ideas.controller.js`
- `server/src/controllers/ideaInteractions.controller.js`
- `server/src/models/Idea.js`
- `server/src/models/Comment.js` - 评论模型
- `server/src/schemas/idea.schemas.js`

**国际化资源:**
- `client/src/locales/en.json` - idea模块（76个键，v3.4新增19个linkWidget相关键）
- `client/src/locales/zh.json` - idea模块（76个键，v3.4新增19个linkWidget相关键）

---

### 3. 社交互动系统 (Social Interactions)

#### 功能列表
- ✅ 点赞创意
- ✅ 评论创意
- ✅ 收藏创意
- ✅ 收藏排行榜
- ✅ 我的点赞列表
- ✅ 我的收藏列表
- ✅ 评论删除（作者/管理员）

#### 相关文件
**前端:**
- `client/src/pages/IdeaDetailPage.tsx` - 互动界面【✅ i18n】
- `client/src/pages/MePage.tsx` - 个人互动记录【✅ i18n】

**后端:**
- `server/src/controllers/ideaInteractions.controller.js`
- `server/src/models/Like.js`
- `server/src/models/Comment.js`
- `server/src/models/Bookmark.js`

**国际化资源:**
- `client/src/locales/en.json` - comment模块
- `client/src/locales/zh.json` - comment模块

---

### 4. AI评审系统 (AI Review)

#### 功能列表
- ✅ AI评审队列
- ✅ 可行性评估
- ✅ 盈利潜力分析
- ✅ AI摘要生成
- ✅ 异步任务处理（Bull队列）
- ✅ 任务状态查询

#### 相关文件
**前端:**
- `client/src/pages/IdeaDetailPage.tsx` - AI评审展示【✅ i18n】

**后端:**
- `server/src/services/aiReview.service.js`
- `server/src/workers/aiReview.worker.js`
- `server/src/controllers/aiReview.controller.js`
- `server/src/controllers/aiJobs.controller.js`
- `server/src/routes/aiJobs.routes.js`
- `server/src/models/AiJob.js`

**国际化资源:**
- `client/src/locales/en.json` - aiReview模块（5个键）
- `client/src/locales/zh.json` - aiReview模块（5个键）

---

### 5. 排行榜系统 (Leaderboard)

#### 功能列表
- ✅ 标签排行榜
- ✅ 创意提名
- ✅ 排行榜创建
- ✅ 排行榜详情
- ✅ 热门/最新排序
- ✅ 提名删除
- ✅ 排行榜收藏

#### 相关文件
**前端:**
- `client/src/pages/TagRankPage.tsx` - 标签排行【✅ i18n】
- `client/src/pages/LeaderboardDetailPage.tsx` - 排行榜详情【✅ i18n】

**后端:**
- （排行榜逻辑分散在ideas.routes.js中）

**国际化资源:**
- `client/src/locales/en.json` - leaderboard模块（21个键）
- `client/src/locales/en.json` - tagRank模块（15个键）
- `client/src/locales/zh.json` - leaderboard模块（21个键）
- `client/src/locales/zh.json` - tagRank模块（15个键）

---

### 6. 通知系统 (Notifications)

#### 功能列表
- ✅ 点赞通知
- ✅ 评论通知
- ✅ 收藏通知
- ✅ 公司兴趣通知
- ✅ 通知列表
- ✅ 通知标记已读
- ✅ 未读通知计数

#### 相关文件
**前端:**
- `client/src/pages/NotificationsPage.tsx` - 通知页【✅ i18n】
- `client/src/components/Navbar.tsx` - 未读通知提示【✅ i18n】

**后端:**
- `server/src/routes/notifications.routes.js`
- `server/src/controllers/notifications.controller.js`
- `server/src/services/notification.service.js`
- `server/src/models/Notification.js`

**国际化资源:**
- `client/src/locales/en.json` - notifications模块（17个键）
- `client/src/locales/zh.json` - notifications模块（17个键）

---

### 7. 用户资料系统 (User Profile)

#### 功能列表
- ✅ 用户主页
- ✅ 用户创意列表
- ✅ 用户关注/粉丝
- ✅ 用户简介编辑
- ✅ 头像管理
- ✅ 用户悬浮卡片

#### 相关文件
**前端:**
- `client/src/pages/UserProfilePage.tsx` - 用户主页【✅ i18n】
- `client/src/components/UserHoverCard.tsx` - 悬浮卡片【✅ i18n】

**后端:**
- （用户资料API分散在各控制器中）

**国际化资源:**
- `client/src/locales/en.json` - profile模块（32个键）
- `client/src/locales/zh.json` - profile模块（32个键）

---

### 8. 个人中心 (Me Page)

#### 功能列表
- ✅ 我的创意列表（服务器+本地）
- ✅ 我的点赞列表
- ✅ 我的收藏列表（创意+排行榜）
- ✅ 收到的公司兴趣
- ✅ 公开创意配额显示
- ✅ 升级提示

#### 相关文件
**前端:**
- `client/src/pages/MePage.tsx` - 个人中心【✅ i18n】

**后端:**
- `server/src/routes/me.routes.js`

**国际化资源:**
- `client/src/locales/en.json` - me模块（24个键）
- `client/src/locales/zh.json` - me模块（24个键）

---

### 9. 公司功能 (Company Features)

#### 功能列表
- ✅ 公司账户注册
- ✅ 对创意表达兴趣
- ✅ 兴趣消息发送
- ✅ 已表达兴趣列表
- ✅ 创作者收到兴趣通知

#### 相关文件
**前端:**
- `client/src/pages/CompanyPage.tsx` - 公司页面【✅ i18n】
- `client/src/pages/IdeaDetailPage.tsx` - 兴趣表达按钮【✅ i18n】
- `client/src/pages/MePage.tsx` - 收到的兴趣【✅ i18n】

**后端:**
- `server/src/routes/company.routes.js`
- `server/src/controllers/interest.controller.js`
- `server/src/models/Interest.js`

**国际化资源:**
- `client/src/locales/en.json` - company模块（4个键）
- `client/src/locales/zh.json` - company模块（4个键）

---

### 10. 管理后台 (Admin Panel)

#### 功能列表
- ✅ 用户管理（查看、删除）
- ✅ 创意管理（查看、删除）
- ✅ 排行榜管理（查看、删除）
- ✅ 反馈管理（Bug报告、功能建议）
- ✅ 反馈状态更新（待处理、审核中、已采纳、已解决、已拒绝）
- ✅ 搜索功能
- ✅ 分页功能

#### 相关文件
**前端:**
- `client/src/pages/AdminUsersPage.tsx` - 内容管理【✅ i18n】
- `client/src/pages/FeedbackAdminPage.tsx` - 反馈管理【✅ i18n】
- `client/src/components/Navbar.tsx` - 管理入口【✅ i18n】

**后端:**
- `server/src/routes/admin.routes.js`
- `server/src/controllers/admin.controller.js`
- `server/src/middleware/auth.js` - requireAdmin中间件

**国际化资源:**
- `client/src/locales/en.json` - admin模块（50个键）
- `client/src/locales/zh.json` - admin模块（50个键）

---

### 11. 国际化系统 (i18n)

#### 功能列表
- ✅ 中英双语切换
- ✅ 语言偏好本地存储
- ✅ 所有页面完整覆盖（17个页面）
- ✅ 所有组件完整覆盖（4个组件）
- ✅ 错误信息国际化
- ✅ 日期/时间本地化
- ✅ 插值支持（变量替换）

#### 相关文件
**前端:**
- `client/src/main.tsx` - i18next初始化配置
- `client/src/locales/en.json` - 英文资源（355行，11个模块）
- `client/src/locales/zh.json` - 中文资源（353行，11个模块）
- `client/src/components/Navbar.tsx` - 语言切换器【✅ i18n】
- `client/src/utils/humanizeError.ts` - 错误信息i18n映射

**所有页面均已完成国际化（17/17）:**
1. ✅ LoginPage
2. ✅ RegisterPage
3. ✅ ResetPasswordPage
4. ✅ PhoneLoginPage
5. ✅ OAuthCallbackPage
6. ✅ HomePage
7. ✅ NewIdeaPage
8. ✅ EditIdeaPage
9. ✅ IdeaDetailPage
10. ✅ MePage
11. ✅ UserProfilePage
12. ✅ CompanyPage
13. ✅ LeaderboardDetailPage
14. ✅ TagRankPage
15. ✅ NotificationsPage
16. ✅ AdminUsersPage
17. ✅ FeedbackAdminPage

**所有组件均已完成国际化（4/4）:**
1. ✅ Navbar
2. ✅ OAuthButtons
3. ✅ UserHoverCard
4. ✅ ProtectedRoute

**翻译模块结构:**
```json
{
  "common": {...},        // 通用词汇（16个键）
  "nav": {...},           // 导航（9个键）
  "auth": {...},          // 认证（76个键）
  "idea": {...},          // 创意（57个键）
  "comment": {...},       // 评论（5个键）
  "aiReview": {...},      // AI评审（5个键）
  "admin": {...},         // 管理（50个键）
  "leaderboard": {...},   // 排行榜（21个键）
  "tagRank": {...},       // 标签排行（15个键）
  "notifications": {...}, // 通知（17个键）
  "profile": {...},       // 用户资料（32个键）
  "me": {...},            // 个人中心（24个键）
  "company": {...}        // 公司（4个键）
}
```

---

## 文件职责说明

### 核心配置文件

#### `client/src/main.tsx`
**职责:** 
- React应用入口
- i18next初始化配置
- localStorage语言偏好读取
- ReactDOM挂载

**关键代码:**
```typescript
i18n.use(initReactI18next).init({
  resources: { en: { translation: enTranslations }, zh: { translation: zhTranslations } },
  lng: localStorage.getItem('language') || 'zh',
  fallbackLng: 'zh'
});
```

---

#### `client/src/App.tsx`
**职责:**
- React Router路由配置
- AuthContext Provider包裹
- 页面路由映射

**路由表:**
```
/ → HomePage
/login → LoginPage
/register → RegisterPage
/reset-password → ResetPasswordPage
/ideas/new → NewIdeaPage
/ideas/:id → IdeaDetailPage
/ideas/:id/edit → EditIdeaPage
/me → MePage
/users/:username → UserProfilePage
/company → CompanyPage
/leaderboard/:id → LeaderboardDetailPage
/tag-rank → TagRankPage
/notifications → NotificationsPage
/admin/users → AdminUsersPage
/admin/feedback → FeedbackAdminPage
/oauth/callback → OAuthCallbackPage
/phone-login → PhoneLoginPage
```

---

#### `client/src/authContext.tsx`
**职责:**
- 用户认证状态管理
- 登录/登出功能
- JWT token管理
- 用户信息全局共享

**导出API:**
```typescript
{
  user: User | null,
  loading: boolean,
  login: (email, password) => Promise<void>,
  loginWithToken: (token) => Promise<void>,
  logout: () => void,
  refreshUser: () => Promise<void>
}
```

---

#### `client/src/api.ts`
**职责:**
- 统一HTTP请求封装
- JWT token自动携带
- 错误处理
- API_BASE_URL配置

**核心函数:**
```typescript
apiFetch<T>(url: string, options?: RequestInit): Promise<T>
```

---

### 工具文件

#### `client/src/utils/humanizeError.ts`
**职责:**
- 后端错误码转为用户友好消息
- 支持国际化错误提示
- 特殊错误码处理（OTP冷却、权限等）

**错误码映射示例:**
```typescript
INVALID_CREDENTIALS → "用户名或密码错误"
OTP_RESEND_COOLDOWN → "请等待 {retryAfter} 秒后再重新发送"
UNAUTHORIZED → "请先登录"
```

---

#### `client/src/utils/localIdeas.ts`
**职责:**
- IndexedDB操作封装
- 本地私密创意存储
- 离线创意管理

**API:**
```typescript
saveLocalIdea(idea)
listLocalIdeas()
deleteLocalIdea(id)
```

---

### 后端架构

#### 中间件链
```
请求 → CORS → 
      Body Parser → 
      Session → 
      Passport → 
      路由 → 
      验证中间件 → 
      认证中间件 → 
      控制器 → 
      错误处理中间件 → 
      响应
```

#### 认证流程
```
1. 本地认证: POST /api/auth/login
   → passport.authenticate('local')
   → 生成JWT token
   → 返回token + user

2. OAuth认证: GET /api/oauth/{google|github}
   → 重定向到OAuth提供商
   → 回调 /api/oauth/{provider}/callback
   → 生成JWT token
   → 重定向到前端 /oauth/callback?token=xxx

3. Token验证: requireAuth中间件
   → 从Authorization header提取token
   → jwt.verify(token)
   → 查询用户
   → req.user = user
```

---

## 所有页面必备功能

> ⚠️ **重要提示：** 创建任何新页面时，必须完整实现以下所有功能，确保功能一致性和用户体验统一。

---

### 🌍 1. 国际化支持（必需）

**所有页面和组件都必须支持中英双语。**

#### 实现步骤：

```typescript
// 1. 导入 useTranslation hook
import { useTranslation } from "react-i18next";

// 2. 在组件中声明
export default function YourPage() {
  const { t } = useTranslation();
  
  // 3. 使用 t() 函数替换所有硬编码文本
  return (
    <h1>{t('module.pageTitle')}</h1>
  );
}
```

#### 必须添加翻译资源：

**路径：** `client/src/locales/en.json` 和 `client/src/locales/zh.json`

```json
// en.json
{
  "yourModule": {
    "pageTitle": "Page Title",
    "description": "Description text",
    "buttonLabel": "Button",
    "successMessage": "Success!",
    "errorMessage": "Error occurred"
  }
}

// zh.json
{
  "yourModule": {
    "pageTitle": "页面标题",
    "description": "描述文本",
    "buttonLabel": "按钮",
    "successMessage": "成功！",
    "errorMessage": "发生错误"
  }
}
```

#### 需要翻译的内容清单：

- ✅ 页面标题（h1, h2, h3）
- ✅ 页面描述和说明文字
- ✅ 所有按钮标签
- ✅ 表单字段标签和占位符
- ✅ 提示消息（成功/错误/警告/信息）
- ✅ 空状态提示文字
- ✅ 加载状态文字（"Loading..."）
- ✅ 确认对话框文本
- ✅ 链接文本
- ✅ 工具提示（tooltip）文本

#### 变量插值：

```typescript
// 使用变量
t('module.welcomeMessage', { username: user.name })

// 翻译文件
"welcomeMessage": "Welcome, {{username}}!"  // en
"welcomeMessage": "欢迎，{{username}}！"     // zh
```

---

### 🔐 2. 认证和权限（根据页面需求）

#### 受保护的路由：

如果页面需要登录才能访问，必须使用 `ProtectedRoute` 包裹：

```typescript
// App.tsx
<Route
  path="/protected-page"
  element={
    <ProtectedRoute>
      <YourProtectedPage />
    </ProtectedRoute>
  }
/>
```

#### 角色权限检查：

```typescript
import { useAuth } from "../authContext";

export default function AdminPage() {
  const { user } = useAuth();
  
  // 检查用户角色
  if (user?.role !== "admin") {
    return <div>{t('auth.forbidden')}</div>;
  }
  
  return <div>Admin content</div>;
}
```

#### 未登录时的友好提示：

```typescript
// 使用统一的提示文本
{!user && (
  <div className="text-gray-400">
    {t('auth.unauthorized')}
  </div>
)}
```

---

### 🎨 3. UI样式统一（必需）

#### 必须使用统一的设计系统：

**容器：**
```typescript
<div className="max-w-3xl mx-auto p-4">
  {/* 页面内容 */}
</div>
```

**标题层级：**
```typescript
<h1 className="text-2xl font-bold text-white">{t('module.title')}</h1>
<h2 className="text-xl font-semibold text-white mt-6">{t('module.subtitle')}</h2>
<h3 className="text-lg font-semibold text-white mt-4">{t('module.section')}</h3>
```

**按钮样式：**
```typescript
// 主要按钮
<button className="rounded-xl bg-white text-black px-4 py-2 font-semibold">
  {t('common.save')}
</button>

// 次要按钮
<button className="rounded-xl border border-gray-700 px-4 py-2 text-gray-200 hover:bg-gray-950">
  {t('common.cancel')}
</button>

// 危险操作按钮
<button className="rounded-xl border border-red-800 px-3 py-1.5 text-red-200 hover:bg-red-950">
  {t('common.delete')}
</button>
```

**卡片样式：**
```typescript
<div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
  {/* 卡片内容 */}
</div>
```

**输入框样式：**
```typescript
<input
  className="rounded-xl bg-gray-950/50 border border-gray-800 px-3 py-2"
  placeholder={t('module.placeholder')}
/>
```

---

### 🚨 4. 错误处理（必需）

#### 统一的错误处理模式：

```typescript
import toast from "react-hot-toast";
import { humanizeError } from "../utils/humanizeError";

async function handleAction() {
  try {
    setLoading(true);
    await apiFetch('/api/endpoint', { method: 'POST', body: JSON.stringify(data) });
    toast.success(t('module.successMessage'));
  } catch (e: any) {
    toast.error(humanizeError(e));  // 自动国际化错误消息
  } finally {
    setLoading(false);
  }
}
```

#### 错误显示：

```typescript
// 页面级错误
{error && (
  <div className="text-red-400 mt-4">
    {t('common.error')}: {error}
  </div>
)}
```

---

### ⏳ 5. 加载状态（必需）

#### 页面加载状态：

```typescript
const [loading, setLoading] = useState(true);

// 显示加载状态
{loading && <p className="text-gray-400">{t('common.loading')}</p>}
```

#### 按钮加载状态：

```typescript
<button
  disabled={loading}
  className="... disabled:opacity-50"
>
  {loading ? t('common.loading') : t('module.buttonLabel')}
</button>
```

#### 带动画的加载状态：

```typescript
{loading ? (
  <>
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeOpacity="0.2" />
      <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="4" />
    </svg>
    {t('common.loading')}
  </>
) : (
  t('module.action')
)}
```

---

### 📭 6. 空状态处理（必需）

#### 数据为空时的友好提示：

```typescript
{items.length === 0 && !loading && (
  <div className="text-center py-12 text-gray-500">
    {t('module.noItemsFound')}
  </div>
)}
```

#### 空状态的变体：

```typescript
// 未登录时的空状态
{!user && (
  <div className="text-gray-400">
    {t('auth.unauthorized')}
  </div>
)}

// 无权限时的空状态
{user && !hasPermission && (
  <div className="text-gray-400">
    {t('auth.forbidden')}
  </div>
)}

// 搜索无结果
{searchQuery && filteredItems.length === 0 && (
  <div className="text-gray-500">
    {t('module.noResultsFor', { query: searchQuery })}
  </div>
)}
```

---

### 🔗 7. 导航和链接（必需）

#### 使用 React Router 的 Link：

```typescript
import { Link } from "react-router-dom";

<Link
  to="/path"
  className="text-blue-400 hover:underline"
>
  {t('module.linkText')}
</Link>
```

#### 动态路由参数：

```typescript
<Link to={`/ideas/${idea._id}`}>
  {idea.title}
</Link>
```

#### 带状态的导航：

```typescript
import { useNavigate } from "react-router-dom";

const navigate = useNavigate();

function handleSuccess() {
  toast.success(t('module.success'));
  navigate('/target-path', { replace: true });
}
```

---

### 🔍 8. SEO和可访问性（建议）

#### 页面标题：

```typescript
import { useEffect } from "react";

useEffect(() => {
  document.title = `${t('module.pageTitle')} - IdeaHub`;
}, [t]);
```

#### 语义化HTML：

```typescript
// 使用正确的标签
<main>
  <article>
    <header>
      <h1>{title}</h1>
    </header>
    <section>{content}</section>
  </article>
</main>
```

#### ARIA标签：

```typescript
<button
  aria-label={t('module.buttonAriaLabel')}
  aria-busy={loading}
>
  {t('module.buttonLabel')}
</button>
```

---

### 📱 9. 响应式设计（必需）

#### 容器最大宽度：

```typescript
// 标准内容页
<div className="max-w-3xl mx-auto p-4">

// 宽内容页（如管理后台）
<div className="max-w-6xl mx-auto p-4">

// 列表页
<div className="max-w-4xl mx-auto p-4">
```

#### 响应式网格：

```typescript
<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
  {items.map(item => <Card key={item.id} />)}
</div>
```

---

### 🧪 10. 开发检查清单

创建新页面时，必须确认以下所有项：

#### 功能完整性：
- [ ] ✅ 已添加 `useTranslation` hook
- [ ] ✅ 所有文本已使用 `t()` 函数
- [ ] ✅ 已添加英文翻译到 `en.json`
- [ ] ✅ 已添加中文翻译到 `zh.json`
- [ ] ✅ 翻译键名一致
- [ ] ✅ 变量插值正确使用

#### UI一致性：
- [ ] ✅ 使用统一的容器样式
- [ ] ✅ 使用统一的标题层级
- [ ] ✅ 使用统一的按钮样式
- [ ] ✅ 使用统一的卡片样式
- [ ] ✅ 使用统一的输入框样式

#### 用户体验：
- [ ] ✅ 实现加载状态
- [ ] ✅ 实现错误处理
- [ ] ✅ 实现空状态提示
- [ ] ✅ 实现成功提示
- [ ] ✅ 响应式设计

#### 安全和权限：
- [ ] ✅ 添加必要的认证检查
- [ ] ✅ 添加必要的权限验证
- [ ] ✅ 使用 `ProtectedRoute`（如需要）

#### 路由配置：
- [ ] ✅ 在 `App.tsx` 添加路由
- [ ] ✅ 更新导航栏（如需要）
- [ ] ✅ 添加导航翻译键（如需要）

#### 文档更新：
- [ ] ✅ 更新 `PROJECT_STRUCTURE.md` 的项目结构树
- [ ] ✅ 更新功能模块清单
- [ ] ✅ 更新国际化模块统计
- [ ] ✅ 更新路由表

---

### 📚 参考示例

以下页面完全遵循上述标准，可作为参考：

1. **LoginPage.tsx** - 表单处理、错误提示、加载状态
2. **HomePage.tsx** - 列表展示、空状态、分页
3. **IdeaDetailPage.tsx** - 详情展示、互动功能、权限控制
4. **MePage.tsx** - 多标签页、数据分组、空状态处理
5. **AdminUsersPage.tsx** - 管理界面、搜索过滤、确认对话框

---

## 开发指南

### 添加新功能时的检查清单

#### ✅ 前端页面开发
1. **创建页面组件** (`client/src/pages/`)
   - 导入 `useTranslation` from `react-i18next`
   - 在组件中声明 `const { t } = useTranslation()`
   - 所有硬编码文本替换为 `t('module.key')`

2. **添加翻译资源**
   - 在 `client/src/locales/en.json` 添加英文翻译
   - 在 `client/src/locales/zh.json` 添加中文翻译
   - 确保键名一致、结构对应

3. **添加路由**
   - 在 `client/src/App.tsx` 添加路由配置
   - 考虑是否需要 `ProtectedRoute` 保护

4. **更新导航**
   - 如需在导航栏显示，更新 `client/src/components/Navbar.tsx`
   - 添加对应的翻译键到 `nav` 模块

#### ✅ 后端API开发
1. **创建路由** (`server/src/routes/`)
   - 定义路由路径和HTTP方法
   - 应用认证/权限中间件
   - 应用验证中间件

2. **创建控制器** (`server/src/controllers/`)
   - 实现业务逻辑
   - 使用统一错误处理（AppError）
   - 返回标准JSON响应

3. **创建数据模型** (`server/src/models/`)
   - 定义Mongoose Schema
   - 添加必要的索引
   - 定义实例方法/静态方法

4. **添加验证模式** (`server/src/schemas/`)
   - 使用Joi定义请求体验证规则
   - 在路由中应用 `validate` 中间件

#### ✅ 国际化集成
**确保新功能完整支持双语:**

1. **识别需要翻译的文本**
   - 页面标题和描述
   - 按钮标签
   - 表单字段标签和占位符
   - 提示消息（成功/错误/警告）
   - 空状态提示
   - 加载状态文本

2. **选择合适的翻译模块**
   - 通用词汇 → `common`
   - 导航相关 → `nav`
   - 认证相关 → `auth`
   - 创意相关 → `idea`
   - 评论相关 → `comment`
   - AI评审 → `aiReview`
   - 管理后台 → `admin`
   - 排行榜 → `leaderboard`
   - 用户资料 → `profile`
   - （或创建新模块）

3. **添加插值变量**
   ```typescript
   // 当需要动态内容时
   t('module.key', { variable: value })
   
   // 翻译文件中
   "key": "Text with {{variable}}"
   ```

4. **测试双语切换**
   - 切换语言后检查所有文本
   - 确保没有遗漏的硬编码文本
   - 验证变量插值正确显示

#### ✅ 错误处理
1. **前端错误处理**
   ```typescript
   try {
     await apiFetch('/api/endpoint', options);
     toast.success(t('module.successMessage'));
   } catch (e: any) {
     toast.error(humanizeError(e));
   }
   ```

2. **后端错误处理**
   ```javascript
   // 使用统一错误类
   throw new AppError('ERROR_CODE', 'Message', 400, { details });
   
   // 错误码应在 errorCodes.js 中定义
   ```

---

### 功能完整性自查

当添加新功能时，参考本文档确保：

#### 📝 页面层级
- [ ] 所有新页面已添加到路由
- [ ] 所有页面已完成国际化
- [ ] 所有页面有对应的后端API支持
- [ ] 所有页面有适当的权限控制

#### 🗂️ 数据层级
- [ ] 数据模型已创建
- [ ] 数据库索引已添加
- [ ] API端点已实现
- [ ] 请求验证已配置

#### 🌍 国际化层级
- [ ] 翻译键已添加到 en.json
- [ ] 翻译键已添加到 zh.json
- [ ] 翻译键结构一致
- [ ] 变量插值正确使用

#### 🔐 安全层级
- [ ] 敏感操作有认证保护
- [ ] 权限检查已实施
- [ ] 输入验证已配置
- [ ] XSS防护已考虑

---

## 项目状态总结

### 已完成功能 ✅
- ✅ 完整的认证系统（邮箱、OAuth）
- ✅ 创意CRUD功能
- ✅ 社交互动（点赞、评论、收藏）
- ✅ AI智能评审
- ✅ 排行榜系统
- ✅ 通知系统
- ✅ 用户资料系统
- ✅ 管理后台
- ✅ 公司功能
- ✅ **完整国际化支持（17个页面 + 4个组件）**

### 待开发功能 🔲
- 🔲 手机号登录（后端Phase B2）
- 🔲 实时聊天/消息系统
- 🔲 高级搜索和过滤
- 🔲 数据分析仪表板
- 🔲 支付集成（会员订阅）
- 🔲 更多OAuth提供商（微信、QQ等）

---

## 更新记录

| 日期 | 版本 | 更新内容 | 更新人 |
|------|------|---------|--------|
| 2026-02-27 | 1.0 | 初始版本，完整项目结构文档 | AI Assistant |
| 2026-02-27 | 1.1 | 添加完整国际化模块说明 | AI Assistant |
| 2026-02-27 | 1.2 | 添加"所有页面必备功能"章节，包含完整的开发检查清单 | AI Assistant |
| 2026-03-21 | 4.8 | 初始化 OpenClaw AI 员工模式记忆层（AGENTS.md, BOOT.md, MEMORY.md 等） | GitHub Copilot |
| 2026-03-21 | 4.9 | 启用 4 个 OpenClaw 内部 hook（boot-md、bootstrap-extra-files、session-memory、command-logger）；分层化项目知识（memory.md 分离） | GitHub Copilot |
| 2026-03-21 | 4.10 | **OpenClaw 深度安全加固**：工具层（`tools.fs.workspaceOnly`, `tools.deny`）、沙箱层（`agents.defaults.sandbox.mode`）、网关层（12项命令黑名单扩展） | GitHub Copilot |
| 2026-03-21 | 4.11 | 补充 OpenClaw 团队快速上手教程（安装、onboard、复制记忆文件、启用 hooks、启动验证） | GitHub Copilot |
| 2026-03-21 | 4.12 | 修复 sandbox 教程：补充 Docker 必要条件与无 Docker 回退到 `agents.defaults.sandbox.mode=off` 的命令 | GitHub Copilot |
| 2026-03-21 | 4.13 | 明确 Docker 安装版本：Docker Desktop 最新稳定版 `Windows - AMD64`，并补充 `docker --version` 验证 | GitHub Copilot |
| 2026-03-21 | 4.14 | 补充 Docker 下载入口与安装勾选项：加入 Docker Desktop 官网链接，并明确启用 `WSL 2 based engine` | GitHub Copilot |
| 2026-03-21 | 4.15 | 补充 WSL 未启用修复命令：在 Docker 小节新增 `wsl --install` 与重启步骤 | GitHub Copilot |
| 2026-03-21 | 4.16 | 补充 Dashboard 稳定编辑规约：单文件串行、单指令唯一上下文、大改动临时关闭自动保存/保存格式化、1-2 文件回读确认 | GitHub Copilot |
| 2026-03-21 | 4.17 | OpenClaw 启动降耗优化：bootstrap 注入仅保留 `MEMORY.md`/`memory.md`，`session-memory.messages` 调整为 `4`，并移除 `tools.allow` 中不可用的 `cron` | GitHub Copilot |
| 2026-03-21 | 4.18 | 新增 OpenClaw 自维护模式：添加 `MAINTENANCE.md` 作为长时自主巡检/修复的规则源，并在 `AGENTS.md`/`CLAUDE.md` 接入入口引用 | GitHub Copilot |
| 2026-03-21 | 4.19 | 新增一键自维护启动脚本：添加 `start-openclaw-maintenance.cmd`，自动创建 maintenance 会话、发送启动语并将 JSON 结果落盘到 `memory/maintenance-logs/` | GitHub Copilot |
| 2026-03-22 | 4.20 | 增强自维护入口：`start-openclaw-maintenance.cmd` 增加自动打开对应 dashboard 会话链接，并新增 `open-latest-maintenance-log.cmd` 快速打开最新维护日志 | GitHub Copilot |
| 2026-03-22 | 4.21 | 增强可观测性与稳定性：`start-openclaw-maintenance.cmd` 增加状态文件和运行/完成标记，chat 跳转解析迁移到 `scripts/openclaw/open-dashboard-chat.ps1`，并新增 `check-latest-maintenance-status.cmd` | GitHub Copilot |
| 2026-03-22 | 4.22 | 优化维护入口与续跑体验：`start-openclaw-maintenance.cmd` 取消启动即打开默认 dashboard，新增 `continue-latest-maintenance.cmd` 自动复用最近 maintenance session 继续下一批，并在启动脚本结束输出续跑提示 | GitHub Copilot |
| 2026-03-22 | 4.23 | 增强续跑容错与维护指引：`continue-latest-maintenance.cmd` 新增 read offset 越界自愈提示（改为新边界重读并继续）；`MAINTENANCE.md` 新增该告警的可忽略条件与处置步骤 | GitHub Copilot |
| 2026-03-22 | 4.24 | 增强续跑编辑容错：`continue-latest-maintenance.cmd` 新增非唯一文本编辑失败的自愈提示（重读文件并改用函数名/唯一上下文的小范围编辑）；`MAINTENANCE.md` 新增该告警的可忽略条件与处置步骤 | GitHub Copilot |

---

## 使用建议

1. **开发新功能前**：先阅读本文档对应模块，了解现有实现
2. **添加新页面时**：必须参考"所有页面必备功能"章节，确保完整实现所有必需功能（尤其是国际化）
3. **遇到问题时**：查看"文件职责说明"了解各文件作用
4. **重构代码时**：更新本文档保持同步
5. **代码审查时**：使用"开发检查清单"验证功能完整性

---

**📌 提示:** 本文档应随项目演进持续更新。每次添加重大功能或重构时，请同步更新相关章节。
