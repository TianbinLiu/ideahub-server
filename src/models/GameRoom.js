// src/models/GameRoom.js
// 「工坊对局」的一间房（集合 `gamerooms`，2026-11-23，G5 联机的第一块：HTTP 轮询版）。
//
// 设计来源：app 仓 `docs/workshop-game-design.md` §三「服务端房间协议」+ `docs/g2-game-ui.md`
// 的大厅需求（4 人匹配 / 8 人匹配 / 自定义房间邀请）。
//
// ══ 为什么只有「谁跟谁在一局里」，没有回合数据 ═══════════════════════════════════════
//   回合推进 / 点赞投票 / 扣血淘汰需要**服务端主动推送**（WebSocket 或 SSE），现在是
//   HTTP 轮询版，先不做。所以这张表只回答「房间还在不在、谁在里面、谁准备好了、开了没有」；
//   `status: "playing"` 之后这里不再往前推进一步，寿命靠 `lastSeenAt` 兜底。
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
    joinedAt: { type: Date, default: Date.now },
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
     * `waiting` → `playing`（房主开局）→ `closed`（今天没有东西会写 closed，
     * 但状态机留着：回合引擎接上之后「打完一局」就是它；过期清理是硬删）
     */
    status: { type: String, required: true, enum: ["waiting", "playing", "closed"], default: "waiting" },
    /** 房间成员，**数组顺序就是座位顺序**（文件头 ★）。最多 8 个（8 人匹配） */
    members: { type: [memberSchema], default: [] },
    /**
     * 这间房怎么来的：`create`（房主自建）/ `match`（服务端撮合建出来的）。
     * ★ 只为「事后数一数匹配到底撮合了多少局」与排查留的，不参与任何判定。
     */
    origin: { type: String, enum: ["create", "match"], default: "create" },
    /** 开局时间（`status: "playing"` 那一刻） */
    startedAt: { type: Date, default: null },
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
