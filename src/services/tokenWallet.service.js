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
//    ★ **任务被受理之后**才失败（Seedance 排队跑完报 failed / cancelled / expired、MiniMax 报 Fail）
//      2026-10-07 起**也退**（主人拍板「做生成失败返回 token」）—— 但不在这条同步链路上退：
//      那时请求早就回去了，结局要等上游明说。唯一实现在 services/taskRefund.service.js（恰好一次、退给账的主人）。
//    ★★ 两种退款都**按扣的那两桶原样退回**（refundSplit：plan 的回 plan、addon 的回 addon）。
//      全进 addon 的话，免费版反复提交「过得了输入审核、过不了输出审核」的提示词，就能把会过期的 plan 洗成永不过期的 addon；
//      全进 plan 又会让充值来的 addon 在月底蒸发。扣的时候就记下两桶（debitSplit 的扣前快照），退的时候照着退。
//
// 【W4 退款欠额只增不减地记在自己那一桶里】渠道退款要把已发的 token 收回来；余额不够
//    的那部分**不能让余额变成负数**（plan/addon 都是 min:0，跨月刷新还会 $set 重写 plan，
//    负数会被静默抹掉 —— 退款套利就此免费），而要转进 `tokenWallet.debt`，并冻结一切消费。
//    抵扣只发生在**真的付过钱**的入账上（recharge / plan_buy）：让 cycle_reset 或首次 grant
//    抵债，等于用户等到下月 1 号欠额自动清零，套利成本归零。见 §15.4 的 R-9 / R-10。
//
// 【W3 月度刷新只发生在跨月的第一次触达】付费套餐的 plan 额度每月归位（未用完的作废），
//    靠 cycle 字段做条件原子更新抢占，抢到的那一次才真正重置。
//    ★ 不能写成"读出来发现跨月了就 save"——并发下会重置多次，等于反复发额度。
//    ★ 免费版（2026-10-07 起）不按月刷新，改成**按 UTC 日补**（`day` 字段，同一种条件原子抢占），见 ensureWallet 的 ③。
const mongoose = require("mongoose");
const User = require("../models/User");
const TokenLedger = require("../models/TokenLedger");
const TokenOrder = require("../models/TokenOrder");
const { planOf, DEFAULT_PLAN_ID, isFreePlan } = require("../config/tokens");

/** 当前计费周期标识（UTC 年月）。用字符串而不是时间戳：可直接做等值条件更新 */
function currentCycle(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 当前 UTC 日（"YYYY-MM-DD"）。免费版每日额度靠它做条件原子更新抢占（与 cycle 同一招）；
 *  ★ 与日上限（spentToday）同一个日界 —— 两件以天计的事用两种日界，用户会在凌晨看到「额度补了、上限没重置」 */
function currentDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** 两个 "YYYY-MM-DD" 之间隔了几天（b − a）。认不出的按 1 天（老钱包没有 day：当作「今天第一次补」） */
function daysBetween(a, b) {
  const t0 = Date.parse(`${a}T00:00:00Z`);
  const t1 = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return 1;
  return Math.round((t1 - t0) / 86_400_000);
}

/**
 * 「付过钱」的入账类别：只有这两类会把 `paidEver` 置真（也只有它们抵欠额，见 REPAY_REASONS）。
 * ★ 支付入账全部走 credit("recharge") 或 buyPlan —— order.service（充值 / 套餐 / 模拟渠道）、play.service（Play 购买与补发）
 *   一个不落地都在这两个函数里，所以置真只写在这两处，调用方不用记得。
 * ★ 例外是 Play 的**测试购买**（许可测试员，一分钱没付）：它照常发币、照常抵欠额，但不算付过钱 —— credit 的 `test` 选项。
 */
const PAYMENT_REASONS = ["recharge", "plan_buy"];

/**
 * 「这个人现在有没有一笔**还作数的**真实付款」—— paidEver 的唯一事实来源（铁律六）。
 *
 * ★★ 为什么不按账本数（2026-10-07 评审）：账本只记「到过账」，记不了「后来被退款了」。按账本数的话，
 *   买一个最小的 Play 充值包、48 小时内找 Google 退款 —— token 被收回（花掉了就转欠额），
 *   可「付过钱」永远是真的：电影级、样片、真人档、参考视频全部对他打开，日上限也从 15 万跳到 300 万。
 *   老的模拟充值（下单系统之前「调一下就到账」的 /recharge）也会在账本里留一条 recharge，那不是钱。
 * ⇒ 改按**订单**数：kind 不限（充值 / 套餐），渠道不限（含模拟渠道 —— 它在生产被启动自检拒掉），
 *   状态是 paid（抢到结算、正在发币）或 settled（发完了），**没有被回收**（revokedAt 为空 —— 退款 / 拒付回收时写），
 *   而且**不是测试购买**（isTest：许可测试员一分钱没付）。
 * ★ Play 的**部分退款**（一次买了 3 份、退了 1 份）也算：回收把整张订单标成 refunded、写上 revokedAt（回收的幂等锚只抢一次），
 *   可剩下那 2 份是真付了钱的 —— 认 voidedQuantity 小于 quantity 的那种（全额退款时 voidedQuantity 是 0 或等于 quantity）。
 */
function hasLivePayment(userId) {
  return TokenOrder.exists({
    user: userId,
    isTest: { $ne: true },
    $or: [
      { status: { $in: ["paid", "settled"] }, revokedAt: null },
      { status: "refunded", $expr: { $and: [{ $gt: ["$voidedQuantity", 0] }, { $lt: ["$voidedQuantity", { $ifNull: ["$quantity", 1] }] }] } },
    ],
  }).then(Boolean);
}

/**
 * 按订单重算一次 `paidEver`。**退款 / 拒付回收之后**由回收的那一方调（play.service.revokeByToken）——
 * 那一笔不作数了，他还有没有别的真实付款决定了他还算不算付费用户。
 *
 * ★ 写 false 有一个窗口：重算的查询跑在一笔新付款的订单落库之前、写回却落在那笔付款的 credit 置真之后，就会把真改回假。
 *   所以写完 false 之后**再问一次**：付款的顺序永远是「订单先落库（paid）→ 再 credit 置真」，
 *   只要 credit 的置真落在我们的 false 之前，那张订单在我们第二次查询时一定已经在了 —— 再置回真即可；
 *   落在之后的话它自己就把真写上了。
 * @returns {Promise<boolean|null>} 重算后的值；钱包不存在 null
 */
async function refreshPaidEver(userId) {
  const paid = await hasLivePayment(userId);
  const r = await User.updateOne({ _id: userId, tokenWallet: { $exists: true } }, { $set: { "tokenWallet.paidEver": paid } });
  if (!r.matchedCount) return null;
  if (paid) return true;
  if (await hasLivePayment(userId)) {
    await User.updateOne({ _id: userId }, { $set: { "tokenWallet.paidEver": true } });
    return true;
  }
  return false;
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
  const debt = debtOf(w);
  // ★ `frozen` 是**服务端算好下发**的，不让客户端自己按 debt>0 推：App 的
  //   canAfford 在镜像为空时一律放行（account.ts），冻结状态必须由服务端明说，
  //   否则镜像没到位的那一拍用户会看到正常报价、点下去才吃 403。
  // ★ paidEver 必须在这里：免费档门禁（config/tokens.isPaidUser）读的就是 getWallet 的返回值。
  //   漏了它的表现是「充过钱的人仍然只能用免费档」，零报错（老账号回填之前一律按 false 读，见 ensureWallet 的 ②）。
  return {
    plan: w.plan,
    addon: w.addon,
    planId: w.planId || DEFAULT_PLAN_ID,
    cycle: w.cycle,
    day: w.day || null,
    debt,
    debtSince: w.debtSince || null,
    frozen: debt > 0,
    paidEver: w.paidEver === true,
  };
}

/** 欠额的唯一读法：老账号没有这个字段（undefined）⇒ 一律按 0（铁律六） */
function debtOf(w) {
  const n = Number(w && w.debt);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 保证钱包存在、且停在当前计费周期。幂等，可以随便多调。
 *
 * 每一步都是条件原子更新（W3）：
 *   ① 没有 tokenWallet 的账号 → 建一个，发新人额度（这是 token 的印钱口之一）：
 *      免费版 = addon 里一次性的 `welcomeTokens`（不过期）+ plan 里今天那一份 `dailyTokens`
 *   ② `paidEver` 还没有（这个字段上线之前的老钱包）→ 按账本回填一次「付没付过钱」
 *   ③ 免费版：每过一个 UTC 日往 plan 里补 `dailyTokens`，补到 `dailyCapTokens` 为止、绝不往下削（`day` 抢占）
 *      付费套餐：cycle 落后于当前月 → plan 归位到套餐当月额度，addon 不动（`cycle` 抢占）
 * 并发时只有一个请求能匹配到条件，另一个自然落空——不会重复发放。
 */
async function ensureWallet(userId, now = new Date()) {
  const cycle = currentCycle(now);
  const day = currentDay(now);

  // ① 初始化。用 $exists:false 抢占，抢不到说明别人已经建好了。
  const p0 = planOf(DEFAULT_PLAN_ID);
  const free0 = isFreePlan(DEFAULT_PLAN_ID);
  const plan0 = free0 ? Number(p0.dailyTokens) || 0 : p0.monthlyTokens;
  const addon0 = Number(p0.welcomeTokens) || 0;
  const created = await User.findOneAndUpdate(
    { _id: userId, tokenWallet: { $exists: false } },
    {
      $set: {
        // ★ debt / debtSince 一并写死初值：不写的话老路径读出来是 undefined，
        //   而 `$inc` 到一个不存在的字段虽然能用，`$set` 与 `$min` 混在同一条管道里时
        //   两种形状会走出两种结果 —— 统一从一开始就存在，省掉这一类分支。
        // ★ paidEver:false 也写死：新钱包肯定没付过钱，省掉一次 ② 的账本回填查询
        tokenWallet: { plan: plan0, addon: addon0, planId: DEFAULT_PLAN_ID, cycle, day, debt: 0, debtSince: null, paidEver: false },
      },
    },
    { returnDocument: "after" },
  )
    .select(SELECT)
    .lean();
  if (created) {
    const memo = free0 ? `新人额度 ${addon0}（一次性）+ 今天的 ${plan0}` : "首次触达发放免费额度";
    await writeEntry(userId, plan0 + addon0, "grant", total(created), memo);
    return shape(created);
  }

  let cur = await User.findById(userId).select(SELECT).lean();
  if (!cur?.tokenWallet) return null; // 用户不存在

  // ② 老钱包回填 paidEver（只跑一次：写成 true / false 之后这个分支就再也进不来）。
  //   ★ 条件带 $exists:false：回填与一笔并发的充值（credit 会把它 $set 成 true）撞车时，回填那一发落空，不会把 true 改回 false。
  //   ★ 按订单判（hasLivePayment 的 ★★），不按账本：退过款的、测试购买、老的模拟充值都不算付过钱。
  if (cur.tokenWallet.paidEver === undefined) {
    const paid = await hasLivePayment(userId);
    await User.updateOne({ _id: userId, "tokenWallet.paidEver": { $exists: false } }, { $set: { "tokenWallet.paidEver": paid } });
    cur = (await User.findById(userId).select(SELECT).lean()) || cur;
  }

  // ③a 免费版：按 UTC 日补
  if (isFreePlan(cur.tokenWallet.planId)) return accrueDaily(userId, cur, { day, cycle });

  // ③b 付费套餐：跨月刷新。条件带上旧 cycle，抢到的那一次才重置。
  // ★★ 只许往前刷，不许往回拨（2026-10-07 评审）：调用方给的 `now` 可能是**旧的** —— 退款清扫器一轮最长十几分钟，
  //   原来整轮共用开轮那一拍的时间。跨月那一夜开轮、半夜之后才退到某个已经刷到新月的人头上，按 `===` 判的话
  //   钱包会被「刷回」上个月（plan 归位到月额度 = 新月里花掉的全吐回来），他下一次请求再刷一次新月（退回去的那一笔被归位抹掉），
  //   账本里还多一条倒填日期的 cycle_reset。YYYY-MM 补零定长，字符串比较就是时间先后；没有 cycle 的老钱包照旧刷。
  if (cur.tokenWallet.cycle && cur.tokenWallet.cycle >= cycle) return shape(cur);

  const grant = planOf(cur.tokenWallet.planId).monthlyTokens;
  const rolled = await User.findOneAndUpdate(
    { _id: userId, "tokenWallet.cycle": cur.tokenWallet.cycle },
    { $set: { "tokenWallet.plan": grant, "tokenWallet.cycle": cycle } },
    { returnDocument: "after" },
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

/**
 * 免费版的每日额度：每过一个 UTC 日往 plan 里补 `dailyTokens`，补到 `dailyCapTokens` 为止（最多攒 7 天）。
 *
 * ★ 新值 = max(现 plan, min(上限, 现 plan + 天数 × 每天))：
 *   · 上限只管「补」不管「有」—— 老账号改版前剩下的月度额度（可能几十万）原样留着，花到上限以下才开始补；
 *     写成 min(上限, …) 的话，第一次触达就把人家剩下的额度削没了；
 *   · 失败退款回 plan 的那部分也可能把 plan 顶过上限，同样不削（那是他自己的钱）。
 * ★ 条件原子更新抢占 `day`（与 cycle 同一招，W3）：并发两个请求只有一个补得上。
 *   要的是**扣前快照**（returnDocument:"before"），补了多少按快照算准 —— 回头再读一次会把并发扣费也算进去。
 * ★ 顺带把 cycle 推到当月：免费版不按月刷新，但 cycle 仍是「这个钱包活到哪个月」的记号（买套餐之后从这里接着走）。
 * ★ 老钱包没有 day（这个字段上线之前建的）：当作「今天第一次补」，补一天的量（不按注册以来的天数补 —— 那是凭空印钱）。
 */
async function accrueDaily(userId, cur, { day, cycle }) {
  const w = cur.tokenWallet;
  if (w.day === day) return shape(cur);
  const days = w.day ? daysBetween(w.day, day) : 1;
  if (days <= 0) return shape(cur); // 时钟往回拨（不该发生）：什么都不补，等真到了那一天
  const p = planOf(w.planId);
  const cap = Number(p.dailyCapTokens) || 0;
  const add = Math.min(cap, days * (Number(p.dailyTokens) || 0));

  const before = await User.findOneAndUpdate(
    // `day: null` 同时匹配「没有这个字段」与「是 null」（老钱包）
    { _id: userId, "tokenWallet.day": w.day ?? null },
    [
      {
        $set: {
          "tokenWallet.plan": { $max: ["$tokenWallet.plan", { $min: [cap, { $add: ["$tokenWallet.plan", add] }] }] },
          "tokenWallet.day": day,
          "tokenWallet.cycle": cycle,
        },
      },
    ],
    { returnDocument: "before", updatePipeline: true },
  )
    .select(SELECT)
    .lean();
  if (!before?.tokenWallet) {
    // 没抢到：别人刚补过，读一次现值即可
    return shape(await User.findById(userId).select(SELECT).lean());
  }
  const b = before.tokenWallet;
  const newPlan = Math.max(b.plan, Math.min(cap, b.plan + add));
  const delta = newPlan - b.plan;
  if (delta > 0) await writeEntry(userId, delta, "daily_grant", total(before) + delta, `${day} 每日额度（攒了 ${days} 天，上限 ${cap}）`);
  return shape({ tokenWallet: { ...b, plan: newPlan, day, cycle } });
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
  const r = await debitSplit(userId, amount, memo, now);
  return r ? r.wallet : null;
}

/**
 * 同 `debit`，另外交代**从哪两桶各扣了多少**（`took`）—— 退款按原桶退回要的就是它（见文件头 W2 的 ★★）。
 *
 * ★ 两桶的数从**扣前快照**算（returnDocument:"before"，同 revokeTokens 的 ★★）：管道里 plan 扣 min(plan, n)、
 *   addon 扣剩下的，快照里的 plan 就是那一拍的 plan —— 算出来的是这一次原子更新**真正**做的事。
 *   扣完再读一次去作差的话，中间任何一笔并发扣费 / 入账都会把它算歪。
 * @returns {Promise<{wallet:object, took:{plan:number, addon:number}}|null>} 不足 / 无钱包 → null
 */
async function debitSplit(userId, amount, memo = "", now = new Date()) {
  const n = toTokens(amount);
  if (n === null) return null;
  if (n === 0) {
    const w0 = await ensureWallet(userId, now);
    return w0 ? { wallet: w0, took: { plan: 0, addon: 0 } } : null;
  }
  await ensureWallet(userId, now);

  const before = await User.findOneAndUpdate(
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
    { returnDocument: "before", updatePipeline: true },
  )
    .select(SELECT)
    .lean();

  if (!before?.tokenWallet) return null;
  const b = before.tokenWallet;
  const tookPlan = Math.min(Number(b.plan), n);
  const took = { plan: tookPlan, addon: n - tookPlan };
  const after = { ...b, plan: b.plan - took.plan, addon: b.addon - took.addon };
  await writeEntry(userId, -n, "ark_spend", after.plan + after.addon, memo);
  return { wallet: shape({ tokenWallet: after }), took };
}

/**
 * 按扣的那两桶原样退回（W2 的未受理退款、taskRefund 的受理后失败退款、组图一张没拿到的全退都走它）。
 * 一次原子 $inc 两桶 + 一行流水。**不抵欠额**（退的是我们的钱，不是用户付的，同 credit 的 R-9）。
 *
 * ★ 先 ensureWallet 再退：付费套餐跨月那一拍的 plan 会被刷新**重写**（$set），先退后刷新的话 plan 那部分就被刷没了；
 *   所以先把月度刷新 / 每日补发做完，退款落在刷新之后（跨月才退的 plan 部分算进新的一个月 —— 退款窗口以分钟计，差不了几笔）。
 * @param {{plan:number, addon:number}} took 当初扣的两桶（debitSplit 的 took）
 * @returns {Promise<object|null>} 退后的钱包；账号不在了 → null
 */
async function refundSplit(userId, took, reason, memo = "", now = new Date()) {
  const p = toTokens(took?.plan ?? 0);
  const a = toTokens(took?.addon ?? 0);
  if (p === null || a === null) {
    console.error(`[tokens] refundSplit 收到不合法的两桶 ${JSON.stringify(took)} user=${userId} reason=${reason}`);
    return null;
  }
  const w0 = await ensureWallet(userId, now);
  if (!w0) return null;
  if (p + a === 0) return w0;
  const updated = await User.findOneAndUpdate(
    { _id: userId, tokenWallet: { $exists: true } },
    { $inc: { "tokenWallet.plan": p, "tokenWallet.addon": a } },
    { returnDocument: "after" },
  )
    .select(SELECT)
    .lean();
  if (!updated) return null;
  await writeEntry(userId, p + a, reason, total(updated), memo);
  return shape(updated);
}

/**
 * 入账进 **addon**（永不过期）：充值、同款奖励，以及**不知道当初扣的是哪两桶**的老退款（refundUnaccepted 没拿到 took 时的兜底）。
 * ★ 知道两桶的退款一律走 refundSplit（按原桶退回，见文件头 W2 的 ★★）—— 全进 addon 会把会过期的 plan 洗成永久余额。
 * ★ 付过钱的入账（PAYMENT_REASONS：recharge / plan_buy）在**同一次原子更新**里把 `paidEver` 置真 ——
 *   免费档门禁（config/tokens.isPaidUser）认的就是它。分两步写的话，钱到了、身份没到的那一拍他点高清仍会被拒。
 *   这笔付款之后被退款 / 拒付回收时，由回收方按订单重算（refreshPaidEver）。
 * @param {object} [opts]
 * @param {boolean} [opts.test] Play 的测试购买：照常入账、照常抵欠额，但**不置 paidEver**（一分钱没付，见 hasLivePayment）
 */
async function credit(userId, amount, reason, memo = "", now = new Date(), opts = {}) {
  const n = toTokens(amount);
  if (n === null || n === 0) return getWallet(userId, now);
  await ensureWallet(userId, now);
  const update = { $inc: { "tokenWallet.addon": n } };
  if (PAYMENT_REASONS.includes(reason) && !opts?.test) update.$set = { "tokenWallet.paidEver": true };
  const updated = await User.findOneAndUpdate({ _id: userId }, update, { returnDocument: "after" })
    .select(SELECT)
    .lean();
  if (!updated) return null;
  await writeEntry(userId, n, reason, total(updated), memo);
  // ★ R-9：**只有真的付过钱的入账才抵欠额**。`grant`（首次发放）与 `cycle_reset`
  //   （月度刷新）是「印钱」不是「付款」—— 让它们抵债，用户只要等到下月 1 号欠额就自动清零，
  //   退款套利的成本归零。`ark_refund` / `provider_failed` 同理：那是我们退给用户的，不是他付的。
  if (REPAY_REASONS.has(reason)) return await repayDebt(userId, `${reason} 后自动抵扣`);
  return shape(updated);
}

/** 哪些入账可以抵欠额。★ 加新取值前先想清楚：它是「用户付了钱」还是「我们印了钱」（与 PAYMENT_REASONS 是同一张单子） */
const REPAY_REASONS = new Set(PAYMENT_REASONS);

/**
 * 把已经发出去的 token 收回来（渠道退款 / 拒付）。
 *
 * ★★ 扣减顺序是 **addon → plan**，与 `debit` 的 plan→addon **刚好相反**（§15.4 R-1）：
 *   plan 每月作废，先扣 plan 等于让用户在月末退款几乎无损 —— 那几万 token 本来
 *   几小时后就蒸发了，扣它等于没扣。
 * ★★ 必须是**一次条件原子更新**（R-2）：读出来算好再 `$inc`，与并发扣费撞车会把
 *   addon 扣成负数，`min:0` 在保存时抛，表现成**回收静默失败**。
 * ★ 差额（余额不够的那部分）转欠额并冻结；`isTest` 订单豁免（R-12）——
 *   许可测试员的购买 3 分钟不 acknowledge 就会被 Google 自动退款，照常发币的政策下
 *   那会给测试员（也就是我们自己和朋友）凭空造出欠额。
 *
 * @returns {Promise<{clawed:number, shortfall:number, debt:number, wallet:object}|null>}
 */
async function revokeTokens({ userId, amount, memo = "", isTest = false, reason = "play_refund", now = new Date() }) {
  const n = toTokens(amount);
  if (n === null) return null;
  const before = await ensureWallet(userId, now);
  if (!before) return null;
  if (n === 0) return { clawed: 0, shortfall: 0, debt: debtOf(before), wallet: before };

  const updated = await User.findOneAndUpdate(
    { _id: userId },
    [
      {
        $set: {
          // addon 先扣：min(addon, n)
          "tokenWallet.addon": { $subtract: ["$tokenWallet.addon", { $min: ["$tokenWallet.addon", n] }] },
          // plan 扣剩下的：min(plan, n - 已从 addon 扣掉的)
          "tokenWallet.plan": {
            $subtract: [
              "$tokenWallet.plan",
              { $min: ["$tokenWallet.plan", { $subtract: [n, { $min: ["$tokenWallet.addon", n] }] }] },
            ],
          },
        },
      },
    ],
    // ★★ 要的是**更新前那一瞬**的文档（2026-09-25 评审）。原来是「先独立读一次算 beforeTotal、
    //   再拿 after 作差」——那个窗口里任何一次并发 credit / debit 都会把 clawed 算错，而且两个方向都坏：
    //     · 并发 credit ⇒ clawed 为负 ⇒ shortfall 被放大成「退款额 + 充值额」，给**没欠钱的人**挂上欠额并冻结，
    //       还会写出一条 delta 为正的 play_refund；
    //     · 并发 debit ⇒ clawed 虚高 ⇒ shortfall=0 少收回，账本的 -clawed 与真实余额变化对不上，
    //       破坏「逐笔 delta 累加 ≡ balanceAfter」这条唯一的对账抓手。
    //   拿 pre-image 就没有那个窗口：管道扣的恰好是 min(总额, n)，所以 clawed 能从它**算准**。
    { returnDocument: "before", updatePipeline: true },
  )
    .select(SELECT)
    .lean();
  if (!updated) return null;

  // 管道两桶各扣 min(...)，合计恒等于 min(扣前总额, n) —— 与上面那条 pre-image 一起，这个值是精确的
  const beforeTotal = total(updated);
  const clawed = Math.min(beforeTotal, n);
  const shortfall = n - clawed;
  // ★ balanceAfter 用**推导值**而不是回头再读一次：再读会把这一拍之后的并发写也算进去，
  //   而这一行要回答的是「这笔操作之后余额是多少」。
  const afterTotal = beforeTotal - clawed;
  await writeEntry(userId, -clawed, reason, afterTotal, memo, isTest ? { isTest: true } : {});

  // 下面几处要回给调用方的是**当前**钱包（含 debt），这属于展示，读一次即可
  const fresh = await User.findById(userId).select(SELECT).lean();
  if (shortfall <= 0) return { clawed, shortfall: 0, debt: debtOf(fresh?.tokenWallet), wallet: shape(fresh) };
  if (isTest) {
    // 豁免也要留痕：否则「为什么这笔差额没转欠额」在事后完全看不出来
    await writeEntry(userId, 0, "debt_incurred", afterTotal, `${memo} 测试购买差额豁免`, { costTokens: shortfall, isTest: true });
    return { clawed, shortfall, debt: debtOf(fresh?.tokenWallet), wallet: shape(fresh), exempt: true };
  }

  const owed = await User.findOneAndUpdate(
    { _id: userId },
    // debtSince 只在第一次欠钱时写：$max 对 null 与日期的比较行为不可靠，
    // 用两次更新反而要处理并发 —— 这里用聚合管道里的 $cond，仍是一次原子更新。
    [
      {
        $set: {
          "tokenWallet.debt": { $add: [{ $ifNull: ["$tokenWallet.debt", 0] }, shortfall] },
          "tokenWallet.debtSince": { $ifNull: ["$tokenWallet.debtSince", now] },
        },
      },
    ],
    { returnDocument: "after", updatePipeline: true },
  )
    .select(SELECT)
    .lean();
  // ★ delta=0、金额记 costTokens —— 照抄 admin_free 的形状（TokenLedger 里写了理由：
  //   balanceAfter 存在的唯一意义就是「账本能和余额对上」，把欠额记成负 delta 会让账本
  //   凭空比余额少一大截）。
  await writeEntry(userId, 0, "debt_incurred", afterTotal, `${memo} 差额转欠额`, { costTokens: shortfall });
  // ★ debtOf 吃的是 **tokenWallet 子文档**，不是 User 文档。传错不报错，只会让返回的 debt 恒为 0
  //   （而同一个对象里的 wallet.debt 却是对的）—— JSDoc 已经把 debt 写进返回契约了。
  return { clawed, shortfall, debt: debtOf(owed?.tokenWallet), wallet: shape(owed || fresh) };
}

/**
 * 用当前余额抵扣欠额。只被 `credit(recharge)` 与 `buyPlan` 调用（R-9）。
 * 抵多少 = min(欠额, 余额)；抵完 debt 归零、debtSince 清空、自动解冻。
 */
async function repayDebt(userId, memo = "", now = new Date()) {
  const cur = await User.findById(userId).select(SELECT).lean();
  if (!cur?.tokenWallet) return null;
  const debt = debtOf(cur.tokenWallet);
  if (debt <= 0) return shape(cur);
  const pay = Math.min(debt, total(cur));
  if (pay <= 0) return shape(cur);

  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      // ★★ **debt 也要进守卫**（2026-09-25 评审）：`pay` 来自上面那次独立的读，
      //   只守余额的话，两笔充值并发时两条都能过 —— 各扣 pay、而管道里的
      //   `$max: [0, debt - pay]` 把第二次夹到 0，于是**静默成功**：
      //   用户白少一份 pay，两条 debt_repaid 的 balanceAfter 还各自自洽，对账查不出来。
      //   触发条件是「余额 ≥ 2×欠额」，一点都不罕见。这正是本文件头 W1 写的「严禁读-改-写」。
      "tokenWallet.debt": debt,
      $expr: { $gte: [{ $add: ["$tokenWallet.plan", "$tokenWallet.addon"] }, pay] },
    },
    [
      {
        $set: {
          // 抵债走与消费同一个顺序（plan→addon）：plan 反正月底作废，先花它
          "tokenWallet.plan": { $subtract: ["$tokenWallet.plan", { $min: ["$tokenWallet.plan", pay] }] },
          "tokenWallet.addon": {
            $subtract: ["$tokenWallet.addon", { $subtract: [pay, { $min: ["$tokenWallet.plan", pay] }] }],
          },
          "tokenWallet.debt": { $max: [0, { $subtract: [{ $ifNull: ["$tokenWallet.debt", 0] }, pay] }] },
          "tokenWallet.debtSince": {
            $cond: [{ $gt: [{ $subtract: [{ $ifNull: ["$tokenWallet.debt", 0] }, pay] }, 0] }, "$tokenWallet.debtSince", null],
          },
        },
      },
    ],
    { returnDocument: "after", updatePipeline: true },
  )
    .select(SELECT)
    .lean();
  if (!updated) return shape(cur); // 抢不到（并发扣费刚花掉了）：下次入账再抵
  await writeEntry(userId, -pay, "debt_repaid", total(updated), memo || "抵扣退款欠额");
  return shape(updated);
}

/** 管理员免除欠额（R-13）。余额不动，落一条 delta=0 的账 */
async function forgiveDebt(userId, memo = "", now = new Date()) {
  const cur = await User.findById(userId).select(SELECT).lean();
  if (!cur?.tokenWallet) return null;
  const debt = debtOf(cur.tokenWallet);
  if (debt <= 0) return shape(cur);
  // ★ 同样要守 debt：免除与在途的 repayDebt 撞车时，不守的话会「先免除、再用余额去还一笔
  //   已经不存在的欠额」—— 用户白花一笔钱，而两条流水看起来都正常。
  const updated = await User.findOneAndUpdate(
    { _id: userId, "tokenWallet.debt": debt },
    { $set: { "tokenWallet.debt": 0, "tokenWallet.debtSince": null } },
    { returnDocument: "after" },
  )
    .select(SELECT)
    .lean();
  if (!updated) return shape(await User.findById(userId).select(SELECT).lean()); // 抢不到：别人刚改过，不落账
  await writeEntry(userId, 0, "debt_forgiven", total(updated), memo || "管理员免除欠额", { costTokens: debt });
  return shape(updated || cur);
}

/**
 * **冲正**：预扣多了，把多的那部分还回去。★ 与 `credit` 的去向**刻意相反** ——
 * 它进 **plan**（会作废的那一桶），不进 addon。
 *
 * ★★ 为什么不能共用 credit（2026-09-25 评审）：`debit` 是 plan 优先、plan 跨月清零、
 *   addon 永不过期。冲正进 addon 就等于给了一条「把当月额度洗成永久余额」的路：
 *   传一段静音音频 → 预扣从 plan 扣、退款进 addon，反复几次就把整月额度搬成永久的。
 *   冲正的语义是「这笔钱本来就不该扣」，所以要按扣的那一侧还回去。
 * ★ 失败调用的退款（W2 的未受理、taskRefund 的受理后失败）走 refundSplit，**按原桶**退回 —— 不是这里，也不是 credit：
 *   那笔钱从 plan 扣的就回 plan、从 addon 扣的就回 addon（2026-10-07 起；之前一律进 addon，见文件头 W2 的 ★★）。
 */
async function creditReversal(userId, amount, reason, memo = "", now = new Date()) {
  const n = toTokens(amount);
  if (n === null || n === 0) return getWallet(userId, now);
  await ensureWallet(userId, now);
  const updated = await User.findOneAndUpdate({ _id: userId }, { $inc: { "tokenWallet.plan": n } }, { returnDocument: "after" })
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

/** 购/续套餐：立即发放该套餐的当月额度（叠加在剩余 plan 上），并记住档位。
 *  ★ 同一次原子更新里把 `paidEver` 置真（付过钱，见 credit 的 ★）—— 套餐的月费本身也已经让 isPaidUser 为真，
 *    置真是为了「哪天套餐被降回免费（今天没有这条路）」时他仍算付过钱的人。 */
async function buyPlan(userId, planId, now = new Date()) {
  const plan = planOf(planId);
  if (plan.id !== planId) return null; // 未知档位
  await ensureWallet(userId, now);
  const updated = await User.findOneAndUpdate(
    { _id: userId },
    {
      $inc: { "tokenWallet.plan": plan.monthlyTokens },
      $set: { "tokenWallet.planId": plan.id, "tokenWallet.cycle": currentCycle(now), "tokenWallet.paidEver": true },
    },
    { returnDocument: "after" },
  )
    .select(SELECT)
    .lean();
  if (!updated) return null;
  await writeEntry(userId, plan.monthlyTokens, "plan_buy", total(updated), `购买 ${plan.name}`);
  // R-9：套餐是真付了钱的，抵债。⚠ 与之相对，ensureWallet 的 cycle_reset **绝不能**碰 debt。
  return await repayDebt(userId, "购买套餐后自动抵扣");
}

/**
 * 今天已经花掉多少 token（UTC 日）。日上限的判据数据（方案 §14.10）。
 * ★ 只数 `ark_spend`：退款（`ark_refund` / `provider_failed` …）要抵掉，否则一次「扣了又退」的失败调用
 *   会白白吃掉用户当天的额度。管理员免单那几行 delta=0，天然不计。
 * ★ 走的是 `{user:1, createdAt:-1}` 那条既有索引；每次付费调用多一次聚合查询，
 *   这是日上限的代价 —— 换成"读一个计数器字段"就要处理跨日重置与并发自增，
 *   那条路踩坑的成本远高于这一次查询。
 */
/** 计入「今天花了多少」的账本类别：一条支出 + 所有会把它退回来的类别 */
// ★ `provider_failed`（受理之后失败的退款，services/taskRefund）也在里面：退款要抵掉当日用量 ——
//   它不是 refundTag（billing.spec 那条扫 `refundTag: "…"` 的钉子扫不到它），所以 tests/taskRefund.spec.js 单独钉了一条。
//   ⚠ 退款落在第二个 UTC 日时抵的是那一天的用量（spentToday 夹在 0），等于那一天多出一点余量 —— 上界是一发的钱，接受。
const SPEND_REASONS = ["ark_spend", "ark_refund", "minimax_refund", "tutor_refund", "provider_failed"];

async function spentToday(userId, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rows = await TokenLedger.aggregate([
    // ★ 退款要抵掉当日用量 —— 每一个 refundTag 都得在这个列表里（`minimax_refund` 漏过一次）。
    //   tests/billing.spec.js 有一条把「所有 refundTag ⊆ 这里」钉死的用例。
    { $match: { user: new mongoose.Types.ObjectId(String(userId)), reason: { $in: SPEND_REASONS }, createdAt: { $gte: start } } },
    { $group: { _id: null, sum: { $sum: "$delta" } } },
  ]);
  const net = rows.length ? Number(rows[0].sum) : 0;
  return net < 0 ? -net : 0;
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
  currentDay,
  ensureWallet,
  getWallet,
  debit,
  debitSplit,
  refundSplit,
  PAYMENT_REASONS,
  hasLivePayment,
  refreshPaidEver,
  debtOf,
  creditReversal,
  SPEND_REASONS,
  spentToday,
  revokeTokens,
  repayDebt,
  forgiveDebt,
  credit,
  noteAdminFree,
  buyPlan,
  mintedToday,
  listLedger,
};
