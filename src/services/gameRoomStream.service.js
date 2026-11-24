/**
 * @file gameRoomStream.service.js - 工坊对局的 **SSE 推送**（`GET /api/game/rooms/:code/stream` 的全部行为）
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节与 docs/api-contract.md
 *
 * 设计正本：`docs/api-contract.md`「工坊对局：推送（SSE）」。
 * 路由只在 `routes/gameRoom.routes.js` 里挂一条线；**帧格式、快照、心跳、寿命、连接上限、清理**
 * 全在这个文件（铁律六：同一条规则只有一处实现）。
 *
 * ══ ★★ 跨实例推送与降级（2026-11-24） ═══════════════════════════════════════════════
 *   广播走 `services/gameRoomBus`：有 Redis 时 A 实例的写会经 pub/sub 推到连在 B 实例上的
 *   订阅者；没有 Redis / 连不上时自动退回进程内广播（详情与取舍见那个文件的 ★★）。
 *   ★ 降级期间只有本实例能收到，客户端**必须**保留轮询退路（App 每 2~5 秒那条
 *   `GET /rooms/:code` / `GET rounds/current`）；`/api/ark/health` 的 `gameRoomStreamShared`
 *   就是给 App 判这件事的（false = 别把轮询删掉）。断线期间漏掉的帧不补，重连只给最新快照。
 *
 * ══ ★★ 为什么每帧都要重新读库，而不是把「变了什么」广播出去 ═════════════════════════
 *   房间快照带 `canStart`（看的人视角）、回合快照带 `likedByMe` / `votedByMe`（也是看的人视角），
 *   同一个变化对每个人的 data **不是同一份**。所以 bus 只说「这间房变了」，每个连接自己按
 *   自己的 userId 重新算一份 —— 一次变化 × N 个连接 = N 次读，一桌最多 8 人，可以接受；
 *   真要优化是「读一次文档、逐连接投影」，等有实测压力再说（见 docs 的「还没做」）。
 *
 * ══ ★ 帧格式（原生 `res.write` 拼，不引依赖） ═════════════════════════════════════
 *   一帧 = `event: <name>\ndata: <JSON>\n\n`；`ping` 的 data 是**空串**（`event: ping\ndata: \n\n`）。
 *
 *   | event | data | 什么时候 |
 *   |---|---|---|
 *   | `snapshot` | `{ room, round }` | 建立连接后**立刻**一帧（`round` 没有回合时为 `null`） |
 *   | `update` | `{ room, round }` | 房间 / 回合任一数据变化（bus 广播后重读） |
 *   | `ping` | 空 | 每 `GAME_STREAM_HEARTBEAT_SEC`（缺省 20 秒），防中间层掐空闲连接 |
 *   | `error` | `{ ok:false, code, message, ... }` | `ROOM_NOT_FOUND` / `NOT_IN_ROOM` / `GAME_ROOMS_OFF` / `TOO_MANY_STREAMS` / `STREAM_ERROR`，**发完就关** |
 *   | `end` | `{ reason:"lifetime" }` | 连接活满 `GAME_STREAM_MAX_SEC`（缺省 30 分钟），**发完就关**，让客户端重连 |
 *
 * ══ ★ 连接上限：每用户同时 2 条 ══════════════════════════════════════════════════
 *   超了在**建立连接之前**回 HTTP 429 `TOO_MANY_STREAMS`（真正的状态码：客户端应停止重试，
 *   而不是把一条 200 的流再读一个 error 帧）。计数只活在进程内，重连错峰时会短暂达到 2 条，
 *   这是刻意留的余量（见 config.STREAM_MAX_PER_USER）。
 */

const gameRoom = require("./gameRoom.service");
const gameRound = require("./gameRound.service");
const gameRoomBus = require("./gameRoomBus");
const config = require("../config/gameRoom");

/** 心跳与快照顺带给房间续命的节流：60 秒一次就够（过期判据是分钟级的，没必要每帧写库） */
const TOUCH_EVERY_MS = 60 * 1000;

/** 一帧 SSE 的字节形状（`ping` 的 data 是空串；其它事件是 JSON） */
function frameOf(event, data) {
  return `event: ${event}\ndata: ${data === undefined || data === null ? "" : JSON.stringify(data)}\n\n`;
}

/** 错误帧的数据形状：与 JSON 回包同一套 `{ ok:false, code, message }`（HTTP 已经是 200，不再重复状态码） */
function errorOf(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function roomNotFound() {
  return errorOf("ROOM_NOT_FOUND", "no room with this code (wrong code, or it has expired)");
}

function notInRoom(roomCode) {
  return errorOf("NOT_IN_ROOM", "you are not in this room", { roomCode });
}

/**
 * 开一条 SSE 并返回 send。
 * ★ 响应头与 `services/companion.service.openSse` / `routes/support.routes` 逐字一致：
 *   三处都是同一种长连接，nginx 的缓冲行为（`X-Accel-Buffering: no`）必须一样，否则这一条
 *   被 buffer 住、那一条不，症状是「有的推送要等 30 秒才到」。
 */
function openSse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  return function send(event, data) {
    if (res.destroyed || res.writableEnded) return false;
    try {
      res.write(frameOf(event, data));
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * 每用户同时连着的流（进程内计数）。
 * ★ 为什么不用 `userRateLimit`：那个数的是「一分钟内打了几发」，而这里要的是「此刻还开着几条」——
 *   一条能用 30 分钟的长连接，按分钟计数会一直放行，上限形同不存在。
 */
const streamsByUser = new Map();

/** 占一个名额；返回释放函数，超限返回 null（**同一个 userId 的并发上限只在这里判**） */
function acquireSlot(userId) {
  const key = String(userId ?? "");
  if (!key) return null;
  const existing = streamsByUser.get(key);
  if (existing && existing.size >= config.STREAM_MAX_PER_USER) return null;
  const slot = { at: Date.now() };
  if (existing) existing.add(slot);
  else streamsByUser.set(key, new Set([slot]));
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const set = streamsByUser.get(key);
    if (!set) return;
    set.delete(slot);
    if (!set.size) streamsByUser.delete(key);
  };
}

/** 这个账号此刻开着几条流（429 的 `details.active` 与测试用） */
function activeCountOf(userId) {
  const key = String(userId ?? "");
  const set = key ? streamsByUser.get(key) : null;
  return set ? set.size : 0;
}

/**
 * 这一帧要发给「他」的那份数据。
 * · 房间快照与 `GET /rooms/:code` 的 `room` **同形**（含 `state` / `winners` / `finishedAt` / `members[].hp`）；
 * · 回合快照与 `GET rounds/current` 的 body **同形**（去掉回包的 `ok`），没有回合时为 `null`；
 * · `touch` = 给房间续命（`lastSeenAt`，见 gameRoom.service.touch 的 ★）。
 */
async function buildSnapshot({ code, viewerId, now = Date.now(), touch = false }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return { error: roomNotFound() };
  const member = room.members.some((item) => gameRoom.sameId(item.userId, viewerId));
  if (!member) return { error: notInRoom(room.code) };
  if (touch) await gameRoom.touch(room, now);
  const payload = { room: await gameRoom.snapshotOf(room, { viewerId, now }), round: null };
  const round = gameRound.currentRoundOf(room);
  // 没有回合时是 null（稳定形状：App 不用先判字段在不在），与 GET rounds/current 的 404 语义不同 ——
  // 这里「还没开始第一回合」是正常状态，不该让整条流断掉。
  if (round) payload.round = await gameRound.snapshotOf(room, round, { viewerId });
  return { payload };
}

/**
 * 只发一帧 error 就关（建立连接阶段的失败：房号不对 / 总开关关着）。
 * 没有名额、没有订阅、没有定时器 —— 不要为一条马上要关的流留下任何状态。
 */
function errorOnly(res, error) {
  const send = openSse(res);
  send("error", error);
  try {
    res.end();
  } catch {
    // 客户端可能已经走了；关不关都不影响（没有状态要清）
  }
}

/**
 * `GET /api/game/rooms/:code/stream` 的处理体。
 * ★ 路由在 `GAME_ROOMS=off` 的 503 闸**之前**注册（见 routes 的 ★）：总开关关着时这里自己回
 *   SSE 的 `error: GAME_ROOMS_OFF`（而不是闸的 JSON 503）—— 客户端拿到的永远是同一种帧。
 */
async function handler(req, res) {
  const code = gameRoom.normalizeCode(req.params?.code);
  const viewerId = req.user?._id;

  if (!config.enabled()) {
    return errorOnly(res, errorOf("GAME_ROOMS_OFF", "game rooms are turned off on this server"));
  }
  if (!code) return errorOnly(res, roomNotFound());

  const release = acquireSlot(viewerId);
  if (!release) {
    return res.status(429).json({
      ok: false,
      code: "TOO_MANY_STREAMS",
      message: `at most ${config.STREAM_MAX_PER_USER} concurrent streams per account`,
      details: { max: config.STREAM_MAX_PER_USER, active: activeCountOf(viewerId) },
    });
  }

  const send = openSse(res);
  const heartbeatMs = config.streamHeartbeatMs();
  const lifetimeMs = config.streamMaxLifetimeMs();
  let lastTouchAt = 0;
  let ended = false;
  let cleaned = false;
  let pushing = false;
  let dirty = false;
  let unsubscribe = null;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    release();
  }

  function endStream() {
    if (ended) return;
    ended = true;
    try {
      res.end();
    } catch {
      // 对端已经断了：close 事件会走 cleanup
    }
    cleanup();
  }

  /** 发一帧 error 再关（错误事件之后连接不再可用 —— 契约） */
  function failWith(error) {
    if (ended) return;
    send("error", error);
    endStream();
  }

  async function emitSnapshot(kind) {
    const now = Date.now();
    const touch = now - lastTouchAt >= TOUCH_EVERY_MS;
    const result = await buildSnapshot({ code, viewerId, now, touch });
    if (ended) return;
    if (result.error) return failWith(result.error);
    if (touch) lastTouchAt = now;
    if (!send(kind, result.payload)) endStream();
  }

  /**
   * 串行地推帧：推的时候又来了变化只置 `dirty`，这一轮推完再补一帧。
   * ★ 收尾还要再看一次 `dirty`（finally 里）：`dirty` 落在「while 判断之后、pushing=false 之前」
   *   这一小段时，不再排一次就会丢掉最后一个变化 —— 那正是客户端停在旧画面、以为服务端没反应的样子。
   */
  async function drain(kind) {
    if (pushing) {
      dirty = true;
      return;
    }
    pushing = true;
    try {
      let nextKind = kind;
      do {
        dirty = false;
        await emitSnapshot(nextKind);
        nextKind = "update";
      } while (dirty && !ended);
    } catch (err) {
      // ★ 流已经开了，不能再交给 errorHandler（res.json 会抛「headers already sent」）。
      //   记日志（铁律八：不要静默），并给客户端一个它认得的错误码，让轮询兜底接上。
      console.error(`[game-stream] push failed room=${code} user=${viewerId}:`, err && err.stack ? err.stack : err);
      failWith(errorOf("STREAM_ERROR", "stream failed, please fall back to polling"));
    } finally {
      pushing = false;
      if (dirty && !ended) drain("update").catch(() => {});
    }
  }

  function scheduleUpdate() {
    if (ended) return;
    drain("update").catch(() => {});
  }

  /**
   * 心跳：发 ping + 给房间续命（节流 60 秒）。
   * ★ 有了推送之后客户端不再轮询，而房间过期判的是 `lastSeenAt`（「最后一次有人在看」）——
   *   不续命的话，一局打到一半（>120 分钟）房间会被懒清理删掉，所有人都被踢回大厅。
   */
  function heartbeat() {
    if (ended) return;
    send("ping");
    const now = Date.now();
    if (now - lastTouchAt < TOUCH_EVERY_MS) return;
    gameRoom
      .loadRoom(code, now)
      .then((room) => {
        if (ended) return;
        if (!room) return failWith(roomNotFound());
        return gameRoom.touch(room, now).then(() => {
          lastTouchAt = Date.now();
        });
      })
      .catch((err) => {
        // 心跳是兜底路径：一次续命失败不该把一条还活着的流掐掉（下一拍会再试）
        console.error(`[game-stream] heartbeat touch failed room=${code}:`, err && err.message ? err.message : err);
      });
  }

  const heartbeatTimer = setInterval(heartbeat, heartbeatMs);
  heartbeatTimer.unref?.();
  const lifetimeTimer = setTimeout(() => {
    if (ended) return;
    send("end", { reason: "lifetime" });
    endStream();
  }, lifetimeMs);
  lifetimeTimer.unref?.();

  // ★ 订阅放在**读第一份快照之前**：读库是异步的，中间可能正好有一次写 —— 先读后订阅会静默
  //   漏掉那一帧（客户端停在旧画面，直到下一次变化或轮询才动）。订阅后任何变化只置 dirty，
  //   初始 snapshot 发完立刻补 update。
  unsubscribe = gameRoomBus.subscribe(code, scheduleUpdate);
  if (!unsubscribe) {
    failWith(errorOf("TOO_MANY_STREAMS", "too many stream subscribers for this room"));
    return;
  }

  // 客户端关 / 断网 / 服务端主动 end，都会走到这里：退订、清定时器、释放名额（幂等）
  res.on("close", cleanup);
  res.on("error", cleanup);

  await drain("snapshot");
}

/** 清空每用户计数（**只给测试用**：同一个进程连跑几十条用例，漏关一条会带偏下一条的上限） */
function resetForTests() {
  streamsByUser.clear();
  gameRoomBus.resetForTests();
}

module.exports = {
  handler,
  frameOf,
  buildSnapshot,
  activeCountOf,
  resetForTests,
};
