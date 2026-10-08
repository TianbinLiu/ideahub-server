// src/models/NarrationFreeUsage.js
// 剪辑页配音的免费额度用了多少：一行 = 「这个账号在这个 UTC 日已经占掉了几个字符」。
//
// ★ 额度与它的来历在 config/tokens.NARRATION_FREE_DAILY_CHARS；占 / 还只有 services/narrationFree 一处。
// ★ 为什么单开一张表、不拿 TokenLedger 现数：数流水是「先查再放」—— 几发并发同时查都看到余量、一起放行，
//   上限就被冲破了；而且合成要一两秒、流水在合成成功之后才写，正在路上的那几发根本数不到。
//   这里靠 (userId, day) 唯一索引做一次原子的「够才加」（做法见 narrationFree.reserve）。
// ★ 只是计数器，不是账：对账看 TokenLedger 里 reason = "narration_free" 的那几行（costTokens）。
const mongoose = require("mongoose");

/** 留 3 天：额度只看当天，多留两天是给排查「昨天为什么说用完了」 */
const TTL_MS = 3 * 24 * 60 * 60 * 1000;

const narrationFreeUsageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** UTC 日 "YYYY-MM-DD"（tokenWallet.currentDay，与每日用量上限同一个日界） */
    day: { type: String, required: true, maxlength: 10 },
    /** 当天已经占掉的字符数（合成没成的那一发会还回来） */
    chars: { type: Number, default: 0, min: 0 },
    expireAt: { type: Date, default: () => new Date(Date.now() + TTL_MS) },
  },
  { timestamps: true, versionKey: false }
);

// ★ 唯一索引是「够才加」成立的前提：upsert 撞上它（E11000）= 当天那一行已经在、而且余量不够
narrationFreeUsageSchema.index({ userId: 1, day: 1 }, { unique: true });
narrationFreeUsageSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("NarrationFreeUsage", narrationFreeUsageSchema);
