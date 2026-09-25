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
const billing = require("./billing.service");
const { priceOf, paidOnlyDenial } = require("../config/tokens");
// 「谁是管理员」全仓只有 utils/roles 一处判据（铁律六）

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
/**
 * 把最新余额挂在响应头上，App 的钱包镜像据此同步（省掉一次 GET /api/me/wallet）。
 * ★ 从 ark.routes 迁到这里（2026-08-24）：minimax 路由也要写同一对头 ——
 *   响应头协议只有一份实现，两个路由各写一份迟早在字段名上分叉。
 * ★ 跨域可见需要 CORS 的 exposedHeaders 放行，见 app.js。
 */
function setWalletHeaders(res, w) {
  if (!w) return;
  res.setHeader("X-Wallet-Plan", String(w.plan));
  res.setHeader("X-Wallet-Addon", String(w.addon));
  // ★ 欠额也要进镜像：App 的 canAfford 在镜像为空时一律放行，冻结状态不下发的话
  //   被冻结的用户会看到正常报价、点下去才吃 403（§15.4.4 的实现坑之一）。
  //   老客户端不认这个头，只是照旧显示余额 —— 不会坏。
  if (w.debt) res.setHeader("X-Wallet-Debt", String(w.debt));
}

async function chargedArkCall({
  user,
  modelAllowed,
  kind,
  path,
  body,
  r2v = null,
  timeoutMs = T_CREATE,
  /**
   * 换上游用的钩子（2026-08-24 为 minimax 真人档参数化）：缺省走方舟（callArk）。
   * 整段「钱」的序列（门禁→原子扣→转发→没受理退→管理员免单记账）**仍然只有这一份**——
   * 参数化的是"往哪儿转发"，不是把序列抄去别处。
   */
  forward = null,
  /**
   * 「上游受理了吗」的判据：缺省 = HTTP 2xx（方舟口径）。MiniMax 习惯 200 +
   * base_resp.status_code 报错，同一个判据会把"业务拒绝"当成"已受理"——
   * 那就是拒了也扣钱，方向性的错。
   */
  acceptedOf = null,
  /** 退款流水的类别标签：月底对账要分得出哪家上游退的钱 */
  refundTag = "ark_refund",
}) {
  const model = String(body?.model ?? "");
  if (!modelAllowed(model)) {
    console.warn(`[ark] 拒绝未在册的模型: ${model.slice(0, 64)}`);
    // ★ 这一路刻意**不带钱包头**：一分钱没动，写头只会让 App 的镜像多刷一次
    return { ok: false, reason: "model", status: 400, body: { ok: false, message: "model not allowed" }, wallet: null };
  }

  // ★ 一趟读，两个用途：套餐门禁的判据、顺带完成钱包初始化与跨月刷新。
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

  // 套餐门禁。判据只有 config/tokens.js 的 paidOnlyDenial 一处（客户端置灰是提示，不是边界）
  const denied = paidOnlyDenial(before?.planId, model);
  if (denied) console.warn(`[ark] 套餐不足，拒绝 ${model}（planId=${before?.planId ?? "?"}）`);

  // ★★ 「钱」的序列（冻结 → 门禁 → 原子扣 → 转发 → 没受理退 → 免单记账）搬到了
  //   services/billing.service.js，**四条链路共用那一份**（铁律六）。这里只负责
  //   方舟特有的两件事：模型白名单与 priceOf 报价。
  let upstream = { status: 0, text: "" };
  const r = await billing.chargedCall({
    user,
    cost,
    memo,
    refundTag,
    denyReason: denied || "",
    forward: async () => {
      upstream = forward ? await forward() : await callArk({ method: "POST", path, body, timeoutMs });
      const ok = acceptedOf ? acceptedOf(upstream.status, upstream.text) : upstream.status >= 200 && upstream.status < 300;
      return { accepted: ok };
    },
  });

  if (!r.ok) {
    // 拒绝的三种形态（冻结 / 套餐 / 余额）在 billing 里已经拼好整句，这里只补回
    // 调用方按 reason 分支时要的那个标签（既有测试按它断言）。
    const reason = r.body.code === "WALLET_FROZEN" ? "debt" : r.body.code === "PLAN_REQUIRED" ? "plan" : "funds";
    if (reason === "plan") r.body.model = model;
    return { ok: false, reason, status: r.status, body: r.body, wallet: r.wallet };
  }

  const { status, text } = upstream;
  const { accepted, wallet: w, free } = r;
  if (!accepted && !free) console.warn(`[ark] ${path} 上游 ${status}，已退回 ${cost} token`);

  return { ok: true, status, text, accepted, wallet: w, cost, free };
}

module.exports = { ARK_BASE, T_CREATE, T_POLL, arkConfigured, callArk, chargedArkCall, setWalletHeaders };
