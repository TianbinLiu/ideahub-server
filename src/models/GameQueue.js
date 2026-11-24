// src/models/GameQueue.js
// 「工坊对局」的匹配队列（集合 `gamequeues`，2026-11-23，G5 联机的第一块：HTTP 轮询版）。
//
// 撮合是**轻量**的：没有后台撮合进程，也没有 Redis 队列 —— 谁「进队 / 续队」谁就顺手
// 看一眼同模式排队的人够不够，够了就地建房（services/gameRoom.service.enqueue → tryMatch）。
// 代价写在 service 的 ★★ 里：两个请求可能同时判断「够了」，所以每拿走一个人都是一次
// 带条件的原子更新，抢不到就整个作废重来。
//
// ══ ★★ 为什么一个人只有**一行**（userId 唯一） ═══════════════════════════════════════
//   能同时在 4 人池和 8 人池里排队的话，两边同时撮合成功 = 一个人被塞进两间房，
//   而且两张「已匹配」的回包都理直气壮。所以：一行 = 一个人，换模式要显式离队
//   （`DELETE /api/game/queue` 再 POST），换的时候服务端回 409 `QUEUE_MODE_CONFLICT`，
//   不替你静默地把 8 人池里的位置丢掉。
//
// ══ ★ 为什么「匹配成功」不删这一行，而是改成 matched ═════════════════════════════════
//   撮合是**在别人的那次请求里**发生的，本人此刻可能正处在两次轮询之间。删掉那行，
//   他就把房间码彻底错过了（下一拍只会看到「你没在排队」）。所以留一行
//   `{ status: "matched", code, roomId }`，客户端下一次 `GET /api/game/queue` 读到房号；
//   `DELETE /api/game/queue` 是「我看到了 / 我不去了」的显式收尾，
//   过期（`matchedAt` 超过 config.MATCH_TTL_MINUTES）由懒清理收拾。
//
// ══ ★ 为什么有 enqueuedAt 和 lastSeenAt 两个时间 ═════════════════════════════════
//   · `enqueuedAt` = 排队顺序（**公平性**：先来先撮）。续队**不动**它 ——
//     否则「每 2 秒续一次」的客户端会永远排在最后，谁续得勤谁吃亏；
//   · `lastSeenAt` = 心跳（**这个人还在不在**）。续队只刷它。
//   没心跳的行（关屏 / 杀进程 / 断网）会被撮合那一路顺手清掉，
//   否则撮合出来的房里有个人永远不会来，另外三个人干等到房间过期。
const mongoose = require("mongoose");
const { QUEUE_MODES } = require("../config/gameRoom");

const gameQueueSchema = new mongoose.Schema(
  {
    /** 排队的人。★ 唯一（文件头 ★★） */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** 只收能匹配的模式（custom 不排队） */
    mode: { type: String, required: true, enum: QUEUE_MODES },
    /** `waiting` → `matched`（撮合成功，带着房号等本人来读）。没有 `cancelled`：离队就是删行 */
    status: { type: String, required: true, enum: ["waiting", "matched"], default: "waiting" },
    /** 排队那一刻（公平性用的排序键；续队不动它） */
    enqueuedAt: { type: Date, default: Date.now },
    /** 最后一次心跳（续队 / 撮合），过期判它 */
    lastSeenAt: { type: Date, default: Date.now },
    /** 撮合成功的那一刻 */
    matchedAt: { type: Date, default: null },
    /** 撮合出来的房间（matched 才有；服务端内部用，客户端拿 code） */
    roomId: { type: mongoose.Schema.Types.ObjectId, ref: "GameRoom", default: null },
    /** 撮合出来的房号（matched 才有，就是它塞进队列响应里） */
    code: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

/** 一个人一行。★ 同时是「并发进队」的锁：抢不到唯一索引的那一方读到同一行（续队），不会建出两行 */
gameQueueSchema.index({ userId: 1 }, { unique: true });

/**
 * 撮合的扫描键：同模式、还在等、按排队顺序取前 N 个。
 * ★ 顺序必须进索引：撮合只取「最早的那 4 / 8 个人」，没有这个顺序键就得把整个池子读进内存再排。
 */
gameQueueSchema.index({ mode: 1, status: 1, enqueuedAt: 1 });

/** 懒清理的扫描键：按 status 分两段删（waiting 看心跳、matched 看撮合时间） */
gameQueueSchema.index({ status: 1, lastSeenAt: 1 });

module.exports = mongoose.model("GameQueue", gameQueueSchema, "gamequeues");
