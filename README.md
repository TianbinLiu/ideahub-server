# 🌟 IdeaHub - 智能创意管理平台

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![AI Workflow](https://img.shields.io/badge/AI%20Workflow-Enabled-green.svg)](.ai-instructions.md)
[![Documentation](https://img.shields.io/badge/docs-up%20to%20date-brightgreen.svg)](PROJECT_STRUCTURE.md)

一个全栈创意管理平台，支持AI评审、社交互动、排行榜等功能。**最重要的是，本项目内置了系统化的AI开发工作流程，确保代码质量和文档的持续同步。**

---

## ✨ 核心特性

### 功能特性
- 📝 **创意管理** - 创建、编辑、浏览创意
- 🤖 **AI智能评审** - 自动评估创意可行性和盈利潜力  
- 💬 **社交互动** - 点赞、评论、收藏、关注
- 🏆 **标签排行榜** - 基于标签的创意排名和投票
- 🔔 **实时通知** - 互动通知推送
- 🌍 **完整国际化** - 中英文双语支持（17页面+8组件）
- 👥 **角色权限** - 普通用户、公司用户、管理员
- 🎨 **现代化UI** - Tailwind CSS响应式设计

### 🤖 AI开发工作流程（项目的"底层逻辑"）

**这是本项目最独特的特性：一套系统化的AI协作开发机制**

```
📖 .ai-instructions.md       →  AI开发工作流程指南  
📋 .ai-file-header-templates.md  →  标准化文件头模板  
📚 PROJECT_STRUCTURE.md      →  项目架构实时文档  
🔍 scripts/validate-project.js   →  自动化验证脚本  
📝 .gitmessage               →  Git提交模板  
🪝 .git/hooks/pre-commit     →  提交前检查  
```

**该系统确保：**
- ✅ 每个文件都有标准化的元数据注释
- ✅ AI在修改代码前必须阅读项目文档
- ✅ 代码修改后自动提醒更新文档
- ✅ 新功能必须遵循必备功能检查清单
- ✅ 文档与代码保持同步

---

## 🏗️ 技术栈

### 前端
- **框架**: React 18 + TypeScript + Vite
- **路由**: React Router v6
- **样式**: Tailwind CSS
- **国际化**: i18next + react-i18next
- **状态管理**: Context API
- **HTTP**: Fetch API封装

### 后端
- **运行时**: Node.js + Express
- **数据库**: MongoDB + Mongoose
- **认证**: Passport.js (Local + OAuth)
- **队列**: Bull + Redis（AI任务队列）
- **邮件**: Nodemailer
- **AI**: OpenAI API

---

## 🚀 快速开始

### 前置要求
- Node.js >= 18
- MongoDB >= 6.0
- Redis >= 6.0（用于任务队列）
- npm 或 yarn

### 安装

```bash
# 克隆后端仓库
git clone https://github.com/TianbinLiu/ideahub-server.git
cd ideahub-server
npm install

# 克隆前端仓库（另一个仓库）
git clone https://github.com/TianbinLiu/ideahub-client.git
```

### 配置环境变量

**后端 `.env`（在 ideahub-server 仓库根目录）**:
```env
# 数据库
MONGODB_URI=mongodb://localhost:27017/ideahub
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-secret-key-change-this

# Email (可选)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-email@example.com
SMTP_PASS=your-password

# OpenAI (可选，用于AI评审)
OPENAI_API_KEY=sk-...

# OAuth (可选)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret

# 服务器
PORT=4000
NODE_ENV=development

# 项目文档（可选，缺少本地文件时使用远程）
PROJECT_DOCS_URL=https://raw.githubusercontent.com/TianbinLiu/ideahub-server/main/PROJECT_STRUCTURE.md
```

**前端 `.env`（在 ideahub-client 仓库根目录）**:
```env
VITE_API_BASE_URL=http://localhost:4000
VITE_GITHUB_REPO_URL=https://github.com/TianbinLiu/ideahub-server
VITE_GITHUB_DOCS_URL=https://github.com/TianbinLiu/ideahub-server/blob/main/PROJECT_STRUCTURE.md
```

### 启动项目

```bash
# 启动后端（在 ideahub-server 目录）
npm run dev

# 启动前端（在 ideahub-client 目录，新终端）
npm run dev
```

访问 http://localhost:5173 查看应用。

### 初始管理员账户

```bash
node scripts/seedAdmin.js
```

默认管理员：
- 邮箱: admin@example.com
- 密码: admin123
- 角色: admin

---

## 📖 AI协作开发指南

### 🤖 给AI开发者

**在对本项目进行任何修改之前，你必须：**

1. **📖 阅读 `.ai-instructions.md`** - 了解完整的AI开发工作流程
2. **📚 阅读 `PROJECT_STRUCTURE.md`** - 了解项目架构和文件关联
3. **✅ 遵循必备功能清单** - 确保不遗漏关键功能
4. **🔄 同步更新文档** - 修改后立即更新相关文档

**工作流程：**
```
接收需求 → 读取文档 → 检查规则 → 实施修改 → 更新文档 → 验证完成
```

**关键文件：**
- [`.ai-instructions.md`](.ai-instructions.md) - **主要指南，必读！**
- [`.ai-file-header-templates.md`](.ai-file-header-templates.md) - 文件头模板
- [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md) - 项目架构文档

### 👨‍💻 给人类开发者

本项目使用系统化的AI协作开发流程。请遵循以下最佳实践：

#### 创建新文件时
1. 使用 `.ai-file-header-templates.md` 中的模板添加文件头
2. 更新 `PROJECT_STRUCTURE.md` 的项目结构树和文件详解
3. 在更新记录表中添加条目

#### 修改现有文件时
1. 检查文件头注释，理解文件职责和关联关系
2. 如果改变了职责或依赖，更新文件头
3. 如果影响了其他文件，更新 `PROJECT_STRUCTURE.md`

#### 提交代码时
```bash
# Git会自动使用提交模板
git commit

# 按照模板填写：
# 1. 类型(范围): 简短描述
# 2. 详细描述
# 3. 勾选文档同步检查清单
```

#### 验证项目完整性
```bash
# 运行验证脚本
node scripts/validate-project.js

# 或添加到 package.json
npm run validate
```

---

## 📁 项目结构

**后端仓库（ideahub-server）**

```
ideahub-server/
│
├── .ai-instructions.md          # 🤖 AI开发工作流程指南
├── .ai-file-header-templates.md # 📋 标准文件头模板
├── PROJECT_STRUCTURE.md         # 📚 项目架构文档（核心）
├── .gitmessage                  # 📝 Git提交模板
├── scripts/
│   ├── validate-project.js      # 🔍 自动化验证脚本
│   ├── add-file-headers.js      # 🧩 批量文件头生成
│   └── copyProjectDocs.js       # 📄 文档同步脚本
│
├── src/
│   ├── routes/                  # 10个路由模块
│   ├── controllers/             # 9个控制器
│   ├── models/                  # 12个数据模型
│   ├── middleware/              # 5个中间件
│   ├── services/                # 4个服务
│   ├── workers/                 # 后台任务
│   ├── config/                  # 配置
│   ├── utils/                   # 工具函数
│   ├── app.js                   # Express配置
│   └── index.js                 # 服务器入口
│
└── package.json
```

**前端仓库（ideahub-client）**
- GitHub: https://github.com/TianbinLiu/ideahub-client

详细结构见 [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md)

---

## 🔧 可用脚本

### 后端仓库根目录
```bash
npm run validate         # 运行项目完整性验证
git commit               # 使用标准化提交模板
```

### 前端 (ideahub-client)
```bash
npm run dev              # 启动开发服务器
npm run build            # 构建生产版本
npm run preview          # 预览构建结果
npm run lint             # 运行 ESLint
```

### 后端 (ideahub-server)
```bash
npm run dev              # 启动开发服务器（nodemon）
npm start                # 启动生产服务器
node scripts/seedAdmin.js # 创建管理员账户
```

---

## 🧪 开发指南

### 新建页面组件

```tsx
/**
 * @file NewPage.tsx - 页面功能描述
 * @category Page
 * @requires_auth yes
 * @i18n_module moduleName
 * @route /new-page
 * 
 * 📖 [AI] 修改前必读: /.ai-instructions.md #新建页面必备功能清单
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md
 * 
 * 必备功能检查:
 * ✅ 国际化 (useTranslation)
 * ✅ 错误处理 (try-catch + humanizeError)
 * ✅ 加载状态 (loading state)
 * ✅ 空状态处理
 * ✅ 统一UI样式 (Tailwind)
 * ✅ 响应式设计
 */

import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { humanizeError } from '../utils/humanizeError';
import { apiFetch } from '../api';

export default function NewPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  // 实现逻辑...

  return (
    <div className="max-w-6xl mx-auto p-4 pb-20">
      <h1 className="text-2xl font-bold text-white mb-6">
        {t('moduleName.title')}
      </h1>
      {/* 页面内容 */}
    </div>
  );
}
```

**完成后：**
1. 在 `App.tsx` 注册路由
2. 添加翻译到 `locales/en.json` 和 `zh.json`
3. 更新 `PROJECT_STRUCTURE.md`

---

## 🌍 国际化

项目使用 i18next 实现完整的中英文双语支持。

### 添加新翻译

1. **确定模块名** - 根据功能归属（auth, idea, admin等）
2. **同时更新两个文件**:

```json
// client/src/locales/en.json
{
  "moduleName": {
    "key": "English Text"
  }
}

// client/src/locales/zh.json  
{
  "moduleName": {
    "key": "中文文本"
  }
}
```

3. **在组件中使用**:
```tsx
const { t } = useTranslation();
<div>{t('moduleName.key')}</div>
```

当前支持的模块：common, nav, auth, idea, comment, aiReview, admin, leaderboard, tagRank, notifications, profile, me, company

---

## 🔐 认证和权限

### 角色类型
- **user** - 普通用户，可以创建和互动
- **company** - 公司用户，可以表达对创意的兴趣
- **admin** - 管理员，完全访问权限

### 保护路由

```tsx
// App.tsx
<Route path="/admin/*" element={
  <ProtectedRoute requireRole="admin">
    <AdminPage />
  </ProtectedRoute>
} />
```

---

## 📊 数据模型

主要数据模型：
- **User** - 用户账户
- **Idea** - 创意
- **Comment** - 评论
- **Like** - 点赞
- **Bookmark** - 收藏
- **Notification** - 通知
- **Interest** - 公司兴趣表达
- **TagLeaderboard** - 标签排行榜
- **AiJob** - AI评审任务

详见 [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md)

---

## 🤝 贡献指南

我们欢迎所有形式的贡献！

### 开发流程

1. **Fork 本仓库**
2. **创建特性分支**: `git checkout -b feature/amazing-feature`
3. **遵循AI工作流程**: 
   - 阅读 `.ai-instructions.md`
   - 添加标准文件头
   - 更新 `PROJECT_STRUCTURE.md`
4. **编写规范的提交信息**: 使用 `.gitmessage` 模板
5. **运行验证**: `node scripts/validate-project.js`
6. **提交修改**: `git commit` (自动使用模板)
7. **推送分支**: `git push origin feature/amazing-feature`
8. **创建 Pull Request**

### Pull Request 检查清单

- [ ] 代码遵循项目规范
- [ ] 所有新文件都有标准文件头
- [ ] 更新了 `PROJECT_STRUCTURE.md`
- [ ] 添加了必要的翻译（en + zh）
- [ ] 测试通过
- [ ] 提交信息清晰规范

---

## 📈 项目统计

- **前端文件**: 37+ (18页面 + 8组件 + 11工具)
- **后端文件**: 62+ (10路由 + 9控制器 + 12模型...)
- **翻译键**: 680+ (en: 355, zh: 353, 13模块)
- **文档覆盖率**: 通过 `npm run validate` 查看
- **代码行数**: 15000+

---

## 🐛 问题反馈

如果你发现了 Bug 或有功能建议：

1. 检查 [Issues](https://github.com/TianbinLiu/ideahub-server/issues) 是否已存在
2. 如果没有，创建新的 Issue
3. 提供详细的描述和复现步骤

---

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

---

## 🙏 致谢

- React社区
- Express.js团队
- i18next国际化框架
- Tailwind CSS
- 所有贡献者

---

## 📚 相关文档

- [`.ai-instructions.md`](.ai-instructions.md) - **AI开发指南（必读）**
- [`.ai-file-header-templates.md`](.ai-file-header-templates.md) - 文件头模板
- [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md) - **项目架构文档**
- [API文档](docs/API.md) - API端点说明（TODO）
- [部署指南](docs/DEPLOYMENT.md) - 生产环境部署（TODO）

---

## 💡 特别说明

**本项目的独特价值在于其系统化的AI协作开发机制：**

1. **标准化文件头** - 每个文件都包含元数据，让AI理解文件职责和关联
2. **强制文档同步** - 代码修改时必须同步更新文档
3. **自动化验证** - 脚本检查项目完整性
4. **必备功能清单** - 确保新功能不遗漏关键特性（国际化、错误处理等）
5. **Git集成** - 提交模板和钩子强化最佳实践

这套系统使得项目能够在不断演进的同时保持高质量和一致性，即使有多个开发者（包括AI）参与也能维持项目的完整性。

**我们相信，这种"AI友好的项目架构"将成为未来软件项目的标准模式。**

---

<p align="center">Made with ❤️ and 🤖</p>
<p align="center">© 2026 IdeaHub Team</p>
