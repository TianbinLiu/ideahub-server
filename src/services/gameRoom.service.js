/**
 * @file gameRoom.service.js - 工坊对局的**房间状态机 + 撮合 + 懒清理**（唯一实现）
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节与 docs/api-contract.md
 *
 * 设计来源：app 仓 `docs/workshop-game-design.md` §三「服务端房间协议」+ `docs/g2-game-ui.md`
 * 大厅需求（4 人匹配 / 8 人匹配 / 自定义房间邀请）。
 *
 * | 方法 | 干什么 |
 * |---|---|
 * | `createRoom`  | 建房（房主 = 创建者，自动 ready）。match4/match8 座位数锁死，custom 2~8 |
 * | `joinRoom`    | 凭 6 位码进房。满员 / 已开局 / 已在别的房 / 码错 各有明确的码 |
 * | `leaveRoom`   | 退房。**房主走了房主自动转移**；最后一个人走了房间当场删掉 |
 * | `setReady`    | 准备 / 取消准备（只在 waiting 阶段） |
 * | `startRoom`   | 开局（**仅房主**；人数达标 + 全员 ready）→ `playing` |
 * | `kickMember`  | 踢人（**仅房主**；不能踢自己） |
 * | `getRoom`     | 快照（成员 / 座位 / ready / 状态 / 时间 / 观众数）。成员读一次算一次「有人在看」 |
 * | `listPublicRooms` | 公开房列表（2026-11-24：只列 public、按创建时间倒序、分页） |
 * | `spectate` / `leaveSpectate` | 观战进 / 出（**不占座、不写 members**；上限 20；与玩家 leave 分开） |
 * | `enqueue`     | 进队 / 续队 + **就地撮合**（够了就建房，把房号写进两边的队列行） |
 * | `queueStatus` | 我的排队状态（排队人数 / 还差几个 / 预计等待）+ 两个池子的现状 |
 * | `dequeue`     | 离队 |
 * | `sweepExpired`| 懒清理（过期房 + 过期的排队行）。没有定时任务（铁律八） |
 *
 * ══ ★★ 状态机（唯一一份，路由与 App 都不要自己判） ════════════════════════════════════
 *
 *   waiting ──(house owner start)──▶ playing
 *      │                                │
 *      │ 最后一个人 leave                 │ 今天没有东西会推它（回合引擎未接）
 *      ▼                                ▼
 *   （硬删）                      （lastSeenAt 超过 playing 寿命 → 硬删）
 *
 *   · join / ready / kick 只在 `waiting` 合法；`playing` 之后 join 回 `ROOM_ALREADY_STARTED`，
 *     ready / kick 同理（开局之后座次就定了 —— 踢人的口子留在建房前的等待区）。
 *   · leave 在**任何状态**都合法：玩到一半想走是真实需求，而且最后一个走的人会把房删掉
 *     （否则那间房要等 2 小时才过期，那几个人在这期间既不能再建房也不能排队）。
 *
 * ══ ★★ 为什么错误用「返回对象」而不是抛 AppError ═════════════════════════════════════
 *   这个模块的判据都要带上**结构化字段**（还差几个人 `need` / 现在几个人 `have` /
 *   谁还没准备 `waitingOn` / 你在哪间房 `code`），App 拿这些字段说人话。
 *   `AppError.details` 能装，但那会把「我该不该重试」这件事藏在一个通用壳里；
 *   这里每个失败都自带 HTTP 状态码（`status`），路由只管 `res.status(r.status).json(r)`。
 *
 * ══ ★ 不存敏感信息 ══════════════════════════════════════════════════════════════
 *   房间与队列里**只有 ObjectId**：用户名 / 头像在**读**的时候现拼（snapshotOf），
 *   不落库 —— 否则「改个昵称」，队友屏幕上还是旧的；删号之后还留着一条昵称副本。
 *   邮箱、手机号、IP 一律不进来。
 */
const { randomInt } = require("crypto");
const mongoose = require("mongoose");
const GameRoom = require("../models/GameRoom");
const GameQueue = require("../models/GameQueue");
const User = require("../models/User");
const config = require("../config/gameRoom");
const { START_HP } = require("../config/gameRound");

const QUEUE_PURGE_INTERVAL_MS = 10 * 1000;

/** 失败结果。`status` 是 HTTP 状态码，路由直接照着回 */
function fail(code, status, message, extra = {}) {
  return { ok: false, code, status, message, ...extra };
}

function sameId(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

function isoOf(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function atOf(now) {
  return new Date(now);
}

/** 6 位房号（字符集见 config.CODE_ALPHABET：去掉了 I/O/0/1） */
function newCode() {
  let out = "";
  for (let i = 0; i < config.CODE_LENGTH; i += 1) out += config.CODE_ALPHABET[randomInt(config.CODE_ALPHABET.length)];
  return out;
}

/**
 * 房号的规范化 —— **唯一一处**。
 * ★ 全大写 + 去空格：手抄 / 口述 / 小写输入都要认（`ab3k7q` 与 `AB3K7Q` 是同一间房）。
 * ★ 形状不对回 null（调用方按「没有这间房」处理）：房号是 6 位大写字母数字，
 *   一个 5 位的串不可能是这间房，与「查不到的 6 位码」对用户是同一件事。
 */
function normalizeCode(raw) {
  const code = String(raw ?? "").trim().toUpperCase();
  return new RegExp(`^[A-Z0-9]{${config.CODE_LENGTH}}$`).test(code) ? code : null;
}

/** 房主是谁（**唯一判据**）。房主已经不在房里（退房 / 删号级联）时自动落到最早进房的人 */
function hostIdOf(room) {
  const members = room?.members || [];
  const host = members.find((m) => sameId(m.userId, room.hostId));
  if (host) return host.userId;
  const oldest = members.slice().sort((a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0))[0];
  return oldest ? oldest.userId : null;
}

/**
 * 这间房公开不公开（**唯一判据**）。
 * ★ 缺省 private：老房间没有 `visibility` 这一格（这一版之前建的），读的时候按 private 处理，
 *   不为此写迁移 —— 房间最多活 2 小时，老文档自然过期完。
 * ★ 非法值（理论上进不来，enum 挡在建房）也当 private：**拿不准就别公开**。
 */
function visibilityOf(room) {
  return room?.visibility === "public" ? "public" : "private";
}

/** 这个人是这间房的**观众**吗（唯一判据；`members` 不算，两张名单互斥） */
function isSpectatorOf(room, userId) {
  if (!userId) return false;
  return (room?.spectators || []).some((spectator) => sameId(spectator.userId, userId));
}

/**
 * 观众做**写操作**时的统一拒绝（2026-11-24，**唯一判据**）。
 *
 * ★★ 为什么是一个函数而不是在每个 service 里各写一遍 `if`：观众能做的读（快照 / 当前回合 /
 *   历史 / SSE）与不能做的写（交片 / 点赞 / 投票 / 推进阶段 / 开局 / 踢人 / 结算 / next /
 *   事件选择 / 准备）是**同一条规则的两面**，散在十来个地方写就会漏一处 —— 而漏掉的那一处
 *   不会报错，会让观众的一票真的算进结算（症状是「名次莫名其妙变了」）。
 *   所以判据只在这里，所有写端点在读完房间之后的第一件事就是问它。
 * ★ 顺序：**先问观众，再问别的**（房主 / 阶段 / 人数）。观众撞上任何一条写端点都应该拿到
 *   `SPECTATOR_NOT_ALLOWED`，而不是「你不是房主」或「现在不是这个阶段」—— 那两句话会让人以为
 *   换个时机就能做。读端点的 `NOT_IN_ROOM` 不受影响（它们不走这里）。
 * ★ 观战的急停（`GAME_SPECTATORS=off`）**不影响**这条：已经在席上的人照样不能写，
 *   只是新的人进不来（见 config/gameRoom.spectatorsEnabled）。
 */
function spectatorWriteDenial(room, userId) {
  if (!isSpectatorOf(room, userId)) return null;
  return fail("SPECTATOR_NOT_ALLOWED", 403, "spectators cannot do this in the room", {
    roomCode: room?.code || null,
  });
}

/**
 * 这间房过期没有。
 * · **0 个人**立刻算过期（退房那一路会当场删，这里是兜底：进程崩在中间也会被下一次读清掉）；
 * · 其余看 `lastSeenAt` 与**按状态给的寿命**（waiting 30 分钟 / playing 2 小时，见 config）。
 */
function isExpired(room, now = Date.now()) {
  const members = room?.members || [];
  if (!members.length) return true;
  const last = room.lastSeenAt || room.updatedAt || room.createdAt;
  const base = last ? new Date(last).getTime() : 0;
  return now - base > config.ttlMsFor(room.status);
}

/**
 * 「这个人在哪间**还活着**的房里」——建房 / 排队之前先问它（一人一间，见 models/GameRoom 的索引注释）。
 * ★ 只算 `waiting` / `playing`：**`over` 不算「还在一间房里」**。一局打完，那间房只剩结算屏的价值，
 *   再拿它把几个人挡在「不能再开一局」外面就是拿旧局当锁（他们想接着玩的心愿正是下一局的开始）。
 *   旧房仍按 over 的寿命（30 分钟）自己过期，与这条判断互不影响。
 */
function findActiveRoomOf(userId, now = Date.now()) {
  return GameRoom.findOne({
    "members.userId": userId,
    status: { $in: ["waiting", "playing"] },
    $or: [
      { status: "waiting", lastSeenAt: { $gte: atOf(now - config.ROOM_TTL_MS) } },
      { status: "playing", lastSeenAt: { $gte: atOf(now - config.PLAYING_ROOM_TTL_MS) } },
    ],
  });
}

/**
 * 懒清理：过期房 + 过期排队行。
 *
 * ★ 为什么是懒清理而不是定时任务（铁律八）：这份代码跑在 pm2 cluster 的两个实例上，
 *   定时任务要么两个都跑（重复删，无害但白烧），要么写 `NODE_APP_INSTANCE === "0"` 的开关
 *   （那就多一个「这个任务到底在哪跑」的问题）；而这里要删的东西**只在有人访问时才值得删** ——
 *   没人看的过期房留着不花钱，被读到的那一刻删掉就行。
 * ★ 节流（`SWEEP_MIN_INTERVAL_MS`）：大厅 4 个人每 2 秒轮询一次，不节流就是每 2 秒一条
 *   deleteMany。注意**被读到的那个过期房不靠这轮扫描** —— `loadRoom` 单独判它自己。
 * ★ `force: true` 只给测试用（同一个进程里连跑几十条用例，节流会把它们串起来）。
 */
let lastSweepAt = 0;
let lastQueuePurgeAt = 0;

async function sweepExpired({ now = Date.now(), force = false } = {}) {
  let removed = 0;
  if (force || now - lastSweepAt >= config.SWEEP_MIN_INTERVAL_MS) {
    lastSweepAt = now;
    const waitingCut = atOf(now - config.ROOM_TTL_MS);
    const playingCut = atOf(now - config.PLAYING_ROOM_TTL_MS);
    const done = await Promise.all([
      GameRoom.deleteMany({ members: { $size: 0 } }),
      GameRoom.deleteMany({ status: "waiting", lastSeenAt: { $lt: waitingCut } }),
      // ★ `over` 用等待房那档寿命（30 分钟）：打完的一局留着给复盘 / 结算屏够久了，
      //   再长就是给每一局留一行永远不死的房间（以及「这个人永远在房间里」）。
      //   config.ttlMsFor 对 over 回的也是这一档，两处同一口径（见那边的 ★）。
      GameRoom.deleteMany({ status: "over", lastSeenAt: { $lt: waitingCut } }),
      GameRoom.deleteMany({ status: "closed", lastSeenAt: { $lt: waitingCut } }),
      GameRoom.deleteMany({ status: "playing", lastSeenAt: { $lt: playingCut } }),
    ]);
    removed += done.reduce((n, r) => n + (r.deletedCount || 0), 0);
  }
  if (force || now - lastQueuePurgeAt >= QUEUE_PURGE_INTERVAL_MS) {
    lastQueuePurgeAt = now;
    const [stale, matched] = await Promise.all([
      GameQueue.deleteMany({ status: "waiting", lastSeenAt: { $lt: atOf(now - config.QUEUE_HEARTBEAT_MS) } }),
      GameQueue.deleteMany({ status: "matched", matchedAt: { $lt: atOf(now - config.MATCH_TTL_MS) } }),
    ]);
    removed += (stale.deletedCount || 0) + (matched.deletedCount || 0);
  }
  return removed;
}

/** 按房号取一间**还活着**的房；过期就地删掉并按「没有这间房」回。 */
async function loadRoom(rawCode, now = Date.now()) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const room = await GameRoom.findByCode(code);
  if (!room) return null;
  if (isExpired(room, now)) {
    await GameRoom.deleteOne({ _id: room._id });
    return null;
  }
  return room;
}

/**
 * 有成员在读快照 → 给这间房续命。
 * ★★ 显式 `timestamps: false`：不写这一条的话 Mongoose 的 updateOne 会顺手改 `updatedAt`，
 *   于是「最后更新时间」永远等于「刚才」，界面上那格数字变成废话，
 *   而且过期判定**看起来**还在按 updatedAt 走（实际不是）—— 两个语义混在一个字段里。
 */
async function touch(room, now) {
  const at = atOf(now);
  await GameRoom.updateOne({ _id: room._id }, { $set: { lastSeenAt: at } }, { timestamps: false });
  room.lastSeenAt = at;
}

/** 开局卡在哪儿（快照里的 `startBlockedBy`，与 startRoom 的判定同一套说法） */
function startBlockedByOf(room, now = Date.now()) {
  if (room.status === "playing") return "already-started";
  // ★ 打完一局（status: "over"）也是「不能开局」：不报出来的话快照会给出 canStart:true，
  //   而 startRoom 会拿 ROOM_ALREADY_STARTED 拒 —— 按钮亮着却点不动。
  if (room.status === "over") return "over";
  if (room.status === "closed") return "closed";
  if (isExpired(room, now)) return "expired";
  const required = config.requiredPlayersOf(room);
  if (room.members.length < required) return "not-enough-players";
  if (room.members.some((m) => !m.ready)) return "not-all-ready";
  return null;
}

/**
 * 对外的三态（`state`）：`waiting` / `playing` / `over`。
 * ★ 为什么不直接把 `status` 给 App：`status` 里还有一个历史遗留的 `closed`（今天没有东西写它，
 *   但老数据里可能有）。App 只认三态，映射只在**这一处**做 —— 客户端各写一遍就会有两种说法。
 */
function stateOf(room) {
  const status = room?.status;
  if (status === "waiting") return "waiting";
  if (status === "over" || status === "closed") return "over";
  return "playing";
}

/**
 * 房间快照（**唯一**的对外形状）。
 * ★ 座位是**派生量**（数组下标，见 models/GameRoom 文件头），不落库；
 * ★ 用户名 / 头像现拼：一次 `$in` 查询，房间里最多 8 个人。
 * ★ `canStart` 是**看的人**视角（只有房主能开局）；`startBlockedBy` 是客观原因 ——
 *   App 拿前者决定按钮亮不亮，拿后者说一句为什么。
 */
async function snapshotOf(room, { viewerId = null, now = Date.now() } = {}) {
  const members = (room.members || []).slice().sort((a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0));
  const ids = members.map((m) => m.userId);
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("_id username avatarUrl").lean() : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const hostId = hostIdOf(room);
  const blocked = startBlockedByOf(room, now);
  const base = new Date(room.lastSeenAt || room.updatedAt || now).getTime();
  const over = room.status === "over";
  return {
    code: room.code,
    roomId: String(room._id),
    mode: room.mode,
    seats: config.capacityOf(room),
    /**
     * `status`：落库的状态（含历史遗留的 `closed`）。
     * `state`：App 认的三态（`waiting` / `playing` / `over`），由 stateOf 一处映射。
     * ★ 两个都给：老 App 已经在读 `status`，新 App 只认 `state`；删掉 `status` 会打断老包。
     */
    status: room.status,
    state: stateOf(room),
    origin: room.origin,
    /**
     * 公开 / 私人（2026-11-24，公开房列表）。★ 缺省 private（老房间没有这一格，见 visibilityOf）。
     * 给出来是为了让「公开房」在房间内屏上也能标明；不等于「房号对谁都可见」（房号本来就是凭据）。
     */
    visibility: visibilityOf(room),
    hostId: hostId ? String(hostId) : null,
    requiredPlayers: config.requiredPlayersOf(room),
    memberCount: members.length,
    /**
     * 观众（2026-11-24）：**只给计数**，不给名单（与成员列表同一层纪律：观众是谁与玩法无关，
     * 而每人身上的 `likedByMe` 之类都是成员视角）。`count` 永远是一个数（没有观众时 0）。
     */
    spectators: { count: (room.spectators || []).length },
    members: members.map((m, index) => {
      const user = byId.get(String(m.userId));
      return {
        userId: String(m.userId),
        username: user?.username || null,
        avatarUrl: user?.avatarUrl || null,
        seat: index,
        ready: Boolean(m.ready),
        /**
         * 血量（回合引擎，2026-11-23）。★ 老房间 / 这一版之前建的行没有 hp 字段，
         * 读的时候按 START_HP 兜底 —— 不为此写一次迁移（回合第一次结算会把它落库）。
         */
        hp: Number.isFinite(m.hp) ? m.hp : START_HP,
        isHost: sameId(m.userId, hostId),
        joinedAt: isoOf(m.joinedAt),
      };
    }),
    canStart: Boolean(viewerId && sameId(viewerId, hostId) && blocked === null),
    startBlockedBy: blocked,
    createdAt: isoOf(room.createdAt),
    updatedAt: isoOf(room.updatedAt),
    startedAt: isoOf(room.startedAt),
    /**
     * 结束状态对外可见（2026-11-23）：
     * · 没结束 → `winners: null`、`finishedAt: null`（**稳定的形状**，App 不用先判字段在不在）；
     * · 结束（`status: "over"`）→ `winners` 是 userId 数组，**空数组 = 平局 / 同归于尽**（不是「还没算」）。
     * ★ 只有房主能调 `next`，写完 over 别人读到的就是这一份 —— 这就是「结束不再只活在回包里」。
     */
    winners: over ? (room.winners || []).map((id) => String(id)) : null,
    finishedAt: over ? isoOf(room.finishedAt) : null,
    lastSeenAt: isoOf(room.lastSeenAt),
    expiresAt: isoOf(new Date(base + config.ttlMsFor(room.status))),
  };
}

/** 建房（带房号撞车重试）。★ 唯一索引是并发闸：撞了 E11000 就换个码重来 */
async function createRoomDoc(doc) {
  let lastErr = null;
  for (let i = 0; i < config.CODE_ATTEMPTS; i += 1) {
    try {
      return await GameRoom.create({ ...doc, code: newCode() });
    } catch (err) {
      lastErr = err;
      if (err?.code === 11000) continue;
      throw err;
    }
  }
  throw lastErr || new Error("could not allocate a room code");
}

// ─────────────────────────────────────────────────────────────────────
// 建房 / 进房 / 退房 / 准备 / 开局 / 踢人
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/game/rooms
 *
 * `{ mode: "match4"|"match8"|"custom", seats?: 2..8, visibility?: "public"|"private" }`
 * · match4 / match8：座位数由模式锁死（4 / 8）。带了 `seats` 且不是那个数 → 400 `SEATS_LOCKED`
 *   （**不静默忽略**：客户端以为建了 6 人局、服务端给 4 座，这种错一句都没有还查不出来）；
 * · custom：必须给 2~8 的整数。
 * · visibility：2026-11-24 起接受 `"public"` / `"private"`，**缺省 private**（老客户端不带这一位 →
 *   建出来的还是私人房；缺省 public 会把每个老用户的自定义房都摆到大厅上）。别的值 → 400
 *   `BAD_VISIBILITY`（不静默当 private：客户端以为建了公开房、结果大厅里找不到，一句错都没有）。
 * · 一个人同时只能在一间房里 → 已经在别的房时 409 `ALREADY_IN_ROOM` + 那间房的码。
 */
async function createRoom({ userId, mode, seats, visibility, now = Date.now() }) {
  const m = String(mode ?? "").trim();
  if (!config.isMode(m)) {
    return fail("BAD_MODE", 400, `mode must be one of ${config.MODES.join(" / ")}`, { modes: config.MODES.slice() });
  }
  // ★ 缺省 private（`undefined` / `null` / 空串都算没给）；显式给别的值整句拒，不猜。
  const rawVisibility = visibility === undefined || visibility === null ? "" : String(visibility).trim();
  let roomVisibility = "private";
  if (rawVisibility) {
    if (rawVisibility !== "public" && rawVisibility !== "private") {
      return fail("BAD_VISIBILITY", 400, "visibility must be public or private", { visibilities: ["public", "private"] });
    }
    roomVisibility = rawVisibility;
  }
  let capacity;
  if (m === "custom") {
    const n = seats === undefined || seats === null || seats === "" ? NaN : Number(seats);
    if (!Number.isInteger(n) || n < config.MIN_CUSTOM_SEATS || n > config.MAX_SEATS) {
      return fail("BAD_SEATS", 400, `seats must be an integer between ${config.MIN_CUSTOM_SEATS} and ${config.MAX_SEATS}`);
    }
    capacity = n;
  } else {
    capacity = config.seatsFor(m);
    if (seats !== undefined && seats !== null && seats !== "" && Number(seats) !== capacity) {
      return fail("SEATS_LOCKED", 400, `${m} is fixed at ${capacity} seats`, { seats: capacity });
    }
  }
  await sweepExpired({ now });
  const active = await findActiveRoomOf(userId, now);
  if (active) {
    return fail("ALREADY_IN_ROOM", 409, "you are already in a room", { roomCode: active.code, roomId: String(active._id) });
  }
  const room = await createRoomDoc({
    mode: m,
    seats: capacity,
    hostId: userId,
    status: "waiting",
    origin: "create",
    visibility: roomVisibility,
    // ★ 房主建完房自己就是 ready（他按下「建房」就是在说「我要玩」）；客人进来默认没准备
    members: [{ userId, ready: true, joinedAt: atOf(now) }],
    lastSeenAt: atOf(now),
  });
  return { ok: true, room: await snapshotOf(room, { viewerId: userId, now }) };
}

/**
 * POST /api/game/rooms/join —— `{ code }`
 *
 * 顺序（每条都对应一个明确的码，App 照它说人话）：
 *   码错 / 过期 → 404 `ROOM_NOT_FOUND`；已开局 → 409 `ROOM_ALREADY_STARTED`；
 *   已在房里 → 409 `ALREADY_IN_ROOM`（带快照：重复点击 / 换设备都当「你已经在里面」）；
 *   满员 → 409 `ROOM_FULL`（带 `seats` / `memberCount`）；在别的房里 → 409 `ALREADY_IN_ROOM`。
 */
async function joinRoom({ userId, code: rawCode, now = Date.now() }) {
  await sweepExpired({ now });
  const room = await loadRoom(rawCode, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  if (room.status !== "waiting") {
    return fail("ROOM_ALREADY_STARTED", 409, "this room has already started", { roomCode: room.code });
  }
  if (room.members.some((m) => sameId(m.userId, userId))) {
    return fail("ALREADY_IN_ROOM", 409, "you are already in this room", {
      roomCode: room.code,
      roomId: String(room._id),
      room: await snapshotOf(room, { viewerId: userId, now }),
    });
  }
  if (room.members.length >= config.capacityOf(room)) {
    return fail("ROOM_FULL", 409, "this room is full", {
      roomCode: room.code,
      seats: config.capacityOf(room),
      memberCount: room.members.length,
    });
  }
  const active = await findActiveRoomOf(userId, now);
  if (active && !sameId(active._id, room._id)) {
    return fail("ALREADY_IN_ROOM", 409, "you are already in another room", { roomCode: active.code, roomId: String(active._id) });
  }
  // ★ 容量与「没在里面」都写进**同一个**带条件的原子更新：两个人同时点进最后一个空位时，
  //   只有一个能成功（另一个落到下面的重新判因）。先查后写会两个人一起进去 = 5/4 人。
  // ★ 同一次更新里把自己从**观众席**拉出来（2026-11-24）：两张名单互斥 —— 先观战再看入局
  //   的人不能同时占着观众席（否则观众计数 +1、而他本人已经坐在座位上）。
  const updated = await GameRoom.findOneAndUpdate(
    {
      _id: room._id,
      status: "waiting",
      "members.userId": { $ne: userId },
      $expr: { $lt: [{ $size: "$members" }, config.capacityOf(room)] },
    },
    {
      $push: { members: { userId, ready: false, joinedAt: atOf(now) } },
      $pull: { spectators: { userId } },
      $set: { lastSeenAt: atOf(now) },
    },
    { returnDocument: "after" },
  );
  if (!updated) {
    const fresh = await GameRoom.findById(room._id);
    if (!fresh) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
    if (fresh.status !== "waiting") return fail("ROOM_ALREADY_STARTED", 409, "this room has already started", { roomCode: fresh.code });
    if (fresh.members.some((m) => sameId(m.userId, userId))) {
      return fail("ALREADY_IN_ROOM", 409, "you are already in this room", {
        roomCode: fresh.code,
        roomId: String(fresh._id),
        room: await snapshotOf(fresh, { viewerId: userId, now }),
      });
    }
    return fail("ROOM_FULL", 409, "this room is full", {
      roomCode: fresh.code,
      seats: config.capacityOf(fresh),
      memberCount: fresh.members.length,
    });
  }
  return { ok: true, room: await snapshotOf(updated, { viewerId: userId, now }) };
}

/**
 * POST /api/game/rooms/:code/leave
 *
 * · **房主走了 → 房主自动转移**给最早进房的那位（`hostIdOf` 的兜底，同一处判据）；
 * · 最后一个人走了 → 房间当场删掉（不留给懒清理：那几个人可能马上要再建一间，
 *   而「一人一间」的检查会把他们挡在已经没人的旧房外面）。
 */
async function leaveRoom({ userId, code: rawCode, now = Date.now() }) {
  const room = await loadRoom(rawCode, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  if (!room.members.some((m) => sameId(m.userId, userId))) {
    return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  }
  const updated = await GameRoom.findOneAndUpdate(
    { _id: room._id, "members.userId": userId },
    // ★ 顺手把自己从观众席也拉掉（2026-11-24）：留着的话「这个人已经走了」却仍占一个观众席位。
    //   正常情况下两者互斥（join 会把观众行拉出来），这里是兜底。
    { $pull: { members: { userId }, spectators: { userId } }, $set: { lastSeenAt: atOf(now) } },
    { returnDocument: "after" },
  );
  if (!updated) return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  if (!updated.members.length) {
    await GameRoom.deleteOne({ _id: updated._id });
    return { ok: true, left: true, closed: true, code: updated.code, roomId: String(updated._id), hostId: null, room: null };
  }
  const hostId = hostIdOf(updated);
  if (!sameId(updated.hostId, hostId)) {
    await GameRoom.updateOne({ _id: updated._id }, { $set: { hostId } });
    updated.hostId = hostId;
  }
  return {
    ok: true,
    left: true,
    closed: false,
    code: updated.code,
    roomId: String(updated._id),
    hostId: hostId ? String(hostId) : null,
    hostTransferred: !sameId(room.hostId, hostId),
    room: await snapshotOf(updated, { viewerId: userId, now }),
  };
}

/** POST /api/game/rooms/:code/ready —— `{ ready: boolean }`（只认布尔，不猜 0/1/"true"） */
async function setReady({ userId, code: rawCode, ready, now = Date.now() }) {
  if (typeof ready !== "boolean") return fail("BAD_READY", 400, "ready must be true or false");
  const room = await loadRoom(rawCode, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  // 观众不能写（唯一判据，见 spectatorWriteDenial）
  const spectatorDenied = spectatorWriteDenial(room, userId);
  if (spectatorDenied) return spectatorDenied;
  if (room.status !== "waiting") return fail("ROOM_ALREADY_STARTED", 409, "this room has already started", { roomCode: room.code });
  if (!room.members.some((m) => sameId(m.userId, userId))) {
    return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  }
  const updated = await GameRoom.findOneAndUpdate(
    { _id: room._id, status: "waiting", "members.userId": userId },
    { $set: { "members.$.ready": ready, lastSeenAt: atOf(now) } },
    { returnDocument: "after" },
  );
  if (!updated) return fail("ROOM_ALREADY_STARTED", 409, "this room has already started", { roomCode: room.code });
  return { ok: true, room: await snapshotOf(updated, { viewerId: userId, now }) };
}

/**
 * POST /api/game/rooms/:code/start —— **仅房主**
 *
 * 三道门，顺序就是 App 会依次撞到的顺序：
 *   ① 不是房主 → 403 `NOT_HOST`（带 `hostId`，客户端可以据此换个说法）；
 *   ② 已经开过 → 409 `ROOM_ALREADY_STARTED`；
 *   ③ 人数不够 → 409 `NOT_ENOUGH_PLAYERS`（`need` / `have`）；
 *   ④ 有人没准备 → 409 `NOT_ALL_READY`（`waitingOn` = 还没点准备的那些 id）。
 * 最后那条原子更新把「还在等」「人数够」「全员 ready」一起写进条件 ——
 * 否则两个人同时点开局、或者点开局的同时有人取消了准备，会出现「少一个人也开了」。
 */
async function startRoom({ userId, code: rawCode, now = Date.now() }) {
  const room = await loadRoom(rawCode, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  // 观众不能开局（**排在 NOT_HOST 之前**：观众本来就不是房主，报「你不是房主」会让人以为
  // 换个时机 / 换个人就能点，而事实是观众这一整类动作都不允许）
  const spectatorDenied = spectatorWriteDenial(room, userId);
  if (spectatorDenied) return spectatorDenied;
  const hostId = hostIdOf(room);
  if (!sameId(hostId, userId)) {
    return fail("NOT_HOST", 403, "only the host can start the game", { hostId: hostId ? String(hostId) : null });
  }
  if (room.status !== "waiting") return fail("ROOM_ALREADY_STARTED", 409, "this room has already started", { roomCode: room.code });
  const required = config.requiredPlayersOf(room);
  if (room.members.length < required) {
    return fail("NOT_ENOUGH_PLAYERS", 409, `this room needs ${required} players to start`, {
      need: required,
      have: room.members.length,
    });
  }
  const waitingOn = room.members.filter((m) => !m.ready).map((m) => String(m.userId));
  if (waitingOn.length) return fail("NOT_ALL_READY", 409, "some players are not ready", { waitingOn });
  const updated = await GameRoom.findOneAndUpdate(
    {
      _id: room._id,
      status: "waiting",
      $expr: { $gte: [{ $size: "$members" }, required] },
      members: { $not: { $elemMatch: { ready: false } } },
    },
    { $set: { status: "playing", startedAt: atOf(now), lastSeenAt: atOf(now) } },
    { returnDocument: "after" },
  );
  if (!updated) return fail("ROOM_ALREADY_STARTED", 409, "this room has already started", { roomCode: room.code });
  return { ok: true, room: await snapshotOf(updated, { viewerId: userId, now }) };
}

/** POST /api/game/rooms/:code/kick —— **仅房主**，`{ userId }`（不能踢自己） */
async function kickMember({ userId, code: rawCode, targetId, now = Date.now() }) {
  const room = await loadRoom(rawCode, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  // 观众不能踢人（同一判据；排在 NOT_HOST 之前，理由同 startRoom）
  const spectatorDenied = spectatorWriteDenial(room, userId);
  if (spectatorDenied) return spectatorDenied;
  const hostId = hostIdOf(room);
  if (!sameId(hostId, userId)) return fail("NOT_HOST", 403, "only the host can kick players", { hostId: hostId ? String(hostId) : null });
  if (room.status !== "waiting") return fail("ROOM_ALREADY_STARTED", 409, "this room has already started", { roomCode: room.code });
  const target = String(targetId ?? "").trim();
  if (!mongoose.isValidObjectId(target)) return fail("BAD_USER", 400, "userId must be a valid account id");
  if (sameId(target, userId)) return fail("CANNOT_KICK_SELF", 400, "the host cannot kick themselves (use leave instead)");
  const updated = await GameRoom.findOneAndUpdate(
    { _id: room._id, status: "waiting", "members.userId": target },
    { $pull: { members: { userId: target } }, $set: { lastSeenAt: atOf(now) } },
    { returnDocument: "after" },
  );
  if (!updated) return fail("MEMBER_NOT_FOUND", 404, "that player is not in this room", { roomCode: room.code });
  return { ok: true, kicked: target, room: await snapshotOf(updated, { viewerId: userId, now }) };
}

/**
 * GET /api/game/rooms/:code —— 快照（任何登录用户都能看：邀请链接要先能看到房间长什么样）
 * ★ 只有**成员**读才给房续命：路人 / 观众看一眼不该让一间没人管的房活着（2026-11-24 观战沿用
 *   这条：观众进席与读快照都不写 lastSeenAt，房间过期时观众一并清掉）。
 * ★ 观众读到的快照与成员读到的是**同一份形状**：现有快照本来就只给计数（成员身上的
 *   `likedByMe` / 回合里的 `votedByMe` 是「看的人」视角，不是别人的私有信息），所以不用给
 *   观众另做一份投影。观众自己的 `spectators.count` 也在这里。
 */
async function getRoom({ userId, code: rawCode, now = Date.now() }) {
  await sweepExpired({ now });
  const room = await loadRoom(rawCode, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  if (userId && room.members.some((m) => sameId(m.userId, userId))) await touch(room, now);
  return { ok: true, room: await snapshotOf(room, { viewerId: userId, now }) };
}

// ─────────────────────────────────────────────────────────────────────
// 观战（2026-11-24）：进 / 出观众席
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/game/rooms/:code/spectate —— 进观众席（2026-11-24）
 *
 * 不占座、不写 `members`：只往 `spectators[]` 里加一行 `{ userId, joinedAt }`，上限 20。
 * · 允许的房间状态：**任何活着的房**（`waiting` / `playing` / `over` 都能看 —— 观战最需要的
 *   恰恰是已经开打 / 已经结束的那两种；`over` 的房在过期之前还能看结算）；
 * · 已在房里的**玩家**不能观战自己的房 → 409 `ALREADY_IN_ROOM`（两张名单互斥）；
 * · 已经在观众席上 → **幂等成功**（`already: true`，不重复占位、不写库）；
 * · 满 20 → 429 `TOO_MANY_SPECTATORS`（带 `max` / `count`）。
 *
 * ★ 一人可以同时是**别的房**的玩家：观战不占座、也不参与「一人一间房」的检查（那条只数
 *   `members`，见 findActiveRoomOf）—— 「看着朋友打、自己在另一间等人」是正常需求。
 * ★ 观众进席**不给房间续命**（不写 lastSeenAt）：房间按成员的活跃度过期，过期时观众一并被
 *   清掉（删的是整份文档）。否则一间全员掉线的房会被围观的人永远钉在库里。
 * ★ 容量判定写进**同一个**原子更新的条件里（与 join 的容量闸同一条纪律）：20 个人同时点观战，
 *   只有第 20 个能进去；条件里还带 `members.userId: {$ne}` 与 `spectators.userId: {$ne}`，
 *   所以「先观战再入局」「双击观战」都只有一发落库。
 */
async function spectate({ userId, code: rawCode, now = Date.now() }) {
  await sweepExpired({ now });
  const room = await loadRoom(rawCode, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const at = atOf(now);

  let updated = null;
  for (let attempt = 0; attempt < 2 && !updated; attempt += 1) {
    if (attempt > 0) {
      const fresh = await GameRoom.findById(room._id);
      if (!fresh) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
      if (fresh.members.some((m) => sameId(m.userId, userId))) {
        return fail("ALREADY_IN_ROOM", 409, "you are already playing in this room", {
          roomCode: fresh.code,
          roomId: String(fresh._id),
        });
      }
      const mine = (fresh.spectators || []).find((spectator) => sameId(spectator.userId, userId));
      if (mine) return spectatorResult(fresh, mine, true);
      if ((fresh.spectators || []).length >= config.MAX_SPECTATORS) return tooManySpectators(fresh);
    }
    updated = await GameRoom.findOneAndUpdate(
      {
        _id: room._id,
        "members.userId": { $ne: userId },
        "spectators.userId": { $ne: userId },
        $expr: { $lt: [{ $size: { $ifNull: ["$spectators", []] } }, config.MAX_SPECTATORS] },
      },
      { $push: { spectators: { userId, joinedAt: at } } },
      { returnDocument: "after" },
    );
  }
  if (!updated) return fail("SPECTATE_CONFLICT", 409, "could not take a spectator seat, please retry");
  const mine = (updated.spectators || []).find((spectator) => sameId(spectator.userId, userId));
  return spectatorResult(updated, mine || { userId, joinedAt: at }, false);
}

/** 429 的统一形状（上限由 config/gameRoom.MAX_SPECTATORS 一处给） */
function tooManySpectators(room) {
  return fail("TOO_MANY_SPECTATORS", 429, `this room already has ${config.MAX_SPECTATORS} spectators`, {
    max: config.MAX_SPECTATORS,
    count: (room.spectators || []).length,
    roomCode: room.code,
  });
}

/** 观战成功的回包（`already` = 本来就在席上，不是这次挤进去的） */
async function spectatorResult(room, spectatorRow, already, now = Date.now()) {
  return {
    ok: true,
    spectating: true,
    already: Boolean(already),
    code: room.code,
    roomId: String(room._id),
    joinedAt: isoOf(spectatorRow?.joinedAt),
    spectators: { count: (room.spectators || []).length },
    // ★ 顺手给一份快照：App 点完「观战」直接就能画那一屏，不用再打一次 GET。
    //   形状与 GET /rooms/:code 的 room 同一份（见 snapshotOf）。
    room: await snapshotOf(room, { viewerId: spectatorRow?.userId ?? null, now }),
  };
}

/**
 * POST /api/game/rooms/:code/spectate/leave —— 出观众席（2026-11-24）
 *
 * **只**从 `spectators[]` 里拉掉自己：不碰 `members` —— 观众按的这个「离开」绝不能把
 * 别人的（或自己的）玩家座位退掉（玩家退房走 `POST /rooms/:code/leave`，两个端点分开）。
 * 幂等：本来就不是观众也回 200 `left:false`（换设备 / 重复点击 / 房间已经把自己清掉的兜底）。
 * 房间已经过期 → 404 `ROOM_NOT_FOUND`（与玩家 leave 同一口径：房间不存在就没什么可离开的）。
 * ★ 出席也不写 lastSeenAt（不为一个观众的离开续命）。
 */
async function leaveSpectate({ userId, code: rawCode, now = Date.now() }) {
  const room = await loadRoom(rawCode, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const updated = await GameRoom.findOneAndUpdate(
    { _id: room._id, "spectators.userId": userId },
    { $pull: { spectators: { userId } } },
    { returnDocument: "after" },
  );
  const fresh = updated || room;
  return {
    ok: true,
    left: Boolean(updated),
    spectating: false,
    code: room.code,
    roomId: String(room._id),
    spectators: { count: (fresh.spectators || []).length },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 公开房列表（2026-11-24）：大厅上「能进的房」
// ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/game/rooms —— 公开房列表（2026-11-24）
 *
 * 查询：`visibility`（只认 `public`，缺省 public）、`state`（`waiting` 缺省 / `playing` / `over`）、
 * `mode`（`match4` / `match8` / `custom`，缺省全部）、`page`（1 起，缺省 1）、`limit`（缺省 20、最大 50）。
 * 回包：`{ ok, visibility, state, mode, page, limit, total, rooms: [{ code, mode, seats, members,
 *   hostName, createdAt, state, joinable }] }`。
 *
 * ★★ 「能进的房」的判据（**择一：不列，而不是列出来标 joinable:false**；契约里写明）：
 *   · 只查 `visibility: "public"` —— private 房（含老客户端建的、撮合出来的）**永远不出现**；
 *   · 过期的不列：`lastSeenAt` 在按状态给的寿命内、而且至少还有 1 个成员（0 人的房立刻过期）；
 *   · `state=waiting`（缺省）时要**没满员**（`members.length < seats`）的房：大厅那一屏就是
 *     「点进去就能坐下」的房，摆一个满员的只会让人点进去吃 `ROOM_FULL`；
 *   · `state=playing` / `over` 是**显式**请求（围观 / 复盘），这时每行 `joinable: false` 仍然给 ——
 *     字段永远在，客户端不用先判 state 再判字段。
 * ★ 排序 `createdAt` 倒序（同秒按 `_id` 兜底，翻页不会同一条出现两次）；`total` 是**符合条件的
 *   总数**（不是本页条数），分页算得出来。
 * ★ 每次都现查（不缓存）：开关一开 / 一关必须是下一拍就生效；大厅每 2~5 秒轮询一次，一间房
 *   最多几十字节一行，20 行一拍。
 */
async function listPublicRooms({ visibility, state, mode, page, limit, now = Date.now() } = {}) {
  const wantVisibility = String(visibility ?? "").trim() || "public";
  if (wantVisibility !== "public") {
    // ★ 不悄悄回空列表：那会让「按 visibility 筛选」看起来像是「这一类房一间都没有」。
    return fail("BAD_VISIBILITY", 400, "only public rooms can be listed", { visibilities: ["public"] });
  }
  const wantState = String(state ?? "").trim() || config.PUBLIC_ROOM_DEFAULT_STATE;
  if (wantState !== "waiting" && wantState !== "playing" && wantState !== "over") {
    return fail("BAD_STATE", 400, "state must be one of waiting / playing / over", {
      states: ["waiting", "playing", "over"],
    });
  }
  const wantMode = String(mode ?? "").trim();
  if (wantMode && !config.isMode(wantMode)) {
    return fail("BAD_MODE", 400, `mode must be one of ${config.MODES.join(" / ")}`, { modes: config.MODES.slice() });
  }
  const pageNum = page === undefined || page === null || page === "" ? 1 : Number(page);
  if (!Number.isInteger(pageNum) || pageNum < 1) {
    return fail("BAD_PAGE", 400, "page must be an integer >= 1");
  }
  const limitNum = limit === undefined || limit === null || limit === "" ? config.PUBLIC_ROOM_PAGE_SIZE : Number(limit);
  if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > config.PUBLIC_ROOM_PAGE_SIZE_MAX) {
    return fail("BAD_LIMIT", 400, `limit must be an integer between 1 and ${config.PUBLIC_ROOM_PAGE_SIZE_MAX}`);
  }

  await sweepExpired({ now });

  /**
   * 过期判据与 isExpired 同一口径（`lastSeenAt` + 按状态的寿命）：Mongo 查不了「0 个人」之外的
   * 过期条件里的 0 人（$size 为 0 的房虽然 lastSeenAt 可能还新，但 isExpired 立刻算过期），
   * 所以再补一条「至少有一个成员」。
   */
  const query = {
    visibility: "public",
    status: wantState === "over" ? { $in: ["over", "closed"] } : wantState,
    "members.0": { $exists: true },
    lastSeenAt: { $gte: atOf(now - config.ttlMsFor(wantState)) },
  };
  if (wantMode) query.mode = wantMode;
  if (wantState === "waiting") {
    // ★ 用**落库的 seats**（它本来就是「能坐几个人」，见 models 的字段注释）：满员的不列。
    //   不在查询里重写一遍 capacityOf 的规则 —— 那份规则（match 模式锁死 / custom 自选）
    //   只在 config 一处，Mongo 里再写一遍就是第二个真相。
    query.$expr = { $lt: [{ $size: "$members" }, { $ifNull: ["$seats", config.MIN_CUSTOM_SEATS] }] };
  }

  const [total, rows] = await Promise.all([
    GameRoom.countDocuments(query),
    GameRoom.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .select("code mode seats members hostId status visibility createdAt")
      .lean(),
  ]);

  const hostIds = [...new Set(rows.map((room) => hostIdOf(room)).filter(Boolean).map((id) => String(id)))];
  const users = hostIds.length ? await User.find({ _id: { $in: hostIds } }).select("_id username").lean() : [];
  const nameById = new Map(users.map((user) => [String(user._id), user.username || null]));

  return {
    ok: true,
    visibility: "public",
    state: wantState,
    mode: wantMode || null,
    page: pageNum,
    limit: limitNum,
    total,
    hasMore: pageNum * limitNum < total,
    rooms: rows.map((room) => {
      const state = stateOf(room);
      const seatCount = config.capacityOf(room);
      const memberCount = (room.members || []).length;
      const hostId = hostIdOf(room);
      return {
        code: room.code,
        mode: room.mode,
        seats: seatCount,
        /** 成员**人数**（不是成员数组）：大厅卡片只写「2/4 人」，名单要进房 / 进观众席才看 */
        members: memberCount,
        hostName: hostId ? nameById.get(String(hostId)) || null : null,
        createdAt: isoOf(room.createdAt),
        state,
        /** 能不能直接 `join` 进去（缺省那一屏恒 true；显式查 playing / over 时恒 false） */
        joinable: state === "waiting" && memberCount < seatCount,
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 匹配队列（进队 / 续队 / 状态 / 离队）
// ─────────────────────────────────────────────────────────────────────

/** 还差几个人 × 每人多少秒（只是大厅上那句「约 N 秒」的估算，不是承诺） */
function etaOf(queued, need) {
  if (!need) return null;
  return queued >= need ? 0 : (need - queued) * config.ETA_PER_MISSING_SLOT_SEC;
}

/** 两个池子现在各有几个人（大厅上「4 人匹配 2/4」那两行）；一次 aggregate 拿全 */
async function poolsOf(now) {
  const cutoff = atOf(now - config.QUEUE_HEARTBEAT_MS);
  const rows = await GameQueue.aggregate([
    { $match: { status: "waiting", lastSeenAt: { $gte: cutoff } } },
    { $group: { _id: "$mode", n: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((r) => [r._id, r.n]));
  const pools = {};
  for (const mode of config.QUEUE_MODES) {
    pools[mode] = { queued: counts.get(mode) || 0, need: config.seatsFor(mode), etaSec: etaOf(counts.get(mode) || 0, config.seatsFor(mode)) };
  }
  return pools;
}

function idleQueueResult(pools) {
  return { ok: true, status: "idle", mode: null, queued: null, need: null, etaSec: null, position: null, pools };
}

async function waitingQueueResult(row, now) {
  const mode = row.mode;
  const need = config.seatsFor(mode);
  const cutoff = atOf(now - config.QUEUE_HEARTBEAT_MS);
  const queued = await GameQueue.countDocuments({ mode, status: "waiting", lastSeenAt: { $gte: cutoff } });
  const ahead = await GameQueue.countDocuments({
    mode,
    status: "waiting",
    lastSeenAt: { $gte: cutoff },
    enqueuedAt: { $lt: new Date(row.enqueuedAt) },
  });
  return {
    ok: true,
    status: "waiting",
    mode,
    queued,
    need,
    etaSec: etaOf(queued, need),
    position: ahead + 1,
    enqueuedAt: isoOf(row.enqueuedAt),
    pools: await poolsOf(now),
  };
}

/** 匹配成功的回包 —— **房间码就是从这一格里给出去的**（两个客户端读到同一个 code） */
async function matchedQueueResult(row, room, now) {
  return {
    ok: true,
    status: "matched",
    mode: row.mode,
    queued: null,
    need: config.seatsFor(row.mode),
    etaSec: 0,
    position: null,
    code: room.code,
    roomId: String(room._id),
    matchedAt: isoOf(row.matchedAt),
    room: await snapshotOf(room, { viewerId: row.userId, now }),
    pools: await poolsOf(now),
  };
}

/** 那一行 matched 指向的房间还活着吗（还活着、而且我真的是它的成员才算数） */
async function matchedRoomOf(row, now = Date.now()) {
  if (!row?.roomId) return null;
  const room = await GameRoom.findById(row.roomId);
  if (!room) return null;
  if (isExpired(room, now)) {
    await GameRoom.deleteOne({ _id: room._id });
    return null;
  }
  if (!room.members.some((m) => sameId(m.userId, row.userId))) return null;
  return room;
}

/**
 * 轻量撮合（**在进队 / 续队的那一次请求里跑**，没有后台撮合进程）。
 *
 * ★★ 为什么不能「查一下够不够、够了就建房」：两个请求可能同时看到同样 4 个人，
 *   于是两间房抢同一批人（甚至同一个人被塞进两间）。所以这里对**每一个**候选人都是一次
 *   带条件的原子更新（`status: "waiting"` 才会被改成 matched）——
 *   抢不到的那个人直接跳过；凑不满就**把自己刚占的几个人放回队里**（位置不变：`enqueuedAt` 没动），
 *   这一拍不撮合，下一次轮询再来（客户端每 2~5 秒一拍，天然重试）。
 * ★ 会有「两个人各抢到 2 个、然后都放回去」的抖动。绝不为此 sleep 重试 ——
 *   那会把两个人的请求都拖住，而且下一个 tick（几秒后）就撮合上了。
 */
async function tryMatch(mode, now) {
  const need = config.seatsFor(mode);
  if (!need) return null;
  const cutoff = atOf(now - config.QUEUE_HEARTBEAT_MS);
  const candidates = await GameQueue.find({ mode, status: "waiting", lastSeenAt: { $gte: cutoff } })
    .sort({ enqueuedAt: 1, _id: 1 })
    .limit(need)
    .select("_id")
    .lean();
  if (candidates.length < need) return null;
  const claimed = [];
  try {
    for (const candidate of candidates) {
      const row = await GameQueue.findOneAndUpdate(
        { _id: candidate._id, status: "waiting" },
        { $set: { status: "matched", matchedAt: atOf(now) } },
        { returnDocument: "after" },
      ).lean();
      if (row) claimed.push(row);
    }
    if (claimed.length < need) {
      // ★ 只回滚**还没被写进任何房间**的那几行（`roomId: null`）：另一个撮合者可能
      //   已经在同一拍里把某几行配上房了，这里无脑回滚会把它刚建好的匹配打回 waiting
      //   （症状：四个人的队列状态一会儿 matched 一会儿 waiting，永远进不去）。
      await GameQueue.updateMany(
        { _id: { $in: claimed.map((r) => r._id) }, roomId: null },
        { $set: { status: "waiting", matchedAt: null } },
      );
      return null;
    }
    claimed.sort((a, b) => new Date(a.enqueuedAt) - new Date(b.enqueuedAt));
    const room = await createRoomDoc({
      mode,
      seats: need,
      hostId: claimed[0].userId,
      status: "waiting",
      origin: "match",
      // ★ 撮合出来的人**建成即 ready**（见 models/GameRoom 的 ready 注释）：
      //   点「匹配」本身就是「我要玩」，再要一次准备只会让整桌卡在「有人没点」。
      members: claimed.map((r) => ({ userId: r.userId, ready: true, joinedAt: atOf(now) })),
      lastSeenAt: atOf(now),
    });
    await GameQueue.updateMany(
      { _id: { $in: claimed.map((r) => r._id) } },
      { $set: { roomId: room._id, code: room.code } },
    );
    return room;
  } catch (err) {
    // 建房失败：把刚占住的人放回队里，让他们下一次轮询继续（否则这几个人卡在
    // matched 且没有房，`GET /api/game/queue` 会一直说「你匹配上了」而进不去）。
    await GameQueue.updateMany(
      { _id: { $in: claimed.map((r) => r._id) }, roomId: null },
      { $set: { status: "waiting", matchedAt: null } },
    ).catch(() => {});
    throw err;
  }
}

/**
 * POST /api/game/queue —— 进队 / 续队（**也是撮合的那一拍**）。
 *
 * `{ mode: "match4"|"match8" }`
 * · 已经在 waiting：续队只刷心跳（`lastSeenAt`），**不动 `enqueuedAt`**（谁续得勤谁吃亏是不行的）；
 * · 已经在 matched 且房间还活着：照回 matched + 房号（客户端重试 / 换页面都能拿到）；
 * · matched 但房间没了（过期 / 被删）：把这一行清掉、重新排队；
 * · 换模式：409 `QUEUE_MODE_CONFLICT`（先 `DELETE /api/game/queue`，不替你静默丢掉位置）；
 * · 已经在某间房里：409 `ALREADY_IN_ROOM`。
 */
async function enqueue({ userId, mode, now = Date.now() }) {
  const m = String(mode ?? "").trim();
  if (!config.isQueueMode(m)) {
    return fail("BAD_MODE", 400, `mode must be one of ${config.QUEUE_MODES.join(" / ")}`, { modes: config.QUEUE_MODES.slice() });
  }
  await sweepExpired({ now });
  const active = await findActiveRoomOf(userId, now);
  if (active) {
    return fail("ALREADY_IN_ROOM", 409, "you are already in a room", { roomCode: active.code, roomId: String(active._id) });
  }
  let row = await GameQueue.findOne({ userId });
  if (row && row.status === "matched") {
    const live = await matchedRoomOf(row, now);
    if (live) return matchedQueueResult(row, live, now);
    await GameQueue.deleteOne({ _id: row._id });
    row = null;
  }
  if (row && row.mode !== m) {
    return fail("QUEUE_MODE_CONFLICT", 409, `you are queued for ${row.mode}`, { queuedMode: row.mode });
  }
  if (!row) {
    try {
      row = await GameQueue.create({ userId, mode: m, status: "waiting", enqueuedAt: atOf(now), lastSeenAt: atOf(now) });
    } catch (err) {
      // 并发进队：唯一索引挡住了第二行 → 读回同一行，当成续队
      if (err?.code !== 11000) throw err;
      row = await GameQueue.findOne({ userId });
      if (!row) throw err;
      if (row.mode !== m) return fail("QUEUE_MODE_CONFLICT", 409, `you are queued for ${row.mode}`, { queuedMode: row.mode });
    }
  }
  row.lastSeenAt = atOf(now);
  await row.save();
  const room = await tryMatch(m, now);
  if (room) {
    const mine = await GameQueue.findOne({ userId }).lean();
    return matchedQueueResult(mine || row, room, now);
  }
  return waitingQueueResult(row, now);
}

/**
 * GET /api/game/queue —— 我的排队状态。
 * `status`: `idle` / `waiting` / `matched`；`pools` 永远给（大厅要摆「4 人匹配 2/4」）。
 */
async function queueStatus({ userId, now = Date.now() }) {
  await sweepExpired({ now });
  const pools = await poolsOf(now);
  const row = await GameQueue.findOne({ userId });
  if (!row) return idleQueueResult(pools);
  if (row.status === "matched") {
    const live = await matchedRoomOf(row, now);
    if (live) return { ...(await matchedQueueResult(row, live, now)), pools };
    await GameQueue.deleteOne({ _id: row._id });
    return idleQueueResult(pools);
  }
  return { ...(await waitingQueueResult(row, now)), pools };
}

/** DELETE /api/game/queue —— 离队（幂等：没在排队也回 200，`left:false`） */
async function dequeue({ userId }) {
  const res = await GameQueue.deleteOne({ userId });
  return { ok: true, left: (res.deletedCount || 0) > 0 };
}

module.exports = {
  // 房间
  createRoom,
  joinRoom,
  leaveRoom,
  setReady,
  startRoom,
  kickMember,
  getRoom,
  // 公开房列表（2026-11-24）
  listPublicRooms,
  // 观战（2026-11-24）：进 / 出观众席（与玩家 leave 分开）
  spectate,
  leaveSpectate,
  // 队列
  enqueue,
  queueStatus,
  dequeue,
  // 快照 / 清理（路由与测试用）
  snapshotOf,
  sweepExpired,
  // 判据（测试与回合引擎用；**别再实现一遍**）
  hostIdOf,
  visibilityOf,
  isSpectatorOf,
  spectatorWriteDenial,
  isExpired,
  normalizeCode,
  startBlockedByOf,
  // 对外形状（快照与历史回合同一处）：`state` 三态映射、时间统一成 ISO 串（null 稳定，见各自函数头）
  stateOf,
  isoOf,
  // 回合引擎要共用同一份「按房号取活房 / 成员读续命」：expire 那条判据只有这里一处，
  // 回合引擎自己再写一遍 loadRoom 就会变成「房间过期了但回合端点还认」的第二个真相。
  loadRoom,
  touch,
  sameId,
};
