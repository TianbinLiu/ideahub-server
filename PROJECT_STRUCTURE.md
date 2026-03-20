# IdeaHub 项目架构文档

> 最后更新: 2026-03-20  
> 版本: 4.6
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
2. [项目结构树](#项目结构树)
3. [核心文件详解](#核心文件详解)
4. [更新记录](#更新记录)

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
├── client/                           # 前端应用
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
  ├── .ai-instructions.md           # AI开发指南（权威版本）
  ├── .ai-file-header-templates.md  # 文件头模板（权威版本）
  ├── AI-WORKFLOW-SYSTEM.md         # AI工作流总说明
  ├── PROJECT_STRUCTURE.md          # 本文档
  ├── README.md                     # 服务端/文档入口说明
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

**功能**:
- 重定向到后端OAuth端点
- 传递next参数（用于回调后跳转）

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

**菜单项** (5个):
1. My Messages → /message-requests
2. System Messages → /notifications?tab=system
3. @Mentions → /notifications?tab=mentions
4. **⭐ Replies → /notifications?tab=replies** [新增]
5. Likes Received → /notifications?tab=likes

**功能**:
- **动态计数显示**
  - 按类型统计未读通知数
  - System：顶级评论 + 收藏 + 公司兴趣（不包含回复）
  - Replies：只统计回复评论通知（parentCommentId存在）
  - @Mentions、Likes：按通知类型统计
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
- `locales/*.json` - auth模块

**表单字段**: 邮箱/用户名、密码  
**功能**: 本地登录、OAuth登录、跳转注册/重置密码  
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
- business模式可请求AI评审
- external模式支持URL自动检测和内容自动抓取
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
- **Likes选项卡**: 点赞通知
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

---

## 使用建议

1. **开发新功能前**：先阅读本文档对应模块，了解现有实现
2. **添加新页面时**：必须参考"所有页面必备功能"章节，确保完整实现所有必需功能（尤其是国际化）
3. **遇到问题时**：查看"文件职责说明"了解各文件作用
4. **重构代码时**：更新本文档保持同步
5. **代码审查时**：使用"开发检查清单"验证功能完整性

---

**📌 提示:** 本文档应随项目演进持续更新。每次添加重大功能或重构时，请同步更新相关章节。
