/**
 * @file taskRefund.service.js - 受理之后才失败的生成任务：按原桶退钱，恰好一次（2026-10-07 主人拍板「做生成失败返回 token」）
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节
 *
 * ★★ 这是「受理之后失败退钱」的**唯一实现**（铁律六）。在它之前的口径是 W2 那句「受理之后才失败不退」——
 *   方舟只对成功生成的视频计费，而我们照收；主人 2026-10-07 改了：上游**明说**这一发失败 / 取消 / 过期（方舟
 *   `failed` / `cancelled` / `expired`；MiniMax `Fail`）就把这一发的钱按扣的那两桶退回去。四条出片路共用它：
 *     · /api/ark 代理（Seedance 普通出片 / 样片两步 / r2v / Seed3D）—— billedForward 受理时 recordCharge，轮询端点看见终态时 settleTask；
 *     · 白模化（服务端自己发的 r2v）—— 受理时 recordCharge，取回结果那一步看见 failed 时 settleTask；
 *     · 真人档 MiniMax —— 受理时 recordCharge（带区域），轮询端点看见 Fail 时 settleTask（开关 MINIMAX_FAIL_REFUND）；
 *     · 没人再来问的那些（App 被杀、卸载）—— 0 号实例的清扫器（src/index.js）每 5 分钟问一次上游。
 *
 * ★★ 只认**上游明说的终态**，别的一律不退：我们自己的超时、方舟的 404 / 504、回包读不懂、还在排队 / 运行，
 *   都不是「失败」——那时钱可能正在方舟那边变成一段好好的视频。把「没问到」当「失败」退了钱，就是白送一段片子。
 * ★★ 恰好一次：GenTaskCharge.state 的 open → claimed 是条件原子更新，抢到的那一方才动钱；
 *   崩在 claimed 之后的由 resumeClaimed 按**账本 memo**判断钱进没进过（remixReward.pay 同一招）。
 *   ⚠ 残留窗口（与 remixReward / play 补发同一个）：refundSplit 是「先 $inc 余额、再写流水」，流水写失败只记日志 ——
 *   恰好那一笔流水写失败、进程又在标 refunded 之前死掉，续办时看不到 memo 会再退一次。单机 Mongo 没有事务可用，
 *   量级是毫秒级、而且要两件事同时坏，另一边的代价是「失败了钱却没退」。
 * ★ 退给**账的主人**（GenTaskCharge.user），不是来问的人：轮询端点不查归属，任何登录用户都能问任何任务号。
 *   `refund` 字段与余额头也只给主人（别人的余额不能写进我的钱包镜像）。
 * ★ 管理员免单（free）与上线之前的老任务（没有这一行账）一律不退：前者没扣钱，后者不知道扣了多少、从哪一桶扣的。
 */
const GenTaskCharge = require("../models/GenTaskCharge");
const TokenLedger = require("../models/TokenLedger");
const BlockoutJob = require("../models/BlockoutJob");
const wallet = require("./tokenWallet.service");
const { createNotification } = require("./notification.service");
const { callArk, T_POLL } = require("./arkGateway.service");
const { BASES, minimaxRegion, minimaxKey } = require("../config/minimax");

/** 退款流水的类别（TokenLedger enum 里早就有它，2026-10-07 起才有写入方）。在 SPEND_REASONS 里：退款抵掉当日用量 */
const LEDGER_REASON = "provider_failed";
/** 站内通知的类型（models/Notification）：钱是在本人自己那次轮询之外退的，就用它告诉他一声 */
const NOTIFY_TYPE = "GEN_TASK_REFUND";

/** 受理之后多久清扫器才第一次去问上游（出片通常几分钟；更早问只是白查） */
const FIRST_CHECK_MS = 10 * 60 * 1000;
/** 问不出结局时的退避上限 */
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** claimed 停多久算搁浅（正常情况下只存在几十毫秒：一次 $inc + 一次标记） */
const CLAIM_STALE_MS = 5 * 60 * 1000;
/**
 * 一直问不出结局的行，多久之后放弃（记成 lost 并吼）。
 * ★ 8 天：每一发 Seedance 任务都钉了 execution_expires_after = 24 小时（arkGateway.withServerTaskFields），
 *   排队 / 运行超过 24 小时方舟自己会标 expired；方舟的任务记录能查 7 天。8 天还没结局说明是我们这边一直没问到
 *   （上游一直 5xx、MiniMax 区域被切走、退款开关关着），再问也没用了 —— 要人看。
 */
const LOST_AFTER_MS = 8 * 24 * 60 * 60 * 1000;
/** 退完钱之后，收尾（钉 BlockoutJob / 发通知）没做完多久由清扫器接手（给正在办的那一方留足时间） */
const FOLLOWUP_GRACE_MS = 60 * 1000;
/** 清扫器每一轮最多问上游几次（方舟查询的 QPS 上限没有公开数，宁少勿多；退避靠 nextCheckAt） */
const SWEEP_LIMIT = 30;

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ARK_FAILED = new Set(["failed", "cancelled", "expired"]);

/** 退款流水的 memo（逐字）—— 续办时靠它判断「这一笔进没进过账」，别改形状 */
function memoOf(provider, taskId) {
  return `${LEDGER_REASON} ${provider} task:${taskId}`;
}

/** MiniMax 失败退款的开关：`MINIMAX_FAIL_REFUND=off` 关掉（缺省开）。每次现读 env（运维改完重启即生效，测试也能切） */
function minimaxRefundOn() {
  return !["off", "false", "0"].includes(String(process.env.MINIMAX_FAIL_REFUND ?? "").trim().toLowerCase());
}

/**
 * 上游这个状态算什么结局。**判据只有这一处**。
 * @returns {"failed"|"succeeded"|null} null = 还没结局（排队 / 运行 / 认不出的状态 —— 认不出的也不当失败）
 */
function verdictOf(provider, status) {
  const s = String(status ?? "");
  if (provider === "minimax") {
    if (s === "Fail") return "failed";
    if (s === "Success") return "succeeded";
    return null;
  }
  if (s === "succeeded") return "succeeded";
  if (ARK_FAILED.has(s)) return "failed";
  return null;
}

/** 这一行结完了之后什么时候回收 */
function purgeAtOf(now) {
  return new Date(now.getTime() + GenTaskCharge.KEEP_AFTER_SETTLE_MS);
}

/** 扣的那两桶：认 debitSplit 给的数；对不上（不该发生）就整笔记进 addon 并吼 —— 退进 addon 至少不会让钱跨月蒸发 */
function normalizeTook(took, charged) {
  const p = Number(took?.plan);
  const a = Number(took?.addon);
  if (Number.isInteger(p) && Number.isInteger(a) && p >= 0 && a >= 0 && p + a === charged) return { plan: p, addon: a };
  if (charged > 0) console.error(`[task-refund] 扣费两桶对不上（${JSON.stringify(took)} vs ${charged}），按全进 addon 记`);
  return { plan: 0, addon: charged };
}

/**
 * 受理之后记一笔账。**任何失败只吼不抛**：调用方那一拍钱已经扣了、任务已经受理，抛出去会变成 5xx，
 * 客户端以为没受理去重试 = 再花一次钱。落账失败的代价是「这一发失败时退不了钱」—— 所以要吼得很响。
 *
 * @param {object} o
 * @param {"ark"|"minimax"} o.provider
 * @param {string} o.taskId 上游任务号
 * @param {string} o.kind   video / draft / draftFinal / 3d / blockout / minimax
 * @param {*}      o.user   钱是谁的（ObjectId）
 * @param {number} o.cost   这一发值多少（chargedArkCall 的 cost）
 * @param {boolean} o.free  管理员免单（chargedArkCall 的 free）
 * @param {{plan:number, addon:number}} o.took 从哪两桶扣的（chargedArkCall 的 took）
 * @returns {Promise<object|null>} 落下的那一行（lean）；没落下 null
 */
async function recordCharge({ provider, taskId, kind, user, model = "", cost, free = false, took, memo = "", region, now = new Date() }) {
  const id = String(taskId ?? "");
  if (!TASK_ID_RE.test(id)) {
    console.error(`[task-refund] 受理了却拿不到能用的任务号（${provider} ${kind}），这一发失败时退不了钱`);
    return null;
  }
  const charged = free ? 0 : Math.max(0, Math.round(Number(cost) || 0));
  // 免单 / 一分没扣：没有钱要退，落成终态（不占清扫器的查询额度）。留一行是为了「那一发退了没有」查得到答案
  const nothingToRefund = !!free || charged <= 0;
  try {
    const doc = await GenTaskCharge.create({
      provider,
      taskId: id,
      kind,
      user,
      model: String(model || "").slice(0, 80),
      charged,
      took: normalizeTook(took, charged),
      free: !!free,
      memo: String(memo || "").slice(0, 200),
      ...(region ? { region: String(region).slice(0, 8) } : {}),
      state: nothingToRefund ? "skipped" : "open",
      note: nothingToRefund ? (free ? "free" : "zero") : "",
      nextCheckAt: nothingToRefund ? null : new Date(now.getTime() + FIRST_CHECK_MS),
      ...(nothingToRefund ? { settledAt: now, purgeAt: purgeAtOf(now), notified: true } : {}),
    });
    return doc.toObject();
  } catch (e) {
    if (e && e.code === 11000) {
      // 同一个上游任务号记第二次（重放）：既有那一行就是账，不算事
      return GenTaskCharge.findOne({ provider, taskId: id }).lean();
    }
    console.error(`[task-refund] 落账失败 ${provider} task=${id} user=${user} cost=${charged}（这一发失败时退不了钱）:`, (e && e.message) || e);
    return null;
  }
}

/**
 * 给调用方（轮询端点 / 白模化取回 / task-charges 查询）的那一小块「钱怎么样了」。
 *   pending   我们还不知道结局（open）
 *   refunding 退款正在办（claimed：另一方刚抢到，或者搁浅了等清扫器续办）
 *   refunded  已经退回（tokens = 退了多少）
 *   settled   上游出成了，钱照收
 *   skipped   没有要退的（管理员免单 / 账号没了）
 *   lost      一直问不出结局，交给人工
 * @returns {{state:string, tokens:number}|null} null = 没有这笔账（上线之前的任务 / 不是经我们这里扣的）
 */
function refundView(row) {
  if (!row) return null;
  switch (row.state) {
    case "refunded":
      return { state: "refunded", tokens: Number(row.refundedTokens) || Number(row.charged) || 0 };
    case "claimed":
      return { state: "refunding", tokens: Number(row.charged) || 0 };
    case "open":
      return { state: "pending", tokens: Number(row.charged) || 0 };
    case "settled":
      return { state: "settled", tokens: Number(row.charged) || 0 };
    case "lost":
      return { state: "lost", tokens: Number(row.charged) || 0 };
    default:
      return { state: "skipped", tokens: 0 };
  }
}

/** 白模化那一发退了钱：把它的取件单一起钉成 failed（带上退款那句话）。条件原子更新，谁先到谁写，幂等 */
async function syncBlockoutJob(row, detail = "") {
  await BlockoutJob.updateOne(
    // ★ expired 也要改：那一位只是「产物过期」的备忘（判据是 expiresAt），而 stateOf 先看 failed 再看过期 ——
    //   不改的话列表会对一发已经退了钱的任务说「费用无法挽回」
    { taskId: row.taskId, ownerId: row.user, status: { $in: ["pending", "claimed", "expired"] } },
    { $set: { status: "failed", failMessage: BlockoutJob.failedMessage({ detail, refund: refundView(row) }), claimedAt: null } },
  );
}

/**
 * 退完钱之后的收尾：白模化钉取件单、钱不是在本人那次轮询里退的就发通知。
 * ★ 先把 notified 原子地抢成 true 再干活（两个实例 / 清扫器同时来收尾，只有一方发通知）；干砸了放回 false，下一轮清扫器再来。
 * ★ **永不抛**：钱已经退了，收尾失败不能把调用方（轮询端点）打成 500。
 */
async function followUp(row, { viewerIsOwner = false, detail = "" } = {}) {
  let mine = null;
  try {
    mine = await GenTaskCharge.findOneAndUpdate({ _id: row._id, state: "refunded", notified: false }, { $set: { notified: true } }, { returnDocument: "after" }).lean();
    if (!mine) return;
    if (mine.kind === "blockout") await syncBlockoutJob(mine, detail);
    if (!viewerIsOwner) {
      // 正文由 App 按界面语言说（金额是数，不拼成句子 —— 与 BRANCH_REMIX_REWARD 同一条理由）；不带 actorId：平台口径
      await createNotification({
        userId: mine.user,
        type: NOTIFY_TYPE,
        payload: { tokens: Number(mine.refundedTokens) || Number(mine.charged) || 0, kind: mine.kind, taskId: mine.taskId, provider: mine.provider },
      });
    }
  } catch (e) {
    console.error(`[task-refund] 退款收尾失败 ${row.provider} task=${row.taskId}（下一轮清扫器再试）:`, (e && e.message) || e);
    if (mine) await GenTaskCharge.updateOne({ _id: mine._id }, { $set: { notified: false } }).catch(() => {});
  }
}

/**
 * 把一行 claimed 办成 refunded。`resume` = 这一行不是这一拍刚抢到的（搁浅续办），要先问账本钱进没进过。
 * @returns {Promise<object>} 办完之后的那一行（lean）
 */
async function payRefund(row, { resume = false, now = new Date(), viewerIsOwner = false, detail = "" } = {}) {
  const memo = memoOf(row.provider, row.taskId);
  const already = resume ? await TokenLedger.exists({ user: row.user, reason: LEDGER_REASON, memo }) : null;
  if (!already) {
    const w = await wallet.refundSplit(row.user, row.took, LEDGER_REASON, memo, now);
    if (!w) {
      // 账号没了（注销 / 硬删）：钱没处退。记成 skipped，不留一行永远办不完的 claimed
      const gone = await GenTaskCharge.findOneAndUpdate(
        { _id: row._id, state: "claimed" },
        { $set: { state: "skipped", note: "user_gone", settledAt: now, purgeAt: purgeAtOf(now), notified: true } },
        { returnDocument: "after" },
      ).lean();
      console.warn(`[task-refund] ${row.provider} task=${row.taskId} 失败了，但账号已经不在，退不了`);
      return gone || { ...row, state: "skipped", note: "user_gone" };
    }
    console.log(`[task-refund] 退回 ${row.charged} token（plan ${row.took?.plan ?? 0} / addon ${row.took?.addon ?? 0}）${row.provider} ${row.kind} task=${row.taskId} user=${row.user}${resume ? "（续办）" : ""}`);
  } else {
    console.warn(`[task-refund] ${row.provider} task=${row.taskId} 的退款上一轮已经进账，只补标记`);
  }
  const done = await GenTaskCharge.findOneAndUpdate(
    { _id: row._id, state: "claimed" },
    { $set: { state: "refunded", refundedTokens: row.charged, settledAt: now, purgeAt: purgeAtOf(now), notified: false } },
    { returnDocument: "after" },
  ).lean();
  const fin = done || (await GenTaskCharge.findById(row._id).lean()) || { ...row, state: "refunded", refundedTokens: row.charged };
  if (fin.state === "refunded") await followUp(fin, { viewerIsOwner, detail });
  return (await GenTaskCharge.findById(row._id).lean()) || fin;
}

/**
 * 上游**明说**了这一发的结局 —— 结账。所有入口（轮询端点、白模化取回、MiniMax 轮询、清扫器）都只调这一个。
 *
 * @param {object} o
 * @param {"ark"|"minimax"} o.provider
 * @param {string} o.taskId
 * @param {string} o.status 上游原样的状态（ark: succeeded/failed/cancelled/expired/…；minimax: Success/Fail/…）
 * @param {string} [o.code]  上游的错误码（对账用）
 * @param {*}      [o.viewerId] 谁在问（是账的主人 ⇒ 他这次的响应里就带着 refund，不再另发通知）
 * @param {string} [o.detail]   上游的错误原话（只给白模化那句话用，不落库）
 * @returns {Promise<object|null>} 这一笔账现在的样子（lean）；null = 不是结局 / 没有这笔账 / 成功（成功不回读，省一次查询）
 */
async function settleTask({ provider, taskId, status, code = "", viewerId = null, detail = "", now = new Date() }) {
  const verdict = verdictOf(provider, status);
  if (!verdict) return null;
  const id = String(taskId ?? "");
  const upstreamStatus = String(status).slice(0, 32);
  if (verdict === "succeeded") {
    // ★ 成功那一拍只写一次库：出成之后客户端还会带着 ?transfer=1 轮询好几次（等转存），这里不能每次多两次读写
    await GenTaskCharge.updateOne(
      { provider, taskId: id, state: "open" },
      { $set: { state: "settled", upstreamStatus, settledAt: now, purgeAt: purgeAtOf(now) } },
    );
    return null;
  }
  if (provider === "minimax" && !minimaxRefundOn()) {
    // 开关关着：一分不动，行留 open（清扫器也不去问），8 天后静悄悄记成 lost。为什么不直接 skipped：开关打开之后还能接着退
    return GenTaskCharge.findOne({ provider, taskId: id }).lean();
  }
  const claimed = await GenTaskCharge.findOneAndUpdate(
    { provider, taskId: id, state: "open" },
    { $set: { state: "claimed", claimedAt: now, upstreamStatus, upstreamCode: String(code || "").slice(0, 80) } },
    { returnDocument: "after" },
  ).lean();
  if (!claimed) {
    // 没抢到：别人刚退过 / 正在退 / 没有这笔账。照实回现在的样子，别猜
    return GenTaskCharge.findOne({ provider, taskId: id }).lean();
  }
  const viewerIsOwner = viewerId != null && String(viewerId) === String(claimed.user);
  return payRefund(claimed, { resume: false, now, viewerIsOwner, detail });
}

/** 这个人的某一笔账（GET /api/ark/task-charges/:taskId）。两家任务号是两个命名空间，同号时方舟优先 */
async function chargeOf(taskId, userId) {
  const id = String(taskId ?? "");
  if (!TASK_ID_RE.test(id)) return null;
  const rows = await GenTaskCharge.find({ taskId: id, user: userId }).lean();
  return rows.find((r) => r.provider === "ark") || rows[0] || null;
}

/** 某个任务号的账（不看归属，给服务端内部用：白模化取回时问「这一发退了没有」） */
async function chargeByTask(provider, taskId) {
  const id = String(taskId ?? "");
  if (!TASK_ID_RE.test(id)) return null;
  return GenTaskCharge.findOne({ provider, taskId: id }).lean();
}

/** 这些任务号里哪些已经退了钱（GET /api/ark/video-tasks 用它把退了钱的那些藏起来：它们没有成片可取了） */
async function refundedTaskIds(provider, taskIds) {
  const ids = (taskIds || []).filter((t) => TASK_ID_RE.test(String(t)));
  if (!ids.length) return new Set();
  const rows = await GenTaskCharge.find({ provider, taskId: { $in: ids }, state: "refunded" }).select("taskId").lean();
  return new Set(rows.map((r) => r.taskId));
}

/**
 * 问一次上游：这一发现在什么状态。**只回明说的状态**，别的（非 200、读不懂、问不了）一律 null —— 清扫器见 null 就退避，绝不当失败。
 * @returns {Promise<{status:string, code?:string, detail?:string}|null>}
 */
async function queryUpstream(row) {
  if (row.provider === "ark") {
    const { status, text } = await callArk({ method: "GET", path: `/contents/generations/tasks/${row.taskId}`, timeoutMs: T_POLL });
    if (status !== 200) return null;
    try {
      const j = JSON.parse(text || "{}");
      if (typeof j?.status !== "string") return null;
      return { status: j.status, code: String(j?.error?.code || ""), detail: String(j?.error?.message || "").slice(0, 300) };
    } catch {
      return null;
    }
  }
  if (row.provider === "minimax") {
    // ★★ MiniMax 的任务绑区域：在哪个站建的只能回哪个站、用同一把 key 问（config/minimax 的 ★★）。
    //   区域被切走了就不问 —— 拿另一个站的 key 去问只会鉴权失败或「查无此任务」，那不是结局。
    if (!minimaxRefundOn()) return null;
    const region = minimaxRegion();
    if (!region || region !== row.region || !BASES[region]) return null;
    try {
      const up = await fetch(`${BASES[region]}/query/video_generation?task_id=${row.taskId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${minimaxKey()}` },
        signal: AbortSignal.timeout(T_POLL),
      });
      if (up.status !== 200) return null;
      const j = JSON.parse((await up.text()) || "{}");
      if (j?.base_resp && j.base_resp.status_code !== 0) return null;
      return typeof j?.status === "string" ? { status: j.status } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 搁浅的 claimed 接着办（进程在「抢到」与「标 refunded」之间死掉的那些）。
 * ★ 续办之前先把它**再抢一次**（claimedAt 从旧值换成 now 的条件更新）：两个续办方同时过账本检查的话会退两次。
 */
async function resumeClaimed({ now = new Date(), limit = SWEEP_LIMIT } = {}) {
  const stale = new Date(now.getTime() - CLAIM_STALE_MS);
  const rows = await GenTaskCharge.find({ state: "claimed", claimedAt: { $lt: stale } }).sort({ claimedAt: 1 }).limit(limit).lean();
  let resumed = 0;
  for (const row of rows) {
    try {
      const mine = await GenTaskCharge.findOneAndUpdate(
        { _id: row._id, state: "claimed", claimedAt: row.claimedAt },
        { $set: { claimedAt: now } },
        { returnDocument: "after" },
      ).lean();
      if (!mine) continue;
      await payRefund(mine, { resume: true, now });
      resumed += 1;
    } catch (e) {
      console.error(`[task-refund] 续办失败 ${row.provider} task=${row.taskId}:`, (e && e.message) || e);
    }
  }
  return resumed;
}

/**
 * 没人再来问的那些（App 被杀 / 卸载 / 用户再也没打开）：到点了替他问一次上游。
 * @param {object} [o]
 * @param {Function} [o.query] 问上游的函数（测试替换用；缺省 queryUpstream）
 * @returns {Promise<{checked:number, settled:number, lost:number}>}
 */
async function reconcile({ now = new Date(), limit = SWEEP_LIMIT, query = queryUpstream } = {}) {
  const rows = await GenTaskCharge.find({ state: "open", nextCheckAt: { $lte: now } }).sort({ nextCheckAt: 1 }).limit(limit).lean();
  const out = { checked: 0, settled: 0, lost: 0 };
  for (const row of rows) {
    try {
      const age = now.getTime() - new Date(row.createdAt).getTime();
      if (age >= LOST_AFTER_MS) {
        const quiet = row.provider === "minimax" && !minimaxRefundOn();
        const r = await GenTaskCharge.updateOne(
          { _id: row._id, state: "open" },
          { $set: { state: "lost", note: quiet ? "refund_off" : "too_old", settledAt: now, purgeAt: purgeAtOf(now) } },
        );
        if (r.modifiedCount) {
          out.lost += 1;
          // ★ 开关关着的那些是有意不退，不吼；其余的是「8 天都没问出结局」，要人看
          if (!quiet) console.error(`[task-refund] ${row.provider} task=${row.taskId} user=${row.user} 8 天都没问出结局（${row.charged} token），记成 lost，请人工核对`);
        }
        continue;
      }
      out.checked += 1;
      const r = await query(row);
      if (r && verdictOf(row.provider, r.status)) {
        await settleTask({ provider: row.provider, taskId: row.taskId, status: r.status, code: r.code, detail: r.detail, viewerId: null, now });
        const after = await GenTaskCharge.findById(row._id).select("state").lean();
        if (after && after.state !== "open") {
          out.settled += 1;
          continue;
        }
      }
      // 还没结局 / 没问到：退避（10 → 20 → 40 → 60 分钟封顶）
      const checks = (Number(row.checks) || 0) + 1;
      const delay = Math.min(MAX_BACKOFF_MS, FIRST_CHECK_MS * 2 ** Math.min(checks - 1, 8));
      await GenTaskCharge.updateOne({ _id: row._id, state: "open" }, { $set: { nextCheckAt: new Date(now.getTime() + delay), checks } });
    } catch (e) {
      console.error(`[task-refund] 对账失败 ${row.provider} task=${row.taskId}:`, (e && e.message) || e);
    }
  }
  return out;
}

/** 退了钱、收尾却没做完的（通知没发出去 / 取件单没钉上）：补上 */
async function finishFollowUps({ now = new Date(), limit = SWEEP_LIMIT } = {}) {
  const rows = await GenTaskCharge.find({ state: "refunded", notified: false, settledAt: { $lt: new Date(now.getTime() - FOLLOWUP_GRACE_MS) } })
    .limit(limit)
    .lean();
  for (const row of rows) await followUp(row, { viewerIsOwner: false });
  return rows.length;
}

let sweeping = false;

/**
 * 清扫一轮（src/index.js 0 号实例每 5 分钟一次）。**永不抛**；同实例内不重入（一轮最多 30 次上游查询、每次最长 30 秒，
 * 可能跨过下一个 5 分钟 —— setInterval 不等上一轮）。
 * @returns {Promise<{resumed:number, checked:number, settled:number, lost:number, followed:number}|{running:true}>}
 */
async function sweepTaskRefunds({ now = new Date(), limit = SWEEP_LIMIT, query } = {}) {
  if (sweeping) return { running: true };
  sweeping = true;
  const out = { resumed: 0, checked: 0, settled: 0, lost: 0, followed: 0 };
  try {
    out.resumed = await resumeClaimed({ now, limit });
    Object.assign(out, await reconcile({ now, limit, ...(query ? { query } : {}) }));
    out.followed = await finishFollowUps({ now, limit });
    if (out.resumed || out.settled || out.lost) {
      console.log(`[task-refund] 一轮：续办 ${out.resumed}、问上游 ${out.checked}、结账 ${out.settled}、放弃 ${out.lost}、补收尾 ${out.followed}`);
    }
  } catch (e) {
    console.error("[task-refund] 清扫失败:", (e && e.message) || e);
  } finally {
    sweeping = false;
  }
  return out;
}

module.exports = {
  LEDGER_REASON,
  NOTIFY_TYPE,
  FIRST_CHECK_MS,
  CLAIM_STALE_MS,
  LOST_AFTER_MS,
  memoOf,
  minimaxRefundOn,
  verdictOf,
  recordCharge,
  refundView,
  settleTask,
  chargeOf,
  chargeByTask,
  refundedTaskIds,
  queryUpstream,
  resumeClaimed,
  reconcile,
  finishFollowUps,
  sweepTaskRefunds,
};
