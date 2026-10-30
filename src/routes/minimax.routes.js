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
 *
 * ★ 2026-10-26 起这里还有 **MiniMax H3（V2）出片**：`POST /v2/video` + `GET /v2/video/:taskId`（文件末尾那一节）——
 *   海外的「草稿 / 高清 / 电影级」（出片按地区下发之后海外只给 MiniMax）。与真人档是**两套接口**：
 *   V2 用真的 HTTP 状态码报错、状态是小写的 succeeded / failed、成片地址直接在查询回包里、按秒计价（tokens.minimaxV2Tokens）。
 *   只在国际站开（config/minimax.minimaxV2Enabled）。
 */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");
const { chargedArkCall, regionGate, setWalletHeaders } = require("../services/arkGateway.service");
const {
  MINIMAX_FLAT_COST,
  MINIMAX_REAL_MODELS,
  minimaxFlatCost,
  MINIMAX_REAL_RESOLUTION,
  MINIMAX_SEC_COST,
  minimaxSecCost,
  minimaxV2Tokens,
} = require("../config/tokens");
// ★★ 往哪个站打、用哪把 key **只有这一处判据**（config/minimax）：中国站与国际站是
//   两套账号两个域名，把国际站的 key 配到中国站地址上只会一路鉴权失败，而那时钱已经扣过。
const { minimaxBase, minimaxKey, minimaxConfigured, minimaxRegion, minimaxV2Base, minimaxV2Enabled, isMinimaxV2VideoUrl } = require("../config/minimax");
// H3（V2）请求体的值上的规矩（名单照 config/tokens 建）—— 路由只拿它重建出来的那一份去问价、扣费、转发
const { parseV2CreateBody } = require("../schemas/minimaxV2.schemas");
// 「谁是管理员」全仓只有 utils/roles 一处判据：V2 查询只给任务的主人看，管理员排查时例外
const { isAdmin } = require("../utils/roles");
const { logSafe } = require("../utils/logSafe");
const wallet = require("../services/tokenWallet.service");
// 受理之后失败的退款（2026-10-07）：受理时记账（带区域）、轮询看见 Fail 时结账 —— 唯一实现在那个文件里
const taskRefund = require("../services/taskRefund.service");
// 视频任务的服务端登记（App 重启之后取回用；H3 从 2026-10-26 起也记，见 models/ArkVideoTask 的 ★★）
const arkVideoTask = require("../services/arkVideoTask.service");

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
      // 出片地区门禁（arkGateway.regionGate）：海外只准 MiniMax 国际站、受全面制裁的地区一家都不给 ——
      // 这台服务器走中国站时海外的真人档在门禁 on 时被拦（403 REGION_UNAVAILABLE，不扣钱）。轮询（GET /video/:taskId）不拦
      req,
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
router.get("/video/:taskId", requireAuth, pollLimit, async (req, res, next) => {
  // ★★ 任务是**绑区域**的：在哪个站建的只能在同一个站查。切换 MINIMAX_REGION 会让在途任务
  //   查不到（钱已扣），所以要切就等在途任务跑完再切（见 config/minimax 的 ★★）。
  const apiKey = minimaxKey();
  const base = minimaxBase();
  if (!apiKey || !base) return res.status(501).json({ message: "minimax not configured" });
  if (!TASK_ID_RE.test(req.params.taskId)) return res.status(400).json({ message: "bad task id" });

  // ★★ 账上记着是 H3（V2）建的任务号 → 404，不去问上游（2026-10-26 文档审核）：
  //   H3 的查询只给任务的主人看（GET /v2/video/:taskId 的 ★），而这条 v1 查询照 2026-10-07 的口径不查归属；
  //   两版的任务号在 MiniMax 那边是同一个命名空间 —— v1 的查询认不认 H3 的号没有验过（要真打上游），按「认」处理：
  //   不拦的话，这里就是 H3 成片的另一条不看归属的路。拦了不伤真人档：真人档的任务从来不是 H3 的号。
  //   没有账的号照旧放行（真人档自动退款上线之前的任务、落账失败过的那几发都没有账）。
  try {
    const row = await taskRefund.chargeByTask("minimax", req.params.taskId);
    if (row?.api === "v2") {
      // 话与 V2 那条的 404 一样不说「有这一发、只是不归这条路查」：对不是主人的人，那也是一句「这个号存在」
      return res.status(404).json({ ok: false, code: "TASK_NOT_FOUND", message: "查不到这一发真人档任务" });
    }
  } catch (e) {
    return next(e);
  }

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
  //   开关 MINIMAX_FAIL_REFUND=off 时 settleTask 一分不动、账留 open，只记下上游说了什么（MiniMax 对按量付费的失败任务计不计费没有书面说法，见 .env.example）。
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
 * ★ 不查归属：我们不记 file_id 属于哪一发任务（真人档取件的归属等它的取回登记一起做，P3）。H3 的成片不走这一条 ——
 *   V2 的查询回包里直接给成片地址，而 /video/:taskId 拒账上记着是 H3 的任务号（那里的 ★★）。
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

// ════ MiniMax H3（V2 出片，2026-10-26）════════════════════════════════════════
//
// 海外的「草稿 / 高清 / 电影级」（H3-Lite 480P / H3-Highspeed 768P / H3 768P，价目 tokens.MINIMAX_SEC_COST）。
// 序列与真人档相同、也只有一份实现（arkGateway.chargedArkCall）。按**效果上**谁先拒人写：在册 → 出片地区门禁 → 冻结 / 套餐 / 日上限
// （在 billing 里，与扣费同一拍）→ 原子扣 → 转发 → 没受理退 → 管理员免单记账 —— 地区门禁排在套餐之前（chargedArkCall 里那一段的 ★）。
// 这一节的路由另在 chargedArkCall 之前加了两样：请求体白名单（schemas/minimaxV2），以及「地区门禁预检 → 按人 → 全站」两道并发闸
// （预检的理由见 POST /v2/video 里那一段）。除此之外只换三样：往哪儿转发、受理判据、回包怎么说。
//
// ★★ 回包**不**原样透传（与真人档、方舟都不同）：V2 用真的 HTTP 状态码报错，而 App 认这几个码另有含义 ——
//   上游 401（我们的 key 坏了）原样回去，App 会当成「登录过期」把人踢回登录页；上游 402（我们在 MiniMax 的余额不足）
//   原样回去，App 会对用户说「余额不足，去充值」—— 两句都是错话，而且都在叫用户做一件没用的事。
//   所以上游的拒绝一律换成我们自己的码（v2UpstreamRejection），上游的码与状态只放在 `upstream` 里给人排查。
// ★ 只在国际站开（config/minimax.minimaxV2Enabled 的 ★）：走中国站（或一把 key 都没配）的服务器上两条都回 501，在扣费之前。

/** 拒绝话的后半句：被拒的这几种都是在扣费之前（或扣了已退回）—— 说清楚，免得用户以为钱没了 */
const NOT_BILLED = "——当前请求未被受理，也没有扣费。";
const REFUNDED = "——这一发没有被受理，扣的钱已经退回。";

/**
 * 全站同时在 MiniMax 上跑的 H3 任务最多几发（官方 V2 的「Max inflight tasks」是 30，2026-10-26 读的速率限制页）。
 * ★ 留 5 发余量：计数是「大概」（taskRefund.minimaxV2InFlight 的 ⚠ —— 两个 pm2 实例可能同时数到同一个数；
 *   受理之前那几秒库里还没有那一行）。超了上游回 429（1045 task concurrency），钱照退 —— 我们在扣费之前就拦下，
 *   用户少一次「扣了又退」，也不把上游的限流额度白打掉。
 */
const V2_MAX_INFLIGHT = 25;
/**
 * 一个人同时最多几发（2026-10-26 审核补的）。★ 为什么全站闸旁边还要一道按人的：只有全站总数的话，一个账号就能把 25 个位全占掉
 *   （genLimit 每人每分钟 30 发，H3-Lite 4 秒一发只要 44,800 token），之后海外所有人都收到 UPSTREAM_BUSY —— 而海外只有 MiniMax 这一家。
 * ★ 为什么是 4：App 一台设备同时只炼一段（flowStore 的 busy 闸），一个人两台设备、外加一两发 App 被杀之后还没人来问的
 *   （出成了也要等清扫器第一次去问才结，最长 10 分钟；MINIMAX_FAIL_REFUND=off 时清扫器不问，占满整个窗口）也够用 ——
 *   开关关着时用户自己问到的失败不算在跑（taskRefund.v2RunningFilter 的 ★），不会让 4 发永远出不来的失败把人关在门外；
 *   要把全站 25 个位占满得 7 个账号。
 * ★ 按人只数**花了钱、还没结局**的行（taskRefund.minimaxV2InFlightOfUser 的 ★）：管理员免单的行落库就是 skipped、之后不再结，
 *   按人数它的话，主人自己测 H3 时出完 4 段就要干等 30 分钟。全站闸照旧数它们（它们照样占着上游的位）。
 */
const V2_MAX_INFLIGHT_PER_USER = 4;
/** 受理多久之后就不再当它「还在跑」（H3 一段实测 10 秒 ~ 2 分钟；窗口外的 open 行多半是出成了没人来问、等清扫器结的） */
const V2_INFLIGHT_WINDOW_MS = 30 * 60 * 1000;
/** 本进程此刻正在建的 V2 任务（扣费 → 上游回话 → 落账之间那几秒，库里还没有那一行）—— 并进并发闸的数 */
let v2Creating = 0;
/** 同上，按人分（userId → 本进程正在建的几发）—— 并进按人那一道的数；到 0 就删掉那一格，别让这张表只长不缩 */
const v2CreatingBy = new Map();

/** 这台服务器没开 V2（走中国站 / 没配 key）：一句话 + 码，App 据此把 H3 三档藏起来（它本该先看 /api/ark/health 的 minimaxV2） */
function v2Off(res) {
  return res.status(501).json({ ok: false, code: "MINIMAX_V2_OFF", message: `这台服务器没有开 MiniMax H3 出片${NOT_BILLED}` });
}

/**
 * 上游受理回包里的任务号（字符串；官方是数字串）。拿不到能用的就是空串 —— 受理判据与记账都只认这一处。
 * ★ 也收「安全范围内的整数」：上游哪天把 task_id 写成数字，受理判据只认字符串的话就是「上游建了任务、我们当没受理把钱退了」，
 *   片子出来了没人取、钱也退了 —— 平台白付一发。超出安全整数的数字（精度已经丢了）不收：拼不回原来的任务号。
 */
function v2TaskIdOf(text) {
  let id;
  try {
    id = JSON.parse(text || "{}")?.task_id;
  } catch {
    return "";
  }
  const s = typeof id === "string" ? id : Number.isSafeInteger(id) && id >= 0 ? String(id) : "";
  return TASK_ID_RE.test(s) ? s : "";
}

/** 上游错误回包（OpenAI 风格 `{ type:"error", error:{ type, message:"… (2013)", http_code } }`）里的内部错误码：message 末尾括号里那串数字 */
function v2UpstreamCodeOf(text) {
  try {
    const msg = String(JSON.parse(text || "{}")?.error?.message ?? "");
    const m = /\((\d{3,6})\)\s*$/.exec(msg);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/**
 * 上游没受理（扣的钱 chargedArkCall 已经退回）→ 回给 App 的 `{ status, body }`。
 * ★ 状态码换成我们自己的（文件这一节开头的 ★★）：
 *   · 400（2013 参数不对）→ 400 UPSTREAM_PARAMS：多半是我们这边的白名单与上游没对齐，要人看（吼）；
 *   · 422（1026 / 1027 内容审核）→ 422 UPSTREAM_SENSITIVE：用户改提示词 / 换图能解决；
 *   · 429（1002 限流 / 1045 并发满）→ 503 UPSTREAM_BUSY：过一会儿再试（与我们自己的并发闸同一个码）；
 *   · 504（我们没等到上游回话，forward 折的）→ 504 UPSTREAM_TIMEOUT；
 *   · 其余（401 / 402 / 403 是我们的 key 或 MiniMax 账户的事、5xx / 529 是上游坏了、2xx 却读不出任务号）→ 502 UPSTREAM_ERROR，吼。
 * ⚠ 504 那一档钱退了、上游却可能已经建了任务（我们没等到它回话而已）：那一发平台白付 —— 与真人档、方舟的 504 同一个取舍，
 *   另一边是「上游没受理也扣钱」。
 */
function v2UpstreamRejection(status, text) {
  const upstream = { status, code: v2UpstreamCodeOf(text) };
  const body = (code, message) => ({ ok: false, code, message, billed: false, upstream });
  if (status === 400) return { status: 400, body: body("UPSTREAM_PARAMS", `MiniMax 说这一发的参数不对${REFUNDED}`) };
  if (status === 422) return { status: 422, body: body("UPSTREAM_SENSITIVE", `提示词或图片没过 MiniMax 的内容审核，请改一改再出片${REFUNDED}`) };
  if (status === 429) return { status: 503, body: body("UPSTREAM_BUSY", `MiniMax 那边同时在出的片太多了，请过一会儿再点${REFUNDED}`) };
  if (status === 504) return { status: 504, body: body("UPSTREAM_TIMEOUT", `没等到 MiniMax 回话${REFUNDED}`) };
  return { status: 502, body: body("UPSTREAM_ERROR", `MiniMax 那边出了问题，请稍后再试${REFUNDED}`) };
}

/**
 * POST /api/minimax/v2/video —— 建一段 H3 出片任务。转发 POST {国际站}/v2/video_generation。
 * 请求体：`{ model, resolution, duration, ratio?, content: [{ type:"text", text }, { type:"image_url", image_url:{ url }, role }…] }`
 *   —— 白名单与每一条的取值见 schemas/minimaxV2.schemas（名单外的键整句拒）。
 * 回包：200 `{ ok:true, task_id }`（带余额头）；我们在扣费之前拒的 400 VIDEO_PARAMS_NOT_ALLOWED / 501 MINIMAX_V2_OFF /
 *   403 REGION_UNAVAILABLE（门禁 on、这个地区不给；排在两道并发闸之前，见路由里预检那一段）/
 *   429 IN_FLIGHT_LIMIT（这个人同时在出的到顶）/ 503 UPSTREAM_BUSY（全站到顶）；钱上的拒绝（402 余额 / 403 套餐 / 429 日上限 …）与真人档同一套；
 *   上游没受理的见 v2UpstreamRejection。
 */
router.post("/v2/video", requireAuth, genLimit, async (req, res, next) => {
  const apiKey = minimaxKey();
  const base = minimaxV2Base();
  if (!apiKey || !base) return v2Off(res);

  // ── 计价参数在扣费**之前**钉死，而且只认重建出来的那一份（schemas 的 ★）──
  const parsed = parseV2CreateBody(req.body);
  const deny = (message) => res.status(400).json({ ok: false, code: "VIDEO_PARAMS_NOT_ALLOWED", message: `${message}${NOT_BILLED}` });
  if (!parsed.ok) return deny(parsed.message);
  const { body } = parsed;
  // 第二道：价目那边报不报得出价（字段名单 + 价钱只在 tokens.minimaxV2Tokens 一处判）。白名单过了它却报不出，
  // 是两处对不上 —— 要人看，并且照样不放（放过去 priceOf 会按最贵的一段兜底收）
  if (minimaxV2Tokens(body) === null) {
    console.error(`[minimax-v2] 白名单过了、价目却报不出价（两处对不上）：model=${body.model} resolution=${body.resolution} duration=${body.duration}`);
    return deny("这一发报不出价");
  }

  try {
    // ── 出片地区门禁预检：排在两道并发闸**之前**（2026-10-26 审核）──
    // ★ 门禁本身挂在 chargedArkCall 上，而并发闸排在它前面：不预检的话，门禁 on 时受全面制裁地区的请求
    //   在池子满的时候（全站 25 发在跑；或这个人在美国开了 4 发、再把 VPN 切到受制裁的地区）收到的是
    //   503「MiniMax 那边忙，过一会儿再点」/ 429「等其中一段出来再点」，而不是 403 REGION_UNAVAILABLE ——
    //   App 只在收到 REGION_UNAVAILABLE 之后才重探地区（app 仓 data/videoZone 的 noteRegionDenied），于是照旧摆着 H3 三档、叫人重试，
    //   而那个重试永远不会成。钱上没事（两条路都没扣），但违背 chargedArkCall 里那一段的规矩：别让真正的原因被另一句话盖住。
    // ★ 执行仍只在 arkGateway.regionGate 一处（off / observe / on 都由它定，回包形状与 chargedArkCall 被拦时逐字相同）；
    //   chargedArkCall 里那一发还会再过同一道门 —— 地区结论按 req 记着、与这里相同，observe 的 would-deny 也不重记。
    // ★ 钱包传 null（还没读）：H3 被拦时拒绝话恒为「一家都没有」那一句（videoRegion.swapVariant：被拦的本来就是 MiniMax），
    //   套餐不影响说哪一句。排在请求体白名单之后：与 chargedArkCall 里「在册 → … → 地区门禁」同一个次序（参数不对是我们自己的错，先说它）。
    const pre = regionGate({ req, user: req.user, kind: "minimax_v2", model: body.model, at: "(minimax)/v2/video_generation", wallet: null });
    if (pre) return res.status(pre.status).json(pre.body);

    // ── 并发闸（扣费之前）：先按人、再全站。两个数一起数完（一个 await），之后到占位为止都是同步的 ──
    const since = new Date(Date.now() - V2_INFLIGHT_WINDOW_MS);
    const uid = String(req.user._id);
    const [inFlight, mine] = await Promise.all([
      taskRefund.minimaxV2InFlight({ since }),
      taskRefund.minimaxV2InFlightOfUser({ since, user: req.user._id }),
    ]);
    // 按人那一道回**另一个码**（429 IN_FLIGHT_LIMIT）：说「全站都忙」的话，占满了自己份额的那个人会以为是别人的事、接着点
    if (mine + (v2CreatingBy.get(uid) || 0) >= V2_MAX_INFLIGHT_PER_USER) {
      console.warn(`[minimax-v2] 这个人同时在出的到顶（库里 ${mine} + 本进程在建 ${v2CreatingBy.get(uid) || 0} ≥ ${V2_MAX_INFLIGHT_PER_USER}），拒 user=${uid}`);
      res.setHeader("Retry-After", "30");
      return res.status(429).json({
        ok: false,
        code: "IN_FLIGHT_LIMIT",
        message: `你同时在出的 H3 视频已经有 ${V2_MAX_INFLIGHT_PER_USER} 段了（一个人最多 ${V2_MAX_INFLIGHT_PER_USER} 段），等其中一段出来再点${NOT_BILLED}`,
        limit: V2_MAX_INFLIGHT_PER_USER,
        billed: false,
      });
    }
    if (inFlight + v2Creating >= V2_MAX_INFLIGHT) {
      console.warn(`[minimax-v2] 全站并发到顶（库里 ${inFlight} + 本进程在建 ${v2Creating} ≥ ${V2_MAX_INFLIGHT}），拒 user=${req.user._id}`);
      res.setHeader("Retry-After", "30");
      return res.status(503).json({
        ok: false,
        code: "UPSTREAM_BUSY",
        message: `MiniMax 那边同时在出的片太多了，请过一会儿再点${NOT_BILLED}`,
        billed: false,
      });
    }
    // 数完立刻占一个位（两道各一个）。★ 从上面那个 await 回来到这里**不许再有 await**：同一进程里并发进来的请求靠这一段同步代码
    //   排成一队，后到的看得见前面占的位；中间插一个 await，两发就能同时挤进最后一个位（tests/minimaxV2.spec「同一进程里同时进来两发」钉着）
    v2Creating += 1;
    v2CreatingBy.set(uid, (v2CreatingBy.get(uid) || 0) + 1);
    try {
      const out = await chargedArkCall({
        user: req.user,
        // 在册 = 价目表里有它（schemas 已经拦过；chargedArkCall 自己还要问一遍，别让它成为唯一的一道）
        modelAllowed: (m) => Object.hasOwn(MINIMAX_SEC_COST, m),
        kind: "minimax_v2",
        path: "(minimax)/v2/video_generation",
        body,
        timeoutMs: T_CREATE,
        forward: async () => {
          // ★ 这里**不许抛**（与真人档同一条）：forward 在扣费之后执行，超时 / 断连折成 504 让「没受理就退」照常走
          try {
            const up = await fetch(`${base}/video_generation`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(T_CREATE),
            });
            return { status: up.status, text: (await up.text()) || "{}" };
          } catch (e) {
            console.error(`[minimax-v2] upstream video_generation ${String((e && e.name) || e)}`);
            return { status: 504, text: JSON.stringify({ message: `minimax upstream ${String((e && e.name) || "error")}` }) };
          }
        },
        // V2 用真的 HTTP 状态码：2xx 且回包里有能用的任务号才算受理（2xx 却读不出任务号 = 没法查询、没法取件，当没受理退钱）
        acceptedOf: (status, text) => status >= 200 && status < 300 && v2TaskIdOf(text) !== "",
        refundTag: "minimax_refund",
        // 出片地区门禁（arkGateway.regionGate）：H3 按「地区 + 站」判 —— 境内 / 海外都给国际站，受全面制裁的地区不给。
        // 上面并发闸之前已经预检过一次；这里照传 req（门禁挂在这一发上的那一处不能缺，tests/regionGate.spec 扫源码钉着）
        req,
      });

      if (!out.ok) {
        setWalletHeaders(res, out.wallet);
        return res.status(out.status).json(out.body);
      }
      if (!out.accepted) {
        const rej = v2UpstreamRejection(out.status, out.text);
        // 400 / 401 / 402 / 403 / 5xx 都要人看（参数没对齐、key 或账户出了事、上游坏了）；422 / 429 是用户与流量的事，记一行 warn
        const log = rej.status === 422 || rej.status === 503 ? console.warn : console.error;
        log(`[minimax-v2] 上游没受理 ${out.status}（${rej.body.upstream.code || "-"}）→ ${rej.status} ${rej.body.code} user=${req.user._id}`);
        if (rej.status === 503) res.setHeader("Retry-After", "30");
        setWalletHeaders(res, out.wallet);
        return res.status(rej.status).json(rej.body);
      }

      // ★★ 记账（services/taskRefund）：H3 之后报 failed / cancelled 时按扣的那两桶退回。带上**站**与 **api: "v2"** ——
      //   结局怎么认、清扫器去哪个端点问都按它分（GenTaskCharge.api 的 ★★）。kind 记 video（GenTaskCharge.KINDS 的 ★）。记账只吼不抛。
      const taskId = v2TaskIdOf(out.text);
      await taskRefund.recordCharge({
        provider: "minimax",
        api: "v2",
        taskId,
        kind: "video",
        user: req.user._id,
        model: body.model,
        cost: out.cost,
        free: out.free,
        took: out.took,
        memo: out.memo,
        region: minimaxRegion(),
      });
      // ★★ 再登记一条给 App 重启之后取回用（models/ArkVideoTask 的 ★★；GET /api/minimax/video-tasks 列它）。
      //   与上面记账是两件事：账只管钱、登记管「找得回来」。只吼不抛（任务已受理、钱已扣）
      //   costTokens 是这一发**实扣**的数：管理员免单记 0（与方舟那张登记表同一条，ark.routes 的 billedForward）——
      //   记 out.cost 的话，取回列表对一发没扣过钱的任务说「花了 N」（2026-10-26 文档审核）
      await arkVideoTask.recordMinimaxV2Task({ userId: req.user._id, body, taskId, costTokens: out.free ? 0 : out.cost });
      setWalletHeaders(res, out.wallet);
      return res.status(200).json({ ok: true, task_id: taskId });
    } finally {
      v2Creating -= 1;
      const left = (v2CreatingBy.get(uid) || 1) - 1;
      if (left > 0) v2CreatingBy.set(uid, left);
      else v2CreatingBy.delete(uid);
    }
  } catch (err) {
    return next(err);
  }
});

/** 同一个没有账的任务号每个进程只吼一次（App 每 5 秒问一次，不然一发就刷几十行） */
const unrecordedSeen = new Set();
const UNRECORDED_SEEN_MAX = 500;

/** H3 查询回包里给 App 的那几样（数都过一遍：上游给什么就原样转出去的话，一个奇怪的值就成了 App 的事） */
function v2UsageOf(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const out = {};
  for (const k of ["total_seconds", "input_seconds", "output_seconds", "input_image_count"]) {
    if (Number.isFinite(usage[k])) out[k] = usage[k];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 成片那一刻对一下账：上游按几秒计费（usage.total_seconds × 这一格的每秒价）与我们实扣的是不是同一个数。**只吼不拦**。
 * ★ 为什么要有：价钱是按**请求体里的** duration 收的（tokens.minimaxV2Tokens），上游按它自己记下的秒数收我们的钱 ——
 *   两边对不上（上游从提示词里读出了别的时长、改了计费口径）没有任何别的症状，只会出现在月底的账单上。
 *   2026-10-26 付费小验 5 发都对得上（成片比请求长 0.2~0.5 秒，usage 按请求的整数秒记）。
 */
function v2ReconcileCharge(row, task) {
  if (!row || row.free || !(row.charged > 0)) return;
  const perSec = minimaxSecCost(row.model, task.resolution);
  const sec = task?.usage?.total_seconds;
  if (perSec === null || !Number.isInteger(sec)) {
    console.error(`[minimax-v2] 对不了账 task=${row.taskId}：上游回 resolution=${logSafe(task.resolution, 16)} total_seconds=${logSafe(sec, 16)}（model=${row.model}，我们收了 ${row.charged}）`);
    return;
  }
  if (sec * perSec !== row.charged) {
    console.error(`[minimax-v2] 计费对不上 task=${row.taskId}：上游按 ${sec} 秒计（应收 ${sec * perSec}），我们收了 ${row.charged}（model=${row.model}）`);
  }
}

/**
 * GET /api/minimax/v2/video/:taskId —— 查一发 H3 任务。转发 GET {国际站}/v2/query/video_generation/{task_id}，**不计费**。
 * 回包（200）：`{ ok:true, taskId, status, url?, usage?, duration?, ratio?, resolution?, error?, refund? }` ——
 *   status 是上游原样（queued / running / succeeded / failed / cancelled）；succeeded 才有 url（成片地址，**有时效**，拿到就转存：
 *   POST /api/ark/transfer-video 认这个主机）与 usage；failed / cancelled 有 error（上游的码与原话）。
 *   refund 只在失败、而且问的是**账的主人**时带（同真人档：`{ state, tokens }`，带余额头）。
 * 不是 200 的：404 TASK_NOT_FOUND（不是你的 / 不是 H3 的 / MiniMax 那边查不到 —— 超过 7 天或从没有过）、503 UPSTREAM_BUSY、
 *   504 UPSTREAM_TIMEOUT、502 UPSTREAM_ERROR —— 都**不是结局**（没问到 ≠ 失败），App 接着问或按「没接到」处理，钱不动。
 *
 * ★ 只给任务的主人看（与真人档、方舟的轮询不同，2026-10-26）：H3 的任务号是十几位、几乎连号的数字，挨个猜就能拿到别人的成片地址。
 *   判据先看我们自己的账（GenTaskCharge：受理那一拍就落）：账上有 H3 的那一行 → 只给那一行的主人（管理员例外），别人 404（不说有没有）。
 *   **账上没有 H3 的那一行**时看取回登记（ArkVideoTask：受理那一拍也记一条）：登记是这个人的才放行，并吼一声（这一发失败了退不了钱）。
 *   两样都没有 → 404（管理员例外）。2026-10-26 终审改的：原来没有账就一律放行 —— 删号级联（branchAdmin.purgeUserCascade）
 *   把账与登记一起删掉之后，那个人的 H3 任务在上游还查得到 7 天，挨个猜号就拿得到成片地址。
 *   放行登记那一支是为了「落账失败、登记落上了」的那个主人自己还取得回成片；「账上那一行是同号的真人档 / 切站之前的老账」也走这一支
 *   （任务号撞上了：落账时已经吼过，见 taskRefund.recordCharge）—— 真正的主人照样取得回，只是这一发失败了退不了钱。
 * ★ 失败退款的挂点同真人档：上游**明说** failed / cancelled → taskRefund.settleTask（api:"v2"，只结国际站建的 H3 账）。
 */
router.get("/v2/video/:taskId", requireAuth, pollLimit, async (req, res, next) => {
  const apiKey = minimaxKey();
  const base = minimaxV2Base();
  if (!apiKey || !base) return v2Off(res);
  const taskId = String(req.params.taskId);
  if (!TASK_ID_RE.test(taskId)) return res.status(400).json({ ok: false, message: "bad task id" });
  const notFound = () =>
    res.status(404).json({ ok: false, code: "TASK_NOT_FOUND", message: "查不到这一发 H3 任务（不是你的，或者已经超过 7 天）" });

  try {
    const found = await taskRefund.chargeByTask("minimax", taskId);
    // 账上 H3 的那一行。同号的真人档 / 中国站老账不是这一发的账：不拿它判归属、不拿它对账（往下都只用 row）
    const row = found?.api === "v2" ? found : null;
    const admin = isAdmin(req.user);
    if (row) {
      if (String(row.user) !== String(req.user._id) && !admin) return notFound();
    } else if (!admin && !(await arkVideoTask.ownsMinimaxV2Task(taskId, req.user._id))) {
      return notFound();
    }
    if (!row && !unrecordedSeen.has(taskId) && unrecordedSeen.size < UNRECORDED_SEEN_MAX) {
      unrecordedSeen.add(taskId);
      console.warn(`[minimax-v2] task=${taskId} 没有 H3 的账（落账失败过，或任务号撞上了同号的老账）：照常查询，失败也退不了钱 user=${req.user._id}`);
    }

    let status;
    let text;
    try {
      const up = await fetch(`${base}/query/video_generation/${taskId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(T_POLL),
      });
      status = up.status;
      text = (await up.text()) || "{}";
    } catch (e) {
      console.error(`[minimax-v2] upstream query ${String((e && e.name) || e)}`);
      return res.status(504).json({ ok: false, code: "UPSTREAM_TIMEOUT", message: "没等到 MiniMax 回话，过一会儿再查" });
    }
    if (status !== 200) {
      // 400 = 查无此任务（官方：只能查 7 天内的，窗口外回 invalid task_id）。别的同建任务那一节（401 / 402 别原样回给 App）
      if (status === 400) return notFound();
      const upstream = { status, code: v2UpstreamCodeOf(text) };
      if (status === 429) return res.status(503).json({ ok: false, code: "UPSTREAM_BUSY", message: "MiniMax 那边忙，过一会儿再查", upstream });
      console.error(`[minimax-v2] 查询 task=${taskId} 上游 ${status}（${upstream.code || "-"}）`);
      return res.status(502).json({ ok: false, code: "UPSTREAM_ERROR", message: "MiniMax 那边出了问题，过一会儿再查", upstream });
    }
    let task;
    try {
      task = JSON.parse(text)?.task;
    } catch {
      task = null;
    }
    if (!task || typeof task !== "object" || typeof task.status !== "string") {
      console.error(`[minimax-v2] 查询 task=${taskId} 回包读不懂`);
      return res.status(502).json({ ok: false, code: "UPSTREAM_ERROR", message: "MiniMax 的回话读不懂，过一会儿再查" });
    }

    const view = { ok: true, taskId, status: task.status.slice(0, 32) };
    if (Number.isInteger(task.duration)) view.duration = task.duration;
    if (typeof task.ratio === "string" && task.ratio) view.ratio = task.ratio.slice(0, 16);
    if (typeof task.resolution === "string" && task.resolution) view.resolution = task.resolution.slice(0, 16);
    const verdict = taskRefund.verdictOf("minimax", task.status, "v2");
    if (verdict === "succeeded") {
      const url = typeof task?.content?.url === "string" ? task.content.url : "";
      if (/^https:\/\//i.test(url)) {
        view.url = url;
        // 落点换了主机：转存与产物代理都只认 config/minimax 那一个，不吼的话成片过期了才有人发现
        if (!isMinimaxV2VideoUrl(url)) console.warn(`[minimax-v2] task=${taskId} 的成片不在认得的主机上，转存会被拒：${logSafe(url, 120)}`);
      } else {
        console.error(`[minimax-v2] task=${taskId} 上游说出成了、却没给能用的地址`);
      }
      const usage = v2UsageOf(task.usage);
      if (usage) view.usage = usage;
      // 第一次看见成片（账还是 open）时对一下账
      if (row && row.state === "open") v2ReconcileCharge(row, task);
    } else if (verdict === "failed") {
      view.error = { code: String(task?.error?.code ?? "").slice(0, 16), message: String(task?.error?.message ?? "").slice(0, 300) };
    }

    // ★★ 失败退款的挂点（services/taskRefund）：上游**明说** failed / cancelled → 按原桶退给账的主人（恰好一次）。
    //   region 是**此刻配的那个站**（上面 fetch 的 base 就是它），settleTask 只结那个站、那一版接口建的账。
    //   结账出错只吼不挡：这一拍照样把上游的话回出去，账还是 open，清扫器接着办。
    if (verdict) {
      try {
        const settled = await taskRefund.settleTask({
          provider: "minimax",
          api: "v2",
          taskId,
          status: task.status,
          code: task?.error?.code,
          viewerId: req.user._id,
          region: minimaxRegion(),
        });
        if (verdict === "failed" && settled && String(settled.user) === String(req.user._id)) {
          view.refund = taskRefund.refundView(settled);
          setWalletHeaders(res, await wallet.getWallet(req.user._id));
        }
      } catch (e) {
        console.error(`[minimax-v2] 失败退款的结账没办成 task=${taskId}（清扫器会接着办）:`, e.message);
      }
    }
    return res.json(view);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/minimax/video-tasks —— 这个账号最近 24 小时提交过的 MiniMax 视频任务（服务端登记，models/ArkVideoTask 的 ★★）。
 * 回包：`{ ok: true, tasks: [{ taskId, api: "v2", createdAt, model, durationSec, ratio, resolution, prompt, costTokens? }] }`
 *   （新的在前、最多 50 条；已经因为失败退了钱的不列）。App 冷启动拿它把本机不认识的任务补成「待取回」凭据，
 *   取回走 GET /v2/video/:taskId（不计费）。**认不得的 api 要跳过**：真人档（v1）以后也会登记进来（P3），取件是另一条路。
 * ★ 为什么要有它（2026-10-26 审核）：出片按地区下发之后海外的普通出片全走 H3，而 H3 原来只有账（GenTaskCharge）、没有登记 ——
 *   App 被杀两次那一发就再也找不回来，最后被清扫器结成 settled（照收钱）。与 GET /api/ark/video-tasks 同一个理由、同一个形状。
 * ★ V2 没开（走中国站 / 没配 key）时回空表：列出来 App 就去问 /v2/video/:taskId，只会拿回 501（任务绑站）。
 * ★ 不计费、走轮询那个限流桶（冷启动一次、进创作入口一次，与方舟那张表同一量级）；只读库，不替你去问上游。
 */
router.get("/video-tasks", requireAuth, pollLimit, async (req, res, next) => {
  try {
    res.json({ ok: true, tasks: await arkVideoTask.listMinimaxVideoTasks(req.user._id, { v2On: minimaxV2Enabled() }) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
