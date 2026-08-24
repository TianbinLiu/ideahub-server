/**
 * Runway 视频生成代理（image_to_video）—— App「真人视频档」的供应商之一。
 *
 * ★ 当前是**脚手架**：key 还没申请，先把形状立住。未配 RUNWAY_API_KEY 时
 *   全部业务端点回 501，App 据此把真人档整段置灰（口径与 /api/minimax 一致，
 *   两家谁的 key 先到就先亮谁）。
 *
 * 为什么必须放服务端 / 为什么白名单不透传 / 上线前必须先接钱包扣费：
 * 三条与 minimax.routes.js 文件头逐字相同的理由，不再抄一遍。
 *
 * ★★★ contentModeration 由服务端**钉死不透传**，且**不设** publicFigureThreshold=low。
 *   这是**产品与合规决定，不是漏配**：
 *   产品拿到的授权范围是「任意真人照片 + 用户勾选本人/已获授权同意」——
 *   **名人不在授权范围里**。Runway 默认开启的公众人物闸（识别到知名人物的脸
 *   就拒单）恰好就是我们产品自己要的那道闸；把 publicFigureThreshold 设成 low
 *   等于替用户解锁"生成名人视频"，而我们没有那个授权。
 *   实现上：CREATE_FIELDS 白名单**不含** contentModeration ⇒ 客户端传什么都被
 *   丢弃，上游一律走默认（严）档。要放开必须先改授权协议，再来改这行注释。
 */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");

const router = express.Router();

const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";

/**
 * Runway 要求每个请求带 API 版本头（不带直接 400）。
 * 值照官方文档 docs.dev.runwayml.com（"API Versioning"一节）：2024-11-06 是
 * 其当前唯一发布的稳定版本号（2026-01 查阅仍是它）。⚠ 待实测校准：key 到手后
 * 以首次真实调用的响应为准，官方发新版本号也只改这一处。
 */
const RUNWAY_VERSION = "2024-11-06";

/** 上游超时。promptImage 可能是 base64 data URI（数 MB），照 ark 的实测经验给宽 */
const T_CREATE = 120_000;
const T_POLL = 30_000;

/** 这台服务器配没配 key。只问这一处（读法照 arkGateway.arkConfigured：每次现读 env） */
function runwayConfigured() {
  return Boolean(process.env.RUNWAY_API_KEY);
}

/** 任务 id 的字符集（Runway 的任务 id 是 UUID，落在这个集合里）。
 *  要拼进上游 URL 的东西一律先收口（与 ark 的 TASK_ID_RE 同一条口径）。 */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 创建请求体的字段白名单（为什么是白名单不是透传：见 minimax.routes.js 同名常量，
 * 逐字相同的理由）。★ contentModeration **刻意不在册**——见文件头那段合规注释。
 */
const CREATE_FIELDS = ["model", "promptImage", "promptText", "ratio", "duration", "seed"];

/** 只留白名单字段，其余丢弃（丢弃而不是 400：客户端多传不该导致真人档整条路挂掉） */
function pickCreateBody(body) {
  const out = {};
  for (const k of CREATE_FIELDS) {
    if (body && body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

/**
 * GET /api/runway/health —— 只回"这台服务器配没配 key"，不真打上游、不泄露 key。
 * 与 /api/ark/health 同口径。
 */
router.get("/health", (_req, res) => {
  res.json({ ok: true, runway: runwayConfigured() });
});

// 限流桶照 ark 的分法：创建贵而低频、轮询便宜而高频，分桶理由见 ark.routes.js
const genLimit = aiRateLimit({ max: 30, scope: "runway-gen" });
const pollLimit = aiRateLimit({ max: 90, scope: "runway-poll" });

/**
 * POST /api/runway/video —— 创建 image_to_video 任务。
 * 转发 POST {RUNWAY_BASE}/image_to_video，成功回 { id }（后续拿 id 去 /tasks/:id 轮询）。
 * ★ 上游状态码与 JSON 原样透传：429（限流退避）与 400（入参/审核拒，不该重试）
 *   在客户端的处置不同，聚合成 502 会把这个区分抹掉。
 */
router.post("/video", requireAuth, genLimit, async (req, res) => {
  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) return res.status(501).json({ message: "runway not configured" });

  let up;
  try {
    up = await fetch(`${RUNWAY_BASE}/image_to_video`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Runway-Version": RUNWAY_VERSION,
      },
      body: JSON.stringify(pickCreateBody(req.body)),
      signal: AbortSignal.timeout(T_CREATE),
    });
  } catch (e) {
    // 超时/连接失败要说出来，不能吞（铁律八）
    console.error(`[runway] upstream image_to_video ${String((e && e.name) || e)}`);
    return res.status(504).json({ message: `runway upstream ${String((e && e.name) || "error")}` });
  }
  return res.status(up.status).type("application/json").send((await up.text()) || "{}");
});

/**
 * GET /api/runway/tasks/:id —— 查询任务状态（SUCCEEDED 时 output 里是产物地址）。
 * 上游：GET {RUNWAY_BASE}/tasks/{id}（官方任务查询端点）。
 * 不计费的轮询走单独的 pollLimit（理由见 ark 同名端点）。
 */
router.get("/tasks/:id", requireAuth, pollLimit, async (req, res) => {
  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) return res.status(501).json({ message: "runway not configured" });
  if (!TASK_ID_RE.test(req.params.id)) return res.status(400).json({ message: "bad task id" });

  let up;
  try {
    up = await fetch(`${RUNWAY_BASE}/tasks/${req.params.id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "X-Runway-Version": RUNWAY_VERSION },
      signal: AbortSignal.timeout(T_POLL),
    });
  } catch (e) {
    console.error(`[runway] upstream tasks ${String((e && e.name) || e)}`);
    return res.status(504).json({ message: `runway upstream ${String((e && e.name) || "error")}` });
  }
  return res.status(up.status).type("application/json").send((await up.text()) || "{}");
});

module.exports = router;
