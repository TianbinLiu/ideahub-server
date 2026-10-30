/**
 * @file billing.service.js - 「钱」的序列：冻结门禁 → 原子扣 → 转发 → 没受理退 → 管理员免单记账
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节
 *
 * ★★ **这段序列只有这一份**（铁律六）。它原先长在 `arkGateway.chargedArkCall` 里，
 *   于是「要扣费就得走方舟那条路」—— 结果是 TTS、ASR、陪聊、客服四条链路一分钱不扣，
 *   而它们的单账号理论日上限按闸门本身算是 **$1,250/日 + ¥2,160/日**。
 *   抽出来之后，任何一条调用付费上游的链路都能用同一段序列，
 *   `chargedArkCall` 变成「模型白名单 + priceOf + 这段序列」。
 *
 * ★ 顺序不能动，每一步都有事故背书：
 *   ① 冻结（退款欠额）与套餐门禁在最前 —— 拒了就一分钱不动；
 *   ② **扣费必须在转发之前**：读-改-写或先转发后扣费，并发下都会双花；
 *   ③ 上游**没受理**就当场退（W2，按扣的那两桶原样退回：refundSplit）。
 *      受理之后才失败（排队跑完报 failed / cancelled / expired、MiniMax 报 Fail）2026-10-07 起**也退**，
 *      但不在这条同步序列里 —— 结局要等上游明说，那时请求早回去了。唯一实现在 services/taskRefund.service.js，
 *      它要的「扣了多少、从哪两桶扣的」由这里交出去（preAuthorize / chargedCall 的 `took`）；
 *   ④ 管理员免单不动余额，但**必须落一笔 costTokens**，否则月底对账会多出一截
 *      查不到来源的钱（见 tokenWallet.noteAdminFree 的 ★★）。
 */
const wallet = require("./tokenWallet.service");
// 「谁是管理员」只有 utils/roles 一处判据（铁律六）：角色名散着写，
// 哪天多出一个 moderator 就会漏改，而漏改的表现是某条链路悄悄变成免费
const { isAdmin } = require("../utils/roles");
const { dailyCapDenial, dailySoftWarn, isPaidUser } = require("../config/tokens");

/**
 * 跑一次要花钱的上游调用。
 *
 * @param {object}   o.user      req.user（role 决定免不免单）
 * @param {number}   o.cost      这次调用值多少 token（由调用方按各自的价目表算好）
 * @param {string}   o.memo      流水备注：`kind model` 这样的可读串，月底对账靠它
 * @param {Function} o.forward   async () => ({ accepted: boolean, ... })，返回值原样带回
 * @param {string}   [o.refundTag="ark_refund"] 退款流水的类别（分得出哪家上游退的）
 * @param {string}   [o.denyReason] 额外的门禁（套餐不足等）：给了就直接 403，不扣费
 * @param {object}   [o.denyExtra]  拒绝时并进 403 回包的结构化字段（免费档门禁的 `allowed`：此刻免费版能用的档名。
 *                                  英文界面不显示服务端的中文句子，客户端靠它自己说「哪几档能用」）
 * @returns {Promise<{ok:boolean, status?:number, body?:object, wallet:object|null, cost:number, free:boolean, result?:object}>}
 *   `ok:false` 时 status/body 是**可以直接回给客户端**的完整响应。
 */
/**
 * 只做「门禁 + 预扣」这前半段，转发由调用方自己跑。
 *
 * ★ 为什么要把它单独露出来：流式链路（陪聊 / 客服 / 试聊）的 SSE 是**边跑边写**的，
 *   包不进 `chargedCall` 的 forward —— 而「先扣再转发」这个顺序是不能让步的
 *   （先转发后扣费，并发下必然双花）。所以那几条用 preAuthorize + refundUnaccepted 两段，
 *   序列本身仍然只有这一份实现。
 * @returns {{ok:false,status,body,wallet}|{ok:true,wallet,before,free,cost,took}}
 *   `took` = 这一次从 plan / addon 各扣了多少（管理员免单两桶都是 0）。没受理退款（refundUnaccepted）与
 *   受理后失败退款（taskRefund）都按它原样退回 —— 调用方退款时**把它传回来**。
 */
async function preAuthorize({ user, cost, memo, denyReason = "", denyExtra = null }) {
  const free = isAdmin(user);
  // 一趟读，三个用途：冻结判据、402 时报给用户的余额、顺带完成钱包初始化与跨月刷新
  const before = await wallet.getWallet(user._id);
  let w = before;
  let took = { plan: 0, addon: 0 };

  if (!free) {
    // ★ 退款欠额冻结（§15.4 R-7/R-8）：403 而不是 402 —— 402 的含义是「充值就能继续」，
    //   欠额下用户要先知道欠了多少、充多少才够，合并成 402 会让他一直充一直被拒。
    const debt = wallet.debtOf(before);
    if (debt > 0) {
      return {
        ok: false,
        status: 403,
        body: {
          ok: false,
          code: "WALLET_FROZEN",
          message: `账户有 ${debt} token 欠额，充值抵扣后即可继续生成`,
          debt,
          need: cost,
          balance: before ? before.plan + before.addon : 0,
        },
        wallet: before,
        cost,
        free,
      };
    }

    if (denyReason) {
      // 403 而不是 402：这一条充多少都没用，得换套餐。合并成同一个码，用户会一直充值一直被拒。
      return {
        ok: false,
        status: 403,
        // ★ denyExtra 先摊、四个固定字段后写：附加字段只能**加**东西，盖不掉 code / message
        body: { ...(denyExtra || {}), ok: false, code: "PLAN_REQUIRED", message: denyReason, planId: before?.planId ?? null },
        wallet: before,
        cost,
        free,
      };
    }

    // ★ 每日上限（§14.10）。**余额不能替代它**：付费档的余额可以很大，
    //   而「一天之内烧光」正是被盗号与脚本滥用的形状，账单要到月底才看得见。
    //   超限只拒当天、不封号，返回的是能直接显示给用户的整句话。
    const spent = await wallet.spentToday(user._id);
    // ★ 付费与否按 isPaidUser（付费套餐或付过钱）分档 —— 与免费档门禁同一个口径（见 dailyCapDenial 的 ★★）
    const paid = isPaidUser(before);
    const capped = dailyCapDenial({ planId: before?.planId, paid, spentToday: spent, cost, accountAgeDays: accountAgeDays(user) });
    if (capped) {
      return {
        ok: false,
        status: 429,
        body: { ok: false, code: "DAILY_LIMIT", message: capped, spentToday: spent, need: cost },
        wallet: before,
        cost,
        free,
      };
    }
    if (dailySoftWarn({ planId: before?.planId, paid, spentToday: spent })) {
      console.warn(`[billing] 付费账号 ${user._id} 今日已用 ${spent} token（软告警线）`);
    }

    const debited = await wallet.debitSplit(user._id, cost, memo);
    if (debited) {
      w = debited.wallet;
      took = debited.took;
    } else {
      w = null;
    }
    if (!w) {
      // 402 而不是 400：App 据此把用户引到充值页，而不是当成"参数写错了"
      return {
        ok: false,
        status: 402,
        body: {
          ok: false,
          code: "INSUFFICIENT_TOKENS",
          message: "token 余额不足",
          need: cost,
          balance: before ? before.plan + before.addon : 0,
        },
        wallet: before,
        cost,
        free,
      };
    }
  }
  return { ok: true, wallet: w, before, free, cost, took };
}

/**
 * 上游**没受理**时把钱退回去（W2）。受理之后才失败的不走这里，走 services/taskRefund（结局要等上游明说）。
 *
 * @param {{plan:number, addon:number}} [o.took] preAuthorize 交出来的两桶。**给了就按原桶退回**（refundSplit）；
 *   没给（老调用点 / 两桶对不上）才退回 addon 兜底 —— 那是改版前的行为，只会让用户多一点不过期的余额，不会让钱蒸发。
 * ★★ 为什么要按原桶（2026-10-07）：原来一律进 addon，于是「敏感词提示词 → 400 → 从 plan 扣的钱退进 addon」
 *   就是一条把会过期的当月额度洗成永久余额的路，零成本、可以反复走。
 */
async function refundUnaccepted({ user, cost, memo, refundTag = "ark_refund", took = null }) {
  if (isAdmin(user) || !cost) return null;
  console.warn(`[billing] ${memo} 上游未受理，已退回 ${cost} token`);
  const p = Number(took?.plan);
  const a = Number(took?.addon);
  if (Number.isInteger(p) && Number.isInteger(a) && p >= 0 && a >= 0 && p + a === Number(cost)) {
    return wallet.refundSplit(user._id, { plan: p, addon: a }, refundTag, `${memo} 未受理`);
  }
  return wallet.credit(user._id, cost, refundTag, `${memo} 未受理`);
}

/** 管理员免单的一次调用：不动余额，但必须落一笔（月底对账要对得上上游账单） */
async function noteFreeCall({ user, cost, memo, snapshot = null }) {
  if (!isAdmin(user)) return null;
  return wallet.noteAdminFree(user._id, cost, `admin ${memo}`, snapshot);
}

/**
 * 跑一次要花钱的上游调用（非流式链路用这一条：门禁 → 预扣 → 转发 → 没受理退 → 免单记账）。
 * @param {Function} o.forward async () => ({ accepted: boolean, ... })，返回值原样带回
 */
async function chargedCall({ user, cost, memo, forward, refundTag = "ark_refund", denyReason = "", denyExtra = null }) {
  const pre = await preAuthorize({ user, cost, memo, denyReason, denyExtra });
  if (!pre.ok) return pre;
  let { wallet: w } = pre;
  const { free, before, took } = pre;

  // ★★ forward **抛异常**时钱也必须退（2026-09-25 评审）。原来这里是裸 await：
  //   `tts.routes.js` 的 `await up.text()` 在它自己的 try 之外，上游 mid-stream 断开
  //   （不需要超时）就会让异常穿过这里 → 500，而 refundUnaccepted 永不执行 ——
  //   「报错一次扣一次钱」，正是 W2 要堵的形状。退完再原样抛，路由那边的行为不变。
  let result
  try {
    result = await forward()
  } catch (e) {
    await refundUnaccepted({ user, cost, memo: `${memo} 异常`, refundTag, took })
    throw e
  };
  const accepted = Boolean(result && result.accepted);

  if (!accepted) {
    const back = await refundUnaccepted({ user, cost, memo, refundTag, took });
    w = back ?? w;
  }
  // ★ 管理员那笔账记在转发之后、且只在上游受理时记，与扣费的顺序正好相反：
  //   扣费必须在前（并发双花），而免单这一路不动余额，可以等"确实花出去了"再落账。
  if (accepted) await noteFreeCall({ user, cost, memo, snapshot: before });

  // `took`：受理了的异步任务要记进 GenTaskCharge（受理后失败时按它原样退回，见 services/taskRefund）
  return { ok: true, wallet: w, cost, free, accepted, result, took };
}

/**
 * 多退少补：上游告诉我们真实用量之后，把预扣多出来的部分退回去。
 * ASR 用它 —— 音频时长要等上游识别完才知道，预扣只能按**字节数上界**估。
 * ★ 只退不补：真实用量比预估多时不再追扣（那会让一次调用扣两次，而差额的量级可忽略）。
 */
async function settleOverCharge({ user, prepaid, actual, memo, refundTag = "ark_refund" }) {
  if (isAdmin(user)) return null;
  const back = Math.floor(prepaid - actual);
  if (!Number.isFinite(back) || back <= 0) return null;
  // ★ 走 creditReversal（进 plan）而不是 credit（进 addon）：见那个函数的 ★★。
  return wallet.creditReversal(user._id, back, refundTag, `${memo} 预扣多退`);
}

/** 账号注册到今天多少天（迎新期判据）。拿不到创建时间就当老账号处理（从严） */
function accountAgeDays(user) {
  const t = user && user.createdAt ? new Date(user.createdAt).getTime() : NaN;
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 86400000;
}

module.exports = { chargedCall, preAuthorize, refundUnaccepted, noteFreeCall, settleOverCharge, isAdmin };
