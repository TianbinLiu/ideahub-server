/**
 * @file gameRoom.routes.js - 「工坊对局」的房间与匹配端点（挂在 /api/game）
 * @category Route
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节 + docs/api-contract.md
 *
 * 设计来源：app 仓 `docs/workshop-game-design.md` §三「服务端房间协议」与 §四 G5「联机」、
 * `docs/g2-game-ui.md` 的大厅需求（4 人匹配 / 8 人匹配 / 自定义房间邀请）。
 * ★ **HTTP 轮询版**：客户端每 2~5 秒轮询一次快照 / 队列状态。WebSocket 推送是下一步，
 *   到时候这些端点的形状**不用改**（推送只是把轮询的结果主动塞过去）。
 *
 * | 方法 | 路径 | 鉴权 | 说明 |
 * |---|---|---|---|
 * | POST   | /api/game/rooms                | 登录 | 建房 `{mode, seats?}` → 201 `{ room }` |
 * | POST   | /api/game/rooms/join           | 登录 | 进房 `{code}` → `{ room }` |
 * | GET    | /api/game/rooms/:code          | 登录 | 快照（成员 / 座位 / ready / 状态 / 时间） |
 * | POST   | /api/game/rooms/:code/leave    | 登录 | 退房（房主自动转移；最后一人退房 = 房间删除） |
 * | POST   | /api/game/rooms/:code/ready    | 登录 | 准备 `{ready:boolean}` |
 * | POST   | /api/game/rooms/:code/start    | **仅房主** | 开局（人数达标 + 全员 ready） |
 * | POST   | /api/game/rooms/:code/kick     | **仅房主** | 踢人 `{userId}` |
 * | POST   | /api/game/queue                | 登录 | 进队 / 续队（**也是撮合的那一拍**）`{mode}` |
 * | GET    | /api/game/queue                | 登录 | 排队状态（人数 / 还差几个 / 预计等待 / 两个池子） |
 * | DELETE | /api/game/queue                | 登录 | 离队 |
 *
 * ★ 所有判定都在 `services/gameRoom.service.js`（唯一实现）；这个文件只做
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
const config = require("../config/gameRoom");

const router = express.Router();

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
    reply(res, await gameRoom.joinRoom({ userId: req.user._id, code: body.code }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/game/rooms/:code —— 房间快照（大厅 / 对局里都用它轮询）
 *
 * 回包：`{ ok:true, room: { code, roomId, mode, seats, status, origin, hostId, requiredPlayers,
 *   memberCount, members:[{userId, username, avatarUrl, seat, ready, isHost, joinedAt}],
 *   canStart, startBlockedBy, createdAt, updatedAt, startedAt, lastSeenAt, expiresAt } }`
 * ★ 座位是**派生量**（数组下标），迟到 / 退房之后自然重排，不落库。
 * ★ `updatedAt` = 最后一次**状态变化**；成员轮询只刷 `lastSeenAt`（它才是过期判据）。
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
    reply(res, await gameRoom.leaveRoom({ userId: req.user._id, code: req.params.code }));
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
    reply(res, await gameRoom.setReady({ userId: req.user._id, code: req.params.code, ready: body.ready }));
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
    reply(res, await gameRoom.startRoom({ userId: req.user._id, code: req.params.code }));
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
    reply(res, await gameRoom.kickMember({ userId: req.user._id, code: req.params.code, targetId: body.userId }));
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

module.exports = router;
