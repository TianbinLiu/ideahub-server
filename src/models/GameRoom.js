// src/models/GameRoom.js
// 「工坊对局」的一间房（集合 `gamerooms`，2026-11-23，G5 联机的第一块：HTTP 轮询版）。
//
// 设计来源：app 仓 `docs/workshop-game-design.md` §三「服务端房间协议」+ `docs/g2-game-ui.md`
// 的大厅需求（4 人匹配 / 8 人匹配 / 自定义房间邀请）。
//
// ══ 回合数据为什么也在这张表里（2026-11-23 回合引擎接上之后）═════════════════════════════
//   每一回合的交片 / 点赞 / 投票 / 结算榜单都存在房间文档的 `rounds[]` 里，**没有独立集合**。
//   · 回合的读写都是「这一桌的那一份」：一回合最多 8 条作品，文档远小于 16MB（8 回合 × 8 条 ×
//     几百字节）；独立集合每读一次房间还要再查一次，而且「删房间」要再记得级联删回合 ——
//     漏一次就是一堆没有房间的孤儿作品。
//   · 点赞 / 投票的**原子性**正是靠同一份文档：`$push` 的条件里同时判「这一回合还在 screening /
//     这个人还没点过」，一个人同时点两次只有一次能中（见 services/gameRound.service）。
//   · 过期懒清理删房间 = 回合数据一起没（`GameRoom.deleteOne` 删的是整份文档）——
//     这就是「清理逻辑带着回合数据一起」的实现，没有第二处要同步清理的表。
//   ★ 代价：房间文档会随回合数长大。今天没有回合上限之前，一局理论上是「打到剩 ≤2 人」，
//     8 回合 × 8 人的量级仍在几十 KB；真要把回合数放开，再谈把 `rounds` 拆出去。
//
// ══ 为什么只有「谁跟谁在一局里」，没有别的对局状态 ═══════════════════════════════════════
//   出片 / 展映 / 点赞 / 投票 / 扣血淘汰的推进都靠**客户端轮询 + 房主点**，服务端不主动推；
//   这张表只回答「房间还在不在、谁在里面、谁准备好了、这一回合走到哪」。
//
// ══ ★★ 为什么有 lastSeenAt 和 updatedAt 两个时间，而不是只用 updatedAt ════════════════
//   需求写的是「`updatedAt` 超过 N 分钟就懒清理」。照字面实现有两个坑：
//     ① 大厅是 HTTP 轮询的，3 个人每 2 秒 GET 一次快照。轮询要是**不**续命，
//        一个正常等待中的房会在第 30 分钟被清理掉（人还在屏幕前，房没了）；
//     ② 轮询要是**按 updatedAt 续命**（Mongoose 的 updateOne 默认会顺手改 updatedAt），
//        那 `updatedAt` 就永远是「刚才」，界面上的「更新时间」变了一句废话。
//   ⇒ 分成两个字段，各回答一件事：
//     · `updatedAt`（timestamps 自动维护）= 最后一次**状态变化**（进房 / 准备 / 开局 / 踢人）；
//       客户端拿它显示「这房多久没动静了」，服务端**不**拿它判过期。
//     · `lastSeenAt` = 最后一次**有人在看**（成员轮询快照 / 上面那些动作）。
//       过期判它 —— 没人看的房才会死。续命那一刻显式 `timestamps: false`，
//       免得把 updatedAt 也一起改了（见 services/gameRoom.service.touch）。
//
// ══ ★ 座位为什么不是字段 ══════════════════════════════════════════════════════════
//   座位 = `members` 数组里的下标（加入顺序）。存成字段就要在「有人离开」时重排
//   （否则座位号会留洞、下一个人的座号算出来是空的），一次改动两个写库点必然漂移。
//   派生量的代价只有一处：快照里现算 `seat: index`（service.snapshotOf）。
const mongoose = require("mongoose");
const { MODES, MIN_CUSTOM_SEATS, MAX_SEATS } = require("../config/gameRoom");
const { START_HP } = require("../config/gameRound");

/** 房间里的一个人。★ 只存 id：用户名 / 头像在**读**的时候现拼（见文件头「不存敏感信息」） */
const memberSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /**
     * 准备好了没有。`match4` / `match8` 撮合出来的房**建成即 ready**：
     * 点「4 人匹配」本身就已经是「我要开始玩」的明确表态，再要一次准备只会
     * 让「有人没来得及点」把整桌卡在这里（没有超时踢人的机制）。
     */
    ready: { type: Boolean, default: false },
    /**
     * 血量（回合引擎，2026-11-23）。开局 100，每回合结算按名次扣；`0` = 淘汰（**不另存
     * eliminated 布尔**：两个字段同时存在就会出现「hp=0 但 eliminated=false」这种自相矛盾的行，
     * 判据只在 services/gameRound.service 的 hpOf 一处）。老房间没有这一位时按 START_HP 读。
     */
    hp: { type: Number, default: START_HP, min: 0 },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** 一条交片（一期作品）。★ `_id:false`：对外只认 userId（一人一条），内部不需要第二个 id */
const roundEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    prompt: { type: String, required: true },
    /** 卡名（App 侧的卡在客户端是完整 GameCard；服务端只保留展映 / 复盘要看的那几个字） */
    cardNames: { type: [String], default: [] },
    /** 真出片的地址（G4 之后才有；今天占位片的 videoUrl 是 App 本地的占位资源） */
    videoUrl: { type: String, default: null },
    posterUrl: { type: String, default: null },
    /** 占位片标记（没券 / 不接生成时服务端只记这一位，App 播占位色块） */
    placeholder: { type: Boolean, default: false },
    modelTier: { type: String, default: null },
    submittedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** 一次点赞：谁点了谁。★ 只存 id：**每条作品被谁点过不对外暴露**（快照只给计数与 likedByMe） */
const roundLikeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** 一张票 / 一次弃权：`targetUserId: null` = 弃权（也要留一行，否则「全员表态」永远凑不齐） */
const roundVoteSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * 回合间事件的一次选择（第 2/4/6 回合结算之后的三选一，2026-11-23）。
 * ★ **不存事件 id**：出哪个事件是 `(roomCode, round)` 的纯函数（config/gameEvent.eventFor），
 *   存一份 id 就是第二处真相（表一改、旧回合里那份 id 就指不到任何事件）。
 * ★ 一人一行、**第一选作数**（App 规则同一条：投过 / 选过再点不改）。服务端只存 `userId`：
 *   名字在读快照时现拼（与房间成员同一条纪律），选项本身在 config/gameEvent 里。
 * ★ 这里只落「谁选了什么」；**唯一由服务端执行的效果是 hp**（见 config/gameEvent 文件头），
 *   写在这条选择落的同一次原子更新里，所以重复 / 并发选择不会把血加两次。
 */
const roundEventPickSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** 选项 id；`"skip"` = App 的跳过出口（三选一全落不了账时仍然能表态，见 config/gameEvent） */
    optionId: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** 结算榜上的一行。★ 存**结果**不存输入：结算是这一回合的终态，下一回合 read 它只用于复盘 */
const settlementRowSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    likes: { type: Number, required: true },
    votes: { type: Number, required: true },
    likeRank: { type: Number, required: true },
    voteRank: { type: Number, required: true },
    composite: { type: Number, required: true },
    damage: { type: Number, required: true },
    hp: { type: Number, required: true },
    eliminated: { type: Boolean, default: false },
  },
  { _id: false },
);

const roundSettlementSchema = new mongoose.Schema(
  {
    ranking: { type: [settlementRowSchema], default: [] },
    /** 剩到胜者名额时的人（**userId**；名字在读的时候现拼，与房间成员同一条纪律） */
    winners: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], default: [] },
    settledAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * 一回合。`phase` 只由 services/gameRound.service 推进：
 *   creating → screening → voting → settled
 * （`screening` 要全员已交片；`voting` 从 screening 进；`settled` 之后只能 next）
 */
const roundSchema = new mongoose.Schema(
  {
    /** 1 起。★ 对外叫 `round`，就是它 */
    round: { type: Number, required: true },
    phase: { type: String, required: true, enum: ["creating", "screening", "voting", "settled"], default: "creating" },
    startedAt: { type: Date, default: Date.now },
    phaseChangedAt: { type: Date, default: Date.now },
    /** 一人一条（重复交片覆盖），**不在这里判重**：原子 upsert 在 service 里（README 的「一人一条」） */
    entries: { type: [roundEntrySchema], default: [] },
    /** 这一回合的点赞（不是作品上的数组：点赞的「一人一条一次」判据只要看这一层） */
    likes: { type: [roundLikeSchema], default: [] },
    /** 这一回合的票（含弃权行） */
    votes: { type: [roundVoteSchema], default: [] },
    settlement: { type: roundSettlementSchema, default: null },
    /**
     * 这一回合结算之后的**事件选择**（只有第 2/4/6 回合会有行）。
     * ★ 事件本身不落库：哪个事件是 `(房号, 回合)` 的纯函数（config/gameEvent.eventFor）；
     *   这里只记「谁选了什么」，用来算 `myChoice` / `allChosen`（跨端一致的那两个数）。
     */
    eventPicks: { type: [roundEventPickSchema], default: [] },
  },
  { _id: false },
);

const gameRoomSchema = new mongoose.Schema(
  {
    /**
     * 6 位房号（`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，去掉了 I/O/0/1）。
     * ★ 这是**对外唯一**的房间标识：App 拿它进房、拉快照、邀请朋友。
     *   `_id` 只在服务端内部用（queue 行指向它），两端都不要互相当成对方。
     */
    code: { type: String, required: true },
    mode: { type: String, required: true, enum: MODES },
    /** 能坐几个人（match4=4 / match8=8 / custom 房主选 2~8）。★ 与「开局要几个人」不是一回事，见 config */
    seats: { type: Number, required: true, min: MIN_CUSTOM_SEATS, max: MAX_SEATS },
    /** 房主。★ 只在「退房 / 踢人」时看它；判据是 service.hostIdOf（房主不在房里时自动落到最早进房的人） */
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /**
     * 房间状态机：`waiting` → `playing`（房主开局）→ `over`（打完一局：`POST /rounds/next` 在
     * `GAME_OVER` 那一刻落库，见 services/gameRound.service.nextRound）。
     * ★ `closed` 是早先留的值（今天没有任何东西写它）；留着是为了老数据不触发 enum 校验，
     *   快照对外只报 `state: waiting|playing|over`（closed 归到 over 那一档）。
     * ★ 过期清理是硬删，与状态无关。
     */
    status: { type: String, required: true, enum: ["waiting", "playing", "over", "closed"], default: "waiting" },
    /** 房间成员，**数组顺序就是座位顺序**（文件头 ★）。最多 8 个（8 人匹配） */
    members: { type: [memberSchema], default: [] },
    /**
     * 这一局的回合历史（**只追加**：next 时 push 一条新回合，旧的点赞 / 投票 / 榜单都留着）。
     * ★ 当前回合 = 数组最后一条（service.currentRoundOf 一处读它，不另存 currentRound 指针 ——
     *   指针和数组是两处真相，一次崩溃就能让它们说不同的话）。
     */
    rounds: { type: [roundSchema], default: [] },
    /**
     * 这间房怎么来的：`create`（房主自建）/ `match`（服务端撮合建出来的）。
     * ★ 只为「事后数一数匹配到底撮合了多少局」与排查留的，不参与任何判定。
     */
    origin: { type: String, enum: ["create", "match"], default: "create" },
    /** 开局时间（`status: "playing"` 那一刻） */
    startedAt: { type: Date, default: null },
    /**
     * 胜者（`status: "over"` 时才有意义；**空数组 = 平局 / 同归于尽**，不是「还没算」）。
     * ★ 为什么落在房间上而不是只回给 `next` 的调用方：只有房主能调 next，其他人拿不到那份回包；
     *   结束状态必须能从**任何人都读得到的快照**里看见（`GET /api/game/rooms/:code`）。
     * ★ 顺序与 settle / gameOverOf 一致：hp 降序、同血按 userId（三处同一串，别在客户端再排一次）。
     */
    winners: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], default: [] },
    /** 结束时间（`status` 变 `over` 那一刻）；没结束时 null */
    finishedAt: { type: Date, default: null },
    /** 最后一次「有人在看」的时间；过期判它（文件头 ★★） */
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
);

/**
 * 房号唯一。
 * ★★ 这不只是「查得快」：它是**建房的并发闸**。两个实例同时建房时，
 *   撞上同一个码的那一方会拿到 E11000，service 那边换个码重来（config.CODE_ATTEMPTS）。
 *   没有这条索引，撞码就是两个人进了同一个房，而且零报错。
 */
gameRoomSchema.index({ code: 1 }, { unique: true });

/**
 * 懒清理的扫描键（`status` + `lastSeenAt`）：删过期 waiting / playing 房。
 * ★ 单独一条 `{ lastSeenAt: 1 }` 不行吗？不行 —— 清理要按状态分寿命
 *   （waiting 30 分钟、playing 2 小时），带上前缀才能各扫各的那一段。
 */
gameRoomSchema.index({ status: 1, lastSeenAt: 1 });

/**
 * 「这个人现在在哪间房」：进房 / 排队 / 建房之前先查一遍，**一个人同时只能在一间房里**
 * （否则撮合与自建各占一间，两边都凑不齐人，而他本人在哪一间都是鬼）。
 * 数组字段上的索引给 `{ "members.userId": uid }` 这种查询用。
 */
gameRoomSchema.index({ "members.userId": 1 });

/**
 * 按房号查一间房（join / leave / ready / start / kick / 快照都走它）。
 * ★ 只按 `code` 查，不带 status：状态机在 service 里判（一次查询回答「有没有这间房」，
 *   状态是这间房的属性，不是查询条件）。
 */
gameRoomSchema.statics.findByCode = function findByCode(code) {
  return this.findOne({ code: String(code || "") });
};

// ★ 过期判定**不放在这里**：`isExpired` 只有 services/gameRoom.service 一处
//   （它要同时回答「0 个人的房立刻算过期」与「按状态给的两种寿命」，
//   写在 schema 上就会变成第二个判据）。

module.exports = mongoose.model("GameRoom", gameRoomSchema, "gamerooms");
