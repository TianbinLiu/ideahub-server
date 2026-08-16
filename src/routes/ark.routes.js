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
 *    但另有一道套餐门禁挡着免费用户，见 billedForward）。
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
const { SEEDANCE_2_5, IMAGE_MODELS, VIDEO_MULT_R2V, audioSupported } = require("../config/tokens");
// 白模模板：r2v 结算按参考视频 URL 反查登记（resolveR2v），试炼闸靠任务追踪（noteR2vOutcome）
const BranchTemplate = require("../models/BranchTemplate");
const BranchTemplateTrial = require("../models/BranchTemplateTrial");
const { cloudinary } = require("../config/cloudinary");
// 归属与「裁剪变换 URL」的形状判据只有一处（铁律六）
const { parseOwnClipUrl } = require("../utils/templateVideoAsset");
const {
  templateVideoMeta,
  templateRefDurationIssue,
  // ★ 分支二判的是**白模化的输入**（下限 5），不是参考视频窗口（下限 4）——
  //   两处差一秒就等于留了一条绕行路：老客户端可以从 /api/ark 这条路把 4 秒的白模化发出去
  blockoutInputIssue,
  secText,
  TEMPLATE_REF_RULES,
} = require("../middleware/upload");
// ★★ 「扣钱 → 转发 → 没受理就退」这条序列的唯一实现在 services/arkGateway ——
//   白模化端点（routes/branchTemplate）自己也要发方舟请求，两处各写一遍就是两套记账。
const { callArk, chargedArkCall, arkConfigured, T_CREATE, T_POLL } = require("../services/arkGateway.service");

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
  // 免费套餐一律拒（判据在 config/tokens.paidOnlyDenial，执行在 services/arkGateway）。
  SEEDANCE_2_5,
  "doubao-seed-2-1-turbo-260628",      // 豆包对话 / 看图说话
  "doubao-seed3d-2-0-260328",          // Seed3D 图生 3D
]);

/** 方舟任务 id 的字符集。直接拼进上游 URL 的东西一律先收口（铁律六的同一条口径） */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
  res.json({ ok: true, ark: arkConfigured() });
});

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
      if (out.accepted && req.r2v?.templateId) {
        try {
          const parsed = JSON.parse(out.text || "{}");
          const taskId = String(parsed?.id || "");
          if (TASK_ID_RE.test(taskId)) {
            await BranchTemplateTrial.create({ taskId, templateId: req.r2v.templateId, userId: req.user._id });
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

/** Seedream 出图。★ **按 body.model 计价**（三档差 3 倍：13,333 / 16,667 / 40,000），
 *  不是一口价——写成常量就是"顶档按最低档收费"，零症状白送。见 config/tokens.imageTokensOf */
router.post("/images/generations", requireAuth, genLimit, billedForward("image", "/images/generations", T_CREATE));

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

    /** 计价结论（下面两条分支各自填一份，参数钉子对两者一视同仁） */
    let verdict = null;

    if (tpl) {
      // blocked = 平台已下架：继续可用的话「事后治理」就没有牙齿
      if (tpl.status === "blocked") {
        return deny("这个白模模板已被平台下架，暂时不能用它出片——当前请求未被受理，也没有扣费。");
      }
      // 未发布的模板只有作者本人能用（那正是发布前的「试炼」一步）；
      // 别人拿到 URL 也不能蹭 —— 市场只暴露 published，这里是同一条边界的服务端实现
      if (tpl.status !== "published" && String(tpl.ownerId) !== String(req.user._id)) {
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

    // ★★ 把 r2v 的**生成参数钉死在计价假设上**，不符整句 400。
    //   计价是 (登记时长×2)×720p×24fps（tokens.r2vTokens），成立的前提是
    //   edit 子任务 + duration:-1（输出≈输入）+ 720p —— 这三件只有客户端
    //   BLOCKOUT_TASK 在遵守，而代理是原样转发的：不在这里钉，改一行客户端
    //   就能按 4s 模板的价买 30s/1080p 的产出（reference 子任务 duration 自由、
    //   -1 会推到 30s 上界，A7 实测），差额全进我们的方舟账单，memo 还与正常
    //   r2v 一模一样，零症状。「不信客户端报的任何数」在这条路上就是这四行。
    const dur = req.body?.duration;
    if (req.body?.omni_reference_task_type !== "edit") {
      return deny("白模出片只支持 edit 参考子任务——当前请求未被受理，也没有扣费。");
    }
    if (dur !== undefined && dur !== -1) {
      return deny("白模出片的时长跟随模板视频（duration 只能是 -1）——当前请求未被受理，也没有扣费。");
    }
    const resl = req.body?.resolution;
    if (resl !== undefined && resl !== "720p") {
      return deny("白模出片目前只支持 720p——当前请求未被受理，也没有扣费。");
    }
    const ratio = req.body?.ratio;
    if (ratio !== undefined && ratio !== "adaptive") {
      return deny("白模出片的画幅跟随模板视频（ratio 只能是 adaptive）——当前请求未被受理，也没有扣费。");
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
  const hit = content.some(
    (e) => e && e.video_url?.url && parseOwnClipUrl(String(e.video_url.url).slice(0, 2000), String(req.user._id)),
  );
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
 * 轮询响应的试炼闸挂钩：r2v 任务 succeeded 且发起人就是模板作者 → 置 provenAt。
 * 证据链两头都在服务端（受理时的追踪记录 + 方舟自己吐的 succeeded），
 * 轮询者是谁无关紧要 —— 追踪里记的是**创建任务**的人。
 * ★ 任何失败都不打断轮询响应（出片进行中的用户不该因为我们的记账问题看到报错），
 *   但要吼出来：吞掉的话作者会遇到"出片成功却还是不能发布"，查无可查（铁律八）。
 */
async function noteR2vOutcome(taskId, text) {
  let parsed;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    return; // 上游给的不是 JSON —— 轮询端点会原样透传，这里不掺和
  }
  if (parsed?.status !== "succeeded") return;
  try {
    const trial = await BranchTemplateTrial.findOne({ taskId }).lean();
    if (!trial) return; // 非 r2v 任务（绝大多数轮询），零额外开销地走人
    const tpl = await BranchTemplate.findById(trial.templateId).select("ownerId provenAt").lean();
    if (tpl && !tpl.provenAt && String(trial.userId) === String(tpl.ownerId)) {
      await BranchTemplate.updateOne({ _id: tpl._id, provenAt: null }, { $set: { provenAt: new Date() } });
      console.log(`[ark] 白模模板试炼通过 tpl:${trial.templateId} task:${taskId}`);
    }
    // 任务已出结果，追踪的使命结束（TTL 只是兜底）；消费者的任务同样清掉
    await BranchTemplateTrial.deleteOne({ taskId });
  } catch (e) {
    console.error(`[ark] r2v 试炼记录处理失败 task=${taskId}:`, e.message);
  }
}

/** Seedance 出视频 / Seed3D 建模（同一个异步任务端点）。
 *  两者单价差一个数量级（一段 720p 视频约 216k，一次建模 160k），按 body.model 分别定价 */
router.post(
  "/contents/generations/tasks",
  requireAuth,
  genLimit,
  limitUnregisteredR2v,
  resolveR2v,
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
      path: `/contents/generations/tasks/${req.params.id}`,
      timeoutMs: T_POLL,
    });
    // 白模模板的试炼闸：succeeded 的 r2v 任务在这里被看见（只有 status 为 succeeded 的
    // 响应才会碰库，running/queued 的高频轮询零额外开销）。失败只吼不打断轮询。
    if (status === 200) await noteR2vOutcome(req.params.id, text);
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
