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

`FREE_VIDEO_GATE`（可选）：免费档出片限制的应急总开关，缺省开；写 `off` 退回改版前的口径（只有电影级挡免费版）。
规则本身见 `docs/api-contract.md`「视频档位与模型能力」。

`MINIMAX_INTL_API_KEY` / `MINIMAX_API_KEY` / `MINIMAX_REGION`（可选）：MiniMax 国际站 / 中国站的 key 与走哪个站（两把都配必须写 `MINIMAX_REGION`，否则生产拒绝启动）。
真人档两个站都能走；海外的「草稿 / 高清 / 电影级」（MiniMax H3，V2）**只在走国际站时开**（`/api/ark/health` 的 `minimaxV2`），没有单独的开关。
契约见 `docs/api-contract.md`「MiniMax H3（V2）出片」。

`MINIMAX_FAIL_REFUND`（可选）：MiniMax 出片（真人档、H3）受理之后报失败时退不退钱，缺省退；写 `off` 关掉。
方舟那边的失败退款没有开关（方舟只对成功的视频计费）。规则见 `docs/api-contract.md`「扣费」与「失败退款」。

`VIDEO_REGION_GATE`（可选）：出片地区门禁（海外不给 Seedance、MiniMax 只准国际站；受全面制裁的四国都不给），`off` / `observe` / `on`，缺省 `observe`（只记日志不拦，`/api/video/zone` 也照常全报）；写了认不出的值生产拒绝启动。**切 `on` 之前有五件要做完，完整清单在 `docs/api-contract.md`「出片地区」→「切 on 之前」**（`.env.example` 那一节是同一张单子），这里只列名目、别只照这几行做：① 用 App 发版脚本的 `--min-version-code` 把旁加载包的强制更新门槛抬到认得地区拒绝的那一版；② 确认 `/api/minimax/health` 的 `region` 是 `intl`；③ 核地区判得对 —— 当面核 `cf-ipcountry` 伪造不了，并做完源站那一道加固（细节在运维的私有笔记），这一步决定门禁能不能被绕开；④ 主人定已经付过钱的片子上的后续出片（样片第二步、片段重拍、往后延长）豁不豁免；⑤ 海外免费用户留的是 MiniMax H3-Lite · 480P（2026-10-26 已定）：V2（H3）出片要在国际站上开着、带 H3 三档的 App 要铺开，缺一样切下去之后他们一档视频都没有。
`VIDEO_ZONE_FORCE`（只给本机开发）：把每个请求的出片地区钉成 `cn` / `intl` / `blocked`，在美国测境内、在国内测海外；**生产配了它拒绝启动**。
规则见 `src/config/videoRegion.js` 文件头；端点形状、被拦时的回包、等主人拍板的几件见 `docs/api-contract.md`「出片地区」。

⚠️ `.env` 已被 gitignore，**永远不要提交**，也不要把值贴进聊天或文档。
生产密钥一律在服务器上用 `openssl rand -base64 48` 生成。

**工坊对局 · 游戏券（可选，缺省开）**：只有 `GAME_TICKETS` 一个开关（写 `off` 关掉，不用发版）。
数额与规则是**代码常量**（`src/config/gameTicket.js`：每月 6 张、每发出一张、任务加券每天最多 5 张），
不在环境变量里 —— 那是价目表，改数要过评审。带券出片走请求头 `X-Game-Ticket: 1`（或请求体
`payWithTicket: true`），扣一张券、不扣 token，并越过「免费版在 H3 上只能纯文字」那一条；
端点、错误码、能力位（`/api/ark/health` 的 `gameTickets`）见 `docs/api-contract.md`「工坊游戏券」。
⚠ 还没做的：分享 / 邀请的事件源（发券端点今天**只给管理员**）与全站熔断。

**工坊对局 · 房间与匹配（可选，缺省开）**：建房 / 进房 / 准备 / 开局 / 踢人 + 4 人 / 8 人匹配队列。
玩法规则是**代码常量**（`src/config/gameRoom.js`：4 人匹配 = 4 座、8 人匹配 = 8 座、
自定义房 2~8 座且 2 人即可开局、房号 6 位），不在环境变量里；
环境变量只有寿命这一类旋钮，全都有缺省值：`GAME_ROOM_TTL_MINUTES`（等待房 30）、
`GAME_ROOM_PLAYING_TTL_MINUTES`（playing 120）、`GAME_QUEUE_HEARTBEAT_SEC`（排队心跳 90）、
`GAME_QUEUE_MATCH_TTL_MINUTES`（撮合行 10）。总开关 `GAME_ROOMS=off`。
端点、状态机、错误码、能力位（`/api/ark/health` 的 `gameRooms`）见 `docs/api-contract.md`
「工坊对局：房间与匹配」。⚠ 还没做的：跨实例广播（推送今天只覆盖单实例）、跨服、
房间里的人的断线重连。

**工坊对局 · SSE 推送（可选，缺省开，2026-11-23）**：`GET /api/game/rooms/:code/stream` 一条长连接
收「房间 / 回合 / 事件 / 结束」的变化：建连即 `snapshot`，之后有变化推 `update`，每 20 秒
`ping` 心跳，错误走 `error`、30 分钟寿命到期走 `end`（都是推完就关）。鉴权支持
`Authorization: Bearer` 与 `?token=` 兜底；每用户同时最多 2 条（超出 429 `TOO_MANY_STREAMS`）。
★★ **它是单实例推送**：广播是进程内 EventEmitter（`src/services/gameRoomBus.js`），pm2 cluster 的
两个实例各有一份 —— App 的轮询退路必须留着；`/api/ark/health` 的 `gameRoomStream` 只表示「有这条流」。
只有两个寿命旋钮：`GAME_STREAM_HEARTBEAT_SEC`（心跳 20）、`GAME_STREAM_MAX_SEC`（单连接寿命 1800）。
帧格式、事件与错误码见 `docs/api-contract.md`「工坊对局：推送（SSE）」。⚠ 还没做的：跨实例广播
（Redis pub/sub）、gzip、断线重连的续帧 / Last-Event-ID。

**工坊对局 · 回合引擎（可选，缺省开）**：开局之后每一回合「开回合 → 各自交片 → 全员展映 → 点赞 →
投票 → 服务端算两个榜与扣血 → 下一回合」。规则是**代码常量**（`src/config/gameRound.js`：初始 100 血、
扣血 20/15/10/5 按人数缩放、4/8 人局剩 2 人结束 / 2 人局剩 1 人结束），不在环境变量里；回合数据存在
房间文档的 `rounds[]` 里，过期懒清理删房间时一起没。只有一个总开关 `GAME_ROUNDS=off`（急停回合端点，
不影响房间端点），能力位是 `/api/ark/health` 的 `gameRounds`。端点、错误码与结算公式见
`docs/api-contract.md`「工坊对局：回合引擎」。打完一局（`next` 遇 `GAME_OVER`）时房间会落成 `over`
并写 `winners` / `finishedAt`，任何人读房间快照的 `state` / `winners` 都能判结束与平局。

**工坊对局 · 回合间事件（可选，缺省开，2026-11-23）**：第 2/4/6 回合结算之后的三选一**由服务端出题**
（同一房间同一回合所有人看到同一个事件；之前只在本机跑，跨端会对不上）。事件表 / 触发回合 /
确定性抽选 / 效果拆分是**代码常量**（`src/config/gameEvent.js`，与 App `rules.GAME_EVENTS` 同口径）：
`effects.server` 只有 `hp`（由服务端落库，App 不要再应用一次），金币 / 模型档位 / 道具上限 /
免费刷新在 `effects.client` 里原样交给 App 本地落。只有一个总开关 `GAME_EVENTS_API=off`（急停
`/rounds/events*`，不影响回合端点），能力位是 `/api/ark/health` 的 `gameEvents`。端点、响应形状、
错误码见 `docs/api-contract.md`「工坊对局：回合引擎」→「回合间事件」。
⚠ 还没做的：断线重连 / 超时自动推进、总回合上限（今天打到只剩胜者名额为止）、跨实例推送。

**老师人格（tutor，可选，`TUTOR_ENABLED=true` 才挂）**：变量名见 `.env.example` 末尾那一组（`TUTOR_AI_MODEL_TEACH` / `TUTOR_AI_MODEL_CHEAP` / `TUTOR_MATERIAL_MAX_BYTES` / `TUTOR_TEXT_JSON_LIMIT` / `TUTOR_ALLOW_DEMO` / `TUTOR_WORKER_POLL_MS`）。开了要有 `AI_API_KEY` 与 Cloudinary 三项，`npm run check:config` 会拦「开了却没配齐」。契约在 `docs/api-contract.md`「老师人格（tutor）」，核心纯函数在 `src/tutor/core/`（从 tutor 仓同步的生成物，别手改）。

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
