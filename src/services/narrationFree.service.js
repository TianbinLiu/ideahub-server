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
 * ★ 但 E11000 还有另一个来由：当天第一批**并发**的几发同时发现「还没有那一行」、各自去插，只有一发插成，其余撞索引 ——
 *   这时余量其实够。带非等值条件（chars ≤ …）的 upsert 不会被 MongoDB 自动重试，所以撞了就**不带 upsert 再做一次**同样的条件 $inc：
 *   那一行此刻一定在了，中了 = 是并发撞车、照常占；不中才是真的不够。原来一撞就拒，当天头几句旁白会被误报「今天的免费配音用完了」
 *   （2026-10-09 核查用 mongodb-memory-server 并发打 5 发，20 轮里误拒 21 次；HTTP 层的并发用例把请求错开了，测不出来）。
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
  const take = (upsert) =>
    NarrationFreeUsage.findOneAndUpdate(
      { userId, day, chars: { $lte: limit - n } },
      { $inc: { chars: n } },
      { upsert, returnDocument: "after" },
    ).lean();
  try {
    const doc = await take(true);
    return { ok: true, day, chars: n, used: doc.chars, limit };
  } catch (e) {
    if (e?.code !== 11000) throw e;
    // ★ 拒的时候报的 used 是另读的一次：两次之间同一个人别的句子没出声、把占的那份还回来（release），
    //   读到的余量就会够这一句 —— 报出去成了「还剩 305 字，这一句 10 字放不下」这种自相矛盾的话。
    //   所以读到够的话再占一次（最多三轮，余量只会被 release 加回来，几毫秒的窗口里撞上两次已经极罕见）
    for (let i = 0; i < 3; i += 1) {
      const doc = await take(false);
      if (doc) return { ok: true, day, chars: n, used: doc.chars, limit };
      const used = await usedNow();
      if (limit - used < n) return { ok: false, used, limit };
    }
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
