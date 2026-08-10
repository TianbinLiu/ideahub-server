/**
 * 火山方舟（Ark v3）代理 —— App 的整条 AI 出片管线。
 *
 * 为什么必须放服务端（与 tts.routes.js 同一个理由，同一个事故）：
 * 这段转发原来是 app 仓 vite.config.ts 里的一个 dev 代理，只有 `npm run dev` 时存在。
 * 打成 APK 后 `/api/ark` 根本没人应答，而 Capacitor 的本地静态服务器对**未命中的
 * 路径做 SPA 回退**——`POST https://localhost/api/ark/...` 拿回的是 **200 + index.html**，
 * 不是 404。于是 app 里 `res.ok` 为真、`res.json()` 一头撞进 HTML，用户看到的是
 *   「第 1 段生成失败：Unexpected token '<', "<!doctype"... is not valid JSON」
 * 工坊 NPC 对话走同一条路，所以同时哑火。（2026-08 真机实测。）
 *
 * 密钥更不能塞进前端包：APK 解一下就拿到了（铁律三）。
 *
 * ★ 这不是一个通用反向代理，是**白名单转发**。
 *   上游 path 只允许下面这四条 App 真正用到的；model 也必须在册。
 *   开成通用代理的话，任何登录用户都能拿我们的 key 调方舟的任意模型
 *   （包括 seedance-2.5 这种 70 元/M 的），账单直接爆。
 *
 * ★ 花钱的闸门有三道，缺一不可：
 *     ① requireAuth —— 不许裸奔；
 *     ② 按账号限流 —— 挡住"合法账号写个循环刷"；
 *     ③ **服务端钱包扣费** —— 见 services/tokenWallet.service.js。
 *   ③ 是 2026-08 补上的：在那之前钱包长在客户端（app 的 IndexedDB 记账），
 *   改一行前端就能把余额写成无限，①②只能限速、限不住总量。
 *   现在的顺序是「条件原子扣减成功 = 拿到这次调用的许可」，扣不动就 402，
 *   上游没受理再原路退回（见 billedForward）。
 */
const express = require("express");
const { Readable } = require("node:stream");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");
const { assertPublicUrl } = require("../utils/ssrfGuard");
const wallet = require("../services/tokenWallet.service");
const { priceOf } = require("../config/tokens");

const router = express.Router();

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * 允许调用的模型白名单。**与 app 仓 src/ai/arkClient.ts 的 MODELS 和
 * src/data/economy.ts 的 VIDEO_TIERS 一一对应**——App 新增一个档位，就要在这里补一行，
 * 这是刻意的：每加一个模型都是一笔新的单价，应该有人明确点头。
 */
const ALLOWED_MODELS = new Set([
  "doubao-seedream-5-0-260128",        // Seedream 出图（卡面 / 首尾帧）
  "doubao-seedance-1-0-pro-250528",    // Seedance 标准档（首尾帧）
  "doubao-seedance-1-0-pro-fast-251015", // Seedance 极速档（只收首帧）
  "doubao-seedance-2-0-mini-260615",   // Seedance 高清档（需控制台开通）
  "doubao-seed-2-1-turbo-260628",      // 豆包对话 / 看图说话
  "doubao-seed3d-2-0-260328",          // Seed3D 图生 3D
]);

/** 方舟任务 id 的字符集。直接拼进上游 URL 的东西一律先收口（铁律六的同一条口径） */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 上游超时。★ 创建类请求体带 2-3MB base64 首尾帧，慢网上行 30s 会掐死在半途
 *  （app 侧实测连超两次后把创建超时提到了 120s，服务端必须给得更宽一点）。 */
const T_CREATE = 150_000;
const T_POLL = 30_000;

/** 产物代理的单文件上限。Seed3D 的 zip 实测 36MB 级，视频 5-10MB。 */
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

/** 方舟产物只在这两个域。允许任意域就等于开了一个公开的下载代理。 */
const ASSET_HOST_RE = /(^|\.)(volces|volccdn)\.com$/i;

/**
 * GET /api/ark/health —— 只回"这台服务器配没配 key"，不泄露 key 本身。
 * 与 /api/tts/health 同口径：部署自检与人工 curl 用它判断"AI 到底通不通"，
 * 不必去翻日志猜。
 */
router.get("/health", (_req, res) => {
  res.json({ ok: true, ark: Boolean(process.env.ARK_API_KEY) });
});

/** 转发一条已经过白名单的请求，返回上游的 { status, text }。
 *  key 只在这里出现，永远不回给客户端。 */
async function callArk(req, path, timeoutMs) {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) return { status: 501, text: JSON.stringify({ message: "ark not configured" }) };

  let up;
  try {
    up = await fetch(`${ARK_BASE}${path}`, {
      method: req.method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      ...(req.method === "GET" ? {} : { body: JSON.stringify(req.body ?? {}) }),
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

/** 把最新余额挂在响应头上，App 的钱包镜像据此同步（省掉一次 GET /api/me/wallet）。
 *  ★ 跨域可见需要 CORS 的 exposedHeaders 放行，见 app.js。 */
function setWalletHeaders(res, w) {
  if (!w) return;
  res.setHeader("X-Wallet-Plan", String(w.plan));
  res.setHeader("X-Wallet-Addon", String(w.addon));
}

/**
 * 计费转发：**先扣钱，再转发；上游没受理就退回来**（W2）。
 *
 * ★ 顺序不能反。先转发再扣钱的话，余额不足的请求已经花掉了钱，扣不扣都晚了；
 *   而"先查余额、转发、再扣"更糟——查和扣之间的窗口正是并发双花的入口。
 *   所以这里是"条件原子扣减成功 = 拿到了这次调用的许可"。
 *
 * ★ 只有**创建类**请求计费。轮询任务状态与取产物不计费：它们既不产生算力消耗，
 *   又高频（一段视频轮询上百次），按次收会把一段片的价格翻好几倍。
 */
function billedForward(kind, path, timeoutMs) {
  return async (req, res, next) => {
    try {
      const model = String(req.body?.model ?? "");
      if (!ALLOWED_MODELS.has(model)) {
        console.warn(`[ark] 拒绝未在册的模型: ${model.slice(0, 64)}`);
        return res.status(400).json({ ok: false, message: "model not allowed" });
      }

      const cost = priceOf(kind, req.body);
      const memo = `${kind} ${model}`;
      let w = await wallet.debit(req.user._id, cost, memo);
      if (!w) {
        // 402 而不是 400：App 据此把用户引到充值页，而不是当成"参数写错了"
        const cur = await wallet.getWallet(req.user._id);
        setWalletHeaders(res, cur);
        return res.status(402).json({
          ok: false,
          code: "INSUFFICIENT_TOKENS",
          message: "token 余额不足",
          need: cost,
          balance: cur ? cur.plan + cur.addon : 0,
        });
      }

      const { status, text } = await callArk(req, path, timeoutMs);

      // W2：方舟没受理 → 这次调用没产生任何产物，钱退回 addon。
      // ★ 任务被受理之后才失败（Seedance 排队跑完报 failed）**不在这里退**：
      //   那时算力已经消耗、方舟也已经向我们计费。刻意为之，不是遗漏。
      if (status < 200 || status >= 300) {
        const back = await wallet.credit(req.user._id, cost, "ark_refund", `${memo} 上游 ${status}`);
        w = back ?? w;
        console.warn(`[ark] ${path} 上游 ${status}，已退回 ${cost} token`);
      }

      setWalletHeaders(res, w);
      // 原样透传状态码与 JSON：App 侧对 429（限流退避）与 400（敏感词，不该重试）
      // 有不同的处理，聚合成 502 会把这个区分抹掉。
      return res.status(status).type("application/json").send(text || "{}");
    } catch (err) {
      return next(err);
    }
  };
}

// ── 白名单端点 ──────────────────────────────────────────────────────────
// ★ 逐条显式注册，不用通配 + 正则过滤：显式注册意味着**没有**到达未列出上游路径的路。
//   （Express 5 的通配写法也变了，少一个坑。）

const genLimit = aiRateLimit({ max: 30, scope: "ark-gen" });
const pollLimit = aiRateLimit({ max: 90, scope: "ark-poll" });

/** Seedream 出图 */
router.post("/images/generations", requireAuth, genLimit, billedForward("image", "/images/generations", T_CREATE));

/** Seedance 出视频 / Seed3D 建模（同一个异步任务端点）。
 *  两者单价差一个数量级（一段 720p 视频约 216k，一次建模 160k），按 body.model 分别定价 */
router.post(
  "/contents/generations/tasks",
  requireAuth,
  genLimit,
  billedForward("task", "/contents/generations/tasks", T_CREATE),
);

/** 轮询任务状态。**不计费**（见 billedForward 的注释），单独一个限流桶：
 *  它便宜且高频（每 5s 一次，一段视频最多 120 次），和"创建"共用一个桶的话，
 *  正常出片会被自己的轮询挤爆。 */
router.get("/contents/generations/tasks/:id", requireAuth, pollLimit, async (req, res, next) => {
  try {
    if (!TASK_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, message: "bad task id" });
    const { status, text } = await callArk(req, `/contents/generations/tasks/${req.params.id}`, T_POLL);
    return res.status(status).type("application/json").send(text || "{}");
  } catch (err) {
    return next(err);
  }
});

/** 豆包对话（剧情推演 / 卡片文案 / 工坊 NPC 闲聊 / 看图说话） */
router.post("/chat/completions", requireAuth, genLimit, billedForward("chat", "/chat/completions", T_CREATE));

/**
 * GET /api/ark/asset?url=… —— 取方舟产物（图片 / 视频 / 3D zip）。
 *
 * 为什么需要它：方舟产物在 TOS 域，**不带 CORS 头**。浏览器直接 fetch 会被拦，
 * 而 App 必须读到二进制才能做三件事：落地成 dataURL 入库、canvas 抽真实尾帧
 * （直连的话画布会被跨域污染，toDataURL 直接抛）、解 Seed3D 的 zip。
 * 这同样原来是 vite 的 dev 中间件，APK 里不存在。
 *
 * ★ 域名白名单 + SSRF 校验两道都要：
 *   白名单挡住"拿我们当公开下载代理"；assertPublicUrl 挡住"域名解析到内网"
 *   （攻击者注册一个 xxx.volccdn.com 的子域并不现实，但 DNS 层的兜底不花钱）。
 */
router.get("/asset", requireAuth, pollLimit, async (req, res) => {
  const raw = String(req.query.url || "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ message: "bad url" });
  }
  if (parsed.protocol !== "https:" || !ASSET_HOST_RE.test(parsed.hostname)) {
    return res.status(400).json({ message: "host not allowed" });
  }
  try {
    await assertPublicUrl(raw); // DNS 层兜底：解析到内网的一律拒绝
  } catch {
    return res.status(400).json({ message: "host not allowed" });
  }

  let up;
  try {
    up = await fetch(raw, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  } catch (e) {
    console.error(`[ark] asset ${String((e && e.name) || e)}`);
    return res.status(504).json({ message: "asset upstream error" });
  }
  if (!up.ok || !up.body) return res.status(up.status || 502).json({ message: `asset upstream ${up.status}` });

  const declared = Number(up.headers.get("content-length") || 0);
  if (declared > MAX_ASSET_BYTES) return res.status(413).json({ message: "asset too large" });

  res.setHeader("Content-Type", up.headers.get("content-type") || "application/octet-stream");
  if (declared) res.setHeader("Content-Length", String(declared));
  // 产物链接 24h 就失效，缓存没有意义
  res.setHeader("Cache-Control", "no-store");

  // ★ 没有 Content-Length 的响应必须边收边数：只信声明的长度等于没有上限。
  let sent = 0;
  const src = Readable.fromWeb(up.body);
  src.on("data", (chunk) => {
    sent += chunk.length;
    if (sent > MAX_ASSET_BYTES) {
      console.warn("[ark] asset 超过上限，掐断");
      src.destroy();
      res.destroy();
    }
  });
  src.on("error", () => res.destroy());
  src.pipe(res);
});

module.exports = router;
