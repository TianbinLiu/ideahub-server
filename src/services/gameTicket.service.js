/**
 * @file gameTicket.service.js - 「工坊游戏券」的**唯一实现**：懒发月度券、原子扣一张、失败退回、余额快照
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节
 *
 * 设计来源（app 仓）：`docs/g2-game-ui.md` §7「改造清单（9 条）」、`docs/g4-ui-revamp-spec.md` §0
 * （免费套餐每月 6 张券；分享 / 邀请任务加券；**券只用于游戏内出片、不扣 token**）。
 *
 * ══ 三张契约（做错了不会报错，只会白送或吞掉真金白银）════════════════════════════
 *
 * 【T1 券与 token 不可互换】买不到、转不了、没有汇率。这里**没有**任何「券 ↔ token」的函数，
 *      账本（TokenLedger）里也一个字都不记券。券的每次进出都落在 GameTicketGrant 上。
 *      所以对账时「券花在哪儿了」要去看 GenTaskCharge 的 `currency: "ticket"` 那几行（一发一行、带任务号）。
 *
 * 【T2 恰好发一次】月度券靠 (userId, "monthly", "YYYY-MM") 抢唯一索引（GameTicketGrant），
 *      跨月第一次触达时懒发 —— 没有定时任务（理由见 config/gameTicket 的文件头）。
 *      任务加券（share / invite）同理，refId 必须是服务端某个**事件**的 id，不能是日期。
 *
 * 【T3 扣券 = 条件原子更新】`findOneAndUpdate({ balance: { $gte: 1 } }, { $inc: { balance: -1 } })`，
 *      与 tokenWallet.debitSplit 同一条 W1：**一次原子操作同时完成"够不够"与"扣掉"**。
 *      读-改-写或先转发后扣，并发下都会把一张券花成两段片。
 *
 * ══ 与 token 那边**不一样**的两处（都是有意的）════════════════════════════════════
 *   · 扣券**不看**日上限（config/tokens.dailyCapDenial）：那套数是 token 的额度，券的上限就是券本身
 *     （每月 6 张，天然有界）。把券也塞进 dailyCap 的话，一个免费用户 6 张券得跨 6 天才能花完。
 *   · 扣券**仍然**看退款欠额（tokenWallet 文件头 W4「冻结一切消费」）：有欠额 = 这个人有退款 / 拒付
 *     正在处理，解冻前连券也不给用 —— 券不花钱，但券换来的是**我们**付给上游的钱。
 *
 * ══ 谁先谁后：管理员免单 > 券（顺序只在 billing.preAuthorize 一处实现）══════════════
 *   管理员发来的「用券」请求**不扣券**（免单照旧）：免单已经是给这个账号的最宽口径，
 *   再扣一张券既不影响他能做什么，还会把一张真金白银的券花在一个本来就免费的请求上。
 *   ★ 写在注释里的另一层理由：管理员自己测券的时候要看的是「券够不够、扣没扣」，
 *     而不是把自己的月度额度花光 —— 测券要用普通账号。
 */
const GameTicket = require("../models/GameTicket");
const GameTicketGrant = require("../models/GameTicketGrant");
const User = require("../models/User");
// ★ 月 / 日的写法**不在这里重写**（铁律六）：与 token 钱包同一个 UTC 月、同一个 UTC 日，
//   两套币用两种日界的话，用户会在凌晨看到「token 补了、券没补」这种自相矛盾。
const wallet = require("./tokenWallet.service");
const config = require("../config/gameTicket");
// 「这一发是不是出片」的唯一判据（券只用于出片）。config/tokens 是纯配置，不会反向 require 服务
const { isVideoGeneration } = require("../config/tokens");

/** 额度表里那个月的标识（"YYYY-MM"）。唯一实现在 tokenWallet.currentCycle */
function cycleOf(now = new Date()) {
  return wallet.currentCycle(now);
}

/** 券的「这个月」从哪一刻换（下个月 1 日 00:00:00 UTC）—— App 用它显示「X 天后重置」 */
function nextResetAt(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * 给客户端的那一份。键名是跨仓契约（app 仓 g2-game-ui.md §7 第 4 条：App **只显示服务端下发的数**）。
 * @param {object} doc GameTicket 的 lean 文档
 * @returns {{cycle:string, limit:number, granted:number, earned:number, spent:number, refunded:number,
 *   used:number, left:number, perGeneration:number, nextResetAt:string}}
 *   `left` 是余额（唯一作数的数）；`used` = spent − refunded（本月**净**用了多少，退款不算用了）；
 *   `limit` = 免费套餐每月几张（6）—— ★ 管理员 / 任务加进来的券让 `left` 超过 `limit`，这是对的：
 *   上限说的是「每月发几张」，不是「手里最多能有几张」。
 */
function shape(doc, now = new Date()) {
  const spent = Number(doc?.spent) || 0;
  const refunded = Number(doc?.refunded) || 0;
  return {
    cycle: String(doc?.cycle || cycleOf(now)),
    limit: config.MONTHLY_TICKETS,
    granted: Number(doc?.granted) || 0,
    earned: Number(doc?.earned) || 0,
    spent,
    refunded,
    used: Math.max(0, spent - refunded),
    left: Math.max(0, Number(doc?.balance) || 0),
    perGeneration: config.TICKETS_PER_GENERATION,
    nextResetAt: nextResetAt(now).toISOString(),
  };
}

/**
 * 保证**当月那一行**存在（幂等）。不做月度发放 —— 那是 ensureTickets 的事，
 * 分开是因为 grant() 自己也要这一行：合在一起会递归（ensureTickets → grant → ensureTickets）。
 * @returns {Promise<object|null>} lean 文档；账号不存在 → null
 */
async function ensureRow(userId, now = new Date()) {
  const cycle = cycleOf(now);
  // ★ $setOnInsert + upsert：两个实例同时到，一个建成、另一个落空并读回同一行（唯一索引是锁）
  try {
    const doc = await GameTicket.findOneAndUpdate(
      { userId, cycle },
      { $setOnInsert: { granted: 0, earned: 0, spent: 0, refunded: 0, balance: 0 } },
      { upsert: true, returnDocument: "after" },
    ).lean();
    return doc || null;
  } catch (e) {
    // ★ upsert 撞唯一索引是**正常的竞态**（两个进程同时给同一个账号建同一个月的那一行）：
    //   Mongo 那边先查后插，两边都没查到就会一起插、后到的那个吃 11000。这里读回对方建好的那一行 ——
    //   不接住的话，用户那一发会 500，而库里其实一切正常（tokenWallet.ensureWallet 用 $exists:false 抢先，
    //   根本走不到这个分支，所以那边的写法不能照抄到这里）。
    if (e && e.code === 11000) return GameTicket.findOne({ userId, cycle }).lean();
    throw e;
  }
}

/**
 * 抢一笔余额变动（发 / 退的**唯一底座**，见 GameTicketGrant 文件头的 fail-closed 取舍）。
 *
 * @param {object} o
 * @param {*}      o.userId
 * @param {string} o.source  config.SOURCES 里的一个
 * @param {string} o.refId   幂等键（必填；空 = 这张表不防重复）
 * @param {number} o.count   几张
 * @param {"grant"|"refund"} [o.kind="grant"]
 * @returns {Promise<{applied:boolean, duplicate?:true, count:number, ticket:object|null}>}
 */
async function mint({ userId, source, refId, count, kind = "grant", memo = "", operator = null, now = new Date() }) {
  const key = String(refId ?? "").trim();
  // ★ 空 refId 是**调用方的 bug**，不能"兜底成一个随机的"：那样就变成「每次都不重复」，
  //   而这张表存在的唯一理由就是防重复。抛出来，让写错的那个调用点在测试里就红。
  if (!key) throw new Error("gameTicket: refId 是幂等键，不能为空");
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw new Error(`gameTicket: count 必须是正整数（收到 ${String(count)}）`);

  const row = await ensureRow(userId, now);
  if (!row) return { applied: false, count: n, ticket: null }; // 账号不在了
  const cycle = cycleOf(now);

  // ① 抢幂等键（抢不到 = 这一笔已经发过）
  let rec;
  try {
    rec = await GameTicketGrant.create({
      userId,
      source,
      refId: key,
      kind,
      count: n,
      cycle,
      day: wallet.currentDay(now),
      memo: String(memo || "").slice(0, 200),
      ...(operator ? { operator } : {}),
    });
  } catch (e) {
    if (e && e.code === 11000) return { applied: false, duplicate: true, count: n, ticket: shape(row, now) };
    throw e;
  }

  // ② 余额真的加上去（只有抢到键的那一方会走到这里）
  const inc =
    kind === "refund"
      ? // 退回来的券：只加余额 + refunded，**不计进 granted / earned**（它不是"这个月发了几张"）
        { balance: n, refunded: n }
      : source === "monthly"
        ? { balance: n, granted: n }
        : { balance: n, earned: n };
  const doc = await GameTicket.findOneAndUpdate({ userId, cycle }, { $inc: inc }, { returnDocument: "after" }).lean();

  // ③ 标记「进账了没有」（只给对账看，不参与判定；失败只吼不抛 —— 余额已经加上了）
  await GameTicketGrant.updateOne({ _id: rec._id, appliedAt: null }, { $set: { appliedAt: now } }).catch((e) =>
    console.warn(`[game-ticket] 标记 appliedAt 失败 ${source}/${key}:`, (e && e.message) || e),
  );
  return { applied: true, count: n, ticket: doc ? shape(doc, now) : null };
}

/**
 * 懒发当月那 6 张（免费套餐口径）。**读余额 = 到账**，与 GET /api/me/wallet 同一个形状。
 * @returns {Promise<object|null>} 当月那一行（lean）；账号不存在 → null
 */
async function ensureTickets(userId, now = new Date()) {
  let row = await ensureRow(userId, now);
  if (!row) return null;
  const cycle = cycleOf(now);
  // granted 为 0 才试发：每月一次的唯一键抢下来之后这里恒为 6，后面每次读都只是一次查询
  if (Number(row.granted) === 0 && config.MONTHLY_TICKETS > 0) {
    await mint({ userId, source: "monthly", refId: cycle, count: config.MONTHLY_TICKETS, memo: `月度游戏券 ${cycle}`, now });
    row = await GameTicket.findOne({ userId, cycle }).lean();
  }
  return row || null;
}

/** 余额快照（顺带完成月度发放） */
async function balance(userId, now = new Date()) {
  const row = await ensureTickets(userId, now);
  return row ? shape(row, now) : null;
}

/**
 * 发券（管理员端点 / 以后的任务事件源）。
 *
 * @param {object} o
 * @param {*}      o.userId
 * @param {string} o.source  monthly / share / invite / admin
 * @param {string} [o.refId] 幂等键。share / invite **必须**给（事件 id）；admin 不给则生成一个（= 故意发一次）
 * @param {number} [o.count=1]
 * @param {*}      [o.operator] 谁发的（管理员）
 * @returns {Promise<{granted:boolean, reason?:string, duplicate?:true, count:number, ticket:object|null}>}
 *   `reason`：disabled / bad_source / bad_count / day_cap / no_user / duplicate（duplicate 时 granted 也是 false，
 *   但**不是错误**：那一笔早就发过了）
 */
async function grant({ userId, source, refId = "", count = 1, memo = "", operator = null, now = new Date() }) {
  const src = String(source || "");
  if (!config.enabled()) return { granted: false, reason: "disabled", count: 0, ticket: null };
  if (!config.GRANT_SOURCES.includes(src)) return { granted: false, reason: "bad_source", count: 0, ticket: null };
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > config.MAX_GRANT_PER_CALL) {
    return { granted: false, reason: "bad_count", count: 0, ticket: null };
  }
  // ★ 人得真的在：发券是管理员端点，userId 打错一个字符不该在库里留一行没有主人的余额
  //   （ensureRow 是 upsert，不查账号存在性；token 那边的钱包建在 User 文档上，天然没有这个问题）
  if (!(await User.exists({ _id: userId }))) return { granted: false, reason: "no_user", count: n, ticket: null };
  // ★ 任务加券的日上限（config.TASK_GRANTS_PER_DAY 的 ★）。monthly / admin 不受它管。
  //   ⚠ 是「先数后发」，两个实例同时到能各多发一次 —— 占位防刷闸，不是账务边界（真正的边界是唯一键）。
  if (src === "share" || src === "invite") {
    const day = wallet.currentDay(now);
    const today = await GameTicketGrant.find({ userId, source: src, kind: "grant", day }).select("count").lean();
    const got = today.reduce((s, r) => s + (Number(r.count) || 0), 0);
    if (got + n > config.TASK_GRANTS_PER_DAY) {
      return { granted: false, reason: "day_cap", count: n, ticket: await balance(userId, now) };
    }
  }
  // 幂等键：给了就用（share / invite 必须给，见路由）；没给时 monthly 一律用当月（**不能**随机 —— 那样手动发就能
  // 绕过「一个月只发一次」），其余来源生成一个不可能撞的键（= 这次是故意的、不幂等）。
  const key = String(refId || "").trim() || (src === "monthly" ? cycleOf(now) : `${src}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`);
  const r = await mint({ userId, source: src, refId: key, count: n, kind: "grant", memo, operator, now });
  if (r.duplicate) return { granted: false, reason: "duplicate", duplicate: true, count: n, ticket: r.ticket };
  if (!r.applied) return { granted: false, reason: "no_user", count: n, ticket: null };
  return { granted: true, count: n, ticket: r.ticket ?? (await balance(userId, now)) };
}

/**
 * 扣一张券（出片那一发）。**先扣再转发** —— 与 token 同一个顺序（W1），
 * 并发两发只有一发扣得到（余额 1 → 两个请求同时进，条件更新只有一个匹配）。
 * @returns {Promise<{ok:boolean, reason?:string, ticket?:object}>} reason：disabled / empty
 */
async function spend({ userId, memo = "", now = new Date() }) {
  if (!config.enabled()) return { ok: false, reason: "disabled" };
  // ★ 先懒发当月那几张：不这么做的话，一个本月还没读过余额的账号第一发「用券出片」会拿到 NO_GAME_TICKET，
  //   而它其实有 6 张 —— 免费用户第一次点就吃一个错，是这类懒加载最常见的坑。
  const row = await ensureTickets(userId, now);
  if (!row) return { ok: false, reason: "no_user" };
  const cycle = cycleOf(now);
  const doc = await GameTicket.findOneAndUpdate(
    { userId, cycle, balance: { $gte: config.TICKETS_PER_GENERATION } },
    { $inc: { balance: -config.TICKETS_PER_GENERATION, spent: config.TICKETS_PER_GENERATION } },
    { returnDocument: "after" },
  ).lean();
  if (!doc) return { ok: false, reason: "empty" }; // 一张都不剩（或并发里被别人抢走了）
  if (memo) console.log(`[game-ticket] 扣 1 张 user=${userId} ${String(memo).slice(0, 120)} 剩 ${doc.balance}`);
  return { ok: true, ticket: shape(doc, now) };
}

/**
 * 失败退回（上游没受理 → billing.refundUnaccepted；受理之后才失败 → taskRefund.payRefund）。
 * 幂等键 = `provider:taskId`（与 taskRefund 的 memoOf 同一个口径），所以续办 / 重复轮询都只退一次。
 * @returns {Promise<{applied:boolean, duplicate?:true, ticket:object|null}>} 账号不在了 → applied:false
 */
async function refund({ userId, refId, memo = "", now = new Date() }) {
  const key = String(refId ?? "").trim();
  if (!key) throw new Error("gameTicket: 退券要用 provider:taskId 当幂等键");
  // ★ 账号没了就退不回去（与 tokenWallet.refundSplit 回 null 是同一件事）：先确认人还在，
  //   不然会给他留一行查不到的券（删号级联已经把这张表删干净了）。
  if (!(await User.exists({ _id: userId }))) return { applied: false, ticket: null };
  const r = await mint({ userId, source: "refund", refId: key, count: config.TICKETS_PER_GENERATION, kind: "refund", memo, now });
  if (r.applied) console.warn(`[game-ticket] 退回 1 张 user=${userId} ${key}（${String(memo).slice(0, 120)}）`);
  return r;
}

/**
 * 这一发请求要不要用券（**唯一判据**，铁律六）。两种写法都认：
 *   · 请求头 `X-Game-Ticket: 1`（App 用这个：请求体是要转发给上游的，塞私货进去容易被带上去）
 *   · 请求体 `payWithTicket: true`（curl / 老调试脚本用；middleware/gameTicket 会**立刻删掉这个键**，
 *     所以它不会被当成参数发给方舟 / MiniMax，也不会撞上 H3 的严格白名单）
 * ★ 刻意只认"明确写了的"：不带标记 = 走 token 钱包，与改版前逐字节相同（默认行为不变）。
 */
function payWithTicketOf(req) {
  const header = String(req?.get?.("x-game-ticket") ?? req?.headers?.["x-game-ticket"] ?? "").trim().toLowerCase();
  if (header === "1" || header === "true" || header === "ticket") return true;
  const body = req?.body;
  return body?.payWithTicket === true || body?.payWithTicket === "true";
}

/**
 * 这一发从哪种币出（三个出片路由与 billedForward 的**唯一判据**）。
 * @param {object} req 已过 middleware/gameTicket 的请求（`req.payWithTicket`）
 * @param {string} kind  priceOf 的 kind（task / minimax_video / minimax_v2 / image / chat …）
 * @param {string} model
 * @returns {"token"|"ticket"|null} `null` = 带了券标记、但这一发**不是出片** → 调用方必须**拒**
 *   （400 TICKET_NOT_APPLICABLE），不能悄悄改走 token 扣钱 —— 用户点的是「用一张券」。
 *   ★ 「是不是出片」的判据就是 config/tokens.isVideoGeneration（不在这里另写一份）：
 *     出图 / 对话 / Seed3D 都不算，券只用于出片（app 仓 g4-ui-revamp-spec.md §0）。
 */
function currencyOf(req, kind, model) {
  if (req?.payWithTicket !== true) return "token";
  return isVideoGeneration(kind, model) ? "ticket" : null;
}

module.exports = {
  cycleOf,
  nextResetAt,
  shape,
  ensureRow,
  ensureTickets,
  balance,
  grant,
  spend,
  refund,
  payWithTicketOf,
  currencyOf,
  MONTHLY_TICKETS: config.MONTHLY_TICKETS,
  TICKETS_PER_GENERATION: config.TICKETS_PER_GENERATION,
  enabled: config.enabled,
};
