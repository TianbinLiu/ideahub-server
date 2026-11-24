/**
 * @file gameRoom.routes.js - 「工坊对局」的房间与匹配端点（挂在 /api/game）
 * @category Route
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节 + docs/api-contract.md
 *
 * 设计来源：app 仓 `docs/workshop-game-design.md` §三「服务端房间协议」与 §四 G5「联机」、
 * `docs/g2-game-ui.md` 的大厅需求（4 人匹配 / 8 人匹配 / 自定义房间邀请）。
 * ★ **轮询 + SSE 推送**（2026-11-23）：房间 / 回合的变化走 `GET /api/game/rooms/:code/stream`
 *   （实现在 `services/gameRoomStream.service.js`），一条长连接就能收到 snapshot / update /
 *   ping / error / end。轮询端点**全部保留**：推送有 Redis 时跨实例（2026-11-24），没有 Redis /
 *   断线时退回进程内，那段时间只能靠轮询（见 gameRoomBus 文件头的 ★★ 与 /api/ark/health 的
 *   `gameRoomStreamShared`）。推送只是把轮询的结果主动塞过去，这些端点的形状**不用改**。
 *
 * | 方法 | 路径 | 鉴权 | 说明 |
 * |---|---|---|---|
 * | POST   | /api/game/rooms                | 登录 | 建房 `{mode, seats?}` → 201 `{ room }` |
 * | POST   | /api/game/rooms/join           | 登录 | 进房 `{code}` → `{ room }` |
 * | GET    | /api/game/rooms/:code          | 登录 | 快照（成员 / 座位 / ready / 状态 / 时间） |
 * | GET    | /api/game/rooms/:code/stream   | 登录（Bearer 或 `?token=`） | SSE 推送（建连即 snapshot，之后 update / ping / error / end） |
 * | POST   | /api/game/rooms/:code/leave    | 登录 | 退房（房主自动转移；最后一人退房 = 房间删除） |
 * | POST   | /api/game/rooms/:code/ready    | 登录 | 准备 `{ready:boolean}` |
 * | POST   | /api/game/rooms/:code/start    | **仅房主** | 开局（人数达标 + 全员 ready） |
 * | POST   | /api/game/rooms/:code/kick     | **仅房主** | 踢人 `{userId}` |
 * | POST   | /api/game/queue                | 登录 | 进队 / 续队（**也是撮合的那一拍**）`{mode}` |
 * | GET    | /api/game/queue                | 登录 | 排队状态（人数 / 还差几个 / 预计等待 / 两个池子） |
 * | DELETE | /api/game/queue                | 登录 | 离队 |
 *
 * 回合引擎（2026-11-23，`services/gameRound.service.js`；设计正本 app 仓 `docs/g3-round-loop.md`）：
 *
 * | 方法 | 路径 | 鉴权 | 说明 |
 * |---|---|---|---|
 * | POST   | /api/game/rooms/:code/rounds/start   | **仅房主** | 开第 1 回合（`playing` 且还没有回合） |
 * | POST   | /api/game/rooms/:code/rounds/entries | 房间成员 | 交片（一人一条、重复覆盖；只在 creating） |
 * | GET    | /api/game/rooms/:code/rounds/current | 房间成员 | 当前回合快照（展映 / 投票屏轮询） |
 * | GET    | /api/game/rooms/:code/rounds/history | 房间成员 | 历史回合 + 战绩（全部回合、按 round 升序；只读） |
 * | POST   | /api/game/rooms/:code/rounds/phase   | **仅房主** | `{phase:"screening"\|"voting"}` 推进阶段 |
 * | POST   | /api/game/rooms/:code/rounds/like    | 房间成员 | `{targetUserId}` 点赞（只在 screening） |
 * | POST   | /api/game/rooms/:code/rounds/vote    | 房间成员 | `{targetUserId\|null}` 投票 / 弃权（只在 voting） |
 * | POST   | /api/game/rooms/:code/rounds/settle  | 房主 / 全员已投 | 两个榜 + 扣血 + 淘汰 + 胜者 |
 * | POST   | /api/game/rooms/:code/rounds/next    | **仅房主** | 回合 +1（保留历史；只剩胜者名额 → 落库 over + `GAME_OVER`） |
 *
 * 回合间事件（2026-11-23，第 2/4/6 回合结算之后的三选一，契约见 `docs/api-contract.md`）：
 *
 * | 方法 | 路径 | 鉴权 | 说明 |
 * |---|---|---|---|
 * | GET    | /api/game/rooms/:code/rounds/events        | 房间成员 | 当前待选事件（服务端出题，同房间同回合同一个） |
 * | POST   | /api/game/rooms/:code/rounds/events/choice | 房间成员 | `{optionId}` 记录我的选择（幂等，第一选作数） |
 *
 * ★ 所有判定都在 `services/gameRoom.service.js` 与 `services/gameRound.service.js`（唯一实现）；这个文件只做
 *   ① 关掉时的 503 闸 ② 限流 ③ 把 service 的 `{ok:false, status, code, message}` 照原样回给客户端。
 *   路由里**不写任何**「几个人能开局 / 谁算房主」的判断 —— 那种句子抄第二遍就会跟服务端说出两种话。
 *
 * ★ 限流的数：快照是轮询路径（按 2 秒一次算，240 次/分钟足够两台设备同时开着）；
 *   进房 / 建房 / 踢人是低频动作，卡紧一点。房号 6 位、32 个字符的字母表 ≈ 10.7 亿种，
 *   `POST /rooms/join` 每分钟 30 次的话，枚举出一间真房要按年算。
 */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const gameRoom = require("../services/gameRoom.service");
const gameRound = require("../services/gameRound.service");
// SSE 推送：变化的广播口（进程内总线）与整条流的行为（帧 / 心跳 / 寿命 / 连接上限）
const gameRoomBus = require("../services/gameRoomBus");
const gameRoomStream = require("../services/gameRoomStream.service");
const config = require("../config/gameRoom");
const roundConfig = require("../config/gameRound");
const eventConfig = require("../config/gameEvent");
const historyConfig = require("../config/gameHistory");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────
// SSE 推送（2026-11-23）：一条长连接收「房间 / 回合变了」
// ★ 这一条**必须注册在下面 requireGameRoomsOn 之前**：总开关关着时，其它端点回 JSON 503，
//   而流要回 `event: error` + `GAME_ROOMS_OFF`（客户端读的是流，不是 JSON）。闸仍然生效 ——
//   处理器自己判 config.enabled()（services/gameRoomStream.handler 的第一段）。
// ─────────────────────────────────────────────────────────────────────

/**
 * 流的鉴权：`Authorization: Bearer` 优先，`?token=` 兜底（**同一套 requireAuth**）。
 * ★ 为什么允许 query token：App 用 fetch + ReadableStream 能带头（推荐这么用），但 EventSource /
 *   原生播放器带不了头；而 URL 会进 nginx access log / Referer，所以能带头的客户端一律带头，
 *   query 只作兜底（短期 token 即可）。
 * ★ 不要把这条规则搬进 middleware/auth：那等于所有端点都接受 URL 里的 token。
 */
function streamAuth(req, res, next) {
  const raw = typeof req.query?.token === "string" ? req.query.token.trim() : "";
  if (raw && !req.headers.authorization) req.headers.authorization = `Bearer ${raw}`;
  return requireAuth(req, res, next);
}

router.get("/rooms/:code/stream", streamAuth, gameRoomStream.handler);

/**
 * 总开关（`GAME_ROOMS=off`）。
 * ★ 只挂在 `/rooms` 与 `/queue` 两个前缀上：这个路由和游戏券那个路由共用 `/api/game`，
 *   一个光秃秃的 `router.use(...)` 会把 `GET /api/game/tickets` 也一起 503 掉
 *   （关掉对局不该顺手关掉出片扣券）。
 */
function requireGameRoomsOn(req, res, next) {
  if (config.enabled()) return next();
  return res.status(503).json({
    ok: false,
    code: "GAME_ROOMS_OFF",
    message: "game rooms are turned off on this server",
  });
}
router.use(["/rooms", "/queue"], requireGameRoomsOn);

/**
 * 回合引擎的总开关（`GAME_ROUNDS=off` 急停）。
 * ★ 与 `GAME_ROOMS` 分开：对局房间本身还开着时，也能把「开回合 / 交片 / 结算」单独关掉
 *   （回合引擎出问题不该顺手把大厅也关掉）。`GAME_ROOMS=off` 时上面的闸会先回 `GAME_ROOMS_OFF`。
 * ★ 只挂在 `/rooms/:code/rounds` 前缀上：不是整棵 `/rooms`，建房 / 进房 / 快照照常。
 */
function requireGameRoundsOn(req, res, next) {
  if (roundConfig.enabled()) return next();
  return res.status(503).json({
    ok: false,
    code: "GAME_ROUNDS_OFF",
    message: "the round engine is turned off on this server",
  });
}
router.use("/rooms/:code/rounds", requireGameRoundsOn);

/**
 * 历史回合 / 战绩读取的总开关（`GAME_HISTORY=off` 急停，2026-11-24）。
 * ★ 注册在回合闸**之后**：`GAME_ROUNDS=off` 时这一条根本轮不到，先回 `GAME_ROUNDS_OFF`
 *   （回合引擎整个关掉时，历史端点也不该单独活着 —— App 那时也不该再进「对局」的屏）。
 *   `GAME_ROUNDS` 开着、只有这里 off 时回 503 `GAME_HISTORY_OFF`。
 * ★ 只挂 `/rooms/:code/rounds/history`：其余回合端点照常（历史读取出问题不该把整局关掉）。
 */
function requireGameHistoryOn(req, res, next) {
  if (historyConfig.enabled()) return next();
  return res.status(503).json({
    ok: false,
    code: "GAME_HISTORY_OFF",
    message: "round history is turned off on this server",
  });
}
router.use("/rooms/:code/rounds/history", requireGameHistoryOn);

/**
 * 回合间事件的总开关（`GAME_EVENTS_API=off` 急停，2026-11-23）。
 * ★ 与 `GAME_ROUNDS` 分开：回合引擎还开着时也能单独关掉「读事件 / 选事件」
 *   （事件出问题不该顺手把整局关掉）。注册在回合闸之后：`GAME_ROUNDS=off` 时先回 `GAME_ROUNDS_OFF`。
 * ★ 只挂 `/rooms/:code/rounds/events`：回合的其它端点（开回合 / 交片 / 结算 / next）照常。
 */
function requireGameEventsOn(req, res, next) {
  if (eventConfig.enabled()) return next();
  return res.status(503).json({
    ok: false,
    code: "GAME_EVENTS_OFF",
    message: "round events are turned off on this server",
  });
}
router.use("/rooms/:code/rounds/events", requireGameEventsOn);

const createLimit = userRateLimit({ max: 20, scope: "game-room-create" });
const joinLimit = userRateLimit({ max: 30, scope: "game-room-join" });
const actLimit = userRateLimit({ max: 120, scope: "game-room-act" });
const pollLimit = userRateLimit({ max: 240, scope: "game-room-poll" });
const queueLimit = userRateLimit({ max: 120, scope: "game-queue" });

/**
 * 把 service 的结果原样回出去。
 * ★ 失败的形状 `{ ok:false, code, message, ...结构化字段 }` 是整个模块的契约：
 *   带 `status`（HTTP 码）的只有内部那一层，回包里去掉了（HTTP 已经说了同一件事）。
 */
function reply(res, result, okStatus = 200) {
  if (!result.ok) {
    const { ok, status, ...rest } = result;
    return res.status(status || 400).json({ ok: false, ...rest });
  }
  const { ok, ...rest } = result;
  return res.status(okStatus).json({ ok: true, ...rest });
}

/**
 * 「这间房变了」的**唯一广播口**（SSE 推送）。
 * ★ 所有写路由都经过 `replyWrite`，不要自己在路由里 emit：多一个出口就有一条路径忘记推，
 *   症状是「有的操作实时、有的要等下一次轮询」—— 在客户端看起来像偶发 bug，很难查。
 * ★ 失败不推：`NOT_HOST` / `WRONG_PHASE` 这类回包什么都没改（**唯一例外**是 `next` 的
 *   `GAME_OVER`：它虽然回 409，却把房间落成了 over，见那边的调用处）。
 */
function bumpRoom(code) {
  if (!code) return 0;
  return gameRoomBus.publish(code);
}

/**
 * 写操作的统一回包：`reply` + 成功时广播。
 * @param {string} [code] 这间房的码（房间内的端点传 `req.params.code`；建房 / 进房从回包里取）
 * @param {{ okStatus?: number, bumpCodes?: string[] }} [opts] `bumpCodes` = 「失败但落了库」的码
 */
function replyWrite(res, result, code, { okStatus = 200, bumpCodes = [] } = {}) {
  reply(res, result, okStatus);
  if (result.ok || bumpCodes.includes(result.code)) {
    bumpRoom(code || result.room?.code || result.code);
  }
}

/**
 * POST /api/game/rooms —— 建房
 *
 * 请求体：`{ mode: "match4"|"match8"|"custom", seats?: 2..8 }`
 * 回包 201：`{ ok:true, room }`（房间快照，形状见下方 GET）
 *
 * 400 `BAD_MODE` / `BAD_SEATS`（custom 的座位不是 2~8 的整数）/ `SEATS_LOCKED`
 *     （match4 给了 6 座：座位数由模式锁死，**不静默忽略**）
 * 409 `ALREADY_IN_ROOM`（已经在别的房里，带那间房的 `code`）
 */
router.post("/rooms", requireAuth, createLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await gameRoom.createRoom({ userId: req.user._id, mode: body.mode, seats: body.seats });
    reply(res, result, 201);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/join —— 凭 6 位码进房（大小写不敏感，`ab3k7q` = `AB3K7Q`）
 *
 * 请求体：`{ code }`
 * 错误码：404 `ROOM_NOT_FOUND`（码错 / 已过期）/ 409 `ROOM_ALREADY_STARTED` / 409 `ROOM_FULL`
 *        （带 `seats` / `memberCount`）/ 409 `ALREADY_IN_ROOM`（带快照：重复点击也当「你已经在里面」）
 */
router.post("/rooms/join", requireAuth, joinLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    replyWrite(res, await gameRoom.joinRoom({ userId: req.user._id, code: body.code }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/game/rooms/:code —— 房间快照（大厅 / 对局里都用它轮询）
 *
 * 回包：`{ ok:true, room: { code, roomId, mode, seats, status, state, origin, hostId, requiredPlayers,
 *   memberCount, members:[{userId, username, avatarUrl, seat, ready, hp, isHost, joinedAt}],
 *   canStart, startBlockedBy, winners, finishedAt, createdAt, updatedAt, startedAt, lastSeenAt, expiresAt } }`
 * ★ 座位是**派生量**（数组下标），迟到 / 退房之后自然重排，不落库。
 * ★ `updatedAt` = 最后一次**状态变化**；成员轮询只刷 `lastSeenAt`（它才是过期判据）。
 * ★ `state` 是 App 认的三态（`waiting` / `playing` / `over`；`status` 保留给老包，另有历史遗留的 `closed`）。
 *   `state: "over"` 时 `winners` 是 userId 数组（**空数组 = 平局**）、`finishedAt` 是结束时间；
 *   没结束时这两项是 `null`（稳定的形状，App 不用先判字段在不在）。每个人身上的 `hp` 照旧给。
 */
router.get("/rooms/:code", requireAuth, pollLimit, async (req, res, next) => {
  try {
    reply(res, await gameRoom.getRoom({ userId: req.user._id, code: req.params.code }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/leave —— 退房
 * 回包：`{ ok:true, left:true, closed, code, roomId, hostId, hostTransferred, room }`
 * ★ 房主走了 → 房主自动转移给最早进房的人（`hostTransferred:true` + 新的 `hostId`）；
 *   最后一个人走了 → `closed:true`、`room:null`、房间当场删掉。
 */
router.post("/rooms/:code/leave", requireAuth, actLimit, async (req, res, next) => {
  try {
    replyWrite(res, await gameRoom.leaveRoom({ userId: req.user._id, code: req.params.code }), req.params.code);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/ready —— 准备 / 取消准备（只认布尔）
 * 请求体：`{ ready: true|false }`；回包 `{ ok:true, room }`
 */
router.post("/rooms/:code/ready", requireAuth, actLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    replyWrite(res, await gameRoom.setReady({ userId: req.user._id, code: req.params.code, ready: body.ready }), req.params.code);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/start —— 开局（**仅房主**）
 * 错误码：403 `NOT_HOST` / 409 `ROOM_ALREADY_STARTED` / 409 `NOT_ENOUGH_PLAYERS`（`need`/`have`）/
 *        409 `NOT_ALL_READY`（`waitingOn`）
 */
router.post("/rooms/:code/start", requireAuth, actLimit, async (req, res, next) => {
  try {
    replyWrite(res, await gameRoom.startRoom({ userId: req.user._id, code: req.params.code }), req.params.code);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/kick —— 踢人（**仅房主**，不能踢自己）
 * 请求体：`{ userId }`；回包 `{ ok:true, kicked, room }`
 */
router.post("/rooms/:code/kick", requireAuth, actLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    replyWrite(res, await gameRoom.kickMember({ userId: req.user._id, code: req.params.code, targetId: body.userId }), req.params.code);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/queue —— 进队 / 续队（**也是撮合的那一拍**；客户端每 2~5 秒调一次）
 *
 * 请求体：`{ mode: "match4"|"match8" }`
 * 回包 `status: "waiting"`：`{ queued, need, etaSec, position, enqueuedAt, pools }`
 * 回包 `status: "matched"`：**带 `code` / `roomId` / `room`** —— 匹配成功就是在这里拿到房间码的
 * 错误码：400 `BAD_MODE` / 409 `ALREADY_IN_ROOM` / 409 `QUEUE_MODE_CONFLICT`（先 DELETE 再换模式）
 */
router.post("/queue", requireAuth, queueLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    reply(res, await gameRoom.enqueue({ userId: req.user._id, mode: body.mode }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/game/queue —— 我的排队状态
 * 回包：`{ status: "idle"|"waiting"|"matched", mode, queued, need, etaSec, position, pools }`
 *   （`matched` 时多 `code` / `roomId` / `matchedAt` / `room`）
 * ★ `pools` 永远给：大厅上那两行「4 人匹配 2/4」「8 人匹配 1/8」读它。
 */
router.get("/queue", requireAuth, pollLimit, async (req, res, next) => {
  try {
    reply(res, await gameRoom.queueStatus({ userId: req.user._id }));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/game/queue —— 离队（幂等：本来没排也回 200 + `left:false`）
 * ★ 它**只**清排队那一行：匹配成功之后「退房」走 `POST /api/game/rooms/:code/leave`，
 *   两件事不要混（一个是我还没进局，一个是我已经从局里出来）。
 */
router.delete("/queue", requireAuth, joinLimit, async (req, res, next) => {
  try {
    reply(res, await gameRoom.dequeue({ userId: req.user._id }));
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 回合引擎（2026-11-23）：每一回合交片 → 展映 → 点赞 → 投票 → 结算 → 下一回合
// ★ 判定全在 services/gameRound.service.js；这里只做开关 / 限流 / 把结果原样回出去。
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/game/rooms/:code/rounds/start —— 开第 1 回合（**仅房主**；房间必须已 `playing`）
 * 回包：`{ ok, round, phase, entries, allSubmitted, likesPending, votesPending }`（回合快照）
 * 错误码：403 `NOT_HOST` / 409 `ROOM_NOT_PLAYING` / 409 `ROUND_ALREADY_STARTED`
 */
router.post("/rooms/:code/rounds/start", requireAuth, actLimit, async (req, res, next) => {
  try {
    replyWrite(res, await gameRound.startRound({ userId: req.user._id, code: req.params.code }), req.params.code);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/rounds/entries —— 我这一回合的交片（**一人一条，重复提交覆盖**）
 *
 * 请求体：`{ prompt, cardNames: string[], videoUrl?, posterUrl?, placeholder?, modelTier? }`
 * 回包：当前回合快照（与 GET current 同形）
 * ★ 重复提交是**覆盖**（`submittedAt` 刷新），但 `entryId` **保持不变**（2026-11-24：
 *   举报 `game-entry` 认它；客户端不许自带这个字段，服务端说了算）。
 * 错误码：400 `BAD_PROMPT` / 400 `PROMPT_TOO_LONG` / 400 `BAD_CARD_NAMES` / 400 `BAD_ENTRY_FIELD` /
 *        404 `ROUND_NOT_FOUND` / 409 `NOT_IN_ROOM` / 409 `PLAYER_ELIMINATED` / 409 `WRONG_PHASE`
 */
router.post("/rooms/:code/rounds/entries", requireAuth, actLimit, async (req, res, next) => {
  try {
    replyWrite(
      res,
      await gameRound.submitEntry({ userId: req.user._id, code: req.params.code, body: req.body || {} }),
      req.params.code,
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/game/rooms/:code/rounds/current —— 当前回合快照（展映 / 投票屏轮询它；成员读续命）
 *
 * 回包：`{ ok, round, phase, entries:[{ entryId, userId, name, prompt, cardNames, videoUrl, posterUrl,
 *   placeholder, likes, likedByMe, votes, votedByMe }], allSubmitted, likesPending, votesPending }`
 * ★ `entryId`（2026-11-24）是这条投稿的**稳定 id**（首次交片生成、覆盖提交不变），也是举报
 *   `game-entry` 的 targetId；老房间的存量投稿没有它 → 回 `null`（重交一次就有）。
 * ★ `likes` / `votes` 是**计数**，`likedByMe` / `votedByMe` 是「我」视角；**谁投给谁不暴露**。
 * ★ `likesPending` / `votesPending` 是还差几个人的**数字**（不是名单）。
 * 错误码：404 `ROOM_NOT_FOUND` / 404 `ROUND_NOT_FOUND` / 409 `NOT_IN_ROOM`
 */
router.get("/rooms/:code/rounds/current", requireAuth, pollLimit, async (req, res, next) => {
  try {
    reply(res, await gameRound.getCurrent({ userId: req.user._id, code: req.params.code }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/game/rooms/:code/rounds/history —— 一局的历史回合 + 战绩（**房间成员**；2026-11-24）
 *
 * 回包：`{ ok, room: { code, state, winners, finishedAt },
 *   rounds: [{ round, settled, entries:[{ entryId, userId, name, prompt, cardNames, videoUrl,
 *   posterUrl, placeholder, modelTier, likes, votes }], settlement? }],
 *   summary: { roundsPlayed, perPlayer:[{ userId, name, hp, wins, likesTotal, votesTotal, bestRound? }] } }`
 * ★ 全部回合（含正在打的，`settled:false`）、按 round 升序、不翻页；`settlement` 只在已结算的回合出现。
 * ★ 战绩口径（wins / likesTotal / votesTotal / bestRound）写在 service.getHistory 文件头与
 *   docs/api-contract.md「历史回合与战绩」—— 两处同一份，别在客户端再算一遍。
 * ★ 房间过期被懒清理 → 404（历史没另存一份，见契约的「还没做」）。
 * 错误码：401（未登录）/ 403 `NOT_IN_ROOM`（不是这间房的成员）/ 404 `ROOM_NOT_FOUND` /
 *        503 `GAME_ROUNDS_OFF`（回合闸在前）/ 503 `GAME_HISTORY_OFF`
 */
router.get("/rooms/:code/rounds/history", requireAuth, pollLimit, async (req, res, next) => {
  try {
    reply(res, await gameRound.getHistory({ userId: req.user._id, code: req.params.code }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/rounds/phase —— 房主推进阶段 `{ phase: "screening" | "voting" }`
 *
 * · creating → screening：全员已交片，否则 409 `NOT_ALL_SUBMITTED`（带 `waitingOn`）；
 * · screening → voting：房主可提前进（不要求全员已点赞）；
 * · 同一阶段重复调用幂等回快照。
 * 错误码：400 `BAD_PHASE` / 403 `NOT_HOST` / 404 `ROUND_NOT_FOUND` / 409 `NOT_ALL_SUBMITTED` / 409 `WRONG_PHASE`
 */
router.post("/rooms/:code/rounds/phase", requireAuth, actLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    replyWrite(
      res,
      await gameRound.setPhase({ userId: req.user._id, code: req.params.code, phase: body.phase }),
      req.params.code,
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/rounds/like —— 点赞 `{ targetUserId }`（只在 screening）
 * 回包：当前回合快照；**一人一条一次、不能给自己、不能取消、重复是幂等的**（计数不涨）
 * 错误码：400 `BAD_TARGET` / 400 `CANNOT_LIKE_SELF` / 404 `TARGET_NOT_IN_ROOM` / 404 `ROUND_NOT_FOUND` /
 *        409 `NOT_IN_ROOM` / 409 `WRONG_PHASE` / 409 `PLAYER_ELIMINATED`
 */
router.post("/rooms/:code/rounds/like", requireAuth, actLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    replyWrite(
      res,
      await gameRound.likeEntry({ userId: req.user._id, code: req.params.code, targetId: body.targetUserId }),
      req.params.code,
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/rounds/vote —— 投票 `{ targetUserId: string | null }`（null = 弃权；只在 voting）
 * 回包：当前回合快照；**一人一次、不能给自己、投过 / 弃过再投是幂等的**（第一票作数）
 * 错误码：400 `BAD_TARGET` / 400 `CANNOT_VOTE_SELF` / 404 `TARGET_NOT_IN_ROOM` / 404 `ROUND_NOT_FOUND` /
 *        409 `WRONG_PHASE` / 409 `PLAYER_ELIMINATED`
 */
router.post("/rooms/:code/rounds/vote", requireAuth, actLimit, async (req, res, next) => {
  try {
    replyWrite(
      res,
      await gameRound.voteEntry({ userId: req.user._id, code: req.params.code, body: req.body || {} }),
      req.params.code,
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/rounds/settle —— 两个榜 + 综合名次 + 扣血 + 淘汰（**房主**，或全员已投票后任何成员）
 *
 * 回包：`{ ok, round, phase:"settled", settlement:{ ranking:[{ userId, name, likes, votes, likeRank,
 *   voteRank, composite, damage, hp, eliminated }], winners? } }`
 * ★ `winners` 只在「剩到胜者名额」时出现（4/8 人局剩 2 人、2 人局剩 1 人）：`winners` = userId 数组。
 * ★ 幂等：已结算的回合再调回**同一份**落库结果，不会重复扣血。
 * 错误码：403 `NOT_HOST`（未全员投票且不是房主）/ 404 `ROUND_NOT_FOUND` / 409 `WRONG_PHASE` / 409 `NO_ENTRIES`
 */
router.post("/rooms/:code/rounds/settle", requireAuth, actLimit, async (req, res, next) => {
  try {
    replyWrite(res, await gameRound.settle({ userId: req.user._id, code: req.params.code }), req.params.code);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/game/rooms/:code/rounds/events —— 当前待选事件（**第 2/4/6 回合结算之后、下一回合之前**）
 *
 * 回包：`{ ok, round, eventId, title, options:[{ id, cost, label,
 *   effects: { server: { hp? }, client: [...] } }], myChoice, allChosen }`
 * ★ 事件由 `(roomCode, round)` **确定性抽选**（config/gameEvent.eventFor）：同一房间同一回合，
 *   四个人看到的是同一个事件（之前各跑各的，选项/事件会对不上）。
 * ★ `effects.server` 是服务端**已经 / 将会**执行的那部分（今天只有 `hp`），App 不要再应用一次；
 *   `effects.client` 与 App `rules.EventEffect` 同形，原样在本地应用（金币 / 档位 / 道具上限 / 免费刷新）。
 * ★ 只在回合是当前最后一条且 `settled` 时可读；`next` 之后（下一回合 `creating`）回 `ROUND_NOT_SETTLED`。
 * 错误码：404 `ROOM_NOT_FOUND` / 409 `NOT_IN_ROOM` / 409 `PLAYER_ELIMINATED` / 404 `ROUND_NOT_FOUND` /
 *        409 `ROUND_NOT_SETTLED` / 409 `GAME_OVER` / 404 `NO_EVENT`（不是事件回合，带 `eventRounds`）/
 *        503 `GAME_EVENTS_OFF`。
 */
router.get("/rooms/:code/rounds/events", requireAuth, pollLimit, async (req, res, next) => {
  try {
    reply(res, await gameRound.getRoundEvent({ userId: req.user._id, code: req.params.code }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/rounds/events/choice —— 记下我的选择 `{ optionId }`
 *
 * 回包：`{ ok, myChoice, allChosen }`
 * ★ **幂等、第一选作数**：重复点 / 两个设备同时点，只有第一发落库（同一次原子更新里写选择 + 落 hp）。
 * ★ `optionId: "skip"` = App 三选一全落不了账时的跳过出口（App `EVENT_SKIP_PICK`），也记一个表态。
 * 错误码：400 `BAD_OPTION` / 其余同 GET 的前置闸 / 503 `GAME_EVENTS_OFF`。
 */
router.post("/rooms/:code/rounds/events/choice", requireAuth, actLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    replyWrite(
      res,
      await gameRound.chooseRoundEvent({ userId: req.user._id, code: req.params.code, optionId: body.optionId }),
      req.params.code,
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/rooms/:code/rounds/next —— 下一回合（**仅房主**；上一回合必须已 settled）
 *
 * 回包：新回合快照（round +1、phase `creating`、entries/likes/votes 都是空的；**历史回合原样留着**）
 * ★ `GAME_OVER` 时顺手把房间落成 `over`（写 `winners` / `finishedAt`）：结束状态不再只活在这一发回包里，
 *   任何人 `GET /api/game/rooms/:code` 都读得到（平局 = `winners: []`）。
 * 错误码：403 `NOT_HOST` / 404 `ROUND_NOT_FOUND` / 409 `ROUND_NOT_SETTLED` /
 *        409 `GAME_OVER`（带 `winners`，胜者可能是空数组 = 同归于尽）
 * ★ `GAME_OVER` 虽然回 409，但它是**改了库**的（房间 → over）：必须 bump（`bumpCodes`），
 *   否则订阅者要等下一次轮询才知道「结束了」—— 结局正是最不能晚到的一帧。
 */
router.post("/rooms/:code/rounds/next", requireAuth, actLimit, async (req, res, next) => {
  try {
    replyWrite(res, await gameRound.nextRound({ userId: req.user._id, code: req.params.code }), req.params.code, {
      bumpCodes: ["GAME_OVER"],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
