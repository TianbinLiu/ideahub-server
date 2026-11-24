// src/config/gameRoom.js
// 「工坊对局」的房间 / 匹配规则表与总开关（2026-11-23，G5 联机的第一块：HTTP 轮询版，先不做 WebSocket）。
//
// 设计来源（都是**产品口径**，不是我定的）：
//   · app 仓 `docs/workshop-game-design.md` §三「对局 → 服务端房间协议：创建/匹配/…」与 §四 G5「联机」；
//   · app 仓 `docs/g2-game-ui.md` 的大厅需求：4 人匹配 / 8 人匹配 / 自定义房间邀请。
//
// ★★ 这一块**只做「谁跟谁在一局里」**：建房 / 进房 / 准备 / 开局 / 踢人 / 排队。
//   「回合怎么推进、点赞投票、扣血淘汰」一条都不在这里 —— 那是 G5 后面的回合引擎，
//   而且它一上来就需要服务端主动推送（WebSocket / SSE），现在的 HTTP 轮询撑不住。
//   所以 `status: "playing"` 之后这个模块**不再推进任何东西**，它只是把状态记下来给客户端看。
//
// ★ 所有数额都是**代码常量**，不做环境变量（与 config/gameTicket 同一条纪律：产品的规则表，
//   改数要过代码评审）。进了环境变量的只有「过期多少分钟」这一类**运维旋钮** ——
//   它们的默认值是缺省即可用的，调它们不会改变玩法。

/** 对局模式。`match4` / `match8` 是排队撮合出来的，`custom` 是房主建房 + 把 6 位房号给朋友 */
const MODES = Object.freeze(["match4", "match8", "custom"]);
/** 能进匹配队列的模式（自定义房间不排队：它靠房号邀请） */
const QUEUE_MODES = Object.freeze(["match4", "match8"]);

/**
 * 两种匹配模式各自的座位数 —— **唯一实现**。
 * ★ 匹配成功时 `seats` 与「要凑够几个人」是同一个数（4 人匹配 = 4 座 4 人），
 *   所以两边都问它：撮合那边问 `seatsFor`，开局校验问 `requiredPlayersOf`（它对 custom 另给 2）。
 */
const MATCH_SEATS = Object.freeze({ match4: 4, match8: 8 });

/** 自定义房间的座位范围（房主自己选 2~8） */
const MIN_CUSTOM_SEATS = 2;
const MAX_SEATS = 8;

/**
 * 自定义房间开局的**最低人数**。
 * ★ 不是「房主选的座位数」：选了 8 座的房间，2 个人也想先玩一局；
 *   而 4 人匹配 / 8 人匹配的「人数达标」就是它自己的座位数（少一个都不是那一局）。
 */
const MIN_PLAYERS_TO_START = 2;

/** 房号：6 位，去掉 I / O / 0 / 1（口述 / 手抄会认错的那几个字符） */
const CODE_LENGTH = 6;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * 房号生成撞车时的重试次数。
 * 32^6 ≈ 10.7 亿，30 天内不可能撞上；这里只是把「撞了就当脏数据」变成「重来一次」。
 * 真撞满 5 次 = 世界上有 5 个一模一样的码还都在用，那已经不是这个模块的问题了。
 */
const CODE_ATTEMPTS = 5;

/**
 * 一间「还在等人」的房间多久没有任何动作就算过期（分钟）。
 * ★ 判据是 `lastSeenAt`（**成员的轮询**会续命），不是 `updatedAt`（最后一次状态变化）——
 *   见 models/GameRoom.js 的 ★★：一个开了 40 分钟还没开局的房，只要还有人每隔几秒
 *   在轮询快照，它就不该被清掉；反过来没人看的房 30 分钟就该消失。
 * ★ 故意**不用 Mongo TTL**：TTL 只认一个绝对时间点，删不掉「0 个人的房」这种
 *   结构化条件，也没法只删 `waiting` 而不动 `playing`；而且「读的时候顺手删」比
 *   每个 cluster 实例都跑一个定时任务简单得多（铁律八：常驻任务先问要跑几份）。
 * ★ 环境变量按**分钟**收（`GAME_ROOM_TTL_MINUTES`），常量本身是**毫秒**（下面几个都是）。
 */
const ROOM_TTL_MS = readMinutes("GAME_ROOM_TTL_MINUTES", 30, 5, 240);

/**
 * `playing` 的房间多久过期（分钟）。
 * ★ 比等待房长得多：这一局可能真的在打。但**回合引擎还没接**，
 *   所以 `playing` 之后没有任何东西会把它推到 `closed` —— 给一个兜底寿命，
 *   免得每一局都留下一行永远不死的房间（以及「这个人永远在房间里、再也排不了队」）。
 */
const PLAYING_ROOM_TTL_MS = readMinutes("GAME_ROOM_PLAYING_TTL_MINUTES", 120, 30, 1440);

/**
 * 懒清理的节流间隔（毫秒）。
 * ★ 每个**读**接口都会顺带清理过期房，但 4 个人的大厅每 2 秒轮询一次，
 *   不节流就是每 2 秒一条 deleteMany。节流之后最多每 30 秒扫一遍；
 *   真正被读到的那个过期房**不靠**这轮扫描（它是单独判的，见 service.loadRoom）。
 */
const SWEEP_MIN_INTERVAL_MS = 30 * 1000;

/**
 * 排队心跳：`waiting` 的那一行多久没被续过就算人走了（环境变量按**秒**收，常量是毫秒）。
 * ★ 客户端节奏是每 2~5 秒一次 `POST /api/game/queue`（= 续队，也是撮合的那一拍），
 *   90 秒是三四十拍没来 —— 手机关屏 / 杀进程 / 断网，都该把位置让出来，
 *   否则「撮合出来的房间里有个人永远不会来」，另外三个人只能干等到过期。
 */
const QUEUE_HEARTBEAT_MS = readSeconds("GAME_QUEUE_HEARTBEAT_SEC", 90, 20, 600);

/**
 * 撮合成功之后，那一行「已匹配 + 房号」在队列里留多久（分钟）。
 * ★ 必须留：撮合是在**别人的请求里**发生的，本人此时可能正处在两次轮询之间，
 *   删掉那一行 = 他把房间码彻底错过了（下次 `GET /api/game/queue` 只会说自己没在排队）。
 *   留一个够长的窗口让他读到房号，`DELETE /api/game/queue` 是「我看过了 / 我不去了」的显式收尾。
 */
const MATCH_TTL_MS = readMinutes("GAME_QUEUE_MATCH_TTL_MINUTES", 10, 1, 60);

/**
 * 「预计等待」的估算参数：还差几个人 × 每人平均等多少秒。
 * ★ 只是个**示意值**（大厅上写「约 30 秒」），不是承诺：真实等待取决于此刻有没有人在排。
 *   所以只按「还差几个人」线性估，不装作用历史数据算出来的。
 */
const ETA_PER_MISSING_SLOT_SEC = 30;

/**
 * 总开关。缺省**开**；`GAME_ROOMS=off` 关掉（不用发版）。
 * ★ 关着的时候：`/api/game/rooms*` 与 `/api/game/queue*` 一律 503 `GAME_ROOMS_OFF`，
 *   `/api/ark/health` 的 `gameRooms` 报 false（App 据此不摆大厅入口）。
 * ★ 每次现读环境变量（不在模块加载时定死）：测试要在同一个进程里开关它。
 */
function enabled() {
  return String(process.env.GAME_ROOMS ?? "").trim().toLowerCase() !== "off";
}

function intFromEnv(name, fallback, min, max, scale) {
  const raw = String(process.env[name] ?? "").trim();
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  const value = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, value)) * scale;
}

function readMinutes(name, fallback, min, max) {
  return intFromEnv(name, fallback, min, max, 60 * 1000);
}

function readSeconds(name, fallback, min, max) {
  return intFromEnv(name, fallback, min, max, 1000);
}

function isMode(mode) {
  return MODES.includes(mode);
}

function isQueueMode(mode) {
  return QUEUE_MODES.includes(mode);
}

/** 匹配模式的座位数（= 要凑够的人数）；custom 不在这里回答，返回 null */
function seatsFor(mode) {
  return MATCH_SEATS[mode] ?? null;
}

/**
 * 这间房**开局**要几个人 —— 三处（建房校验 / 开局校验 / 快照里的 `requiredPlayers`）共用这一个答案。
 * match4 → 4、match8 → 8、custom → 2（不看房主选了几座，见 MIN_PLAYERS_TO_START 的 ★）。
 */
function requiredPlayersOf(room) {
  const mode = room?.mode;
  if (mode === "match4" || mode === "match8") return MATCH_SEATS[mode];
  return MIN_PLAYERS_TO_START;
}

/** 这间房能坐几个人（custom 是房主选的，匹配模式恒等于座位数） */
function capacityOf(room) {
  const mode = room?.mode;
  if (mode === "match4" || mode === "match8") return MATCH_SEATS[mode];
  return Number(room?.seats) || MIN_CUSTOM_SEATS;
}

/** 按状态给寿命（毫秒） */
function ttlMsFor(status) {
  return status === "playing" ? PLAYING_ROOM_TTL_MS : ROOM_TTL_MS;
}

module.exports = {
  MODES,
  QUEUE_MODES,
  MATCH_SEATS,
  MIN_CUSTOM_SEATS,
  MAX_SEATS,
  MIN_PLAYERS_TO_START,
  CODE_LENGTH,
  CODE_ALPHABET,
  CODE_ATTEMPTS,
  ROOM_TTL_MS,
  PLAYING_ROOM_TTL_MS,
  SWEEP_MIN_INTERVAL_MS,
  QUEUE_HEARTBEAT_MS,
  MATCH_TTL_MS,
  ETA_PER_MISSING_SLOT_SEC,
  enabled,
  isMode,
  isQueueMode,
  seatsFor,
  requiredPlayersOf,
  capacityOf,
  ttlMsFor,
};
