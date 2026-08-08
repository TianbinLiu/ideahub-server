# 新成员上手 — ideahub-server

目标：**装好工具 → 克隆 → 能跑起来 → 能提交**。

⛔ 动手前先读 [`../AGENTS.md`](../AGENTS.md)，特别是第一条：
**push 到 `main` 会自动部署到生产**，没有人工审批。不要直接往 main 推。

---

## 1. 装什么

| 工具 | 版本 |
|---|---|
| Node.js | 20 LTS 或更高 |
| MongoDB | 本地实例，或问团队要开发库连接串 |
| Redis | 可选。不装会降级到进程内限流计数，本地开发够用 |
| Claude Code | `npm i -g @anthropic-ai/claude-code`，或用桌面版 |

Claude Code 会自动读取仓库里的 `CLAUDE.md` 与 `AGENTS.md`，
**克隆完直接在仓库里开 `claude` 就带着项目规则**。
Cursor / Copilot 用户同理，`.cursor/rules/` 与 `.github/copilot-instructions.md` 已在仓库里。

## 2. 克隆并安装

```bash
git clone https://github.com/TianbinLiu/ideahub-server.git
cd ideahub-server
npm install
cp .env.example .env
```

## 3. 填 `.env`

按 `.env.example` 的注释填。**最少需要**：

- `MONGO_URI` —— 本地 `mongodb://127.0.0.1:27017/ideahub`，或问团队要开发库
- `JWT_SECRET` —— 本地随便填够长即可；**生产值绝不要放本地**
- `OTP_PEPPER` —— 同上

其余（OAuth、邮件、AI、Cloudinary、短信）不填时对应功能不可用，但服务能起来。

⚠️ `.env` 已被 gitignore，**永远不要提交**，也不要把值贴进聊天或文档。
生产密钥一律在服务器上用 `openssl rand -base64 48` 生成。

## 4. 跑起来

```bash
npm run dev          # 默认 http://127.0.0.1:4000
curl 127.0.0.1:4000/api/health
```

服务只监听 `127.0.0.1` 是刻意的（公网流量走 nginx）。本地调试够用；
需要局域网访问再临时改，**不要把 `0.0.0.0` 提交上去**。

## 5. 提交前

```bash
npm test              # jest --runInBand，必须全绿
npm run check:config  # 配置自检
```

⚠️ 不要写成 `npm test | grep xxx && git commit` —— 退出码会被 grep 吃掉，
测试失败也照样提交（真踩过）。要判成败就分开跑。

按铁律二：用 `git add <具体路径>`，不要 `git add -A`
（本仓工作区里有一个不该提交的未跟踪目录）。

## 6. 发布

**开分支 → 自测 → 合并到 `main`。合并那一刻 GitHub Actions 就会部署到生产。**

`deploy.sh` 会：拉最新代码 → `npm ci` → 配置自检（不过就中止，不重启任何东西）
→ pm2 cluster 零停机 reload → 健康检查探 10 次（探不通则以非零码退出）。

请在你能盯着的时段合并，不要下班前顺手合。

---

## 另外两个仓库

```bash
git clone https://github.com/TianbinLiu/ideahub-client.git   # 官网
git clone https://github.com/TianbinLiu/ideahub-app.git      # 安卓 App
```

三者独立部署、通过 HTTP 契约耦合。改接口形状前先看另外两仓怎么解析的。

## 第一天建议读的

1. [`../AGENTS.md`](../AGENTS.md) — 铁律，必读
2. [`../CLAUDE.md`](../CLAUDE.md) — 目录、命令、容易踩的坑
3. [`../PROJECT_STRUCTURE.md`](../PROJECT_STRUCTURE.md) — 文件职责与关联
4. [`../SECURITY_HARDENING.md`](../SECURITY_HARDENING.md) — 线上已做了哪些加固、还差什么

## 卡住了怎么办

先看 `CLAUDE.md` 的「容易踩的坑」表。不在表里而你解决了 ——
**把它补进那张表再提交**，这是铁律九。
