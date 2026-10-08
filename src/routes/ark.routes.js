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
 *   开成通用代理的话，任何登录用户都能拿我们的 key 调方舟的任意模型，账单直接爆
 *   （最贵的一档 seedance-2.5 是 70 元/M，标准档的 4.7 倍；它现在**在册**，
 *    但另有一道免费档门禁挡着没付过钱的用户，见 billedForward）。
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
// 方舟成片 → 永久地址：域名表/上限/拉取/上传只有这一份实现（发布时的转存也用它）
const videoAsset = require("../services/videoAsset.service");
// 转存的后台任务化（认领/去重/执行/查询）：轮询自动转存与 /transfer-video 两个入口共用
const arkTransfer = require("../services/arkTransfer.service");
const {
  SEEDANCE_2_5,
  IMAGE_MODELS,
  VIDEO_MULT,
  VIDEO_MULT_R2V,
  VIDEO_RESOLUTIONS,
  VIDEO_PIXELS,
  DRAFT_RESOLUTION,
  DRAFT_FINAL_RESOLUTION,
  audioSupported,
  videoSecWindow,
  retiredDenial,
  freeVideoTiers,
  freeVideoGateOn,
} = require("../config/tokens");
// 白模模板：r2v 结算按参考视频 URL 反查登记（resolveR2v），试炼闸靠任务追踪（noteR2vOutcome）
const BranchTemplate = require("../models/BranchTemplate");
const arkVideoTask = require("../services/arkVideoTask.service");
// 受理之后失败的退款（2026-10-07）：受理时记账（billedForward）、轮询看见终态时结账 —— 唯一实现在那个文件里
const taskRefund = require("../services/taskRefund.service");
// 组图（一次出一组关联的图）：按上限预扣、后台画、按拿到手的张数结算（见那个文件头的 ★★）
const imageGroups = require("../services/arkImageGroup.service");
const MaterialRefVideo = require("../models/MaterialRefVideo");
const BranchTemplateTrial = require("../models/BranchTemplateTrial");
const { cloudinary } = require("../config/cloudinary");
// 归属与「裁剪变换 URL」的形状判据只有一处（铁律六）
const { parseOwnClipUrl } = require("../utils/templateVideoAsset");
// 「本人成片」的归属与形状判据只有一处：服务端合并成片认段落归属用的同一个函数（铁律六）
const { parseOwnBranchVideoUrl } = require("../utils/videoCompose");
const SegmentRefVideo = require("../models/SegmentRefVideo");
const {
  templateVideoMeta,
  templateRefDurationIssue,
  // ★ 分支二判的是**白模化的输入**（下限 5），不是参考视频窗口（下限 4）——
  //   两处差一秒就等于留了一条绕行路：老客户端可以从 /api/ark 这条路把 4 秒的白模化发出去
  blockoutInputIssue,
  secText,
  TEMPLATE_REF_RULES,
  // 分支四（本人成片）的窗口 = 方舟参考视频那一套（4~30 秒、边长、画幅、像素下限）
  templateRefIssue,
} = require("../middleware/upload");
// ★★ 「扣钱 → 转发 → 没受理就退」这条序列的唯一实现在 services/arkGateway ——
//   白模化端点（routes/branchTemplate）自己也要发方舟请求，两处各写一遍就是两套记账。
const { callArk, chargedArkCall, arkConfigured, setWalletHeaders, T_CREATE, T_POLL } = require("../services/arkGateway.service");
const wallet = require("../services/tokenWallet.service");

const router = express.Router();

/**
 * 允许调用的模型白名单。**与 app 仓 src/ai/arkClient.ts 的 MODELS、
 * src/data/economy.ts 的 VIDEO_TIERS 与 IMAGE_TIERS 一一对应**——App 新增一个档位，
 * 就要在这里补一行（出图那几行由价目表自动带出，见下），
 * 这是刻意的：每加一个模型都是一笔新的单价，应该有人明确点头。
 */
const ALLOWED_MODELS = new Set([
  // Seedream 出图（卡面 / 首尾帧 / AI 封面）。★ 这一段**不写字面量**，直接摊开价目表的
  // key：出图的「在册」与「有价」必须是同一件事（见 config/tokens.js 的 IMAGE_MODELS）。
  // 分成两张手写的表，两种漏法都不报错——在册没定价 = 按最贵档兜底多扣用户的钱，
  // 定价没在册 = 这一档永远 400，用户只会觉得"这档坏了"。
  ...IMAGE_MODELS,
  "doubao-seedance-1-0-pro-250528",    // Seedance 标准档（首尾帧）
  "doubao-seedance-1-0-pro-fast-251015", // Seedance 极速档（只收首帧）
  "doubao-seedance-2-0-mini-260615",   // Seedance 高清档（需控制台开通）
  // Seedance 2.5「电影级」档。70 元/M，是标准档的 4.7 倍 —— 全站最贵的一次调用
  // （10 秒一段 ≈ 1,015,200 token）。所以它在白名单之外还有**第二道门**：
  // 没付过钱的用户一律拒（判据在 config/tokens.videoPlanDenial，执行在 services/arkGateway）。
  SEEDANCE_2_5,
  "doubao-seed-2-1-turbo-260628",      // 豆包对话 / 看图说话
  "doubao-seed3d-2-0-260328",          // Seed3D 图生 3D
]);

/** 方舟任务 id 的字符集。直接拼进上游 URL 的东西一律先收口（铁律六的同一条口径） */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 产物代理的单文件上限。Seed3D 的 zip 实测 36MB 级，视频 5-10MB。 */
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

/** 方舟产物只在这两个域。允许任意域就等于开了一个公开的下载代理。 */
// ★ 第二条是 MiniMax（真人档）出片视频的落点（2026-08-24 实测：
//   public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com）。收口到
//   public-cdn-video-data* 前缀的阿里 OSS，不放开整个 aliyuncs.com——那是把
//   任意人的 OSS 桶都变成我们代理的开放跳板。
const ASSET_HOST_RE = /(^|\.)(volces|volccdn)\.com$|^public-cdn-video-data[\w-]*\.oss-cn-[\w-]+\.aliyuncs\.com$/i;

/**
 * GET /api/ark/health —— 只回"这台服务器配没配 key"，不泄露 key 本身。
 * 与 /api/tts/health 同口径：部署自检与人工 curl 用它判断"AI 到底通不通"，
 * 不必去翻日志猜。
 */
router.get("/health", (_req, res) => {
  // imageGroups：这台服务器有没有 /image-groups（组图任务）。App 据此决定「九宫格分镜」能不能用 ——
  // 判断「有没有这个能力」只看能力位，不看状态码（Capacitor 的 SPA 回退见文件头）
  // 2026-10-07 的四个能力位（老服务端一个都没有 —— App 见不到就把对应的东西藏起来）：
  //   · res480：纯任务收 480p（「草稿」档）。老服务端对 480p 整句 400「出片目前只支持 720p」；
  //   · draftMode：电影级「样片」两步（draft:true 的第一步 + content 里只有一条 draft_task 的第二步）；
  //   · failRefund：受理之后**方舟**报 failed / cancelled / expired 的任务会退钱（无条件，没有开关）；
  //   · freeVideo：免费档门禁开着时，免费版能出普通片的档（停用的自动出局）。App 置灰照它（读不到 = 老服务端，按自己档位表的 freeOk），
  //     判据仍在服务端（config/tokens.videoPlanDenial）—— 客户端置灰只是提示。
  // 2026-10-07 评审补的两个**运维开关的现状**（老服务端没有 = 当成开着）：
  //   · freeVideoGate：FREE_VIDEO_GATE 开没开。false = 服务端不按 freeVideo 拦，退回改版前只挡电影级的口径；
  //     App 读到 false 要跟着放开置灰 —— 不报这一位的话，关闸只放开了服务端，App 照旧把标准 / 高清画成会员档，开关形同虚设。
  //   · minimaxFailRefund：MINIMAX_FAIL_REFUND 开没开。false = 真人档（MiniMax）受理之后的失败**不退**（账留着，开关打开后接着退），
  //     App 对真人档说「会自动退回」之前要看这一位，不能只看 failRefund（那一位只说方舟）。
  res.json({
    ok: true,
    ark: arkConfigured(),
    imageGroups: true,
    res480: true,
    draftMode: true,
    failRefund: true,
    freeVideo: freeVideoTiers().map(({ label, model, resolution }) => ({ label, model, resolution })),
    freeVideoGate: freeVideoGateOn(),
    minimaxFailRefund: taskRefund.minimaxRefundOn(),
  });
});

// setWalletHeaders 2026-08-24 迁到 arkGateway.service（minimax 路由也要写同一对头，
// 响应头协议只留一份实现）——这里只是引用。

/**
 * 计费转发：**先扣钱，再转发；上游没受理就退回来**（W2）。
 *
 * ★ 顺序不能反。先转发再扣钱的话，余额不足的请求已经花掉了钱，扣不扣都晚了；
 *   而"先查余额、转发、再扣"更糟——查和扣之间的窗口正是并发双花的入口。
 *   所以这里是"条件原子扣减成功 = 拿到了这次调用的许可"。
 *
 * ★ 只有**创建类**请求计费。轮询任务状态与取产物不计费：它们既不产生算力消耗，
 *   又高频（一段视频轮询上百次），按次收会把一段片的价格翻好几倍。
 *
 * ★ 三道判断的顺序是有讲究的：**在册 → 套餐够不够格 → 钱够不够**。
 *   套餐门禁必须排在扣费**之前**：排在后面的话，免费用户点一次 2.5 会先被扣掉
 *   一百万 token（大概率直接 402），错误信息还是"余额不足"——真正的原因
 *   （这一档不对你开放）被彻底盖住，用户会去充值，然后再被拒一次。
 *
 * ★★ 管理员免单，但**照实记一笔流水**（见下面的 free 分支）。
 *   跳过的是"钱"的那两道（套餐门禁 + 扣费），**没跳过**的是：
 *     · 模型白名单 —— 在册与否是"这个模型我们认不认、有没有定价"，与谁在调无关；
 *       管理员也不该能点名一个我们从没估过价的模型。
 *     · 限流（aiRateLimit）—— 管理员账号被盗、或者自己写了个循环，
 *       在这条路上就是直接往火山账单上打洞。免单免的是我们内部的记账，
 *       不是外面那张账单。
 */
function billedForward(kind, path, timeoutMs) {
  return async (req, res, next) => {
    try {
      // ★★ 整段"钱"的判断（在册 → 套餐门禁 → 原子扣费 → 转发 → 没受理就退 → 管理员免单
      //   照实记账）都在 services/arkGateway.chargedArkCall 里 —— **只有那一份实现**。
      //   白模化端点（POST /api/branch/templates/blockoutize）服务端自己发方舟请求时
      //   走的也是它；在这里再抄一遍的话，两套记账迟早分叉，而分叉的表现是
      //   「月底账单对不上，且查不出是哪个口子漏的」，零症状。
      const out = await chargedArkCall({
        user: req.user,
        // 在册白名单是本路由的数据（"这个模型我们认不认"），不搬进服务层
        modelAllowed: (m) => ALLOWED_MODELS.has(m),
        kind,
        path,
        body: req.body,
        // req.r2v 由 resolveR2v 挂上（只有任务端点有它）：白模出片按登记时长换公式计价
        r2v: req.r2v ?? null,
        // req.draftFinal 由 resolveDraftFinal 挂上：样片第二步按样片的登记时长 × 1080p 计价
        draftFinal: req.draftFinal ?? null,
        timeoutMs,
      });

      if (!out.ok) {
        // model 那一路刻意不带钱包头（一分钱没动）；plan/funds 两路带 before 的余额
        setWalletHeaders(res, out.wallet);
        return res.status(out.status).json(out.body);
      }

      // r2v 任务被受理 → 落一条试炼追踪 { taskId, templateId, userId }（TTL 48h）。
      // 轮询看到 succeeded 且发起人就是模板作者时，靠它置 provenAt（发布的前置）——
      // 服务端两头都自己看见了，不用信客户端一句「我跑通了」。
      // ★ 只有**命中已登记模板**那一路才有试炼可言：resolveR2v 的第二条分支
      //   （本账号刚传、尚未登记的素材）根本还没有模板，templateId 是 null ——
      //   拿 null 去 create 会抛 ValidationError，而那时任务已受理、钱已扣。
      // ★ 落库失败不打断响应（任务已受理、钱已扣，此时 5xx 会让客户端误以为没受理去重试），
      //   但必须吼：追踪丢了 = 作者这一发试炼白跑，他会看到"出片成功却还是不能发布"。
      // ★★ 视频任务受理即在服务端记一条（models/ArkVideoTask 的 ★★）：客户端那份凭据只在 localStorage，
      //   App 被重启两次就可能把一发已经付过钱的成片弄丢；有了这条，冷启动 GET /video-tasks 就能补回凭据。
      // ★ 样片第一步（draft:true）记下来还有第二个用途：第二步只认「本人、经我们这里出的样片」，归属与时长都从这条读
      //   （见 resolveDraftFinal）。costTokens 是这一发实扣的数（管理员免单记 0）。
      if (out.accepted && kind === "task") {
        await arkVideoTask.recordVideoTask({
          userId: req.user._id,
          body: req.body,
          responseText: out.text,
          r2v: req.r2v ?? null,
          draftFinal: req.draftFinal ?? null,
          costTokens: out.free ? 0 : out.cost,
        });
        // ★★ 记账（services/taskRefund）：这一发扣了多少、从哪两桶扣的、是不是免单 —— 方舟之后明说失败 / 取消 / 过期时
        //   按它原样退回。每一发受理了的任务都记（Seedance 普通出片、r2v、样片两步、Seed3D）；记账只吼不抛
        //   （此刻钱已扣、任务已受理，5xx 会让客户端以为没受理去重试 = 再花一次钱）。
        //   样片两步各记各的：两笔独立的钱，第二步失败只退第二步。
        let taskId = "";
        try {
          taskId = String(JSON.parse(out.text || "{}")?.id || "");
        } catch {
          /* 回包读不出任务号：recordCharge 自己会吼 */
        }
        const model = String(req.body?.model ?? "");
        await taskRefund.recordCharge({
          provider: "ark",
          taskId,
          kind: req.draftFinal ? "draftFinal" : req.body?.draft === true ? "draft" : Object.hasOwn(VIDEO_MULT, model) ? "video" : "3d",
          user: req.user._id,
          model,
          cost: out.cost,
          free: out.free,
          took: out.took,
          memo: out.memo,
        });
      }
      if (out.accepted && req.r2v?.templateId) {
        try {
          const parsed = JSON.parse(out.text || "{}");
          const taskId = String(parsed?.id || "");
          if (TASK_ID_RE.test(taskId)) {
            await BranchTemplateTrial.create({
              taskId,
              templateId: req.r2v.templateId,
              userId: req.user._id,
              // 这一发用的出片模型：试炼成功时记进模板的 provenModels（事实底账，见 BranchTemplate.provenModels）。
              // 走到这里它已过 ALLOWED_MODELS 与 r2v 价目表两道闸，不是任意字符串
              model: String(req.body?.model ?? "").slice(0, 80),
            });
          } else {
            console.error(`[ark] r2v 任务受理但响应里没有可用的任务 id（tpl:${req.r2v.templateId}）`);
          }
        } catch (e) {
          console.error(`[ark] r2v 试炼追踪落库失败 tpl:${req.r2v.templateId}:`, e.message);
        }
      }

      setWalletHeaders(res, out.wallet);
      // 原样透传状态码与 JSON：App 侧对 429（限流退避）与 400（敏感词，不该重试）
      // 有不同的处理，聚合成 502 会把这个区分抹掉。
      return res.status(out.status).type("application/json").send(out.text || "{}");
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

/**
 * 单张出图这条路**只出一张**：一次出多张的参数整句拒（2026-10-05）。
 *
 * ★★ 为什么：方舟同一个出图端点上有两种「一次出好几张」的开关，都按**实际画出的张数**计费 ——
 *   `sequential_image_generation: "auto"`（组图，缺省最多 15 张）与 `layer_decomposition: true`（5.0 pro，1 张底图 + 最多 16 个图层）；
 *   而这条代理是**按调用**收一张的钱、请求体原样转发。在这道闸之前，带上那个开关就能用一张的钱换十几张，
 *   零症状，只有火山账单知道。组图走 POST /image-groups（按上限预扣、按实际张数结算）。
 * ★ `stream` 也拒：流式回的是 SSE，billedForward 只认一次性的 JSON；`tools`（联网搜索）另有用量、App 从没发过。
 * ★ 判「不是缺省值就拒」，不判「等于某个值才拒」：`"auto "` / `1` 这类写法方舟认不认没人测过，宁可整句拒。
 *   App 从来只发 model / prompt / image / size / response_format / watermark（git 史核过），一个字都不拦它。
 */
function pinSingleImage(req, res, next) {
  const b = req.body || {};
  const many =
    (b.sequential_image_generation !== undefined && b.sequential_image_generation !== "disabled") ||
    (b.layer_decomposition !== undefined && b.layer_decomposition !== false) ||
    (b.stream !== undefined && b.stream !== false) ||
    (b.n !== undefined && b.n !== 1) ||
    (b.tools !== undefined && !(Array.isArray(b.tools) && b.tools.length === 0));
  if (many) {
    return res.status(400).json({
      ok: false,
      code: "IMAGE_PARAMS_NOT_ALLOWED",
      message: "这条路一次只出一张图（组图请走 /api/ark/image-groups）——当前请求未被受理，也没有扣费。",
    });
  }
  return next();
}

/** Seedream 出图。★ **按 body.model 计价**（三档差 3 倍：13,333 / 16,667 / 40,000），
 *  不是一口价——写成常量就是"顶档按最低档收费"，零症状白送。见 config/tokens.imageTokensOf */
router.post("/images/generations", requireAuth, genLimit, pinSingleImage, billedForward("image", "/images/generations", T_CREATE));

/**
 * 组图：POST 受理（202 + 任务号，按「单价 × max_images」预扣）→ 后台画 → GET 短轮询（每画好一张就多一张）。
 * 结束时按**拿到手的张数**结算，多扣的退回（services/arkImageGroup）。契约见 docs/api-contract.md「组图」。
 * ★ 受理走 genLimit（会花钱），查询走 pollLimit（不花钱、高频）—— 与视频任务的分法一样。
 */
router.post("/image-groups", requireAuth, genLimit, async (req, res, next) => {
  try {
    const out = await imageGroups.startImageGroup({ user: req.user, body: req.body });
    setWalletHeaders(res, out.wallet);
    return res.status(out.status).json(out.body);
  } catch (err) {
    return next(err);
  }
});

router.get("/image-groups", requireAuth, pollLimit, async (req, res, next) => {
  try {
    return res.json({ ok: true, groups: await imageGroups.listImageGroups({ user: req.user }) });
  } catch (err) {
    return next(err);
  }
});

router.get("/image-groups/:id", requireAuth, pollLimit, async (req, res, next) => {
  try {
    const group = await imageGroups.getImageGroup({ user: req.user, id: req.params.id });
    if (!group) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "没有这一组（或已过期）" });
    // 结束了才带余额头：退款发生在后台，App 的钱包镜像要靠这一趟同步（running 时余额没变，省一次读）
    if (group.status !== "running") setWalletHeaders(res, await wallet.getWallet(req.user._id));
    return res.json({ ok: true, group });
  } catch (err) {
    return next(err);
  }
});

/**
 * 参考视频生视频（r2v，白模模板）的解析闸门 —— **只准已登记模板的 URL**。
 * （前身是一律 400 的 rejectReferenceVideo：计价能力就位前的临时钉子，2026-08-14 换成本实现。）
 *
 * ★★ 为什么必须收窄到注册表：r2v 的官方计费公式是
 *   **(输入视频时长 + 输出时长)×宽×高×帧率/1024** —— 输入视频的时长计进 token，
 *   而「输入多长」只能有一个可信来源：服务端建模板时自己从 Cloudinary 登记的
 *   durationSec（models/BranchTemplate.refVideo）。放任意 URL 的话输入时长没有可信
 *   来源，要么信客户端报数（等于让用户自己标价）、要么按纯任务价结算（输入一分不收）。
 *   代价是封死了「拿任意视频二创」这类非模板 r2v —— 有意的范围取舍，放开前必须先
 *   解决输入时长的可信来源。
 * ★ 查不到 / 模型不在 R2V 价目表 → 400 整句拒，**绝不静默按纯任务系数（4.7）结算**。
 *   伪造一个"像模像样"的假 URL 也蹭不到 2.8 的价：查不到登记直接 400，根本到不了扣费。
 * ★ 400 而不是静默剥掉那个条目：剥掉的话任务照跑、产出却是一段没有参考视频的
 *   无关视频，钱照收 —— 那是偷换商品（铁律八）。
 * ★ 「这个请求是不是 r2v」只在这里判一次，结论挂在 req.r2v 上 ——
 *   billedForward 的计价、memo、试炼追踪都只消费这个结论（铁律六）。
 */
/**
 * 分支四用：本人成片的时长与尺寸 —— 先读缓存（models/SegmentRefVideo，一天），没有再问 Cloudinary Admin API 并记下。
 * @returns {{durationSec:number,width:number,height:number}|{issue:string}|{status:502}}
 * ★ 窗口与白模模板视频同一把尺（middleware/upload.templateRefIssue：4~30 秒、边长、画幅、像素下限）——
 *   那就是方舟编辑任务的输入窗口；延长的输入下限官方是 2 秒，我们的成片最短 4 秒，统一按 4 不会误伤。
 * ★ 404 当「没有这段视频」说（还没转存完 / 已被回收）；其余读取失败回 502、不扣钱（同分支二）。
 */
async function ownSegmentMeta(publicId, userId) {
  const hit = await SegmentRefVideo.findOne({ publicId }).select("durationSec width height").lean();
  let meta = hit ? { duration: hit.durationSec, width: hit.width, height: hit.height } : null;
  if (!meta) {
    let resource;
    try {
      resource = await cloudinary.api.resource(publicId, { resource_type: "video", media_metadata: true });
    } catch (e) {
      const http = e?.error?.http_code ?? e?.http_code;
      if (http === 404) return { issue: "找不到这一段成片（可能还没转存完，或已经被回收）" };
      console.error(`[ark] 本人成片详情读取失败 public_id=${publicId}:`, e?.error?.message || e.message);
      return { status: 502 };
    }
    meta = templateVideoMeta(resource);
  }
  const issue = templateRefIssue(meta, "这一段成片");
  if (issue) return { issue };
  if (!hit) {
    // 缓存写不进去不挡这一发（时长已经拿到了），但要吼：长期写不进去 = 每一发都在烧全局的 Admin API 配额
    await SegmentRefVideo.updateOne(
      { publicId },
      { $set: { userId, durationSec: meta.duration, width: meta.width, height: meta.height } },
      { upsert: true },
    ).catch((e) => console.error(`[ark] 本人成片时长缓存写入失败 public_id=${publicId}:`, e.message));
  }
  return { durationSec: meta.duration, width: meta.width, height: meta.height };
}

async function resolveR2v(req, res, next) {
  try {
    const content = req.body?.content;
    // ★★ 「是不是 r2v」按**形状**判（type 或 video_url 键任一命中），不按 role 判 ——
    //   role 是客户端完全可控的字符串：只认 role==="reference_video" 的话，
    //   去掉 role 的 video_url 条目会整个绕过本闸门、按纯任务 4.7 系数放行
    //   （输入视频时长一分不收，且流水与纯任务无法区分）。方舟对缺 role 的
    //   video_url 是拒是收**没有实测过**，而这道闸的意义恰恰是不赌上游行为。
    //   全 App 没有任何合法的非 r2v video_url 用途，命中即走全套校验。
    const vids = Array.isArray(content)
      ? content.filter((e) => e && (e.type === "video_url" || e.video_url !== undefined))
      : [];
    if (!vids.length) return next();

    const deny = (message) => res.status(400).json({ ok: false, code: "R2V_NOT_ALLOWED", message });

    // 方舟协议里参考视频就是单条；多条不是我们客户端会拼出的形状，按可疑请求整句拒
    if (vids.length > 1) {
      return deny("一次出片只能带一个参考视频——当前请求未被受理，也没有扣费。");
    }
    const refs = vids.filter((e) => e.role === "reference_video");
    if (!refs.length) {
      // 有 video_url 却不带规范 role：不是我们客户端拼得出的形状，也没法按 r2v 计价
      return deny("参考视频条目缺少 reference_video 标记——当前请求未被受理，也没有扣费。");
    }

    const model = String(req.body?.model ?? "");
    if (VIDEO_MULT_R2V[model] === undefined) {
      // 模型不在 r2v 价目表：宁可拒单也不落回纯任务价（那是不含视频输入的价，会少收且账目瞎）
      return deny(`这一档（${model.slice(0, 64) || "未知模型"}）暂不支持参考视频出片——当前请求未被受理，也没有扣费。`);
    }

    const url = String(refs[0]?.video_url?.url || "").slice(0, 2000);
    // ── 分支一：已登记的白模模板（套用出片 / 作者试炼）───────────────
    // 反查登记（refVideo.url 是 unique 索引，等值匹配服务端规范化过的 secure_url）
    const tpl = url
      ? await BranchTemplate.findOne({ "refVideo.url": url })
          // ★ realDurationSec 一起取：光看 durationSec（ceil 出来的计价锚点）**看不出坏** ——
          //   一段 3.712s 的产物在那个字段里写着 4（2026-08-16 线上 3 个废模板就是这么隐身的）
          .select("_id ownerId status refVideo.durationSec refVideo.realDurationSec")
          .lean()
      : null;

    /** 计价结论（下面几条分支各自填一份，参数钉子按 kind 各钉各的） */
    let verdict = null;
    /** 分支四用：本人成片的 public_id（parseOwnBranchVideoUrl 的结论） */
    let own = null;

    if (tpl) {
      // blocked = 平台已下架：继续可用的话「事后治理」就没有牙齿
      if (tpl.status === "blocked") {
        return deny("这个白模模板已被平台下架，暂时不能用它出片——当前请求未被受理，也没有扣费。");
      }
      // 未发布的模板只有作者本人能用（那正是发布前的「试炼」一步）；
      // 别人拿到 URL 也不能蹭 —— 市场只暴露 published，这里是同一条边界的服务端实现。
      // retired（被公开流程引用着、作者下了架）对所有人放行：复制了那条流程的人要靠它出片（BranchTemplate model 的 ★）
      if (tpl.status !== "published" && tpl.status !== "retired" && String(tpl.ownerId) !== String(req.user._id)) {
        return deny("这个白模模板还没有发布，暂时不能用它出片——当前请求未被受理，也没有扣费。");
      }
      // ★★ 模板视频自己过不过方舟窗口 —— 2026-08-16 补上的结构性缺口。
      //   在此之前这条分支**完全不复核时长**（分支二反而有），于是一个 3.712s 的坏模板
      //   在我们这边一路绿灯，撞的是方舟那句英文 `InvalidParameter.TaskTypeConstraint`。
      //   钱这一侧本来就是安全的（W2 会退未受理的那一笔），但用户看到的是一句天书。
      //   成本只是一次比较，保护的是"万一有坏模板真的到了 published"的每一个套用者。
      // ★ 判据与发布闸同一处（BranchTemplate.refVideoSec：realDurationSec ?? durationSec，
      //   缺失当好）—— 两边分家就会出现"发布闸放行、套用闸拒绝"这种自相矛盾。
      const tplSec = BranchTemplate.refVideoSec(tpl.refVideo);
      const tplIssue = templateRefDurationIssue(tplSec, "这个白模模板的视频");
      if (tplIssue) {
        return deny(
          tplSec < TEMPLATE_REF_RULES.minSec
            ? `这个白模模板的视频只有约 ${secText(tplSec)} 秒，短于 AI 出片引擎要求的 ${TEMPLATE_REF_RULES.minSec} 秒下限，` +
                "用它出片一定会失败——当前请求未被受理，也没有扣费。"
            : `${tplIssue}（当前请求未被受理，也没有扣费。）`,
        );
      }
      verdict = {
        templateId: String(tpl._id),
        ownerId: String(tpl.ownerId),
        // ★ 计价的输入时长只从服务端登记值读（建模板时从 Cloudinary 写入的那份），
        //   请求体里客户端说什么都不作数
        durationSec: Number(tpl.refVideo?.durationSec),
      };
    } else if (url && (await MaterialRefVideo.exists({ url }))) {
      // ── 分支三：已登记的**用户素材参考视频**（2026-08-28，工作流「自定义 =
      //    多图 + 参考视频」那条路）────────────────────────────
      // ★ 与模板两条分支的本质区别：它走的是 reference 子任务（不是 edit 复刻），
      //   输出时长由用户选（3~10s），首/中/尾帧用 reference_image + 提示词点名。
      //   （窗口按模型走 videoSecWindow，2.5 是 4~30s）。
      //   参数钉子因此是**另一套**（见下面 material 那个分支），别把 edit 的钉子
      //   套在它头上——duration:-1 在 reference 子任务上会推到 30s 上界（A7 实测），
      //   那正是"按小价买大产出"的口子。
      const mat = await MaterialRefVideo.findOne({ url }).select("_id userId durationSec publicId").lean();
      // 素材**私有**：登记者本人才能拿它出片。别人拿到 URL 也不能蹭（与未发布模板同一条边界）
      if (String(mat.userId) !== String(req.user._id)) {
        return deny("这段素材视频是别人登记的，不能用它出片——当前请求未被受理，也没有扣费。");
      }
      verdict = {
        kind: "material",
        templateId: null, // 不是模板 —— 试炼追踪按空跳过（同分支二）
        ownerId: String(mat.userId),
        // 计价输入只读服务端登记值（register 时从 Cloudinary 写入），请求体说什么不作数
        durationSec: Number(mat.durationSec),
        sourcePublicId: mat.publicId,
        // 输出时长 = 用户点的 duration（下面素材钉子会把它钉成这个模型时长窗口里的整数）
        outputSec: Number(req.body?.duration),
      };
    } else if (url && (own = parseOwnBranchVideoUrl(url, String(req.user._id)))) {
      // ── 分支四：**本人自己出的成片**（2026-10-05，App「修这一段」：返修 / 片段重拍 / 延长）──────
      // ★★ 为什么必须有这条分支：返修（2026-09-06）发的参考视频就是本段自己的成片（出片即转存的
      //   `ideahub/branch-videos/<userId>-<毫秒>-seg`），而上面两条只认模板与素材登记、下面那条只认带裁剪变换的模板素材 ——
      //   于是**正式包里的返修一直被这道闸整句 400**（不扣钱），只在 dev（直连方舟）里跑得通。
      // ★ 归属与形状用服务端合并认段落的同一个判据（目录 + 文件名以本人 id 开头）；时长由服务端向 Cloudinary 查
      //   （ownSegmentMeta，查过缓存一天），客户端报的数一个不信。
      // ★ 只收两种子任务，各钉各的计价假设（下面的钉子）：
      //   · edit（返修 / 片段重拍 / 换机位）：输出跟随输入 ⇒ r2vTokens（输入 × 2），与白模复刻同一个公式；
      //   · extend（延长）：输出时长由用户选 ⇒ (输入 + 输出)，与素材参考同一个公式（tokens.materialRefTokens）。
      //   reference（拿自己的片当运镜参考另拍一段）这一期不开：计价形状与 extend 相同，但还没有调用方。
      const meta = await ownSegmentMeta(own.publicId, req.user._id);
      if (meta.status === 502) {
        return res.status(502).json({ ok: false, message: "云端视频信息读取失败，本次请求未被受理，也没有扣费，请稍后重试。" });
      }
      if (meta.issue) return deny(`${meta.issue}（当前请求未被受理，也没有扣费。）`);
      const omni = req.body?.omni_reference_task_type;
      if (omni !== "edit" && omni !== "extend") {
        return deny("拿自己的成片当参考视频，只能返修（edit）或延长（extend）——当前请求未被受理，也没有扣费。");
      }
      verdict = {
        kind: omni === "edit" ? "ownEdit" : "ownExtend",
        templateId: null, // 不是模板 —— 试炼追踪按空跳过（同分支二、三）
        ownerId: String(req.user._id),
        durationSec: meta.durationSec,
        sourcePublicId: own.publicId,
        ...(omni === "extend" ? { outputSec: Number(req.body?.duration) } : {}),
      };
    } else {
      // ── 分支二：本账号刚传、**尚未登记**的托管素材（白模化那一发的输入）──
      //
      // ★★ 为什么必须有这条分支：白模化（原视频 → 一人一色的人偶视频）那一发的输入是
      //   「用户刚传的素材裁出来的那一段」，此时世上还没有任何模板，反查必然落空。
      //   而**绝不能**为了过闸门先把用户原视频登记成一个"模板" —— 那会污染模板库、
      //   撞 refVideo.url 的唯一索引，还让试炼闸对着中间物计数。
      //
      // ★★ 计价的输入时长取 **URL 里的 `du_` 那个数**，理由是它**自洽**：
      //   Cloudinary 会照这条变换投递，方舟拿到的就是这么长的一段 ——
      //   同一个字符串同时决定了"上游收到多长"和"我们收多少钱"，
      //   客户端拼不出"少付多得"。反过来，**没有 `du_` 的地址一律不认**
      //   （parseOwnClipUrl 直接返回 null）：那等于把整条原片（最长 600s）喂进去，
      //   却只按纯任务价收 —— 输入时长一分不收，账目全瞎。
      const clip = url ? parseOwnClipUrl(url, String(req.user._id)) : null;
      if (!clip) {
        return deny("参考视频必须先登记为白模模板（且地址与登记完全一致）——当前请求未被受理，也没有扣费。");
      }
      // 已经被登记过的素材不许从这条分支走：登记过的必须用**精确的登记地址**走分支一，
      // 否则「加一段裁剪变换」就绕开了 blocked / 未发布 两道门禁
      const registered = await BranchTemplate.exists({
        $or: [{ "refVideo.cloudinaryPublicId": clip.publicId }, { "source.publicId": clip.publicId }],
      });
      if (registered) {
        return deny("这段视频已经登记过白模模板了，请直接用模板出片——当前请求未被受理，也没有扣费。");
      }
      // 这条分支上的素材**就是白模化的输入**，所以判的是白模化那套窗口
      // （方舟 edit 的 F1/F3 + 时长下限抬到 5）。规则的唯一实现在 middleware/upload.js。
      // ★★ 必须与阶段一用同一个函数：两道门差一秒的话，一个老客户端就能从这条路
      //   把 4 秒的白模化发出去，产出 3.7 秒，又造一个谁都套用不了的模板。
      const issue = blockoutInputIssue(
        { duration: clip.durSec, width: clip.crop.w, height: clip.crop.h },
        "这一段",
      );
      if (issue) return deny(`${issue}（当前请求未被受理，也没有扣费。）`);
      // 现查一次资源详情：确认这个 public_id 真的存在、且裁剪框没超出原片
      // ——编造一个"形状对"的地址到不了扣费这一步。
      let resource;
      try {
        resource = await cloudinary.api.resource(clip.publicId, { resource_type: "video", media_metadata: true });
      } catch (e) {
        const http = e?.error?.http_code ?? e?.http_code;
        if (http === 404) {
          return deny("找不到这段素材（可能未上传成功或已被回收），请重新上传后再试——当前请求未被受理，也没有扣费。");
        }
        console.error(`[ark] r2v 素材详情读取失败 public_id=${clip.publicId}:`, e?.error?.message || e.message);
        return res
          .status(502)
          .json({ ok: false, message: "云端视频信息读取失败，本次请求未被受理，也没有扣费，请稍后重试。" });
      }
      const src = templateVideoMeta(resource);
      const boundIssue = clipOutOfBounds(clip, src);
      if (boundIssue) return deny(`${boundIssue}（当前请求未被受理，也没有扣费。）`);

      verdict = {
        templateId: null, // 还没有模板 —— 试炼追踪要靠这个判空跳过（见 billedForward）
        ownerId: String(req.user._id),
        durationSec: clip.durSec,
        sourcePublicId: clip.publicId, // 流水 memo 用（对账时分得出白模化那一发）
      };
    }

    if (verdict.kind === "material") {
      // ★★ 素材参考（reference 子任务）的钉子 —— 与 edit 那套**分开**，各钉各的计价假设。
      //   计价是 (登记输入时长 + 用户选的输出时长)×720p 锚×系数（tokens.materialRefTokens）。
      const dur = req.body?.duration;
      // 收 undefined 或显式 "reference"：app 对 2.5 显式发 reference（auto 判错是**异步**
      // 失败（钱先扣、几十秒后才 failed —— 2026-10-07 起会自动退回，但人白等一趟），显式判错是提交时同步 400 ——
      // arkClient 那行 ★ 的同一条理由）。
      // edit 一律拒：那是白模复刻的计价形状（输出跟随输入），揣着素材票走 edit 就是错价。
      const omni = req.body?.omni_reference_task_type;
      if (omni !== undefined && omni !== "reference") {
        return deny("素材参考出片只走 reference 子任务——当前请求未被受理，也没有扣费。");
      }
      // ★ 窗口按模型走（videoSecWindow，2026-10-03 起 2.5 是 [4,30]；此前写死 3~10）。整数才收：
      //   方舟只认整数秒，4.5 这种数发过去不是被拒就是被它自己取整，与我们按 round 结算的数可能差一秒
      const [lo, hi] = videoSecWindow(model);
      if (!Number.isInteger(dur) || dur < lo || dur > hi) {
        // -1（智能时长）明确拒：reference 子任务上它会推到 30s 上界（A7 实测），报价对不上实扣
        return deny(`素材参考出片要指定 ${lo}~${hi} 秒的整数时长（不收 -1 智能时长）——当前请求未被受理，也没有扣费。`);
      }
      const resl = req.body?.resolution;
      if (resl !== undefined && resl !== "720p") {
        return deny("素材参考出片目前只支持 720p——当前请求未被受理，也没有扣费。");
      }
      const ratio = req.body?.ratio;
      if (ratio !== undefined && !["16:9", "9:16", "adaptive"].includes(ratio)) {
        return deny("素材参考出片的画幅只收 16:9 / 9:16 / adaptive——当前请求未被受理，也没有扣费。");
      }
    } else if (verdict.kind === "ownExtend") {
      // ★★ 延长（extend 子任务）的钉子：计价是 (登记输入时长 + 用户选的输出时长)×720p 锚×系数（tokens.materialRefTokens），
      //   成立的前提是输出时长就是请求里那个整数 —— -1（智能时长）会推到上界，必须拒（素材参考那条 ★ 同一个理由）。
      const dur = req.body?.duration;
      const [lo, hi] = videoSecWindow(model);
      if (!Number.isInteger(dur) || dur < lo || dur > hi) {
        return deny(`延长要指定 ${lo}~${hi} 秒的整数时长（不收 -1 智能时长）——当前请求未被受理，也没有扣费。`);
      }
      const resl = req.body?.resolution;
      if (resl !== undefined && resl !== "720p") {
        return deny("延长目前只支持 720p——当前请求未被受理，也没有扣费。");
      }
      // 方舟：延长任务的 ratio 必须是 adaptive（跟随待延长的那段视频）
      const ratio = req.body?.ratio;
      if (ratio !== undefined && ratio !== "adaptive") {
        return deny("延长的画幅跟随原片（ratio 只能是 adaptive）——当前请求未被受理，也没有扣费。");
      }
    } else {
    // ★★ 把 r2v 的**生成参数钉死在计价假设上**，不符整句 400。
    //   计价是 (登记时长×2)×720p×24fps（tokens.r2vTokens），成立的前提是
    //   edit 子任务 + duration:-1（输出≈输入）+ 720p —— 这三件只有客户端
    //   BLOCKOUT_TASK 在遵守，而代理是原样转发的：不在这里钉，改一行客户端
    //   就能按 4s 模板的价买 30s/1080p 的产出（reference 子任务 duration 自由、
    //   -1 会推到 30s 上界，A7 实测），差额全进我们的方舟账单，memo 还与正常
    //   r2v 一模一样，零症状。「不信客户端报的任何数」在这条路上就是这四行。
    // 返修（分支四的 edit）与白模复刻走同一套钉子（计价公式相同），只是拒绝语里的叫法不同
    const what = verdict.kind === "ownEdit" ? "返修" : "白模出片";
    const dur = req.body?.duration;
    if (req.body?.omni_reference_task_type !== "edit") {
      return deny(`${what}只支持 edit 参考子任务——当前请求未被受理，也没有扣费。`);
    }
    if (dur !== undefined && dur !== -1) {
      return deny(`${what}的时长跟随参考视频（duration 只能是 -1）——当前请求未被受理，也没有扣费。`);
    }
    const resl = req.body?.resolution;
    if (resl !== undefined && resl !== "720p") {
      return deny(`${what}目前只支持 720p——当前请求未被受理，也没有扣费。`);
    }
    const ratio = req.body?.ratio;
    if (ratio !== undefined && ratio !== "adaptive") {
      return deny(`${what}的画幅跟随参考视频（ratio 只能是 adaptive）——当前请求未被受理，也没有扣费。`);
    }
    }
    // ★ 样片模式（draft）只给**纯任务**的电影级：方舟按「第一步有没有输入视频」给第二步定单价，
    //   我们只定了无视频那一档（tokens.DRAFT_FINAL_MULT），而且 r2v 各分支的计价都钉在 720p，样片却只出 480p。
    //   带参考视频的出片一律不收 draft（缺省 / false 照常放行，老客户端不受影响）。
    if (req.body?.draft !== undefined && req.body.draft !== false) {
      return deny("带参考视频的出片不支持样片模式——当前请求未被受理，也没有扣费。");
    }
    // ★ generate_audio 同样要钉，但钉的是「**与该模型的支持情况一致**」，不是"必须 false"。
    //   2026-08-15 零成本探针实测：方舟在 r2v edit 路上真收这个参数（给非法值报的是
    //   "parameter `generate_audio` is not valid"，param 精确指向它）。
    //   ★★ 这一条 2026-08-15 从「必须 false/缺省」放开，依据是**费用中心逐行核对**：
    //     同素材有声/无声两发的用量与单价逐位相同（各 209.71 千 tokens × ¥0.042/千），
    //     计费单元里也没有给音频单列的条目 ⇒ 开音频**零额外成本**，r2vTokens 不用加项，
    //     「按无声价买有声产出」这件事根本不存在。放开与价目同一个提交（价目一个字没改）。
    //   ★ 仍然要钉：**不支持的档只许 false/缺省**（1.x 收下参数却静默忽略 —— 传了会让
    //     两边都以为"这一发有声"，用户只会觉得自己手机静音了）。能力表只有
    //     config/tokens.js 的 VIDEO_AUDIO 一处（与 app 的 VideoTier.audio 逐条相等）。
    const genAudio = req.body?.generate_audio;
    if (genAudio !== undefined && genAudio !== false && !(genAudio === true && audioSupported(model))) {
      return deny(`这一档（${model.slice(0, 64) || "未知模型"}）出片不支持生成音频——当前请求未被受理，也没有扣费。`);
    }

    req.r2v = verdict;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 分支二专用的额外限流桶（**串在 genLimit 后面**，不是替代它）。
 *
 * ★ 为什么单独一道：分支二每一发都要向 Cloudinary Admin API 查一次资源详情，
 *   而免费档 Admin API 是**全局** 500 次/小时（不是按账号）。genLimit 是 30/分，
 *   一个账号 17 分钟就能把全 App 的**建模板**能力一起刷停摆 ——
 *   而那时的症状是"别人建模板莫名其妙 502"，完全指不到这里。
 *   （建模板那条路早就为同一个理由限成 5 次/分，见 createLimit。）
 * ★ 6 次/分对真人绰绰有余：白模化一发要等好几分钟才出结果。
 */
const unregisteredR2vLimit = aiRateLimit({ max: 6, windowMs: 60 * 1000, scope: "ark-r2v-source" });

/**
 * 只有「带裁剪变换的自有素材」那条路走上面那道桶，其余请求原样放行。
 * ★ 判据用的是同一个 parseOwnClipUrl（不另写一份形状匹配）：这里只是**要不要限流**的
 *   预筛，真正的校验仍然在 resolveR2v 里 —— 预筛放宽了最多是少限一道，不会放行任何东西。
 */
function limitUnregisteredR2v(req, res, next) {
  const content = req.body?.content;
  if (!Array.isArray(content) || !req.user?._id) return next();
  const uid = String(req.user._id);
  const hit = content.some((e) => {
    const u = e && e.video_url?.url ? String(e.video_url.url).slice(0, 2000) : "";
    // 分支四（本人成片）在缓存没命中时也要现查 Admin API —— 同一道桶（返修 / 延长每发都要等几分钟，6 次/分对真人绰绰有余）
    return !!u && (!!parseOwnClipUrl(u, uid) || !!parseOwnBranchVideoUrl(u, uid));
  });
  return hit ? unregisteredR2vLimit(req, res, next) : next();
}

/**
 * 裁剪框是不是落在原片里（分支二专用）。
 * ★ 为什么要查：`c_crop` 超出画面时 Cloudinary 的行为是**自己裁到边界**，不是报错 ——
 *   于是方舟收到的尺寸与我们按 `w_/h_` 算出来的不一样，F3 的预检就白做了
 *   （用户在付费那一步才撞 400，而那时钱已经扣了）。
 * @returns {string|null} null = 合格；字符串 = 整句中文原因
 */
function clipOutOfBounds(clip, src) {
  if (!Number.isFinite(src.duration) || !Number.isFinite(src.width) || !Number.isFinite(src.height)) {
    return "云端没有返回这段素材的时长或尺寸，无法确定裁剪范围";
  }
  if (clip.crop.x + clip.crop.w > src.width || clip.crop.y + clip.crop.h > src.height) {
    return `裁剪框超出了画面（原片 ${src.width}×${src.height}，裁剪到 ${clip.crop.x + clip.crop.w}×${clip.crop.y + clip.crop.h}）`;
  }
  if (clip.startSec + clip.durSec > src.duration) {
    // ★ src.duration 现在是**小数**（templateVideoMeta 不再取整）——直接插值会印出
    //   "原片约 59.9666 秒" 这种机器味的数，用 secText 收口显示形态
    return `选的这一段超出了视频长度（原片约 ${secText(src.duration)} 秒，选到第 ${clip.startSec + clip.durSec} 秒）`;
  }
  return null;
}

/**
 * 轮询响应的试炼闸挂钩：r2v 任务 succeeded 且发起人就是模板作者 → 置 provenAt，
 * 并把这一发用的模型记进 provenModels（「在哪个模型上真实跑通过」，2026-10-02）。
 * 证据链两头都在服务端（受理时的追踪记录 + 方舟自己吐的 succeeded），
 * 轮询者是谁无关紧要 —— 追踪里记的是**创建任务**的人。
 * ★ 两件事分两句写：provenAt 只置一次（过滤条件带 `provenAt: null`，并发轮询也只有一发写得进）；
 *   provenModels 是 `$addToSet`（幂等）且**不看 provenAt 置没置过** —— 作者之后在另一个模型上再跑通一次，
 *   那个模型也要记上，这正是这一格存在的理由。
 * ★ 任何失败都不打断轮询响应（出片进行中的用户不该因为我们的记账问题看到报错），
 *   但要吼出来：吞掉的话作者会遇到"出片成功却还是不能发布"，查无可查（铁律八）。
 */
async function noteR2vOutcome(taskId, parsed) {
  if (parsed?.status !== "succeeded") return;
  try {
    const trial = await BranchTemplateTrial.findOne({ taskId }).lean();
    if (!trial) return; // 非 r2v 任务（绝大多数轮询），零额外开销地走人
    const tpl = await BranchTemplate.findById(trial.templateId).select("ownerId provenAt").lean();
    if (tpl && String(trial.userId) === String(tpl.ownerId)) {
      if (!tpl.provenAt) {
        await BranchTemplate.updateOne({ _id: tpl._id, provenAt: null }, { $set: { provenAt: new Date() } });
        console.log(`[ark] 白模模板试炼通过 tpl:${trial.templateId} task:${taskId}`);
      }
      // 老追踪（上线前落的）没有 model：那一发不记，出口由 provenModelsOf 的存量兜底负责
      if (trial.model) {
        await BranchTemplate.updateOne({ _id: tpl._id }, { $addToSet: { provenModels: trial.model } });
      }
    }
    // 任务已出结果，追踪的使命结束（TTL 只是兜底）；消费者的任务同样清掉
    await BranchTemplateTrial.deleteOne({ taskId });
  } catch (e) {
    console.error(`[ark] r2v 试炼记录处理失败 task=${taskId}:`, e.message);
  }
}

/** 纯任务的 content 里只认这三种条目（App 只拼得出这三种；video_url 由 resolveR2v 接走，draft_task 由 resolveDraftFinal 接走） */
const PLAIN_CONTENT_TYPES = new Set(["text", "image_url", "audio_url"]);

/**
 * 提示词里「弱校验」写法的生成参数（`小猫 --rs 1080p --dur 30`）。
 *
 * ★★ 为什么要拦（2026-10-07 评审）：方舟「创建视频生成任务」写明 resolution / ratio / duration / frames / seed /
 *   camera_fixed / watermark 七个参数**也可以**追加在文本提示词后面传（`--rs` `--rt` `--dur` `--frames` `--seed` `--cf` `--wm`，
 *   「所有模型均兼容」），而且没说请求体与提示词冲突时听谁的。下面那几行钉子只看请求体 ——
 *   于是请求体写 480p / 4 秒（按「草稿」放行、按 4 秒收钱），提示词里写 `--rs 720p --dur 15`，方舟要是听提示词的，
 *   就是免费版拿到 15 秒高清、我们收 4 秒草稿的钱；样片第一步同理（第二步按第一步登记的时长收 1080p 的钱）。
 *   门禁与计价的假设都钉在请求体上，所以提示词里**一个都不许出现**（整句 400，不扣钱）。
 * ★ 拒而不是悄悄删：删掉用户提示词里的字是在改他的创作；App 从来不拼这种写法（git 史核过），
 *   撞上的只会是手搓的请求，或者用户自己在提示词里打了这几个字 —— 后者那句话能看懂怎么改。
 * ★ 七个参数的长短两种写法都认（--rs/--resolution、--rt/--ratio、--dur/--duration、--cf/--camerafixed、--wm/--watermark），
 *   外加旧版文档里的帧率 --fps / --framespersecond。参数名后面紧跟字母的不算（`--seedling` 不是 --seed），紧跟数字的算（`--dur30`）。
 *   前面不能是字母数字（`a--dur` 不是一个参数）；中文紧挨着的算（`小猫--dur 30`，宁可多拦）。
 * ★ 只管 Seedance 视频任务：同一个端点上的 Seed3D 正是用 `--subdivisionlevel` 这类写法传参的，别把它一起拦了。
 */
const WEAK_PARAM_RE = /(?<![A-Za-z0-9_])--(?:rs|resolution|rt|ratio|dur|duration|frames|fps|framespersecond|seed|cf|camerafixed|wm|watermark)(?![A-Za-z])/i;

/** content 里哪一条文字带了弱校验参数 —— 回参数原样（给拒绝那句话用），没有回 null */
function weakParamIn(content) {
  if (!Array.isArray(content)) return null;
  for (const e of content) {
    if (!e || e.type !== "text" || typeof e.text !== "string") continue;
    const m = WEAK_PARAM_RE.exec(e.text);
    if (m) return m[0].trim();
  }
  return null;
}

/**
 * 纯视频任务（没有参考视频：文生 / 图生 / 参考图生视频 / 样片第一步）的参数钉子 —— 把**生成参数钉在计价假设上**，
 * 缺省的补齐、不符的整句 400。
 *
 * ★★ 为什么要有（2026-10-03 随「段时长放开」加）：纯任务按 segTokens 结算 = 请求里的 duration × 像素 × 系数，
 *   而代理是原样转发的。此前这条路一个参数都不钉，于是改一行客户端就能：
 *     · `duration: -1`（智能时长）→ 方舟按模型上界出（2.5 是 30 秒），我们按 `Math.round(-1)` 夹到最短收；
 *     · `duration: 15` 发给 1.0 → 我们夹到 10 秒收，方舟收不收 15 是它的事，我们不赌；
 *     · `frames: 361`（按帧数定长，与 duration 二选一）→ 时长由帧数决定，我们按缺省 5 秒收；
 *     · `resolution: "1080p"` → 像素是 720p 的 2.25 倍，我们按 720p 收。
 *   差额全进我们的方舟账单，流水与正常出片一模一样，零症状 —— 与 resolveR2v 那几行钉子同一个道理
 *   （「不信客户端报的任何数」）。
 * ★★ 2026-10-07 起**缺省的补齐，不再放行**：2026-10-03 那一版写着「duration 缺省放行：方舟的缺省是 5 秒」——
 *   官方文档里 2.5 的缺省是 **-1**（智能，最长 30 秒）、2.0 系列没写缺省；1.0 不传 resolution 的缺省是 **1080p**。
 *   于是「不传」这两个字段本身就是两个少收的口子（App 从来都传，只有手搓的请求够得着）。
 *   补成 5 秒 / 720p 而不是 400：老客户端与一堆既有用例都不传它们，补齐对它们一个字不变，口子同时堵上。
 * ★ 分辨率按模型放（tokens.VIDEO_RESOLUTIONS）：1.0 两档 720p；2.0 mini 480p（「草稿」）/ 720p（「高清」）；
 *   2.5 只放 720p —— 480p 只在 `draft: true`（样片第一步）时放，而且样片要**显式**写 480p 与整数时长
 *   （第二步的价钱按第一步登记的时长算，见 resolveDraftFinal）。
 * ★ content 条目只认 text / image_url / audio_url：`draft_task`（样片第二步）只许从 resolveDraftFinal 那条路进来 ——
 *   从这里漏过去的话，它按 5 秒 720p 收、方舟却按样片的时长出 1080p。
 * ★ 文字条目里不许出现 `--rs` / `--dur` 这类「弱校验」参数（WEAK_PARAM_RE 的 ★★）：只钉请求体等于没钉。
 *   这一道对带参考视频的任务（req.r2v）同样生效。
 * ★ 停用的模型（tokens.RETIRED_MODELS_AT）在这里拒新任务：码是 MODEL_RETIRED，不是参数错。
 * ★ execution_expires_after / callback_url / service_tier 不在这里钉：它们对**每一发** Seedance 任务都一样
 *   （r2v、样片第二步、白模化也要），唯一实现在 services/arkGateway 的 withServerTaskFields。
 * ★ 窗口按模型走（tokens.videoSecWindow，与 app 的 VideoTier.minSec / maxSec 逐条相等）。
 * ★ 只钉 Seedance 视频模型（VIDEO_MULT 里有的）：同一个端点上的 Seed3D 建模没有这些参数，不归这里管；
 *   不在册的模型由 billedForward 的白名单拒，也不归这里管。
 */
function pinPlainVideoTask(req, res, next) {
  // 样片第二步由 resolveDraftFinal 钉过了（请求体整体重写成只有一条 draft_task，没有文字）
  if (req.draftFinal) return next();
  const model = String(req.body?.model ?? "");
  // 带参考视频的任务（req.r2v）也要过下面那道「提示词里的弱校验参数」：resolveR2v 钉的同样只是请求体
  if (!req.r2v && !Object.hasOwn(VIDEO_MULT, model)) return next();
  const deny = (message) => res.status(400).json({ ok: false, code: "VIDEO_PARAMS_NOT_ALLOWED", message });

  const weak = weakParamIn(req.body?.content);
  if (weak) {
    return deny(
      `提示词里不能用 ${weak.slice(0, 20)} 这种写法指定分辨率、画幅、时长等参数（这些由档位与时长设置决定），请删掉后再出片——当前请求未被受理，也没有扣费。`,
    );
  }
  // 带参考视频的任务的其余参数由 resolveR2v 钉过了（各钉各的计价假设）
  if (req.r2v) return next();

  const retired = retiredDenial(model);
  if (retired) return res.status(400).json({ ok: false, code: "MODEL_RETIRED", message: retired });

  const b = req.body;
  if (b.content !== undefined && !Array.isArray(b.content)) {
    return deny("出片请求的 content 必须是一个列表——当前请求未被受理，也没有扣费。");
  }
  for (const e of b.content || []) {
    if (e && (e.type === "draft_task" || e.draft_task !== undefined)) {
      return deny("样片转成片要单独发（content 里只放那一条样片）——当前请求未被受理，也没有扣费。");
    }
    if (!e || !PLAIN_CONTENT_TYPES.has(e.type)) {
      return deny(`出片请求里不认 ${String(e?.type ?? "没写类型").slice(0, 32)} 这种内容——当前请求未被受理，也没有扣费。`);
    }
  }

  // draft：只认布尔；false 与缺省同义，转发前剥掉（只有 2.5 认这个参数，别把它发给别的模型）
  if (b.draft !== undefined && typeof b.draft !== "boolean") {
    return deny("draft 只能是 true 或 false——当前请求未被受理，也没有扣费。");
  }
  if (b.draft === false) delete b.draft;
  const draft = b.draft === true;

  const [lo, hi] = videoSecWindow(model);
  if (b.duration === undefined) {
    // 样片必须显式写时长：第二步按第一步登记的时长收钱（resolveDraftFinal），而 2.5 的缺省 -1 会推到 30 秒
    if (draft) return deny(`样片要指定 ${lo}~${hi} 秒的整数时长——当前请求未被受理，也没有扣费。`);
    b.duration = 5;
  } else if (!Number.isInteger(b.duration) || b.duration < lo || b.duration > hi) {
    return deny(`这一档的时长只能是 ${lo}~${hi} 秒的整数（不收 -1 智能时长）——当前请求未被受理，也没有扣费。`);
  }
  if (b.frames !== undefined) {
    return deny("出片时长请用 duration 指定（不收 frames）——当前请求未被受理，也没有扣费。");
  }

  if (draft) {
    if (model !== SEEDANCE_2_5) {
      return deny("样片模式只有「电影级」能用——当前请求未被受理，也没有扣费。");
    }
    if (b.resolution !== DRAFT_RESOLUTION) {
      return deny(`样片只出 ${DRAFT_RESOLUTION}（resolution 要写 ${DRAFT_RESOLUTION}）——当前请求未被受理，也没有扣费。`);
    }
    return next();
  }
  if (b.resolution === undefined) b.resolution = "720p";
  const allowed = VIDEO_RESOLUTIONS[model] || ["720p"];
  if (!allowed.includes(b.resolution)) {
    return deny(`这一档只能出 ${allowed.join(" / ")}——当前请求未被受理，也没有扣费。`);
  }
  return next();
}

/** 样片的有效期：方舟规定样片任务 ID 自创建起 7 天内可转成片；我们只放到 7 天差 1 小时（排队那几分钟里过期 = 白跑一趟） */
const DRAFT_FINAL_WINDOW_MS = arkVideoTask.DRAFT_FINAL_WINDOW_MS;

/**
 * 样片第二步的请求体里客户端**可以出现**的键 —— 除了 model / content，其余几个都会被下面整体重写（或剥掉）。
 * ★ 方舟规定：提示词 / 图 / 视频 / 音频 / 时长 / 画幅 / 种子 / 音频开关 / 任务类型都由样片自动沿用，
 *   **重传一个都会报错**（哪怕值一样）。所以那些键在这里整句拒（同步、不花钱），不放去方舟撞失败。
 */
const DRAFT_FINAL_CLIENT_KEYS = new Set([
  "model",
  "content",
  "resolution",
  "watermark",
  "draft",
  "execution_expires_after",
  "callback_url",
  "service_tier",
]);

/** 样片转成片时我们认的画幅（方舟查询回的那一份；认不出就不填，按 1080p 最大一格收） */
const DRAFT_RATIOS = new Set(Object.keys(VIDEO_PIXELS[DRAFT_FINAL_RESOLUTION][SEEDANCE_2_5]));

/**
 * 电影级「样片」第二步（480p 样片 → 1080p 成片）的解析闸门。content 里出现 `draft_task` 就归这里管。
 *
 * ★★ 为什么必须单独一道：第二步的请求里**没有**时长与画幅（方舟规定沿用样片、禁止重传），
 *   而价钱 = 样片时长 × 1080p 像素 × 77/15 —— 这两个数只能来自我们自己记下的第一步，客户端说什么都不作数
 *   （与 resolveR2v「输入时长只读服务端登记」同一个道理）。
 * ★★ 归属必须由我们自己查：所有人的任务都挂在**同一把**方舟 key 下，方舟认 id 不认人 ——
 *   不查的话，拿到别人的样片 id 就能替别人转成片（钱算自己的，产物是别人的创作）。
 *   所以只认 ArkVideoTask 里「本人、draft:true」的那一条（经我们这里出的样片受理时记下的）。
 * ★ 有效期：方舟 7 天；我们放到 7 天差 1 小时（DRAFT_FINAL_WINDOW_MS），按「我们的登记 / 方舟的 created_at」里更早的那个算。
 * ★ 再向方舟问一次（GET，不计费）：样片真的 succeeded 了才转 —— 没成的样片转不出东西，提交了就是一笔失败。
 * ★ 通过之后把请求体**整体重写**成方舟要的最小形状（model + 那一条 draft_task + 1080p + 无水印；24 小时超时由
 *   arkGateway 的 withServerTaskFields 统一套上），再挂上 req.draftFinal = { draftTaskId, durationSec, ratio }，
 *   计价（tokens.priceOf）与免费档门禁只认它。
 * ★ 免费版一律拒（样片两步都是电影级）—— 那道门在 chargedArkCall 里，与其它出片同一处。
 */
async function resolveDraftFinal(req, res, next) {
  try {
    const content = req.body?.content;
    const hasDraftTask = Array.isArray(content) && content.some((e) => e && (e.type === "draft_task" || e.draft_task !== undefined));
    if (!hasDraftTask) return next();

    const deny = (message) => res.status(400).json({ ok: false, code: "DRAFT_FINAL_NOT_ALLOWED", message });
    const b = req.body;
    if (String(b.model ?? "") !== SEEDANCE_2_5) {
      return deny("样片转成片只支持「电影级」——当前请求未被受理，也没有扣费。");
    }
    if (content.length !== 1) {
      return deny("样片转成片的请求里只能有那一条样片（提示词、图、视频、音频都由样片沿用，不能再传）——当前请求未被受理，也没有扣费。");
    }
    const item = content[0] || {};
    const id = String(item.draft_task?.id ?? "");
    const itemOk =
      item.type === "draft_task" &&
      !!item.draft_task &&
      typeof item.draft_task === "object" &&
      Object.keys(item).every((k) => k === "type" || k === "draft_task") &&
      Object.keys(item.draft_task).every((k) => k === "id") &&
      TASK_ID_RE.test(id);
    if (!itemOk) {
      return deny("样片条目的形状不对（只收 type 为 draft_task、里面只有 id 的那一条）——当前请求未被受理，也没有扣费。");
    }
    const extra = Object.keys(b).find((k) => !DRAFT_FINAL_CLIENT_KEYS.has(k));
    if (extra) {
      return deny(`样片转成片不收 ${extra.slice(0, 40)} 这个参数（时长、画幅、声音都沿用样片）——当前请求未被受理，也没有扣费。`);
    }
    if (b.resolution !== undefined && b.resolution !== DRAFT_FINAL_RESOLUTION) {
      return deny(`样片转成片只出 ${DRAFT_FINAL_RESOLUTION}——当前请求未被受理，也没有扣费。`);
    }
    if (b.draft !== undefined && b.draft !== false) {
      return deny("样片转成片这一发本身不是样片（draft 只能缺省或 false）——当前请求未被受理，也没有扣费。");
    }

    const rec = await arkVideoTask.findOwnDraft(id, req.user._id);
    if (!rec) {
      return deny("找不到这条样片：只能用你自己、在这里生成的样片转成片——当前请求未被受理，也没有扣费。");
    }
    const now = Date.now();
    let createdMs = new Date(rec.createdAt).getTime();
    if (!(now - createdMs < DRAFT_FINAL_WINDOW_MS)) {
      return deny("这条样片已经超过 7 天有效期，不能再转成片了——当前请求未被受理，也没有扣费。");
    }

    // 向方舟确认样片的真实状态（GET 不计费；与轮询同一个超时）
    const { status, text } = await callArk({ method: "GET", path: `/contents/generations/tasks/${id}`, timeoutMs: T_POLL });
    if (status === 501) return res.status(501).type("application/json").send(text || "{}"); // 没配 key：与其它出片同口径
    if (status === 404) {
      return deny("方舟那边已经查不到这条样片了（可能已过期）——当前请求未被受理，也没有扣费。");
    }
    let parsed = null;
    try {
      parsed = status === 200 ? JSON.parse(text || "{}") : null;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      console.error(`[ark] 样片状态查询失败 task=${id} status=${status}`);
      return res.status(502).json({ ok: false, message: "暂时查不到这条样片的状态，本次没有开始生成、也没有扣费，请稍后重试。" });
    }
    if (parsed.status !== "succeeded") {
      const st = String(parsed.status ?? "").replace(/[^a-z_]/gi, "").slice(0, 20) || "未知";
      return deny(`这条样片还没有生成成功（方舟状态：${st}），不能转成片——当前请求未被受理，也没有扣费。`);
    }
    if (parsed.model !== undefined && parsed.model !== SEEDANCE_2_5) {
      return deny("这条样片不是电影级出的，不能转成片——当前请求未被受理，也没有扣费。");
    }
    const arkCreated = Number(parsed.created_at) * 1000;
    if (Number.isFinite(arkCreated) && arkCreated > 0) createdMs = Math.min(createdMs, arkCreated);
    if (!(now - createdMs < DRAFT_FINAL_WINDOW_MS)) {
      return deny("这条样片已经超过 7 天有效期，不能再转成片了——当前请求未被受理，也没有扣费。");
    }

    // 时长：我们登记的那份（样片第一步被钉子要求显式写整数时长）与方舟回的整数秒**两份都认得出时必须相等**；
    // 只认得出一份就用那一份；都认不出就不转 —— 时长是价钱的一半，猜一个就是"报价与实扣分家"。
    // ★★ 为什么不再「登记优先、方舟的不看」（2026-10-07 评审）：登记的是**请求体**里的数，而第一步的提示词里
    //   要是夹着 `--dur 30`、方舟又听了它的，样片其实是 30 秒 —— 按登记的 4 秒收 1080p 的钱就少收了七倍多。
    //   钉子现在拦了提示词里的这种写法（WEAK_PARAM_RE），这里是第二道：两份对不上就不转（不扣钱、吼一声），
    //   不取大的那个 —— 取大的会让 App 的报价（照登记时长算）与实扣分家；对不上本来就不该发生，要人看。
    // ★ 方舟只回 duration 与 frames 里的一个（查询任务文档）：只回了 frames 说明这一发是按帧数定长的（钉子不放 frames），同样不转。
    const [lo, hi] = videoSecWindow(SEEDANCE_2_5);
    const okSec = (n) => Number.isInteger(n) && n >= lo && n <= hi;
    if ((parsed.duration === undefined || parsed.duration === null) && parsed.frames !== undefined && parsed.frames !== null) {
      console.error(`[ark] 样片 ${id} 是按帧数（${String(parsed.frames).slice(0, 12)}）出的，不转成片`);
      return deny("这条样片是按帧数定长的，没法按时长报价，不能转成片——当前请求未被受理，也没有扣费。");
    }
    const regSec = okSec(rec.durationSec) ? rec.durationSec : null;
    const arkSec = okSec(Number(parsed.duration)) ? Number(parsed.duration) : null;
    if (regSec !== null && arkSec !== null && regSec !== arkSec) {
      console.error(`[ark] 样片 ${id} 的时长对不上（登记 ${regSec} 秒，方舟 ${arkSec} 秒），不转成片 user=${req.user._id}`);
      return deny(`这条样片的时长对不上（提交时是 ${regSec} 秒，生成出来是 ${arkSec} 秒），没法按报价转成片——当前请求未被受理，也没有扣费。`);
    }
    const durationSec = regSec ?? arkSec;
    if (durationSec === null) {
      console.error(`[ark] 样片 ${id} 认不出时长（登记 ${String(rec.durationSec)}，方舟 ${String(parsed.duration)}）`);
      return deny("认不出这条样片的时长，没法报价——当前请求未被受理，也没有扣费。");
    }
    // 画幅：方舟回的是实际出片的画幅（adaptive 已经落成具体比例）；认不出就留空，计价按 1080p 最大一格（宁高不低）
    const ratio = DRAFT_RATIOS.has(parsed.ratio) ? parsed.ratio : DRAFT_RATIOS.has(rec.ratio) ? rec.ratio : undefined;

    // 请求体整体重写成方舟要的最小形状（就地改：后面的中间件与 billedForward 拿的是同一个对象）
    for (const k of Object.keys(b)) delete b[k];
    Object.assign(b, {
      model: SEEDANCE_2_5,
      content: [{ type: "draft_task", draft_task: { id } }],
      resolution: DRAFT_FINAL_RESOLUTION,
      watermark: false,
    });
    req.draftFinal = { draftTaskId: id, durationSec, ...(ratio ? { ratio } : {}) };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Seedance 出视频 / Seed3D 建模（同一个异步任务端点）。
 *  两者单价差一个数量级（一段 720p 视频约 216k，一次建模 160k），按 body.model 分别定价。
 *  ★ resolveDraftFinal 排在 resolveR2v 前面：带 draft_task 的请求只许有那一条，先拒掉就不会白查一次 Cloudinary（全局配额） */
router.post(
  "/contents/generations/tasks",
  requireAuth,
  genLimit,
  limitUnregisteredR2v,
  resolveDraftFinal,
  resolveR2v,
  pinPlainVideoTask,
  billedForward("task", "/contents/generations/tasks", T_CREATE),
);

/** 轮询任务状态。**不计费**（见 billedForward 的注释），单独一个限流桶：
 *  它便宜且高频（每 5s 一次，一段视频最多 120 次），和"创建"共用一个桶的话，
 *  正常出片会被自己的轮询挤爆。 */
router.get("/contents/generations/tasks/:id", requireAuth, pollLimit, async (req, res, next) => {
  try {
    if (!TASK_ID_RE.test(req.params.id)) return res.status(400).json({ ok: false, message: "bad task id" });
    const { status, text } = await callArk({
      method: "GET",
      path: `/contents/generations/tasks/${req.params.id}`, // query（?transfer=1）是我们与客户端的私货，不上桌给方舟
      timeoutMs: T_POLL,
    });
    let out = text || "{}";
    if (status === 200) {
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        /* 上游给的不是 JSON —— 原样透传，这里不掺和 */
      }
      // ★★ 失败退款的挂点（2026-10-07，services/taskRefund）：方舟**明说**这一发失败 / 取消 / 过期 → 按原桶退给账的主人
      //   （恰好一次：别人、清扫器、白模化取回同时看见也只退一次）。只在终态上查库 —— 排队 / 运行中的高频轮询零额外开销。
      // ★ 退给**账的主人**，不是来问的人：这条路不查归属，任何登录用户都能问任何任务号。`refund` 字段与余额头也只给主人。
      // ★ 失败只吼不挡：查库 / 退款出了错，这一拍照样把方舟的原话回出去（不回 5xx —— 客户端连查失败几次就当成
      //   「还在跑、盯不住了」，一发已经退了钱的任务反而被说成还在跑）。没退成的那一笔账还是 open，清扫器会接着退。
      const verdict = taskRefund.verdictOf("ark", parsed?.status);
      if (verdict) {
        try {
          const row = await taskRefund.settleTask({
            provider: "ark",
            taskId: req.params.id,
            status: parsed.status,
            code: parsed?.error?.code,
            viewerId: req.user._id,
            // ★ 方舟的原话要带上（与白模化取回、清扫器的 queryUpstream 同一个截法）：白模化那一发在 App 里是**先在这里轮询、
            //   再调 finish** 的，退款就落在这一拍 —— 不带的话取件单的 failMessage 里没有失败原因，finish 之后照它回话，
            //   「内容审核未通过」这类原因用户永远看不到（2026-10-07 评审）
            detail: String(parsed?.error?.message || "").slice(0, 300),
          });
          if (verdict === "failed" && row && String(row.user) === String(req.user._id)) {
            parsed.refund = taskRefund.refundView(row);
            setWalletHeaders(res, await wallet.getWallet(req.user._id));
            out = JSON.stringify(parsed);
          }
        } catch (e) {
          console.error(`[ark] 失败退款的结账没办成 task=${req.params.id}（清扫器会接着办）:`, e.message);
        }
      }
      if (parsed?.status === "succeeded") {
        // 白模模板的试炼闸：succeeded 的 r2v 任务在这里被看见（running/queued 的高频
        // 轮询零额外开销）。失败只吼不打断轮询。
        await noteR2vOutcome(req.params.id, parsed);
        // ★★ 轮询自动转存（2026-08-21）：客户端带 ?transfer=1 声明「这个任务的成片请顺手
        //   搬去永久地址」——server 在**看到 succeeded 的第一眼**就后台开搬（幂等，按产物
        //   去重），进展以 `transfer` 字段挂回响应，客户端接着轮询就能拿到 Cloudinary 地址。
        //   为什么由服务端搬而不是客户端 POST 一趟傻等：弱网手机上那一趟 180s 都不够
        //   （server 拉 TOS 跨境 + 传 Cloudinary 跨境，两跳都慢），超时后只能静默退回直链，
        //   预览/合并跟着全坏——而这活儿本来就不需要客户端在线（真机复盘见 CLAUDE.md）。
        // ★ 要显式 opt-in 而不是见 succeeded 就搬：同一个轮询端点还伺候白模化
        //   （产物由 finish 阶段按模板流程另行转存）与 Seed3D（zip，不是视频）——
        //   对它们自动搬就是每单白搬 20MB 去一个没人读的角落。
        // ★ content.video_url **原样保留**（不偷换）：老客户端读它自己去 POST /transfer-video，
        //   那条路靠登记表与这里去重，行为不变只是变快。
        const vurl = typeof parsed?.content?.video_url === "string" ? parsed.content.video_url : "";
        if (req.query.transfer === "1" && videoAsset.isArkVideoUrl(vurl)) {
          try {
            const job = await arkTransfer.ensureTransfer(vurl, req.user._id);
            parsed.transfer =
              job.state === "done"
                ? { state: "done", url: job.url }
                : job.state === "failed"
                  ? { state: "failed", message: job.error || "转存失败" }
                  : { state: "pending" };
            out = JSON.stringify(parsed);
          } catch (e) {
            // 登记失败不打断轮询（出片本身是成功的）。**不挂 transfer 字段** = 客户端
            // 按"老服务端"退回它自己的兜底转存——降级有路可走，且这边留了日志（铁律八）。
            console.error(`[ark] 轮询自动转存登记失败 task=${req.params.id}:`, e.message);
          }
        }
      }
    }
    return res.status(status).type("application/json").send(out);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/ark/task-charges/:taskId —— 我的某一发任务的钱怎么样了（2026-10-07，失败退款）：
 *   `{ ok, taskId, provider, kind, state, tokens }`，state ∈ pending（还不知道结局）/ refunding / refunded / settled（出成了，钱照收）/
 *   skipped（没有要退的：管理员免单）/ lost（一直问不出结局，交人工）。查不到（不是你的 / 自动退款上线之前的任务）→ 404。
 * App 在对一发过期没取回的任务说「已经花掉的钱无法挽回」之前先问它（那一发可能早被清扫器退了钱）。
 * ★ 只给本人（按账的 user 查）；不计费、走轮询那个限流桶；不替你去问上游（那是清扫器的事，这里只读账）。
 */
router.get("/task-charges/:taskId", requireAuth, pollLimit, async (req, res, next) => {
  try {
    if (!TASK_ID_RE.test(req.params.taskId)) return res.status(400).json({ ok: false, message: "bad task id" });
    const row = await taskRefund.chargeOf(req.params.taskId, req.user._id);
    if (!row) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "没有这一发任务的扣费记录" });
    return res.json({ ok: true, taskId: row.taskId, provider: row.provider, kind: row.kind, ...taskRefund.refundView(row) });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/ark/video-tasks —— 这个账号最近 24 小时提交过的视频任务（服务端登记，见 models/ArkVideoTask）。
 * App 冷启动拿它把本机不认识的任务补成「待取回」凭据；取回本身仍走 GET tasks/:id（不计费）。
 * ★ 不计费、走轮询那个限流桶：它与轮询同一量级（冷启动一次、进创作入口一次）。
 */
router.get("/video-tasks", requireAuth, pollLimit, async (req, res, next) => {
  try {
    res.json({ ok: true, tasks: await arkVideoTask.listVideoTasks(req.user._id) });
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

/** 阻塞形态的等待预算：老客户端（已装机 APK）那头是 180s 超时，这边要抢在它前面
 *  给出可读的答复，而不是让它掐线后只留一句英文 AbortError。 */
const TRANSFER_WAIT_BUDGET_MS = 165_000;

/**
 * POST /api/ark/transfer-video —— 把方舟成片转存成永久地址（Cloudinary）。
 *
 * ★ 为什么存在：videoUrl 揣着 TOS 直链到发布才转存，而预览/合并都在发布之前。
 *   跨境用户直连 TOS 的下载速度（实测 1.06 MB/s）低于成片码率 —— 预览黑屏干等、
 *   合并的代理抓取超时（2026-08-20 真机实测）。换成全球 CDN 地址三条路一起变快。
 * ★ 2026-08-21 起搬运本体挪进 **arkTransfer.service 的后台任务**（真机复盘：同步搬完
 *   再应答的形态在弱网手机上 180s 都等不完，超时=静默失败）。本端点收两种形态：
 *     · 缺省（老客户端）：阻塞等登记表出结果，预算内搬完回 {url}，否则 502 + 中文原因
 *       ——语义与老实现一致，但搬运**不会**随请求超时而废掉，下次再问就是现成的；
 *     · body.wait === false（受理式）：立即 202 {state,url?,message?}，进展由
 *       POST /transfer-video/status 或轮询端点的 transfer 字段拿。
 *   同一个产物三个入口（轮询自动转存/受理式/阻塞式）在登记表上去重，只搬一次。
 * ★ 不计费：它不产生算力消耗，只是把已经付过钱的产物搬个家。但它重
 *   （最多拉 80MB + 传 Cloudinary），所以挂 genLimit（30 次/窗口）而不是 pollLimit ——
 *   正常用法一段只踢一脚，30 已经宽裕；放 90 等于给带宽开洞。
 * ★ 白名单 + assertPublicUrl 与 /asset 同一套：允许任意域就是公开搬运代理 + SSRF。
 */
router.post("/transfer-video", requireAuth, genLimit, async (req, res) => {
  const raw = String((req.body && req.body.url) || "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ message: "bad url" });
  }
  if (parsed.protocol !== "https:" || !videoAsset.isArkVideoUrl(raw)) {
    return res.status(400).json({ message: "host not allowed" });
  }
  try {
    await assertPublicUrl(raw); // DNS 层兜底：解析到内网的一律拒绝
  } catch {
    return res.status(400).json({ message: "host not allowed" });
  }
  try {
    if (req.body?.wait === false) {
      const job = await arkTransfer.requestTransfer(raw, req.user._id);
      return res.status(202).json(
        job.state === "done"
          ? { state: "done", url: job.url }
          : job.state === "failed"
            ? { state: "failed", message: job.error || "转存失败" }
            : { state: "pending" }
      );
    }
    const job = await arkTransfer.waitTransfer(raw, req.user._id, TRANSFER_WAIT_BUDGET_MS);
    if (job?.state === "done" && job.url) return res.json({ url: job.url });
    if (job?.state === "pending") {
      // 预算用完还没搬完 ≠ 失败：后台还在搬。这句话老客户端会原样显示在进度行里，
      // 所以必须说清"直链先顶着、稍后自动换上"，不能只给一个英文码（铁律八）。
      return res.status(502).json({ message: "转存还在后台进行——先用方舟临时链接，合并/发布时会自动换成长期地址" });
    }
    console.warn("[ark] transfer-video 失败:", (job && job.error) || "unknown");
    return res.status(502).json({ message: "transfer failed" });
  } catch (e) {
    // 失败不装死：客户端据此退回方舟直链（24h 内仍可用），发布时老路会再试一次
    console.warn("[ark] transfer-video 失败:", (e && e.message) || e);
    return res.status(502).json({ message: "transfer failed" });
  }
});

/**
 * POST /api/ark/transfer-video/status —— 批量查转存进展（只读，不登记不搬运）。
 * body = { urls: string[] }（≤24 条），响应 { results: { [原样传入的 url]: {state,url?,message?} } }，
 * 没登记过的是 {state:"none"}。挂 pollLimit（90/min）：剪辑页合并前自救每 5s 问一轮
 * （一轮一个请求，段数打包在 body 里），与出片轮询同一个量级。
 * ★ 用 POST 装 body 而不是 GET 拼 query：一批最多 24 条 2000 字节的 URL，塞 query
 *   会顶穿各层的 URL 长度上限，而且日志里整串铺开毫无可读性。
 */
router.post("/transfer-video/status", requireAuth, pollLimit, async (req, res, next) => {
  try {
    const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 24).map((u) => String(u).slice(0, 2000)) : [];
    const results = await arkTransfer.statusOf(urls);
    return res.json({ results });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
