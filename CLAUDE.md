# CLAUDE.md — ideahub-server

Claude Code 会自动读取本文件。**工程铁律在 [`AGENTS.md`](AGENTS.md)，先读那份**，
尤其是开头那条：**push 到 `main` 会经 GitHub Actions 直接部署到生产**。

新成员从零上手看 [`docs/ONBOARDING.md`](docs/ONBOARDING.md)。

---

## 这是什么

IdeaHub 后端：Node + **Express 5** + MongoDB(Mongoose) + Redis。
提供创意管理、AI 评审、社交互动、标签排行榜、Creative Workshop 模板市场，
以及 app 侧的分支视频接口。

线上跑在阿里云 ECS：**pm2 cluster（2 实例）+ nginx 反代 + Redis**，
Node 只监听 `127.0.0.1`，公网证书与安全响应头在 nginx 层。

三仓关系见 [`AGENTS.md`](AGENTS.md)。

## 跑起来

```bash
npm install
cp .env.example .env      # 填 MONGO_URI / JWT_SECRET 等，见 docs/ONBOARDING.md
npm run dev               # nodemon，默认 4000
npm test                  # jest --runInBand，提交前必须全绿
npm run check:config      # 配置自检；生产环境弱密钥会直接拒绝启动
```

## 本仓已有的文档（不要重复造）

| 文件 | 讲什么 |
|---|---|
| [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md) | 目录结构、文件职责、关联关系。**改了结构要同步它** |
| [`.ai-instructions.md`](.ai-instructions.md) | 既有的 AI 协作工作流（改代码的步骤） |
| [`.ai-file-header-templates.md`](.ai-file-header-templates.md) | 文件头注释模板 |
| [`SECURITY_HARDENING.md`](SECURITY_HARDENING.md) | 安全加固清单：已做 / 待人工 / 待办 |
| [`ALIYUN_HK_DEPLOYMENT_RUNBOOK.md`](ALIYUN_HK_DEPLOYMENT_RUNBOOK.md) | 服务器部署手册 |
| [`ACCOUNT_SECURITY_CHECKLIST.md`](ACCOUNT_SECURITY_CHECKLIST.md) | 云账号侧的安全项 |

`AGENTS.md` 与它们互补：那些讲**怎么做**，`AGENTS.md` 讲**不能做什么**。

## 容易踩的坑

| 坑 | 症状 | 说明 |
|---|---|---|
| 给 `req.query` 整体赋值 | 运行时抛错 | Express 5 里它是只读 getter，要逐字段就地改 |
| 觉得"登录限流按 IP 太松是 bug" | —— | 刻意的。CGNAT 下按 IP 卡严会误伤整片真实用户 |
| 把 `INCR`/`PEXPIRE` 拆成两条 | 偶发账号被永久封 | 必须在同一个 Lua 脚本里，否则可能留下无 TTL 的键 |
| 新增常驻任务没加实例判断 | 任务被执行 N 次 | cluster 有多实例，用 `NODE_APP_INSTANCE === "0"` |
| 兜底 `catch` 吞掉错误 | 功能"正常"但没生效 | 限流曾因此对所有请求静默失效 |
| 在服务器上直接改代码 | 下次部署被抹掉 | `deploy.sh` 会 `git reset --hard origin/main` |
| 用 root 跑 `pm2 reload` | 起出第二份重复服务 | 该命令在进程不存在时会新建。只用 deploy 用户 |
| 工作区里有仓库的嵌套副本 | `npm test` 结果时好时坏 | jest 已用 `roots` 限定只跑 `tests/`；副本是同事的 WIP，不要删 |

## 约定

- **注释写"为什么"**，尤其是踩过的坑、量出来的数值、被推翻过的做法。用 `★` 标记关键取舍。
- **一条规则只有一处实现**（取 IP、限流判定、默认值……）。改之前先 grep。
- 改了目录结构或文件职责，同一次提交里更新 `PROJECT_STRUCTURE.md`。
