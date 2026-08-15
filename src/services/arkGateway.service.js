// src/services/arkGateway.service.js
// 方舟出口 + **「一次方舟调用怎么收钱」的唯一实现**（铁律六）。
//
// 为什么要有这一层：白模 V2 之前，"扣钱 → 转发 → 没受理就退" 这条序列只长在
// routes/ark.routes.js 的 billedForward 里，因为只有代理会调方舟。V2 起
// **服务端自己也要发方舟请求**（白模化那一步：先 chat vision 看帧，再 r2v edit 出片，
// 两次都是真金白银），如果在路由里再抄一遍这条序列，就会出现两套记账 ——
// 而两套记账分叉的表现是「账单对不上，且查不出是谁的口子漏了」，零症状。
//
// ══ 这条序列的三条硬顺序（照抄 tokenWallet.service 的 W1/W2，不要改）══════
//  ① 在册 → ② 套餐门禁 → ③ 扣费 → ④ 转发 → ⑤ 上游没受理就退回 addon。
//  · ②必须排在③前：排后面的话，免费用户点一次 2.5 会先被扣掉一百万 token
//    （大概率直接 402），真正的原因（这一档不对你开放）被"余额不足"彻底盖住。
//  · ③必须排在④前，且是**条件原子扣减**：先转发再扣钱的话钱已经花出去了；
//    "先查余额、再转发、再扣"更糟 —— 查和扣之间的窗口正是并发双花的入口。
//  · 管理员免单跳过②③，但**照实记一笔流水**（火山账单上是真花了钱的），
//    且那笔账等转发回来、确认受理了才落 —— 敏感词 400 那种根本没被受理的调用
//    记进去，等于自己给自己造对不上的账。
const wallet = require("./tokenWallet.service");
const { priceOf, paidOnlyDenial } = require("../config/tokens");
// 「谁是管理员」全仓只有 utils/roles 一处判据（铁律六）
const { isAdmin } = require("../utils/roles");

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

/** 上游超时。★ 创建类请求体带 2-3MB base64 首尾帧，慢网上行 30s 会掐死在半途
 *  （app 侧实测连超两次后把创建超时提到了 120s，服务端必须给得更宽一点）。 */
const T_CREATE = 150_000;
const T_POLL = 30_000;

/** 这台服务器配没配 key。健康端点与"要不要白跑一趟"都只问这一处 */
function arkConfigured() {
  return Boolean(process.env.ARK_API_KEY);
}

/**
 * 转发一条已经过白名单的请求，返回上游的 { status, text }。
 * key 只在这里出现，永远不回给客户端（铁律三）。
 */
async function callArk({ method = "POST", path, body, timeoutMs = T_CREATE }) {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) return { status: 501, text: JSON.stringify({ message: "ark not configured" }) };

  let up;
  try {
    up = await fetch(`${ARK_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // ★ 超时/连接失败要**说出来**，不能吞（铁律八）。App 那边靠这条消息区分
    //   "方舟慢"和"这台服务器没有代理"，两者的处置完全不同。
    console.error(`[ark] upstream ${path} ${String((e && e.name) || e)}`);
    return { status: 504, text: JSON.stringify({ message: `ark upstream ${String((e && e.name) || "error")}` }) };
  }
  return { status: up.status, text: await up.text() };
}

/**
 * 扣钱 → 转发 → 没受理就退。**代理与服务端自发的调用共用这一份**。
 *
 * @param {object} args
 * @param {object} args.user            登录用户文档（requireAuth 每次从库里重读，role 是新的）
 * @param {(m:string)=>boolean} args.modelAllowed 在册判据（路由持有那张白名单，服务不复制一份）
 * @param {"image"|"chat"|"task"} args.kind
 * @param {string} args.path            上游路径
 * @param {object} args.body            请求体（原样转发）
 * @param {{durationSec:number, templateId?:string|null, sourcePublicId?:string}|null} [args.r2v]
 *        resolveR2v / 白模化端点解析出的 r2v 结论。有它 = 按 r2vTokens 计价（定价规则
 *        仍只在 config/tokens.js 一处，这里只把结论递进去）。
 * @param {number} [args.timeoutMs]
 * @returns {Promise<
 *   | { ok:true,  status:number, text:string, accepted:boolean, wallet:object|null, cost:number, free:boolean }
 *   | { ok:false, reason:"model"|"plan"|"funds", status:number, body:object, wallet:object|null }
 * >}
 */
async function chargedArkCall({ user, modelAllowed, kind, path, body, r2v = null, timeoutMs = T_CREATE }) {
  const model = String(body?.model ?? "");
  if (!modelAllowed(model)) {
    console.warn(`[ark] 拒绝未在册的模型: ${model.slice(0, 64)}`);
    // ★ 这一路刻意**不带钱包头**：一分钱没动，写头只会让 App 的镜像多刷一次
    return { ok: false, reason: "model", status: 400, body: { ok: false, message: "model not allowed" }, wallet: null };
  }

  // 管理员免单。★ 判据来自 req.user.role，而 requireAuth **每次请求都从库里重读** role
  //   （不信 JWT 里的快照）—— 撤掉某人的管理员身份立刻生效，不用等他的 token 过期。
  const free = isAdmin(user);

  // ★ 一趟读，三个用途：套餐门禁的判据、402 时报给用户的余额、顺带完成钱包初始化与跨月刷新。
  //   故意选"每次都读"这种贵写法：换成"只有 paidOnly 的模型才去读套餐"就等于把门禁的判据
  //   劈成两半，以后往 PAID_ONLY_MODELS 里加第二个模型时漏改任何一半都不报错，只会静默放行。
  const before = await wallet.getWallet(user._id);
  const cost = priceOf(kind, body, r2v ?? null);
  // r2v 的流水 memo 带来源标记：不带的话 `task <model>` 与纯任务一模一样，
  // 月底对方舟账单时分不出哪些钱是白模花的。
  //  · 命中已登记模板 → `r2v tpl:<模板id>`
  //  · 白模化那一发（还没有模板）→ `r2v src:<原视频 public_id>`
  let memo = `${kind} ${model}`;
  if (r2v?.templateId) memo += ` r2v tpl:${r2v.templateId}`;
  else if (r2v) memo += ` r2v src:${String(r2v.sourcePublicId || "?")}`;

  // ★ 管理员这一路的 w 保持 before（余额没动）。**不能给 null**：钱包头一个都不写的话，
  //   App 的镜像就停在"本地先减过一次"的值上，界面显示的余额比真实值少 —— 一个不报错的假账。
  let w = before;

  if (!free) {
    // 套餐门禁。判据只有 config/tokens.js 的 paidOnlyDenial 一处（客户端置灰是提示，不是边界）
    const denied = paidOnlyDenial(before?.planId, model);
    if (denied) {
      console.warn(`[ark] 套餐不足，拒绝 ${model}（planId=${before?.planId ?? "?"}）`);
      // 403 而不是 402：402 的含义是"充值就能继续"，而这一条充多少都没用，得换套餐。
      // 合并成同一个码，用户会一直充值一直被拒。
      return {
        ok: false,
        reason: "plan",
        status: 403,
        body: { ok: false, code: "PLAN_REQUIRED", message: denied, planId: before?.planId ?? null, model },
        wallet: before,
      };
    }

    w = await wallet.debit(user._id, cost, memo);
    if (!w) {
      // 402 而不是 400：App 据此把用户引到充值页，而不是当成"参数写错了"
      return {
        ok: false,
        reason: "funds",
        status: 402,
        body: {
          ok: false,
          code: "INSUFFICIENT_TOKENS",
          message: "token 余额不足",
          need: cost,
          balance: before ? before.plan + before.addon : 0,
        },
        wallet: before,
      };
    }
  }

  const { status, text } = await callArk({ method: "POST", path, body, timeoutMs });
  const accepted = status >= 200 && status < 300;

  // W2：方舟没受理 → 这次调用没产生任何产物，钱退回 addon。
  // ★ 任务被受理之后才失败（Seedance 排队跑完报 failed）**不在这里退**：
  //   那时算力已经消耗、方舟也已经向我们计费。刻意为之，不是遗漏。
  if (!accepted && !free) {
    const back = await wallet.credit(user._id, cost, "ark_refund", `${memo} 上游 ${status}`);
    w = back ?? w;
    console.warn(`[ark] ${path} 上游 ${status}，已退回 ${cost} token`);
  }

  // ★★ 管理员那笔账记在转发之后、且只在上游受理时记，与扣费的顺序正好相反：
  //   扣费必须在前（并发双花），而免单这一路不动余额，可以等"确实花出去了"再落账。
  if (accepted && free) {
    await wallet.noteAdminFree(user._id, cost, `admin ${memo}`, before);
  }

  return { ok: true, status, text, accepted, wallet: w, cost, free };
}

module.exports = { ARK_BASE, T_CREATE, T_POLL, arkConfigured, callArk, chargedArkCall };
