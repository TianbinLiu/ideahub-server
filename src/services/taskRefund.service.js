/**
 * @file taskRefund.service.js - 受理之后才失败的生成任务：按原桶退钱，恰好一次（2026-10-07 主人拍板「做生成失败返回 token」）
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节
 *
 * ★★ 这是「受理之后失败退钱」的**唯一实现**（铁律六）。在它之前的口径是 W2 那句「受理之后才失败不退」——
 *   方舟只对成功生成的视频计费，而我们照收；主人 2026-10-07 改了：上游**明说**这一发失败 / 取消 / 过期（方舟
 *   `failed` / `cancelled` / `expired`；MiniMax 真人档 `Fail`、H3 `failed` / `cancelled`）就把这一发的钱按扣的那两桶退回去。这几条出片路共用它：
 *     · /api/ark 代理（Seedance 普通出片 / 样片两步 / r2v / Seed3D）—— billedForward 受理时 recordCharge，轮询端点看见终态时 settleTask；
 *     · 白模化（服务端自己发的 r2v）—— 受理时 recordCharge，取回结果那一步看见 failed 时 settleTask；
 *     · 真人档 MiniMax —— 受理时 recordCharge（带区域），轮询端点看见 Fail 时 settleTask（开关 MINIMAX_FAIL_REFUND）；
 *     · MiniMax H3（V2，2026-10-26）—— 受理时 recordCharge（带区域与 api:"v2"），V2 轮询端点看见 failed / cancelled 时 settleTask
 *       （同一个开关 MINIMAX_FAIL_REFUND：按量付费的失败任务计不计费，H3 与真人档是同一个没有书面说法的问题）；
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
const { BASES, minimaxRegion, minimaxKey, minimaxV2BaseOf } = require("../config/minimax");

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
/**
 * MiniMax H3（V2）的失败终态（官方 V2 查询文档 VideoTask.status：queued / running / succeeded / failed / cancelled）。
 * ★ V2 **没有** expired：任务只能在 7 天内查（官方：窗口外回 `invalid task_id`）—— 查不到不是结局（那一发可能好好地出成了），
 *   不退；问 8 天还没结局的行由 reconcile 记成 lost 交人工（与「没问到 ≠ 失败」同一条）。
 */
const MINIMAX_V2_FAILED = new Set(["failed", "cancelled"]);

/**
 * 这一行 / 这一次结账说的是不是 MiniMax V2（H3）。**只认 "v2" 这一个值**（判否定：没有 api = v1 真人档 / 方舟）。
 * 结局怎么认、清扫器去哪个端点问、settleTask 只结哪一版的账都只问它。
 */
function isV2(api) {
  return api === "v2";
}

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
 * @param {"ark"|"minimax"} provider
 * @param {string} status 上游原样的状态
 * @param {"v2"} [api] MiniMax 的哪一版接口（GenTaskCharge.api）：`"v2"` = H3（小写 succeeded / failed / cancelled），
 *   不传 = v1 真人档（Success / Fail）。两版的写法互不相认 —— v1 的判据见 `failed` 认不出（2026-10-26 设计审核：
 *   原来只有 v1 这一支，H3 明说失败也永远不退）；反过来 v2 也不认 `Fail`。
 * @returns {"failed"|"succeeded"|null} null = 还没结局（排队 / 运行 / 认不出的状态 —— 认不出的也不当失败）
 */
function verdictOf(provider, status, api) {
  const s = String(status ?? "");
  if (provider === "minimax") {
    if (isV2(api)) {
      if (s === "succeeded") return "succeeded";
      return MINIMAX_V2_FAILED.has(s) ? "failed" : null;
    }
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

/** 库里那一行与这一次要记的是不是同一笔（同一个人、同一版接口、同一个站）—— recordCharge 撞上唯一索引时分「重放」与「撞号」用 */
function sameCharge(row, { user, api, region }) {
  return (
    String(row.user) === String(user) &&
    (row.api || "") === (isV2(api) ? "v2" : "") &&
    String(row.region || "") === String(region ? String(region).slice(0, 8) : "")
  );
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
 * @param {string} [o.region] MiniMax 必带：任务建在哪个站（minimaxRegion()）
 * @param {"v2"} [o.api] MiniMax H3 必带 `"v2"`（结局怎么认、清扫器去哪问都按它分，见 GenTaskCharge.api）；真人档 / 方舟不传
 * @returns {Promise<object|null>} 落下的那一行（lean）；没落下 null
 */
async function recordCharge({ provider, taskId, kind, user, model = "", cost, free = false, took, memo = "", region, api, now = new Date() }) {
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
      ...(isV2(api) ? { api: "v2" } : {}),
      state: nothingToRefund ? "skipped" : "open",
      note: nothingToRefund ? (free ? "free" : "zero") : "",
      nextCheckAt: nothingToRefund ? null : new Date(now.getTime() + FIRST_CHECK_MS),
      ...(nothingToRefund ? { settledAt: now, purgeAt: purgeAtOf(now), notified: true } : {}),
    });
    return doc.toObject();
  } catch (e) {
    if (e && e.code === 11000) {
      // 同一个上游任务号记第二次（重放）：既有那一行就是账，不算事。
      // ★ 回读也不许抛：这一拍钱已扣、任务已受理，抛出去调用方就回 5xx（客户端以为没受理、去重试 = 再花一次钱）
      const existing = await GenTaskCharge.findOne({ provider, taskId: id })
        .lean()
        .catch((err) => {
          console.error(`[task-refund] 重复落账后回读失败 ${provider} task=${id}:`, (err && err.message) || err);
          return null;
        });
      // ★ 但既有那一行**不是这一发的**（别人的 / 另一版接口的 / 另一个站的）就不是重放，是任务号撞上了（2026-10-26 终审）：
      //   唯一索引是 (provider, taskId)，而 MiniMax 两个站、两版接口的号都是数字串 —— 切站之前中国站建过的老号，
      //   与国际站新建的 H3 撞上时，这一发的钱就记不进账（失败了退不了），轮询端点也只认得那一行老账。没有任何报错，所以要吼。
      if (existing && !sameCharge(existing, { user, api, region })) {
        console.error(
          `[task-refund] 任务号撞上了另一笔账 ${provider} task=${id}：库里那一行 user=${existing.user} api=${existing.api || "-"} region=${existing.region || "-"}，` +
            `这一发 user=${user} api=${isV2(api) ? "v2" : "-"} region=${region || "-"} cost=${charged}（这一发的钱没记进账，失败时退不了，请人工核对）`,
        );
      }
      return existing;
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
    // ★ 3D（Seed3D 建模）**本人轮询退的也发**（2026-10-07 评审）：App 的建模那条路把失败吞成一行 console.warn（随卡组出模型时
    //   不打断整件事），轮询响应里的 refund 字段没有人读 —— 不发通知的话，这一笔退款到账时一个字都没有，
    //   而「一笔说不出来历的余额变动比一条通知糟」。出片那几种的本人轮询由 App 当场说「已退回」，不重复发。
    if (!viewerIsOwner || mine.kind === "3d") {
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
 * @param {string} [o.region]   **MiniMax 必填**：回答这个状态的是哪个站（minimaxRegion()）。只结那个站建的账 ——
 *   MiniMax 的任务号绑站，切过 MINIMAX_REGION 之后，另一个站上同号的任务不是这一发（它报 Fail 不该退这一笔、报 Success 也不该把它结掉）。
 *   方舟只有一个站，不看它。
 * @param {"v2"} [o.api] MiniMax：回答这个状态的是哪一版接口（V2 轮询端点 / 清扫器问 V2 时传 `"v2"`，真人档不传）。
 *   两件事都按它：status 按哪一版的写法认（verdictOf），以及**只结那一版建的账** —— v1 的轮询结不了 H3 的账、反过来也一样
 *   （两版的任务号在 MiniMax 那边是同一个命名空间，同号时宁可不结，也不拿一个接口的结论去动另一个接口建的账的钱）。
 * @returns {Promise<object|null>} 这一笔账现在的样子（lean）；null = 不是结局 / 没有这笔账 / 成功（成功不回读，省一次查询）
 */
async function settleTask({ provider, taskId, status, code = "", viewerId = null, detail = "", region, api, now = new Date() }) {
  const verdict = verdictOf(provider, status, api);
  if (!verdict) return null;
  const id = String(taskId ?? "");
  const upstreamStatus = String(status).slice(0, 32);
  // ★★ MiniMax 的账只认建它的那个站回的话（2026-10-07 评审）：清扫器的 queryUpstream 早就按区域问，
  //   而轮询端点问的是**此刻**配的那个站 —— 切站之后两边的结论会打架。判据放在这里（所有入口都走 settleTask），
  //   调用方不说是哪个站回的就不结（宁可留给清扫器，也不按一个说不清来历的结论动钱）。
  let scope = { provider, taskId: id };
  if (provider === "minimax") {
    const r = String(region ?? "");
    if (!r) {
      console.error(`[task-refund] minimax task=${id} 结账没说是哪个站回的，不结（留给清扫器）`);
      return null;
    }
    // api：v2 只结 H3 的行；没说（真人档 v1）只结**没有** api 的行 —— Mongo 的 `api: null` 连「这一位不存在」一起认（老行就是这样）
    scope = { ...scope, region: r, api: isV2(api) ? "v2" : null };
  }
  if (verdict === "succeeded") {
    // ★ 成功那一拍只写一次库：出成之后客户端还会带着 ?transfer=1 轮询好几次（等转存），这里不能每次多两次读写
    await GenTaskCharge.updateOne({ ...scope, state: "open" }, { $set: { state: "settled", upstreamStatus, settledAt: now, purgeAt: purgeAtOf(now) } });
    return null;
  }
  if (provider === "minimax" && !minimaxRefundOn()) {
    // 开关关着：一分不动，行留 open（清扫器也不去问），8 天后静悄悄记成 lost。为什么不直接 skipped：开关打开之后还能接着退。
    // ★ 但要把「上游已经明说失败了」记在这一行上（upstreamStatus / upstreamCode；state 不动，2026-10-26 文档审核）：
    //   H3 的两道并发闸只数「还在跑」的（v2RunningFilter）—— 不记的话，用户自己轮询看见失败的那几发照样 open、照样算在跑，
    //   在 30 分钟窗口里一直占着位：一个人 4 发审核没过的失败就被关在 H3 门外半小时（「等其中一段出来再点」，而那几段永远不会出来）；
    //   全站 25 发就是海外所有人都 UPSTREAM_BUSY —— 海外只有 MiniMax 这一家。开关打开之后这一行照常被抢成 claimed、退钱。
    const marked = await GenTaskCharge.findOneAndUpdate(
      { ...scope, state: "open" },
      { $set: { upstreamStatus, upstreamCode: String(code || "").slice(0, 80) } },
      { returnDocument: "after" },
    ).lean();
    return marked || GenTaskCharge.findOne(scope).lean();
  }
  const claimed = await GenTaskCharge.findOneAndUpdate(
    { ...scope, state: "open" },
    { $set: { state: "claimed", claimedAt: now, upstreamStatus, upstreamCode: String(code || "").slice(0, 80) } },
    { returnDocument: "after" },
  ).lean();
  if (!claimed) {
    // 没抢到：别人刚退过 / 正在退 / 没有这笔账（或是另一个站的）。照实回现在的样子，别猜
    return GenTaskCharge.findOne(scope).lean();
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
    if (isV2(row.api)) return queryMinimaxV2(row, region);
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
 * 清扫器问 MiniMax H3（V2）的一发：`GET {国际站}/v2/query/video_generation/{id}`，回 `{ task: { status, error? } }`。
 * ★ 只认 200 + task.status 是字符串；非 200（V2 用真的 HTTP 状态码报错：400 = 查无此任务 / 超过 7 天，401 / 429 / 5xx）、
 *   读不懂、问不了一律 null —— 清扫器见 null 就退避，绝不当失败（文件头 ★★）。
 * ★ 根地址按账上记的站取（minimaxV2BaseOf）：没有 V2 的站（中国站）回 null、不问 —— 那一行本来就不该存在。
 */
async function queryMinimaxV2(row, region) {
  const base = minimaxV2BaseOf(region);
  if (!base) return null;
  try {
    const up = await fetch(`${base}/query/video_generation/${row.taskId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${minimaxKey()}` },
      signal: AbortSignal.timeout(T_POLL),
    });
    if (up.status !== 200) return null;
    const task = JSON.parse((await up.text()) || "{}")?.task;
    if (!task || typeof task.status !== "string") return null;
    return { status: task.status, code: String(task?.error?.code ?? "").slice(0, 80), detail: String(task?.error?.message ?? "").slice(0, 300) };
  } catch {
    return null;
  }
}

/**
 * 「这一发 H3 在上游还在跑」在账上长什么样 —— 下面两道并发闸的计数共用这一份（判据只有这一处）：
 * 账还 `open`，**而且**上游没明说过失败（upstreamStatus 不是 V2 的失败终态）。
 * ★ 第二条只在 MINIMAX_FAIL_REFUND=off 时起作用（2026-10-26 文档审核）：开关开着时上游一说失败，settleTask 就把这一行抢成 claimed，
 *   本来就不再 open；关着时 settleTask 一分不动、行留 open，只把上游的话记在 upstreamStatus 上 —— 不看这一位的话，
 *   那几发永远出不来的失败会在窗口里一直占着位（settleTask 那一支的 ★）。
 * ★ 出成了的不用在这里排：成功那一拍 settleTask 不看开关、当场结成 settled。
 * ⚠ 没人来问的那些照旧算在跑：开关关着时清扫器不问 MiniMax（queryUpstream），没被问到的失败与成片都要等窗口过去。
 */
function v2RunningFilter() {
  return { state: "open", upstreamStatus: { $nin: [...MINIMAX_V2_FAILED] } };
}

/**
 * MiniMax H3（V2）此刻大概有几发在上游跑着 —— V2 出片路由的全站并发闸只问它（每一发扣费之前数一次）。
 * ★ 为什么数库、不在进程里计数（2026-10-26 设计审核）：生产是 pm2 两个实例（cluster），进程内的数各算各的；
 *   而 H3 在上游异步跑完，用户可能根本不再轮询 —— 「创建时加一、看到结局减一」的计数会一直往上漏。
 *   这张账本两个实例共用、受理那一拍就落一行、看见结局就结掉，正好是「还在跑的」那一批。
 * ★ 数的是 `since` 之后受理的这几种行：
 *   · 还在跑（v2RunningFilter：open、上游没明说过失败）—— 排队 / 运行；也包括出成了但没人来问、清扫器还没问到的
 *     （多算几发，方向是少放、不是多放）。开关 MINIMAX_FAIL_REFUND=off 时上游明说了失败、账还 open 的那些**不算**（v2RunningFilter 的 ★）；
 *   · 管理员免单（free）—— 落库那一拍就记成 skipped、之后不再结，按受理时间算它在跑（在窗口里就算一发）。
 *   claimed / refunded / settled 都是上游已经明说了结局的，不算。
 * ⚠ 是「大概」：两个实例可能同时数到同一个数、各放一发；受理之前的那几秒（扣费 → 上游回话 → 落账）库里还没有这一行。
 *   所以路由那边的上限比官方的 30 留了余量，并且把本进程正在建的那几发另外加上（routes/minimax.routes 的 V2_CREATING）。
 * @param {object} o
 * @param {Date} o.since 只数这一刻之后受理的（窗口之外的当成早就跑完了：H3 一段实测 10 秒 ~ 2 分钟）
 * @returns {Promise<number>}
 */
async function minimaxV2InFlight({ since }) {
  return GenTaskCharge.countDocuments({
    api: "v2",
    provider: "minimax",
    createdAt: { $gte: since },
    $or: [v2RunningFilter(), { free: true }],
  });
}

/**
 * 某一个人此刻大概有几发 H3 在上游跑着 —— V2 出片路由**按人**那一道并发闸只问它（2026-10-26 审核：只有全站闸的话，
 * 一个账号就能把全站的位占满，海外所有人随后都被拒）。
 * ★ 与上面全站那一个只差一处：**只数还在跑的（v2RunningFilter），不数管理员免单**。免单的行落库就是 skipped、之后不再结，在窗口里一直算「在跑」——
 *   全站闸照旧数它（它确实占过上游的位，宁可少放），按人数它的话主人自己测 H3 出完 4 段就要干等 30 分钟，而他不是这道闸要防的人。
 * ⚠ 同样是「大概」（见上面那一个的 ⚠）；路由那边把本进程正在建的那几发按人另外加上。
 * @param {object} o
 * @param {Date} o.since 窗口起点（与全站那一个用同一个窗口）
 * @param {*} o.user 账号 id
 * @returns {Promise<number>}
 */
async function minimaxV2InFlightOfUser({ since, user }) {
  return GenTaskCharge.countDocuments({ api: "v2", provider: "minimax", user, createdAt: { $gte: since }, ...v2RunningFilter() });
}

/**
 * 搁浅的 claimed 接着办（进程在「抢到」与「标 refunded」之间死掉的那些）。
 * ★ 续办之前先把它**再抢一次**（claimedAt 从旧值换成此刻的条件更新）：两个续办方同时过账本检查的话会退两次。
 * ★★ `now` 只管「挑哪几行」；动钱与写时间戳一律用**这一行办的那一刻**（`at`，见 reconcile 的同一条 ★★）。
 */
async function resumeClaimed({ now = new Date(), limit = SWEEP_LIMIT } = {}) {
  const stale = new Date(now.getTime() - CLAIM_STALE_MS);
  const rows = await GenTaskCharge.find({ state: "claimed", claimedAt: { $lt: stale } }).sort({ claimedAt: 1 }).limit(limit).lean();
  let resumed = 0;
  for (const row of rows) {
    try {
      const at = new Date();
      const mine = await GenTaskCharge.findOneAndUpdate(
        { _id: row._id, state: "claimed", claimedAt: row.claimedAt },
        { $set: { claimedAt: at } },
        { returnDocument: "after" },
      ).lean();
      if (!mine) continue;
      await payRefund(mine, { resume: true, now: at });
      resumed += 1;
    } catch (e) {
      console.error(`[task-refund] 续办失败 ${row.provider} task=${row.taskId}:`, (e && e.message) || e);
    }
  }
  return resumed;
}

/**
 * 这一行上记着的「上游已经明说失败」（`{ status, code }`，与 queryUpstream 回的同形）；没有、或此刻还不该按它结 → null。
 * ★ 只有 MINIMAX_FAIL_REFUND=off 时才会有这种行：开关关着时 settleTask 一分不动、行留 open，只把上游的原话记在
 *   upstreamStatus / upstreamCode 上（开着的话上游一说失败就当场抢成 claimed，不会留 open）。
 * ★ 为什么开关打开之后不再回去问（2026-10-26 终审）：H3（V2）的任务只查得到受理之后 7 天内的（官方：窗口外回 invalid task_id）——
 *   原来清扫器每一行都回去问，第 8 天问只会查无此任务（null，不是结局），最后记成 lost，连**用户亲眼看见失败**的那几发也退不了。
 *   而这句结论本来就可信：settleTask 只在建这一行的那个站、那一版接口回的话上记它（按 region / api 圈定），之后不会变（失败是终态）。
 * ★ 开关还关着时不认（回 null）：照旧回 queryUpstream 那条路（它关着时也回 null）、退避，等开关打开。
 */
function knownFailureOf(row) {
  if (row.provider === "minimax" && !minimaxRefundOn()) return null;
  if (verdictOf(row.provider, row.upstreamStatus, row.api) !== "failed") return null;
  return { status: row.upstreamStatus, code: row.upstreamCode || "", detail: "" };
}

/**
 * 没人再来问的那些（App 被杀 / 卸载 / 用户再也没打开）：到点了替他问一次上游。
 * 上游早就明说过失败、只是当时开关关着没退的，不再问、照记下的那句结（knownFailureOf）。
 *
 * ★★ `now` 是开轮那一拍的时间，**只拿来挑行**（到没到点、老没老）。结账（动钱、claimedAt / settledAt）一律用这一行
 *   真正办的那一刻：一轮最多 30 次上游查询、每次最长 30 秒，开轮的时间到最后一行可能已经旧了十几分钟。
 *   2026-10-07 评审复现过：跨月那一夜开轮、半夜之后才退到某个付费用户头上，旧的 now 一路传进 ensureWallet，
 *   把他已经刷到新月的钱包又刷回上个月 —— 新月里花掉的全吐回来、退回去的那一笔被下一次归位抹掉（钱包那边另有一道「不许往回拨」）。
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
      // 上游早就明说过失败（开关关着时 settleTask 记下的 upstreamStatus）：开关打开之后按记下的那句结、不再回去问（knownFailureOf 的 ★）
      const known = knownFailureOf(row);
      if (!known) out.checked += 1;
      const r = known || (await query(row));
      if (r && verdictOf(row.provider, r.status, row.api)) {
        // region：queryUpstream 只回建这一行的那个站问出来的结论（不是那个站就回 null），所以这里照行上的报；
        // api 同理：queryUpstream 按行上的 api 去问对应那一版的端点（H3 走 V2 查询），结论按同一版的写法认
        await settleTask({
          provider: row.provider,
          taskId: row.taskId,
          status: r.status,
          code: r.code,
          detail: r.detail,
          viewerId: null,
          region: row.region,
          api: row.api,
          now: new Date(),
        });
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
  minimaxV2InFlight,
  minimaxV2InFlightOfUser,
  resumeClaimed,
  reconcile,
  finishFollowUps,
  sweepTaskRefunds,
};
