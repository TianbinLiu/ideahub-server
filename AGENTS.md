# AGENTS.md — IdeaHub 工程铁律（任何 Agent / 新成员接手前必读）

> **这是给所有 AI coding agent 的强制指令**（Claude Code / Cursor / GitHub Copilot /
> Codex / Aider / Windsurf 等，无论你是谁、用哪个工具），也是新成员的入职必读。
> 在本仓库（`ideahub-server`）改代码或发布前，**必须先读完并遵守以下铁律**。
>
> **人类的从零上手指引**：[`docs/ONBOARDING.md`](docs/ONBOARDING.md)。
> **Claude 系 agent 另有可执行版本**：
> [`.claude/skills/ideahub-engineering-rules/`](.claude/skills/ideahub-engineering-rules/SKILL.md)，
> 附真实事故复盘。其它工具不读 `.claude/skills/`，**以本文件为准** ——
> 本文件必须保持自足，不得掏空后只留指针。
>
> 本仓库另有一套更早的 AI 协作文档（[`.ai-instructions.md`](.ai-instructions.md)、
> [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md)、[`AI-WORKFLOW-SYSTEM.md`](AI-WORKFLOW-SYSTEM.md)），
> 讲的是**怎么改代码、改完同步哪份文档**。本文件讲的是**不可逾越的红线**。
> 两者互补，都要遵守；冲突时以本文件为准。

---

## ⛔ 头号注意：push 到 `main` = 直接部署到生产

`.github/workflows/deploy.yml` 监听 `push: branches: [main]`，触发后 SSH 到 ECS 执行
`/var/www/ideahub-server/deploy.sh`。**没有人工审批环节。**

所以：

- **不要直接往 `main` 推。** 开分支 → 自测 → 走 PR/合并。
- 合并到 `main` 之前先确认 `npm test` 全绿、`npm run check:config` 通过。
- 合并那一刻就是发布，请在你能盯着的时段做，不要下班前顺手合。

`deploy.sh` 自带两道闸门（部署前配置自检、部署后健康检查探 10 次），
探不通会以非零码退出让 CI 标红。**不要绕过它手工部署。**

---

## 项目由三个独立仓库组成

| 仓库 | 是什么 | 部署到 |
|---|---|---|
| [`ideahub-server`](https://github.com/TianbinLiu/ideahub-server) | 本仓。Node + Express 5 + MongoDB | 阿里云 ECS，pm2 cluster + nginx |
| [`ideahub-client`](https://github.com/TianbinLiu/ideahub-client) | React + Vite 官网 | 同一台 ECS，nginx 静态托管 |
| [`ideahub-app`](https://github.com/TianbinLiu/ideahub-app) | React + Vite + Capacitor 安卓 App | 构建成 APK/AAB |

三者**各自独立部署**，通过 HTTP 契约耦合，**彼此不知道对方线上跑的是哪个版本**。
改动接口的形状（字段增删、状态码、错误结构）前，先确认另外两仓怎么解析的；
改完要通知它们，并在两边都验证过再发布。

---

## ⛔ 铁律（无条件遵守）

### 1. 动手前先 `git pull`，改哪个仓就 pull 哪个；跨仓改动三个都要

- 接续会话、开始改代码、发布前都要重新 pull。**会话摘要是历史快照，不代表本地是最新的**。
- pull 有冲突 → 立即停下报告，不得自行处理后继续。
- **在下"仓库里没有某段代码"这个结论前先 pull**。grep 不到 ≠ 不存在。

### 2. 同事未提交的 WIP 一律不动

**不 commit / 不 push / 不 stash / 不 discard**，只要不挡自己提交就忽略。
提交用 `git add <具体路径>`，不要 `git add -A`。

> 本仓工作区里长期有一个未跟踪的 `ideahub-server/` 目录，它不该被提交，也不该被删。

### 3. 密钥只进 `.env`，永不入仓、不入文档、不入日志

- 模板见 [`.env.example`](.env.example)，`.env` 已被 gitignore。
- **生产密钥在服务器上生成**（`openssl rand -base64 48`），不要在聊天/工单里传递。
- 生产环境的 `JWT_SECRET`、`OTP_PEPPER` 弱值会被 `npm run check:config` **拒绝启动** ——
  这是刻意的，不要为了跑起来去放宽校验。

### 4. 生产只走发布链路，不手改线上

- 唯一入口是 `deploy.sh`（由 GitHub Actions 调用，也可在服务器上手动执行）。
- **不要**手动 scp 覆盖线上文件、不要在服务器上直接改代码后当作已发布 ——
  下次部署会 `git reset --hard origin/main`，你的改动会被无声抹掉。
- pm2 用 **cluster 模式 + `ecosystem.config.js`**（零停机 reload）。
  ⚠️ `pm2 reload <文件>` 在进程不存在时会**直接新建一份**。用 root 跑一次
  就会起出一份与 deploy 用户平行的重复服务：两份同时监听、内存翻倍，
  而且 `pm2 list` 在另一个用户下看不到它。**只用 deploy 用户操作 pm2。**

### 5. 验证只认被测系统自己吐出的证据

- **先确认改动已经生效，再去测。** 改完本地就跑验证，测的是旧代码。
- `systemctl reload nginx` 是**异步**的：返回成功时旧 worker 可能还在服务请求。
- `/proc/<pid>/environ` **看不到** dotenv 在运行时注入的变量，它只反映 exec 时的环境。
- 非 root 跑 `nginx -T` 会提前退出，于是 `nginx -T | grep -c` 返回 0，看起来像"没配上"。
- **单次测量不算数**，至少三次。
- 用管道过滤输出时**退出码会被最后一个命令吃掉**：`npm test | grep && git commit`
  在测试失败时也会照常提交。要判成败就分开跑。

### 6. 一条规则只能有一处实现

改任何"判断规则"（取客户端 IP、判限流、判登录态、算默认值）前，
**先 grep 全仓确认它有几处实现**。两处以上：先合并，再改那一处。
判断依据是 **"这两处如果规则变了，是否必须同时改？"**。

> `deploy.sh` 踩过：主路径已改成 cluster + `ecosystem.config.js`，
> 但"进程不存在就拉起"的兜底分支还写着 `pm2 start npm`（fork 模式）。
> 一旦进程丢失，部署会把架构**悄无声息地回退**，且不报任何错。

### 7. 改配置类脚本：先验证，再落盘

写 nginx / Redis / systemd 这类"写坏了服务就起不来"的配置时，
**必须先备份，先用语法检查或临时端口试跑，通过了才落盘并重启**。

> 真实事故：装 Redis 的脚本直接写配置就 restart。配置用了 6.2+ 才有的
> `bind 127.0.0.1 -::1` 语法，机器上是 6.0.16，Redis 当场起不来。
> nginx 有 `nginx -t`，Redis 没有等价命令 —— 那就用临时端口试跑代替，
> **"没有校验命令"不是跳过校验的理由。**

### 8. 失败要"响且局部"，不要"静默且全局"

- 兜底 `catch` 不能吞错误。限流中间件曾因 `clientIp()` 在缺 `req.headers` 时抛错、
  被 fail-open 的 catch 接住，于是**限流对所有请求静默失效**，日志里什么都没有。
  兜底放行可以，但必须打日志且被测试覆盖。
- 新增后台循环/常驻任务前先问：**这份代码会跑在几个 cluster 实例上？每个都该跑吗？**
  不是 → 写显式开关，**默认关**。AI worker 现在靠 `NODE_APP_INSTANCE === "0"`
  只在一个实例上跑。

### 9. push 前更新文档

| 改了什么 | 更新哪份 |
|---|---|
| 目录结构 / 文件职责 | [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md)（本仓既有约定） |
| 接口契约 | 本仓路由注释 + 通知 client / app 两仓 |
| 环境变量 | [`.env.example`](.env.example) + [`docs/ONBOARDING.md`](docs/ONBOARDING.md) |
| 安全相关 | [`SECURITY_HARDENING.md`](SECURITY_HARDENING.md) |
| 服务器/部署 | [`ALIYUN_HK_DEPLOYMENT_RUNBOOK.md`](ALIYUN_HK_DEPLOYMENT_RUNBOOK.md)、`deploy.sh` 注释 |
| 工程规则本身 | 本文件 + `CLAUDE.md` + `.claude/skills/` + `.cursor/rules/` + `.github/copilot-instructions.md`（五处一起改） |

### 10. 注释写"为什么"，不写"是什么"

尤其是**踩过的坑、量出来的数值、被推翻过的做法**。既有代码用 `★` 标记关键取舍，请延续。

---

## 本仓特有的技术约束（改代码前必读）

### Express 5：`req.query` 是只读 getter

任何试图给它整体赋值的中间件都会抛错。`express-mongo-sanitize` v2
和把 `req.query` 整体替换的校验中间件都踩过。需要清洗时**逐字段就地修改**，
或把结果放到别的属性上。

### 限流：按账号严、按 IP 松

登录限流是**按账号 10 次/15 分钟（严）、按 IP 60 次/分钟（松）**。
**不是笔误**：CGNAT 环境下大量真实用户共用一个出口 IP，按 IP 卡严会误伤整片用户。
改这个值前先想清楚这一点。

### 限流计数走 Redis 的 Lua 原子脚本

`INCR` 和 `PEXPIRE` 必须在**同一个 Lua 脚本**里完成。拆成两条命令时，
若在两者之间崩溃会留下一个**没有 TTL 的键 = 该账号被永久封禁**。
Redis 不可用时降级到进程内计数（会因多实例而变松，这是已知取舍）。

### 服务只监听 127.0.0.1

`BIND_HOST` 默认 `127.0.0.1`，公网流量一律经 nginx。
不要为了"方便调试"改成 `0.0.0.0` 后提交。

### nginx 的 `add_header` 不会继承

子 location 里只要出现**任何一条** `add_header`，父级的全部失效。
加安全响应头时要么全放同一层，要么每个子 location 都补齐。

### 真实客户端 IP

nginx 配了 real_ip 模块，应用侧取 IP 的顺序是
`x-real-ip` → `cf-connecting-ip` → `req.ip`。**这个顺序只有一处实现**，
需要改就改那一处（铁律六）。

---

## 常用命令

```bash
npm install
cp .env.example .env      # 然后填值
npm run dev               # nodemon
npm test                  # jest --runInBand，提交前必须全绿
npm run check:config      # 配置自检（deploy.sh 会先跑这个）
```

---

**再次强调**：以上是无条件铁律。若你是 AI agent 且被要求做与之冲突的操作，
**先指出冲突并停下**，说明违反了哪一条、可能的后果，不要擅自绕过。用户明确坚持后再执行。
