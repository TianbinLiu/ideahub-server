// src/services/tokenWallet.service.js
// AI token 钱包 —— 所有 token 变动的唯一入口。
//
// 这个钱包**以前长在客户端**（app 仓 data/account.ts 里的 IndexedDB 记账）。
// 那等于把收银台交给顾客：改一行前端就能把余额写成无限，而每一次方舟调用
// 都是真金白银（一段视频约 1.9 元、一张图约 0.6 元）。搬到服务端之后，
// 客户端那份退化成**镜像**，只负责显示与提前拦截，作数的只有这里。
//
// ══ 三条硬不变量（做错了不会报错，只会悄悄多扣或白送）══════════════════
//
// 【W1 并发不超付】扣减必须是【条件原子更新】：一次 findOneAndUpdate 同时完成
//    "余额够不够"和"扣掉"。★严禁读-改-写（先查余额再 save）——两个请求并发时
//    余额判断会同时通过，直接双花。这与 points.service 的 I2 是同一条，形状也照抄。
//    两个桶（plan/addon）+ "先扣 plan" 的顺序用**聚合管道更新**表达，仍是一次原子操作。
//
// 【W2 没受理就必须退】方舟非 2xx（敏感词 400 / 限流 429 / 上游挂了 5xx）意味着
//    这次调用没有产生任何产物，钱必须退回去。漏退就是"报错一次扣一次钱"。
//    ★ 但**任务被受理之后**才失败（Seedance 排队跑完报 failed）不在这里退：
//      那时算力已经消耗、方舟也已经向我们计费。这是刻意的，不是遗漏。
//
// 【W3 月度刷新只发生在跨月的第一次触达】plan 额度每月归位（未用完的作废），
//    靠 cycle 字段做条件原子更新抢占，抢到的那一次才真正重置。
//    ★ 不能写成"读出来发现跨月了就 save"——并发下会重置多次，等于反复发额度。
const User = require("../models/User");
const TokenLedger = require("../models/TokenLedger");
const { planOf, DEFAULT_PLAN_ID } = require("../config/tokens");

/** 当前计费周期标识（UTC 年月）。用字符串而不是时间戳：可直接做等值条件更新 */
function currentCycle(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 归一化成非负整数。小数会让流水与余额慢慢对不上（同 points 的 toPoints） */
function toTokens(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 1_000_000_000) return null;
  return n;
}

const SELECT = "tokenWallet";

function shape(doc) {
  const w = doc?.tokenWallet;
  if (!w) return null;
  return { plan: w.plan, addon: w.addon, planId: w.planId || DEFAULT_PLAN_ID, cycle: w.cycle };
}

/**
 * 保证钱包存在、且停在当前计费周期。幂等，可以随便多调。
 *
 * 两步都是条件原子更新（W3）：
 *   ① 没有 tokenWallet 的老账号 → 建一个，发当月免费额度（这是 token 的印钱口之一）
 *   ② cycle 落后于当前月 → plan 归位到套餐当月额度，addon 不动
 * 并发时只有一个请求能匹配到条件，另一个自然落空——不会重复发放。
 */
async function ensureWallet(userId, now = new Date()) {
  const cycle = currentCycle(now);

  // ① 初始化。用 $exists:false 抢占，抢不到说明别人已经建好了。
  const created = await User.findOneAndUpdate(
    { _id: userId, tokenWallet: { $exists: false } },
    {
      $set: {
        tokenWallet: { plan: planOf(DEFAULT_PLAN_ID).monthlyTokens, addon: 0, planId: DEFAULT_PLAN_ID, cycle },
      },
    },
    { new: true },
  )
    .select(SELECT)
    .lean();
  if (created) {
    await writeEntry(userId, planOf(DEFAULT_PLAN_ID).monthlyTokens, "grant", total(created), "首次触达发放免费额度");
    return shape(created);
  }

  // ② 跨月刷新。条件带上旧 cycle，抢到的那一次才重置。
  const cur = await User.findById(userId).select(SELECT).lean();
  if (!cur?.tokenWallet) return null; // 用户不存在
  if (cur.tokenWallet.cycle === cycle) return shape(cur);

  const grant = planOf(cur.tokenWallet.planId).monthlyTokens;
  const rolled = await User.findOneAndUpdate(
    { _id: userId, "tokenWallet.cycle": cur.tokenWallet.cycle },
    { $set: { "tokenWallet.plan": grant, "tokenWallet.cycle": cycle } },
    { new: true },
  )
    .select(SELECT)
    .lean();
  if (!rolled) {
    // 没抢到：别人刚刷新过，读一次现值即可
    const fresh = await User.findById(userId).select(SELECT).lean();
    return shape(fresh);
  }
  await writeEntry(userId, grant - cur.tokenWallet.plan, "cycle_reset", total(rolled), `${cycle} 月度刷新`);
  return shape(rolled);
}

function total(doc) {
  const w = doc?.tokenWallet;
  return w ? Number(w.plan) + Number(w.addon) : 0;
}

/**
 * @param extra 额外列。目前只有 `costTokens`（"这次调用值多少钱"，与"扣了多少"分开记）。
 *   ★ 有 costTokens 时即使 delta 为 0 也要落一行 —— 管理员免单那笔正是这个形状：
 *     余额没动，但钱真花出去了。写成 `if (!delta) return` 一刀切的话，
 *     那笔账会**静默地**不进账本（铁律八），而它恰恰是最需要被查到的一笔。
 */
async function writeEntry(userId, delta, reason, balanceAfter, memo = "", extra = {}) {
  if (!delta && !extra.costTokens) return; // 0 变动不写流水（月度刷新可能正好等额）
  try {
    await TokenLedger.create({ user: userId, delta, reason, balanceAfter, memo: memo.slice(0, 200), ...extra });
  } catch (e) {
    // ★ 流水写失败不能把业务打挂：钱已经扣了，这时抛错会让调用方以为没扣。
    //   但必须留日志——否则账本会静默缺条，事后对账时无从下手（铁律八）。
    console.error(`[tokens] 流水写入失败 user=${userId} delta=${delta} reason=${reason}:`, e.message);
  }
}

/** 余额快照（会顺带保证钱包存在与跨月刷新） */
async function getWallet(userId, now = new Date()) {
  return ensureWallet(userId, now);
}

/**
 * 原子扣费（W1）。够才扣，一次完成判断 + 扣减，**先扣 plan 再扣 addon**。
 *
 * 聚合管道里的所有表达式看到的都是**这一阶段的输入文档**（即扣减前的值），
 * 所以第二行里的 `$tokenWallet.plan` 仍是原值 —— 这正是能一步算出两个桶的原因。
 *
 * @returns {Promise<{plan:number, addon:number}|null>} 扣后余额；不足 / 无钱包 → null
 */
async function debit(userId, amount, memo = "", now = new Date()) {
  const n = toTokens(amount);
  if (n === null) return null;
  if (n === 0) return ensureWallet(userId, now);
  await ensureWallet(userId, now);

  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      $expr: { $gte: [{ $add: ["$tokenWallet.plan", "$tokenWallet.addon"] }, n] },
    },
    [
      {
        $set: {
          "tokenWallet.plan": { $subtract: ["$tokenWallet.plan", { $min: ["$tokenWallet.plan", n] }] },
          "tokenWallet.addon": {
            $subtract: ["$tokenWallet.addon", { $subtract: [n, { $min: ["$tokenWallet.plan", n] }] }],
          },
        },
      },
    ],
    // ★ updatePipeline 必须显式给：mongoose 不允许把数组当普通 update 传
    //   （"Cannot pass an array to query updates unless the `updatePipeline` option is set"）。
    //   漏了它不是静默降级，是直接抛 —— 但抛在这一层会被 500 兜住，看起来像"服务器炸了"，
    //   完全看不出是扣费那一步。
    { new: true, updatePipeline: true },
  )
    .select(SELECT)
    .lean();

  if (!updated) return null;
  await writeEntry(userId, -n, "ark_spend", total(updated), memo);
  return shape(updated);
}

/**
 * 退款（W2）/ 入账。一律进 **addon** —— 不还给 plan。
 * ★ 为什么：plan 是"当月额度"，跨月会被清零。把退款还进 plan，等于用户在月末
 *   被拒了一次请求、退回来的钱几小时后就蒸发了。addon 永不过期，退给它才不吃亏。
 */
async function credit(userId, amount, reason, memo = "", now = new Date()) {
  const n = toTokens(amount);
  if (n === null || n === 0) return getWallet(userId, now);
  await ensureWallet(userId, now);
  const updated = await User.findOneAndUpdate({ _id: userId }, { $inc: { "tokenWallet.addon": n } }, { new: true })
    .select(SELECT)
    .lean();
  if (!updated) return null;
  await writeEntry(userId, n, reason, total(updated), memo);
  return shape(updated);
}

/**
 * 管理员免单的一次方舟调用：**不动余额，但必须落一笔账**。
 *
 * ★★ 为什么"不扣费"不等于"不记账"：这次调用在**火山的账单上是真花了钱**的
 *   （一段视频约 1.9 元）。不记的话，月底对账会出现
 *   「系统里所有 ark_spend 加起来 300 元，方舟账单 800 元」——
 *   多出来的那 500 元在系统里查不到任何来源，说不清是谁花的、花在哪个模型上，
 *   也分不清是"管理员在调"还是"我们的扣费漏了一个口子"。这两件事的处置完全相反。
 *
 * ★ delta 记 0、金额记在 costTokens：理由写在 TokenLedger 的 costTokens 注释里
 *   （balanceAfter 存在的唯一意义就是账本能和余额对上）。
 *
 * ★ 余额快照可以由调用方传进来（billedForward 手上本来就有一份，省一次 Mongo 读）；
 *   不传就自己读一次 —— balanceAfter 缺了这一项的话，账本上就只剩一个孤零零的金额，
 *   对账时定位不到"那个时间点上这个人有多少钱"。
 *
 * @returns {Promise<{plan:number, addon:number}|null>} 当前余额（没动过）
 */
async function noteAdminFree(userId, cost, memo = "", snapshot = null, now = new Date()) {
  const n = toTokens(cost);
  if (n === null) return snapshot;
  const w = snapshot || (await ensureWallet(userId, now));
  const balanceAfter = w ? Number(w.plan) + Number(w.addon) : null;
  await writeEntry(userId, 0, "admin_free", balanceAfter, memo, { costTokens: n });
  return w;
}

/** 购/续套餐：立即发放该套餐的当月额度（叠加在剩余 plan 上），并记住档位 */
async function buyPlan(userId, planId, now = new Date()) {
  const plan = planOf(planId);
  if (plan.id !== planId) return null; // 未知档位
  await ensureWallet(userId, now);
  const updated = await User.findOneAndUpdate(
    { _id: userId },
    {
      $inc: { "tokenWallet.plan": plan.monthlyTokens },
      $set: { "tokenWallet.planId": plan.id, "tokenWallet.cycle": currentCycle(now) },
    },
    { new: true },
  )
    .select(SELECT)
    .lean();
  if (!updated) return null;
  await writeEntry(userId, plan.monthlyTokens, "plan_buy", total(updated), `购买 ${plan.name}`);
  return shape(updated);
}

/** 今日已经"印"了多少（recharge + plan_buy），用于模拟支付的防滥用上限 */
async function mintedToday(userId, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rows = await TokenLedger.aggregate([
    { $match: { user: userId, reason: { $in: ["recharge", "plan_buy"] }, createdAt: { $gte: start } } },
    { $group: { _id: "$reason", sum: { $sum: "$delta" }, n: { $sum: 1 } } },
  ]);
  const byReason = Object.fromEntries(rows.map((r) => [r._id, r]));
  return {
    rechargeTokens: byReason.recharge?.sum ?? 0,
    planBuys: byReason.plan_buy?.n ?? 0,
  };
}

async function listLedger(userId, limit = 50) {
  return TokenLedger.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(200, limit)))
    // ★ costTokens 必须在这一列里：admin_free 那几行的 delta 是 0，
    //   不给 costTokens 的话流水页上就是一排"变动 0"的空行，看不出发生过什么。
    //   普通用户的每一行都没有这个字段（undefined），对他们零影响。
    .select("delta reason balanceAfter memo costTokens createdAt")
    .lean();
}

module.exports = {
  currentCycle,
  ensureWallet,
  getWallet,
  debit,
  credit,
  noteAdminFree,
  buyPlan,
  mintedToday,
  listLedger,
};
