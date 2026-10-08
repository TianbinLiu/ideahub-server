/**
 * @file narrationFree.service.js - 剪辑页配音免费额度的「占」与「还」
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节
 *
 * ★ 额度是多少、为什么、对谁：config/tokens.NARRATION_FREE_DAILY_CHARS。调用方只有 routes/tts.routes 的旁白那一支。
 * ★ 顺序与扣费那条（billing.chargedCall）同一个形状：**先占、再合成、合成没成就还** ——
 *   先合成后记数的话，并发几发同时放行，上限就只是个建议。
 * ★ 计数器在 models/NarrationFreeUsage（为什么不数流水见那个文件头）。
 */
const NarrationFreeUsage = require("../models/NarrationFreeUsage");
const { NARRATION_FREE_DAILY_CHARS } = require("../config/tokens");
const { currentDay } = require("./tokenWallet.service");

/**
 * 从今天的免费额度里占 `chars` 个字符。**够才占**（一次原子操作），不够一个字都不占。
 *
 * 做法：带 `chars ≤ 上限 − n` 的条件 upsert。当天还没有那一行 → 插一行（chars = n）；
 * 有那一行且余量够 → 加上去；有那一行但余量不够 → 条件不中、upsert 去插 → 撞 (userId, day) 唯一索引（E11000）= 拒。
 *
 * @returns {Promise<{ok:true, day:string, chars:number, used:number, limit:number} | {ok:false, used:number, limit:number}>}
 *   `used` = 当天已用（占成了就是占完之后的数）。占成的那一份要原样交回 release。
 */
async function reserve(userId, chars, now = new Date()) {
  const limit = NARRATION_FREE_DAILY_CHARS;
  const day = currentDay(now);
  const n = Math.max(0, Math.ceil(Number(chars) || 0));
  const usedNow = async () => (await NarrationFreeUsage.findOne({ userId, day }).select("chars").lean())?.chars ?? 0;
  if (n > limit) return { ok: false, used: await usedNow(), limit };
  // ★ 唯一索引得先在：没有它，余量不够时 upsert 会**另插一行**而不是撞墙，上限就没了。
  //   索引由 autoIndex 在模型编译时开始建，刚起的实例第一发可能赶在它建好之前 —— init() 等的就是这一下（只跑一次，之后是同一个 promise）。
  //   建不成（init 拒）就整句 500：宁可这一句配不了，也不放一个没有上限的免费桶出去
  await NarrationFreeUsage.init();
  try {
    const doc = await NarrationFreeUsage.findOneAndUpdate(
      { userId, day, chars: { $lte: limit - n } },
      { $inc: { chars: n } },
      { upsert: true, returnDocument: "after" },
    ).lean();
    return { ok: true, day, chars: n, used: doc.chars, limit };
  } catch (e) {
    if (e?.code !== 11000) throw e;
    return { ok: false, used: await usedNow(), limit };
  }
}

/**
 * 合成没成：把 reserve 占的那一份还回去（只还当初那一天的，跨了 UTC 日照样还到那一天上）。
 * ★ 永不抛：还不回去的后果只是这个人今天少配几个字，不能拿它盖掉「合成没成」那句话。
 */
async function release(userId, held) {
  if (!held?.ok || !held.chars) return;
  try {
    await NarrationFreeUsage.updateOne({ userId, day: held.day, chars: { $gte: held.chars } }, { $inc: { chars: -held.chars } });
  } catch (e) {
    console.error(`[narration-free] 额度没还回去 user=${userId} day=${held.day} chars=${held.chars}:`, e?.message || e);
  }
}

module.exports = { reserve, release };
