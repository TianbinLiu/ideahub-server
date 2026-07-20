// src/services/points.service.js
// 虚拟点数记账层 —— 所有点数变动的唯一入口。
//
// ★点数是平台虚拟点数，不是真钱：无现金价值，不可提现/兑换，不接任何真实支付。
//
// ══ 三条硬不变量 ══════════════════════════════════════════════════
// 做错了【不会报错】，只会悄悄多印钱或少给人钱。所以逻辑集中在这一个文件里，别在控制器里手搓。
//
// 【I1 只有注册赠送能印钱】
//    除 reason="signup" 外，每一次点数变动都必须【成对】写账且【和为零】。
//    对账式：sum(所有 delta) === sum(所有 signup 的 delta)。
//    → 落地方式：非 signup 的写账一律走 writeTransferEntries()，它只接受一对和为零的分录，
//      而且两条一次 insertMany 写进去，不会只落一半。
//
// 【I2 并发不超付】
//    一切扣减/发放必须用【条件原子更新】：findOneAndUpdate({_id, points:{$gte:X}}, {$inc:{points:-X}})。
//    ★严禁读-改-写（先 find 再 save）—— 两个请求并发时余额判断会同时通过，直接双花。
//    本文件里 debitUser / claimEscrow / settleBountyEscrow 都是这个形状，改的时候别退化。
//
// 【I3 退款幂等】
//    关闭悬赏退还未用完的托管必须幂等：靠 Bounty.refundedAt 的条件原子更新抢占，
//    只有抢到的那一次真正退款。反复退款 = 反复印钱。
//
// ══ 托管账户 ══════════════════════════════════════════════════════
// 分录里 user:null 表示挂在【悬赏的托管账户】上。某悬赏的托管余额有两个等价表示：
//   a) 该 bounty 下所有 user:null 分录的 delta 之和（账本口径，用于对账/测试）
//   b) Bounty.escrowPoints（可做条件原子更新的镜像，用于运行时判断）
// 两者必须恒等。改一个就必须改另一个。
const User = require("../models/User");
const Bounty = require("../models/Bounty");
const PointsLedger = require("../models/PointsLedger");
const { SIGNUP_GRANT_POINTS, PERSONA_FEE_PERCENT } = require("../config/points");
const { badRequest } = require("../utils/http");

/** 点数上限：和 bounty.schemas 的 reward 上限一致，纯防呆 */
const MAX_POINTS = 100000000;

/**
 * 归一化成非负整数点数。NaN / Infinity / 负数 / 超限一律返回 null（由调用方拒绝）。
 * ★点数是账本里的数，只收整数：小数会引入浮点误差，几笔加减之后 sum(delta) 就不再精确等于 0，
 *   I1 的对账式会莫名其妙地挂掉。
 */
function toPoints(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > MAX_POINTS) return null;
  return n;
}

function isDuplicateKeyError(err) {
  return Boolean(err && (err.code === 11000 || err.code === 11001));
}

/**
 * 原子扣款（I2）。points 够才扣，一次完成判断+扣减。
 * @returns {Promise<number|null>} 扣后余额；余额不足 / 用户不存在 / 还没 backfill points 字段 → null
 */
async function debitUser(userId, amount) {
  const updated = await User.findOneAndUpdate(
    { _id: userId, points: { $gte: amount } },
    { $inc: { points: -amount } },
    { new: true }
  )
    .select("points")
    .lean();
  return updated ? Number(updated.points) : null;
}

/**
 * 原子入账。
 * @returns {Promise<number|null>} 入账后余额；用户不存在 → null
 */
async function creditUser(userId, amount) {
  const updated = await User.findOneAndUpdate({ _id: userId }, { $inc: { points: amount } }, { new: true })
    .select("points")
    .lean();
  return updated ? Number(updated.points) : null;
}

/**
 * 写一对【和为零】的分录（I1 的落地点）。
 * 两条一次 insertMany 提交，避免只落一半把账本写歪。
 * 这里会先自检和是否为零 —— 与其把歪账写进库里等对账时才发现，不如当场炸。
 */
async function writeTransferEntries(entries) {
  const sum = entries.reduce((acc, e) => acc + Number(e.delta || 0), 0);
  if (sum !== 0) {
    throw new Error(`[points] refusing to write unbalanced ledger entries (sum=${sum})`);
  }
  await PointsLedger.insertMany(entries, { ordered: true });
}

/**
 * 注册赠送 —— 【唯一】的印钱口，单条分录（无对手方）。
 *
 * ★余额不在这里加：新用户的 1000 点由 User schema 的 default（= SIGNUP_GRANT_POINTS）
 *   在 User.create 那一刻就给足了，这里只负责把它记进账本。
 *   若这里再 $inc 一次，新用户就会拿到 2000 点却只有一条 +1000 的分录 —— 悄悄印钱。
 *
 * 幂等：同一 user 不得有两条 signup 分录，由 PointsLedger 上
 * {user, reason:"signup"} 的唯一索引在库层面挡住（代码"先查再插"挡不住并发）。
 *
 * @returns {Promise<boolean>} true = 本次记入；false = 已经有了/用户不存在，跳过
 */
async function grantSignupBonus(userId) {
  const user = await User.findById(userId).select("points").lean();
  if (!user) return false;

  try {
    await PointsLedger.create({
      user: userId,
      bounty: null,
      delta: SIGNUP_GRANT_POINTS,
      reason: "signup",
      // 记真实余额，不兜底：新用户此刻的 points 就是 schema default 给的那份
      balanceAfter: Number(user.points),
      memo: "注册赠送虚拟点数",
    });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false; // 已赠送过 → 幂等跳过
    throw err;
  }
}

/**
 * 发布/追加托管：发布者 -amount → 该悬赏的托管账户 +amount。
 * ★只动「用户余额 + 账本」，不动 Bounty.escrowPoints —— 那一侧由调用方负责，
 *   因为它往往要和别的条件（名额、refundedAt）挤在同一个原子更新里。
 * 余额不足 → badRequest("点数不足")，此时【什么都没写】，调用方保证悬赏还没建/还没改。
 */
async function holdEscrow({ bountyId, posterId, amount, memo }) {
  if (amount <= 0) return 0; // 0 点不写分录（写了也是一对 0，纯噪音）

  const balanceAfter = await debitUser(posterId, amount);
  if (balanceAfter === null) badRequest("点数不足");

  await writeTransferEntries([
    { user: posterId, bounty: bountyId, delta: -amount, reason: "bounty_hold", balanceAfter, memo },
    { user: null, bounty: bountyId, delta: amount, reason: "bounty_hold", balanceAfter: null, memo },
  ]);
  return amount;
}

/**
 * 托管 → 猎人：托管账户 -amount → hunter +amount。
 * ★调用方【必须】已经用条件原子更新从 Bounty.escrowPoints 里扣走了这 amount，
 *   否则托管会被透支（账本上 user:null 的和变成负数）。
 */
async function payEscrowToHunter({ bountyId, hunterId, amount, memo }) {
  if (amount <= 0) return 0;

  const balanceAfter = await creditUser(hunterId, amount);
  // ★收款人不存在（本仓确有硬删用户的路径：admin.controller / users.controller）。
  // 此时调用方【已经把这笔从 escrowPoints 里原子扣走了】—— 若照常写分录，
  // 就成了「托管付出去了、没人收到」，点数凭空消失。I1 还照样成立（那对分录和为零），
  // 所以对账式抓不到它 —— 这正是必须在这里显式挡住的原因。
  // 补偿：把托管原样加回去，再抛错让审批失败（宁可审批不了，也不能吞掉发布者的点数）。
  if (balanceAfter === null) {
    await Bounty.updateOne({ _id: bountyId }, { $inc: { escrowPoints: amount } });
    badRequest("猎人账号不存在，无法发放赏金");
  }
  await writeTransferEntries([
    { user: null, bounty: bountyId, delta: -amount, reason: "bounty_reward", balanceAfter: null, memo },
    { user: hunterId, bounty: bountyId, delta: amount, reason: "bounty_reward", balanceAfter, memo },
  ]);
  return amount;
}

/**
 * 托管 → 发布者（退款）。
 * ★调用方【必须】已经原子地把这 amount 从 Bounty.escrowPoints 里claim走了。
 */
async function refundEscrowToPoster({ bountyId, posterId, amount, memo }) {
  if (amount <= 0) return 0; // 剩余为 0 时不写分录

  const balanceAfter = await creditUser(posterId, amount);
  // 发布者已被硬删：托管已被调用方 claim 走，若照常写分录就是「退了、但没人收到」。
  // 这里【不补偿回 escrow】—— 退款走的是 refundedAt 幂等抢占，补回去会让下次退款又抢一遍。
  // 收款人都没了，托管留在原地即可；分录不写，账本不会出现「付给不存在的人」的假记录。
  if (balanceAfter === null) {
    return 0;
  }
  await writeTransferEntries([
    { user: null, bounty: bountyId, delta: -amount, reason: "bounty_refund", balanceAfter: null, memo },
    { user: posterId, bounty: bountyId, delta: amount, reason: "bounty_refund", balanceAfter, memo },
  ]);
  return amount;
}

/**
 * 结算悬赏托管：把剩余托管一次性退还发布者。关闭 / 完成 / 删除悬赏时调用。
 *
 * ★幂等（I3）就靠这里的第一步：只有把 refundedAt 从 null 改成时间戳的【那一个】调用者
 *   才拿得到 escrowPoints 并真正退款；并发的、重复点的一律拿到 null 直接返回 0。
 *   单文档 findOneAndUpdate 是原子的，所以「连点两次关闭」只可能有一个抢到。
 *   ⚠️ 绝不能改成「先 find 看 refundedAt，再 save」——那样两次点击会各退一次 = 凭空印钱。
 *
 * new:false 是有意的：要的是【改之前】的 escrowPoints（改之后已经被清零了）。
 *
 * @returns {Promise<number>} 实际退还的点数；已结算过 → 0
 */
async function settleBountyEscrow(bountyId, memo) {
  const claimed = await Bounty.findOneAndUpdate(
    { _id: bountyId, refundedAt: null },
    { $set: { refundedAt: new Date(), escrowPoints: 0 } },
    { new: false }
  )
    .select("author escrowPoints")
    .lean();

  if (!claimed) return 0; // 已结算过（或悬赏不存在）→ 跳过，绝不重复退款

  const amount = Number(claimed.escrowPoints || 0);
  return refundEscrowToPoster({ bountyId, posterId: claimed.author, amount, memo });
}

/** 人格购买的平台抽成（点数，整数，floor）。 */
function personaFee(price) {
  return Math.floor((price * PERSONA_FEE_PERCENT) / 100);
}

/**
 * 人格购买转账：买家 -price → 创作者 +(price-fee)，平台抽成 fee 记到 user:null 分录。
 * 三条分录和为零（fee=0 时省掉第三条），I1 对账式与「用户余额=个人流水和」都保持。
 *
 * ★只做「余额 + 账本」——购买记录（PersonaPurchase）的 claim/补偿由调用方
 *   （persona.controller.purchasePersona）负责，与 holdEscrow 不碰 Bounty.escrowPoints 同款分工。
 *
 * @returns {Promise<{price:number, fee:number, buyerBalance:number}>}
 * @throws badRequest 余额不足 / 创作者账号不存在（此时买家已退款，什么都没写进账本）
 */
async function purchasePersonaTransfer({ personaId, buyerId, creatorId, price, memo }) {
  const fee = personaFee(price);
  const creatorAmount = price - fee;

  const buyerBalance = await debitUser(buyerId, price);
  if (buyerBalance === null) badRequest("点数不足");

  const creatorBalance = await creditUser(creatorId, creatorAmount);
  // 创作者已被硬删：把买家的钱原样退回去，交易不成立、账本一个字不写。
  if (creatorBalance === null) {
    await creditUser(buyerId, price);
    badRequest("创作者账号不存在，无法购买");
  }

  const entries = [
    { user: buyerId, persona: personaId, delta: -price, reason: "persona_buy", balanceAfter: buyerBalance, memo },
    { user: creatorId, persona: personaId, delta: creatorAmount, reason: "persona_income", balanceAfter: creatorBalance, memo },
    { user: null, persona: personaId, delta: fee, reason: "persona_fee", balanceAfter: null, memo },
  ].filter((e) => e.delta !== 0);
  await writeTransferEntries(entries);

  return { price, fee, buyerBalance };
}

module.exports = {
  SIGNUP_GRANT_POINTS,
  MAX_POINTS,
  toPoints,
  debitUser,
  creditUser,
  writeTransferEntries,
  grantSignupBonus,
  holdEscrow,
  payEscrowToHunter,
  refundEscrowToPoster,
  settleBountyEscrow,
  personaFee,
  purchasePersonaTransfer,
};
