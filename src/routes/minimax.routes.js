/**
 * MiniMax（海螺）视频生成代理 —— App「真人视频档」的供应商之一。
 *
 * ★ 两把 key（中国站 MINIMAX_API_KEY / 国际站 MINIMAX_INTL_API_KEY）一把都没配时
 *   全部业务端点回 501，App 据此把真人档整段置灰
 *   （与 /api/tts 未配密钥退回浏览器合成器是同一个约定：降级要明说，不要静默装死）。
 *
 * 为什么必须放服务端（与 ark.routes.js / tts.routes.js 同一个理由、同一个事故）：
 * 密钥进前端包 = APK 解一下就拿到（铁律三）；dev 代理只在 `npm run dev` 时存在，
 * 打成 APK 后无人应答，而 Capacitor 对未命中路径回 **200 + index.html**，
 * 故障静默（"Unexpected token '<'"那次）。
 *
 * ★ 这不是通用反向代理，是**白名单转发**（与 /api/ark 同款纪律）：
 *   上游 path 只有下面两条，创建体只透传 CREATE_FIELDS 里的字段。
 *
 * ★★ 钱包扣费**已接**（2026-08-24）：POST /video 走 arkGateway.chargedArkCall 的
 *   「门禁 → 原子扣 → 转发 → 没受理就退 → 管理员免单记账」同一序列（唯一实现，
 *   本文件只换了"往哪儿转发"与"受理判据"——MiniMax 习惯 200 + base_resp 报错，
 *   HTTP 2xx 不等于受理）。价目在 config/tokens.MINIMAX_FLAT_COST，与 App 报价
 *   跨仓钉死（realPersonProxy.spec.js 末尾）。生产可以配真 key 了。
 */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");
const { chargedArkCall, setWalletHeaders } = require("../services/arkGateway.service");
const { MINIMAX_FLAT_COST, MINIMAX_REAL_MODELS, minimaxFlatCost, MINIMAX_REAL_RESOLUTION } = require("../config/tokens");
// ★★ 往哪个站打、用哪把 key **只有这一处判据**（config/minimax）：中国站与国际站是
//   两套账号两个域名，把国际站的 key 配到中国站地址上只会一路鉴权失败，而那时钱已经扣过。
const { minimaxBase, minimaxKey, minimaxConfigured, minimaxRegion } = require("../config/minimax");
const wallet = require("../services/tokenWallet.service");
// 受理之后失败的退款（2026-10-07）：受理时记账（带区域）、轮询看见 Fail 时结账 —— 唯一实现在那个文件里
const taskRefund = require("../services/taskRefund.service");

const router = express.Router();

/** 上游超时。创建体可能带 base64 首帧（压到 720p 仍有 2-3MB，照 ark 的实测经验
 *  给宽），轮询与 ark 的 T_POLL 同一个量级。 */
const T_CREATE = 120_000;
const T_POLL = 30_000;

/** 任务 id 的字符集。要拼进上游 URL 的东西一律先收口（与 ark 的 TASK_ID_RE 同一条口径） */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 创建请求体的字段白名单。
 *
 * ★ 为什么是白名单不是透传：MiniMax 同一个端点还收 callback_url（回调打到任意
 *   URL——拿我们的 key 当 SSRF/骚扰炮）、prompt_optimizer 等我们没审过面、没估过价
 *   的参数；透传 = 客户端能点名任意昂贵参数组合，而账单在我们名下。与 /api/ark
 *   只逐条显式注册端点是同一个道理：**没列出来的字段就没有路能到上游**。
 *   以后每放行一个新字段都是一笔新的单价 / 一个新的攻击面，应该有人明确点头。
 */
const CREATE_FIELDS = ["model", "prompt", "first_frame_image", "subject_reference", "duration", "resolution"];

/** 只留白名单字段，其余丢弃（丢弃而不是 400：客户端多传不该导致真人档整条路挂掉） */
function pickCreateBody(body) {
  const out = {};
  for (const k of CREATE_FIELDS) {
    if (body && body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

/**
 * GET /api/minimax/health —— 只回"这台服务器配没配 key"，不真打上游、不泄露 key。
 * 与 /api/ark/health 同口径：部署自检与人工 curl 用它判断"真人档到底通不通"。
 */
router.get("/health", (_req, res) => {
  // ★ 带上 region：两把 key 长得一样、域名不一样，出问题时第一件要确认的就是"在往哪打"。
  //   只回区域名，不回 key、不回完整 base（后者对外没用，对攻击者是提示）。
  res.json({ ok: true, minimax: minimaxConfigured(), region: require("../config/minimax").minimaxRegion() });
});

// 限流桶照 ark 的分法：创建贵而低频、轮询便宜而高频，共用一个桶的话
// 正常出片会被自己的轮询挤爆。
const genLimit = aiRateLimit({ max: 30, scope: "minimax-gen" });
const pollLimit = aiRateLimit({ max: 90, scope: "minimax-poll" });

/**
 * POST /api/minimax/video —— 创建视频生成任务。
 * 转发 POST {base}/video_generation（base 按区域取，见 config/minimax），回 { task_id, base_resp }。
 * ★ 上游状态码与 JSON 原样透传：MiniMax 习惯 200 + base_resp.status_code 报错，
 *   聚合成 502 会把客户端能读的真实原因抹掉。
 */
router.post("/video", requireAuth, genLimit, async (req, res, next) => {
  const apiKey = minimaxKey();
  const base = minimaxBase();
  if (!apiKey || !base) return res.status(501).json({ message: "minimax not configured" });

  // ── 计价参数在扣费**之前**钉死（照 resolveR2v 的先例：算钱与校验同一拍）──
  // 价目表锚了 海螺2.3 / 2.3-Fast · 768P · 6/10 秒（config/tokens.MINIMAX_FLAT_COST 的 ★★）。
  // 表外组合没有价，放行就是"按某个数收费、按另一个规格出片"——所以整发 400，
  // 不是悄悄改写参数（改写 = 用户要 1080P 我们发 768P 还照收钱，偷换商品）。
  const body = pickCreateBody(req.body);
  // ★ model 不填时按老客户端处理（App ≤2.52 其实一直都填，这里只是别让缺字段变成 500）
  const model = String(body.model ?? MINIMAX_REAL_MODELS[0]);
  const duration = Number(body.duration ?? 6);
  // ★★ **一条判据管两件事**（铁律六）：不在册的模型、表外的时长，都是"这个组合没有价"
  //   的同一种情况，而 `minimaxFlatCost` 返回 null 就是它的唯一答案。
  //   写成两个 if 看着更"周全"，实际是同一条规则的两份实现 —— 删掉其中一份，
  //   另一份照样拦得住，于是没有任何测试能证明那一份还活着（实测：变异它，全绿）。
  if (minimaxFlatCost(model, duration) === null) {
    const durs = MINIMAX_FLAT_COST[model] ? Object.keys(MINIMAX_FLAT_COST[model]).join("/") : "";
    return res.status(400).json({
      ok: false,
      message: durs
        ? `${model} 只有 ${durs} 秒两档（duration=${String(body.duration)}）`
        : `真人档只在册 ${MINIMAX_REAL_MODELS.join(" / ")}（model=${String(body.model)}）`,
    });
  }
  body.model = model;
  if (body.resolution !== undefined && body.resolution !== MINIMAX_REAL_RESOLUTION) {
    return res.status(400).json({ ok: false, message: `真人档只按 ${MINIMAX_REAL_RESOLUTION} 计价出片（resolution=${String(body.resolution)}）` });
  }
  body.duration = duration;
  body.resolution = MINIMAX_REAL_RESOLUTION;

  try {
    // 整段「钱」的序列（门禁→原子扣→转发→没受理退→管理员免单记账）在
    // arkGateway.chargedArkCall **唯一一份**——这里只换了"往哪儿转发"与"受理判据"。
    const out = await chargedArkCall({
      user: req.user,
      // 在册 = 计价表里有它。别的模型没有价，管理员也不该能点名一个没估过价的模型
      modelAllowed: (m) => MINIMAX_REAL_MODELS.includes(m),
      kind: "minimax_video",
      path: "(minimax)/video_generation",
      body,
      timeoutMs: T_CREATE,
      forward: async () => {
        // ★ 这里**不许抛**：forward 在扣费之后执行，抛出去就绕过了"未受理退款"那一步
        //   （chargedArkCall 只对返回的 status 判退）。超时/断连一律折成 504 返回，
        //   让退款路正常走，同时把真实原因记进日志。
        try {
          const up = await fetch(`${base}/video_generation`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(T_CREATE),
          });
          return { status: up.status, text: (await up.text()) || "{}" };
        } catch (e) {
          console.error(`[minimax] upstream video_generation ${String((e && e.name) || e)}`);
          return { status: 504, text: JSON.stringify({ message: `minimax upstream ${String((e && e.name) || "error")}` }) };
        }
      },
      // MiniMax 习惯 200 + base_resp.status_code 报错：HTTP 2xx 不等于受理。
      // 按方舟口径判的话，业务拒绝（敏感词/参数错）也会当成"已受理"不退款。
      acceptedOf: (status, text) => {
        if (status < 200 || status >= 300) return false;
        try {
          const j = JSON.parse(text);
          return j?.base_resp?.status_code === 0 && !!j?.task_id;
        } catch {
          return false;
        }
      },
      refundTag: "minimax_refund",
    });

    if (!out.ok) {
      setWalletHeaders(res, out.wallet);
      return res.status(out.status).json(out.body);
    }
    if (out.accepted) {
      // ★★ 记账（services/taskRefund）：MiniMax 之后报 Fail 时按扣的那两桶退回。**带上区域** ——
      //   MiniMax 的任务绑站（config/minimax 的 ★★），清扫器只能回同一个站去问。记账只吼不抛。
      let taskId = "";
      try {
        taskId = String(JSON.parse(out.text || "{}")?.task_id || "");
      } catch {
        /* acceptedOf 已经确认过有 task_id；读不出来 recordCharge 自己会吼 */
      }
      await taskRefund.recordCharge({
        provider: "minimax",
        taskId,
        kind: "minimax",
        user: req.user._id,
        model,
        cost: out.cost,
        free: out.free,
        took: out.took,
        memo: out.memo,
        region: minimaxRegion(),
      });
    }
    setWalletHeaders(res, out.wallet);
    // 上游状态码与 JSON 原样透传（业务码在 base_resp 里，App 的 minimaxVideo 会读）
    return res.status(out.status).type("application/json").send(out.text || "{}");
  } catch (err) {
    // 转发阶段抛出（超时/断连）时 chargedArkCall 内部还没走到退款——callArk 不抛而
    // forward 会抛。为了不吞钱，这里不能让它裸抛：交给 next 之前先说明。
    // ★ 实际上 forward 抛出发生在扣费之后 ⇒ 必须退。为不复制退款逻辑，
    //   forward 里已经把 fetch 异常转成 {status:504}（见下方封装），走正常"未受理退款"。
    return next(err);
  }
});

/**
 * GET /api/minimax/video/:taskId —— 查询任务状态。
 * 上游是官方 v1 的 query 形状：GET {base}/query/video_generation?task_id=<id>
 * （2026-08-24 已实测：query 与 files/retrieve 两条路径直连打通，形状与此一致）。
 * 不计费的轮询走单独的 pollLimit（理由见 ark 同名端点）。
 */
router.get("/video/:taskId", requireAuth, pollLimit, async (req, res) => {
  // ★★ 任务是**绑区域**的：在哪个站建的只能在同一个站查。切换 MINIMAX_REGION 会让在途任务
  //   查不到（钱已扣），所以要切就等在途任务跑完再切（见 config/minimax 的 ★★）。
  const apiKey = minimaxKey();
  const base = minimaxBase();
  if (!apiKey || !base) return res.status(501).json({ message: "minimax not configured" });
  if (!TASK_ID_RE.test(req.params.taskId)) return res.status(400).json({ message: "bad task id" });

  let up;
  try {
    up = await fetch(`${base}/query/video_generation?task_id=${req.params.taskId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(T_POLL),
    });
  } catch (e) {
    console.error(`[minimax] upstream query ${String((e && e.name) || e)}`);
    return res.status(504).json({ message: `minimax upstream ${String((e && e.name) || "error")}` });
  }
  let out = (await up.text()) || "{}";
  // ★★ 失败退款的挂点（2026-10-07，services/taskRefund）：MiniMax **明说** Fail → 按原桶退给账的主人（恰好一次）。
  //   只认 200 + base_resp 成功 + status 字段；别的（非 200、读不懂、查无此任务）一律不是结局。
  //   开关 MINIMAX_FAIL_REFUND=off 时 settleTask 一分不动（MiniMax 对按量付费的失败任务计不计费没有书面说法，见 .env.example）。
  // ★ 同 /api/ark 的轮询：退给账的主人、refund 字段与余额头只给主人；失败只吼不挡，原话照回。
  if (up.status === 200) {
    try {
      const j = JSON.parse(out);
      const okResp = !j?.base_resp || j.base_resp.status_code === 0;
      const verdict = okResp ? taskRefund.verdictOf("minimax", j?.status) : null;
      if (verdict) {
        // region：回答这句话的是**此刻配的那个站**（上面 fetch 的 base）—— settleTask 只结那个站建的账（切过站的不动）
        const row = await taskRefund.settleTask({
          provider: "minimax",
          taskId: req.params.taskId,
          status: j.status,
          viewerId: req.user._id,
          region: minimaxRegion(),
        });
        if (verdict === "failed" && row && String(row.user) === String(req.user._id)) {
          j.refund = taskRefund.refundView(row);
          setWalletHeaders(res, await wallet.getWallet(req.user._id));
          out = JSON.stringify(j);
        }
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) console.error(`[minimax] 失败退款的结账没办成 task=${req.params.taskId}（清扫器会接着办）:`, e.message);
    }
  }
  return res.status(up.status).type("application/json").send(out);
});

/**
 * GET /api/minimax/file/:fileId —— 出片成功后取下载地址（官方 files/retrieve）。
 * 2026-08-24 已实测：query 出 file_id 后打这一发，回 file.download_url
 * （落在 public-cdn-video-data-*.oss-cn-*.aliyuncs.com）。
 * 与 /video/:taskId 同一套纪律：id 收口、不计费限流、超时 504、原样透传。
 */
router.get("/file/:fileId", requireAuth, pollLimit, async (req, res) => {
  // 同 /video/:taskId：file_id 也是**绑区域**的，只能回它生成的那个站去取
  const apiKey = minimaxKey();
  const base = minimaxBase();
  if (!apiKey || !base) return res.status(501).json({ message: "minimax not configured" });
  if (!TASK_ID_RE.test(req.params.fileId)) return res.status(400).json({ message: "bad file id" });

  let up;
  try {
    up = await fetch(`${base}/files/retrieve?file_id=${req.params.fileId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(T_POLL),
    });
  } catch (e) {
    console.error(`[minimax] upstream retrieve ${String((e && e.name) || e)}`);
    return res.status(504).json({ message: `minimax upstream ${String((e && e.name) || "error")}` });
  }
  return res.status(up.status).type("application/json").send((await up.text()) || "{}");
});

module.exports = router;
