// src/routes/branchTemplate.routes.js
// 白模模板（blockout r2v）：建 / 市场列表 / 详情 / 发布 / 下架 / 删除。
// 挂在 /api/branch 下（与 branchVideo / branchAsset 同一 base，路径不重叠）：
//   app.use("/api/branch", require("./routes/branchTemplate.routes"));
//
// 生命周期与闸门（每道闸门只有一处实现，铁律六）：
//   上传视频（uploads.routes /template-video，回执复核）
//   → 建模板 status=pending，两条路二选一：
//       · V1 登记（本文件：videoUrl 三重白名单 + 服务端向 Cloudinary 取元数据）
//       · V2 白模化（本文件，**两阶段**：blockoutize 开炼落取件凭据 → blockoutize/finish 取回建模板）
//   → 作者自己付费出一次片（ark.routes 的 r2v 追踪在轮询到 succeeded 时置 provenAt）
//   → （白模 V2 多一步）作者核对角色位编号（本文件：PATCH /templates/:id/roles）
//   → 发布（本文件：**两道独立的门** —— provenAt 非空 + 编号已核对）status=published → 上市场
//   平台下架（blocked）走管理端（后续另接），作者 publish/unpublish 都动不了它。
const router = require("express").Router();
const mongoose = require("mongoose");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const {
  createTemplateBody,
  blockoutizeBody,
  finishBlockoutizeBody,
  patchRolesBody,
} = require("../schemas/branchTemplate.schemas");
const BranchTemplate = require("../models/BranchTemplate");
// 白模 V2 的**取件凭据**（两阶段的分界线）。为什么非拆不可见该文件的文件头
const BlockoutJob = require("../models/BlockoutJob");
const { cloudinary } = require("../config/cloudinary");
const { templateVideoMeta, templateRefIssue } = require("../middleware/upload");
const { forbidden, notFound, invalidId, badRequest } = require("../utils/http");
// ★ 归属与地址形状的判据**只有 utils/templateVideoAsset 一处**（铁律六）——
//   此前这里、uploads.routes、以及 V2 要加的 resolveR2v 各写一份，松一份就有一条绕行路
const {
  parseOwnTemplateVideoUrl,
  ownedCloudinaryAsset,
  ownTemplateVideoPublicId,
  buildClipUrl,
  buildFrameUrl,
} = require("../utils/templateVideoAsset");
const { chargedArkCall, T_CREATE } = require("../services/arkGateway.service");
const blockout = require("../services/blockoutize.service");
const { SEEDANCE_2_5, VIDEO_MULT_R2V, paidOnlyDenial } = require("../config/tokens");
const wallet = require("../services/tokenWallet.service");
// 「谁是管理员」全仓只有 utils/roles 一处判据（铁律六）
const { isAdmin } = require("../utils/roles");

/**
 * 角色位怎么出到响应里 —— **一处实现**（模板详情与白模化受理回执共用）。
 *
 * ★ `labelConfirmed` 只有明确 `true` 才算核对过：存量 V2 模板那一项是 `undefined`，
 *   按未核对出，与 BranchTemplate.rolesNeedConfirm 同一条口径 ——
 *   两处分家会让界面（显示"已核对"）与闸门（拒绝发布）打架，而两边各自看着都没错。
 * ★ 白模化受理回执里那份是**草案**（还没有模板），形状仍与模板里的一模一样：
 *   App 侧那个角色位列表组件两处共用，形状分家就得写两个渲染器，迟早只改一个。
 */
function rolesPayload(roles) {
  return (Array.isArray(roles) ? roles : []).map((r) => ({
    label: String(r.label || ""),
    desc: String(r.desc || ""),
    labelConfirmed: r.labelConfirmed === true,
  }));
}

/** 响应形状。cloudinaryPublicId 刻意不出（纯内部回收记账，客户端拿它没有正当用途） */
function toTemplatePayload(doc, viewer) {
  if (!doc) return null;
  return {
    _id: doc._id,
    id: String(doc._id),
    ownerId: String(doc.ownerId),
    authorName: doc.authorName || "",
    title: doc.title || "",
    intro: doc.intro || "",
    coverUrl: doc.coverUrl || "",
    recipe: {
      styleHint: doc.recipe?.styleHint || "",
      beats: Array.isArray(doc.recipe?.beats) ? doc.recipe.beats : [],
      durationSec: Number(doc.recipe?.durationSec || 5),
      videoTier: doc.recipe?.videoTier || "",
      aspect: doc.recipe?.aspect,
      framePrompt: doc.recipe?.framePrompt || "",
    },
    refVideo: {
      url: doc.refVideo?.url || "",
      durationSec: Number(doc.refVideo?.durationSec || 0),
      width: Number(doc.refVideo?.width || 0),
      height: Number(doc.refVideo?.height || 0),
      bytes: Number(doc.refVideo?.bytes || 0),
    },
    // 角色位（白模 V2）。★ **只在真有的时候出这个字段**：V1 老模板一个角色位都没有，
    //   回一个空数组会让客户端分不清"这是老模板"和"新模板但一个人都没认出来"
    //   （后者根本建不出来 —— 见 blockoutize 的「roles 为空整句拒」）。
    //   客户端判它一律用存在性（`roles?.length`），别用等值。
    ...(Array.isArray(doc.roles) && doc.roles.length ? { roles: rolesPayload(doc.roles) } : {}),
    // ★ source **刻意不出**：它指向作者自己上传的原始素材（可能是有版权的片子），
    //   把 public_id 发给每个逛市场的人没有任何正当用途（同 cloudinaryPublicId）。
    status: doc.status,
    provenAt: doc.provenAt ?? null,
    // 身份判定只认 ownerId 对当前账号，绝不拿显示名（CLAUDE.md「拿名字当身份」坑）
    isOwner: viewer ? String(doc.ownerId) === String(viewer._id) : false,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── 建模板 ──────────────────────────────────────────────────────────
// ★ 限流比一般 CRUD 严：每次建模板都要向 Cloudinary Admin API 发一次资源详情查询
//   （免费档 Admin API 全局只有 500 次/小时），不限的话一个账号就能把整个 App 的
//   建模板能力刷停摆。5 次/分对真人绰绰有余（建一个模板前后要传视频、写介绍）。
const createLimit = userRateLimit({ max: 5, windowMs: 60 * 1000, scope: "branchTemplate:create" });

router.post("/templates", requireAuth, createLimit, validate({ body: createTemplateBody }), async (req, res, next) => {
  try {
    const own = parseOwnTemplateVideoUrl(req.body.videoUrl, req.user._id);
    if (!own) {
      badRequest("模板视频地址无效：必须是你本人刚通过「上传模板视频」传到本站的地址，别处的链接不能登记。");
    }

    // ★★ 元数据**只从 Cloudinary 取**，不收客户端报的任何数（zod schema 里压根没这些字段）。
    //   durationSec 是 r2v 结算的输入时长 —— 信客户端等于让用户自己标价。
    //   顺带这一步也验了「资源真的存在」：上传后被复核 destroy 掉的、编出来的地址，
    //   在这里都会 404。
    let resource;
    try {
      // ★ media_metadata: true 是**必须的**，不是锦上添花：Admin API 对视频默认只回
      //   width/height/bytes，**不回 duration**（2026-08-14 生产实测——上传回执带时长、
      //   资源详情却不带，测试的 mock 把这层差异盖住了，第一发真登记就 400）。
      //   duration 正是 r2v 结算的输入时长，缺它整个登记不成立。
      resource = await cloudinary.api.resource(own.publicId, { resource_type: "video", media_metadata: true });
    } catch (e) {
      const http = e?.error?.http_code ?? e?.http_code;
      if (http === 404) {
        badRequest("找不到这段模板视频（可能未上传成功或已被回收），请重新上传后再登记。");
      }
      // 其它错误（配置缺失 / Cloudinary 挂了）：响亮报出去，不静默、不猜数
      console.error(`[branchTemplate] Cloudinary 资源详情读取失败 public_id=${own.publicId}:`, e?.error?.message || e.message);
      return res.status(502).json({ ok: false, message: "云端视频信息读取失败，模板没有创建，请稍后重试。" });
    }

    // ★★ 这里复核的是**参考视频**那套窗口（templateRefIssue，[4,30]s + F3 像素/边长/比例），
    //   不是上传口那套 —— V2 起两者不同：上传口收的是"任意原始素材"（(0,600]s、不校比例），
    //   而这条 V1 登记路把**整段原片直接当参考视频**用，它必须满足方舟 edit 的硬约束。
    //   拿上传口那套松窗口复核的话，一段 300s 的素材会被登记成模板，然后每个套用它的人
    //   在付费出片那一步撞 400 —— 而方舟受理后失败是不退费的。
    const meta = templateVideoMeta(resource);
    const issue = templateRefIssue(meta);
    if (issue) badRequest(issue);

    let doc;
    try {
      doc = await BranchTemplate.create({
        ownerId: req.user._id,
        // 显示快照由服务端从登录态取，不收客户端报的名字（身份判定始终走 ownerId）
        authorName: req.user.username || "",
        title: req.body.title,
        intro: req.body.intro,
        coverUrl: req.body.coverUrl,
        recipe: req.body.recipe,
        refVideo: {
          // ★ 存 Cloudinary 给的 secure_url（规范形态），不存客户端传的原串：
          //   unique 索引与 r2v 结算反查都按这个字符串等值匹配，
          //   存原串的话塞一段 transformation 就能绕开去重
          url: resource.secure_url,
          durationSec: meta.duration,
          width: meta.width,
          height: meta.height,
          bytes: meta.bytes,
          cloudinaryPublicId: own.publicId,
        },
        status: "pending",
        provenAt: null,
      });
    } catch (e) {
      if (e?.code === 11000) {
        // refVideo.url 唯一索引：一段视频只许挂一个模板（重复登记多半是重试/误操作）
        return res.status(409).json({ ok: false, message: "这段视频已经登记过一个模板了，请直接使用那一个，或换一段视频。" });
      }
      throw e;
    }

    res.status(201).json({ ok: true, template: toTemplatePayload(doc.toObject(), req.user) });
  } catch (err) {
    next(err);
  }
});

// ── 白模化：任意视频 → 带编号的白模模板（白模 V2，**两阶段**）─────────
//
//   阶段一 POST /api/branch/templates/blockoutize          ①~⑥ + 落取件凭据（钱在这里花掉）
//   客户端自己轮询 GET /api/ark/contents/generations/tasks/:id（不计费、已有限流桶）
//   阶段二 POST /api/branch/templates/blockoutize/finish   ⑦~⑨（核实 → 转存 → 建模板）
//   掉线兜底 GET /api/branch/templates/blockoutize/pending 列出还没取回结果的凭据
//
// 用户在编辑页框出「哪一段 + 画面哪一块」，提交**四组数**（startSec/durSec/crop），
// 阶段一走六步：
//   ① 归属校验 → ② 服务端自己拼 Cloudinary 变换 URL → ③ 预热（F9）
//   → ④ 复核裁后元数据满足方舟约束（F1/F3）→ ⑤ chat vision 先看一眼列出画面里有谁（F4 的"先看"，
//        看几帧由 blockout.visionFrameTimes 一处说了算：自动按时长算 3~8 帧，或用户自己标）
//   → ⑥ 点名式提示词发 r2v edit（F4 的"点名"），**到"方舟受理了"为止**
// 阶段二走三步：⑦ 向方舟核实任务状态 → ⑧ 产物转存 Cloudinary（F12）→ ⑨ 建模板 status=pending。
//
// ══ 为什么要拆（2026-08-16，拆之前是一条同步长请求）══════════════════
// 拆之前这九步在**同一条 HTTP 请求**里跑完，中间含最长 5 分钟的服务端轮询。而这条链路的
// 钱是在**中途**花掉的（看帧一笔 + r2v 受理一笔，受理后失败不退，F11）—— 于是手机切后台、
// 弱网断线、App 进程被系统回收、nginx 超时掐断，任何一条都会让用户**丢掉这一发的结果，
// 而钱已经花了**，我们这边的日志里却是一次成功。一条要等五分钟的请求本身就是脆的：
// 它把"钱已经付了"和"东西拿到了"绑在同一个 TCP 连接的命上。
// 拆成两阶段之后，「结果」变成一件**可以再来取**的东西（凭据见 models/BlockoutJob.js）。
//
// ★★ 为什么这一整条必须在服务端：变换 URL 里的 `du_` 就是 r2v 的计价输入时长
//   （方舟公式把输入视频时长计进 token）。让客户端拼 URL = 让用户自己标价。
//   客户端从头到尾拿不到这个地址。
//
// ★★ 这条路**花两次真钱**：⑤ 一次 chat（看帧）+ ⑥ 一次 r2v 出片。两笔都走
//   services/arkGateway 的同一条计费序列（与 /api/ark 代理**同一份实现**）。
//   ⑥ 一旦被方舟受理，**失败也不退费**（F11：含真人人脸的视频创建时不拒、
//   跑到一半才 failed）—— 所以 App 必须在开炼前就把这句话整句写给用户看。
const BLOCKOUT_MODEL = SEEDANCE_2_5;
/** 看帧用的对话模型。与 app 的 MODELS.chat 同一个 id（看图说话走同一个模型） */
const VISION_MODEL = "doubao-seed-2-1-turbo-260628";
// ★ 「看几帧」原来是这里一个写死的 `VISION_FRAMES = 3`。2026-08-15 实测：4 秒素材看 3 帧
//   只认出 2 个人，方舟出片时看到更多人**自己编到了 3 号** —— 画面上有 3 号、角色位列表
//   里没有第三格，套用者挂不上卡且零报错。现在帧数按时长算 / 由用户自选，规则的**唯一实现**
//   是 services/blockoutize.visionFrameTimes（报价的 App 镜像也照抄它）。

/**
 * 「看帧那一笔已经花掉且不退」这句话的**唯一措辞**（铁律六）。
 *
 * ★★ 这条链路花的是**两笔**结构不同的钱：⑤ 看帧（chat，CHAT_TURN_TOKENS）与
 *   ⑥ 出片（r2v）。W2 只退"上游没受理"的那一笔 —— 看帧那一次是**受理了的**
 *   （它成功吐出了人物清单），所以只要走到 ⑤ 之后，看帧这笔就一定花了、一定不退。
 * ★ 于是 ⑤ 之后的每一条失败都必须**分开说**两笔钱：一句笼统的"费用已原路退回"
 *   覆盖不了两笔结论相反的账，那是在钱上撒谎（铁律八）。措辞收在这一个常量里，
 *   免得三处各写一句、改一处漏两处（2026-08-15 对抗审查 #4/#9 的起因就是各写各的）。
 */
const VISION_BILLED_NOTE = "看画面那一步的费用已经产生、无法退回";

// ★ 限流比建模板更严：一发要打 1 次 Cloudinary Admin API（免费档全局 500 次/小时）、
//   3~8 次抽帧（帧数按时长算或由用户自选，见 blockout.visionFrameTimes）、1 次 chat、1 次 r2v，
//   每一发都是真金白银。
//   3 次/10 分钟对真人足够（框选 + 等出片本身就要几分钟）。
const blockoutizeLimit = userRateLimit({ max: 3, windowMs: 10 * 60 * 1000, scope: "branchTemplate:blockoutize" });

/** 取回结果的限流。★ 比开炼松得多（它**不花钱**，只做一次方舟查询 + 一次转存），
 *  但不能不限：转存是一次 100MB 级的出网，拿它当循环打同样能把出网账单打洞。
 *  20 次/5 分钟 —— 正常路径是"出片了点一次"，重试几次也远够。 */
const blockoutFinishLimit = userRateLimit({ max: 20, windowMs: 5 * 60 * 1000, scope: "branchTemplate:blockoutFinish" });

/** 「还有哪些没取回」列表的限流。纯本库查询，给一个防呆值即可 */
const blockoutPendingLimit = userRateLimit({ max: 30, windowMs: 60 * 1000, scope: "branchTemplate:blockoutPending" });

/** 整句失败 —— 全 app 没有任何地方监听 emitApiError，只回错误码等于让用户对着转圈干等（铁律八）。
 *
 * ★★ `billed` 的语义在两阶段里必须**分得开**，别把两件事混成一位：
 *   · 阶段一（开炼）：r2v 一旦被方舟受理就是 `billed:true` —— 受理后失败不退（F11）；
 *   · 阶段二（取回结果）：**它自己一分钱都不花**（核实任务、转存、建模板都不计费），
 *     所以它的失败一律 `billed:false` —— 那是「这次没取到」，不是「又花了一笔」。
 *     写成 true 的话，用户会以为每点一次「取回结果」就再扣一笔钱，于是不敢重试 ——
 *     而重试恰恰是我们拆两阶段给他的那条活路。
 *   · 钱确实没了的那两种终局（产物过期、方舟受理后 failed）另有 `lost:true` 一位，
 *     并且**话要说满**（见 BlockoutJob.stateOf 的整句）。
 */
function fail(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, message, ...extra });
}

router.post(
  "/templates/blockoutize",
  requireAuth,
  blockoutizeLimit,
  validate({ body: blockoutizeBody }),
  async (req, res, next) => {
    try {
      const userId = String(req.user._id);
      const { startSec, durSec, crop, title, intro, coverUrl, videoTier, aspect, note, frameTimes } = req.body;

      // ── ① 归属校验（判据只有 utils/templateVideoAsset 一处）────────────
      const publicId = ownTemplateVideoPublicId(req.body.publicId, userId);
      if (!publicId) {
        return fail(res, 400, "素材地址无效：只能用你本人刚通过「上传视频」传到本站的素材，别处的链接不能用。", { billed: false });
      }
      // 同一段素材不许做两次：refVideo 的 url 唯一索引会在最后一步才拦，
      // 那时钱已经花掉了 —— 在开炼之前就问一次
      const used = await BranchTemplate.exists({
        $or: [{ "refVideo.cloudinaryPublicId": publicId }, { "source.publicId": publicId }],
      });
      if (used) {
        return fail(res, 400, "这段素材已经做过白模模板了，请直接使用那一个，或换一段素材。", { billed: false });
      }
      // ★★ 两阶段专有的一道：**还没取回结果**的那一发也占着这段素材。
      //   拆开之前，"做过了"等价于"库里有模板"；拆开之后，从受理到取回之间有一段
      //   **世上还没有模板**的窗口 —— 不问这一句的话，用户在等出片时手一抖再点一次，
      //   同一段素材就被扣**第二笔** r2v 的钱（几十万 token），而两发都会成功，
      //   他只会看到"怎么多了一个一模一样的模板"，完全对不上那笔账。
      const running = await BlockoutJob.findOne({
        "source.publicId": publicId,
        status: { $in: ["pending", "claimed"] },
        expiresAt: { $gt: new Date() },
      })
        .select("_id")
        .lean();
      if (running) {
        return fail(
          res,
          400,
          "这段素材已经有一发白模化在进行中了（费用已经产生）。请到「待取回的白模」里把那一发的结果取回来，别重复开炼——重开一发会再花一笔钱。",
          { billed: false, jobId: String(running._id) },
        );
      }

      // ── 钱的门禁前置：套餐不够格就别让他等完整条链路 ────────────────
      // ★ 排在**任何一次付费调用之前**：排在后面的话，免费用户会先被扣掉看帧那 400 token，
      //   然后在 r2v 那一步撞 403，而他看到的错误信息与真正的原因对不上。
      if (VIDEO_MULT_R2V[BLOCKOUT_MODEL] === undefined) {
        // 配置错（价目表里没有这一档）。响亮报出去，绝不静默落回别的系数
        console.error(`[blockoutize] ${BLOCKOUT_MODEL} 不在 VIDEO_MULT_R2V 价目表里，白模化整条不可用`);
        return fail(res, 503, "白模功能暂时不可用（服务端价目未就绪），本次没有扣费，请稍后再试。", { billed: false });
      }
      const w0 = await wallet.getWallet(req.user._id);
      // ★ 管理员免单那一路要跳过套餐门禁 —— 判据只有 utils/roles 一处，
      //   与 services/arkGateway 里那一段逐字同理：那道门守的是"钱"，
      //   对一个根本不花钱的人守它没有意义。不跳的话，挂在免费档上的管理员账号
      //   在这里被 403，而同一发走 /api/ark 却是通的（两处行为分家）。
      const denied = isAdmin(req.user) ? null : paidOnlyDenial(w0?.planId, BLOCKOUT_MODEL);
      if (denied) {
        // 403 而不是 402：充值解决不了，得换套餐（与 /api/ark 同一条口径）
        return fail(res, 403, denied, { code: "PLAN_REQUIRED", planId: w0?.planId ?? null, billed: false });
      }

      // ── ④ 前置：现查原片元数据（四组数要靠它校）──────────────────────
      let resource;
      try {
        // ★ media_metadata: true 是**必须的**：Admin API 对视频默认只回 width/height/bytes，
        //   **不回 duration**（2026-08-14 生产实测，测试里的 mock 盖住了这层差异）。
        //   没有 duration 就没法判"选的这一段有没有超出片长"。
        resource = await cloudinary.api.resource(publicId, { resource_type: "video", media_metadata: true });
      } catch (e) {
        const http = e?.error?.http_code ?? e?.http_code;
        if (http === 404) {
          return fail(res, 400, "找不到这段素材（可能未上传成功或已被回收），请重新上传后再试。", { billed: false });
        }
        console.error(`[blockoutize] Cloudinary 资源详情读取失败 public_id=${publicId}:`, e?.error?.message || e.message);
        return fail(res, 502, "云端视频信息读取失败，本次没有开始生成、也没有扣费，请稍后重试。", { billed: false });
      }
      const src = templateVideoMeta(resource);
      if (!Number.isFinite(src.duration) || !Number.isFinite(src.width) || !Number.isFinite(src.height)) {
        return fail(res, 400, "云端没有返回这段素材的时长或尺寸，无法裁剪，请换一个 mp4/mov 文件重试。", { billed: false });
      }
      // 四组数：裁剪框必须落在画面里、选段必须落在片长里。
      // ★ 为什么非查不可：`c_crop` 超出画面时 Cloudinary 会**自己裁到边界**而不是报错，
      //   于是方舟收到的尺寸与我们按 w_/h_ 预检的那个不一样 —— F3 预检就白做了，
      //   用户在付费那一步才撞 400。
      if (crop.x + crop.w > src.width || crop.y + crop.h > src.height) {
        return fail(res, 400, `裁剪框超出了画面（原片 ${src.width}×${src.height}），请重新框选。`, { billed: false });
      }
      if (startSec + durSec > src.duration) {
        return fail(res, 400, `选的这一段超出了视频长度（原片约 ${src.duration} 秒），请重新框选。`, { billed: false });
      }
      // 裁后那一段必须满足方舟 edit 的硬约束（时长 [4,30]、像素/边长/比例）。
      // 窗口的唯一实现在 middleware/upload.js —— 这里只是把同一份规则用在裁后的数上。
      const clipIssue = templateRefIssue({ duration: durSec, width: crop.w, height: crop.h }, "选中的这一段");
      if (clipIssue) return fail(res, 400, clipIssue, { billed: false });

      // ── ② 服务端自己拼变换 URL（客户端永远碰不到）──────────────────
      const clip = { startSec, durSec, crop };
      const clipUrl = buildClipUrl(publicId, clip, resource.version);
      if (!clipUrl) {
        console.error("[blockoutize] Cloudinary 未配置 cloud_name，拼不出变换地址");
        return fail(res, 503, "云存储未配置，白模功能暂时不可用，本次没有扣费。", { billed: false });
      }

      // ── ③ 预热（F9：变换是懒生成的，首次可能拿到不完整的资产）──────
      const warm = await blockout.prewarm(clipUrl, "选中的这一段");
      if (!warm.ok) return fail(res, 502, warm.message, { billed: false });

      // ── ⑤ 先看：抽几帧问一次 chat vision，列出画面里有哪些人（F4 上半）──
      // ★★ 「看几帧」只问 blockout.visionFrameTimes（唯一实现）：自动模式按时长算
      //   （每 1.5s 一帧、下限 3 上限 8），传了 frameTimes 就用用户自己标的那些 ——
      //   但**服务端自己再验一遍**（越界丢弃/去重/排序/截断），不信客户端报的数。
      //   它回的是**片段内的相对秒数**，加上 startSec 才是原片上的绝对时刻（帧地址切的是原片）。
      const times = blockout.visionFrameTimes(durSec, frameTimes).map((t) => startSec + t);
      const images = [];
      for (const atSec of times) {
        const url = buildFrameUrl(publicId, { atSec, crop }, resource.version);
        const got = await blockout.fetchFrameDataUrl(url);
        // 单帧取不到不算失败（8 帧取到 1 帧也认得出人）；一帧都没有才拒
        if (got.ok) images.push(got.dataUrl);
        else console.warn(`[blockoutize] 抽帧失败 ${publicId}@${atSec}s: ${got.reason}`);
      }
      if (!images.length) {
        return fail(res, 502, "没能从这段视频里取到画面（云端还没准备好），本次没有开始生成、也没有扣费，请稍后重试。", { billed: false });
      }
      // ★★ 「实际用了几帧」= **真正喂进模型的那几张**（取不到的帧不算）。App 拿它对账报价：
      //   报价按计划帧数算、这里可能更少 —— 方向永远是「报价 ≥ 实收」，那是安全的一侧。
      //   报计划数就会出现"报价 3 帧、实际只看了 1 帧、却按 3 帧对上账"，把一次降级藏起来。
      const visionFrames = images.length;

      const visionOut = await chargedArkCall({
        user: req.user,
        // ★ 服务端自己发起的调用：白名单收成**恰好一个** model（比代理那份更严）。
        //   model 不是用户可控的，写成 `() => true` 也不会被利用，但那样一来
        //   "这次调用打的是哪个模型"就没有任何代码表达了。
        modelAllowed: (m) => m === VISION_MODEL,
        kind: "chat",
        path: "/chat/completions",
        body: {
          model: VISION_MODEL,
          messages: [
            { role: "system", content: blockout.VISION_SYSTEM },
            {
              role: "user",
              content: [
                { type: "text", text: blockout.visionPrompt(note) },
                ...images.map((url) => ({ type: "image_url", image_url: { url } })),
              ],
            },
          ],
          max_tokens: 1200,
          // 豆包默认开深度思考，实测同一请求 52s → 10s（app 侧 chatVision 同款）
          thinking: { type: "disabled" },
        },
        timeoutMs: T_CREATE,
      });
      if (!visionOut.ok) {
        // 套餐/余额/在册：原样把服务层的整句理由透出去（钱一分没动）
        return res.status(visionOut.status).json({ ...visionOut.body, billed: false });
      }
      if (!visionOut.accepted) {
        // W2 已经把这 400 token 退回来了（arkGateway 里做的）
        return fail(res, 502, "看画面这一步失败了，本次没有开始生成，费用已原路退回，请稍后重试。", { billed: false });
      }
      let roles = [];
      try {
        const parsed = JSON.parse(visionOut.text || "{}");
        roles = blockout.parseRoles(parsed?.choices?.[0]?.message?.content ?? "");
      } catch (e) {
        console.error("[blockoutize] 视觉回包解析失败:", e.message);
      }
      // ★ roles 为空 → 整句拒，**不建一个点不了角色位的空壳模板**：
      //   角色位是套用者挂卡的唯一入口，没有它这个模板只能白模到底，
      //   而用户会以为是"点了没反应"。
      if (!roles.length) {
        return fail(
          res,
          400,
          // 措辞走同一个常量：三处"看帧这笔已经花了"分开写就会各自漂（铁律六）
          `AI 没能在这段画面里认出任何人物，所以做不出可以挂角色卡的白模模板。出片那一笔一分钱没动，但${VISION_BILLED_NOTE}（这一发看了 ${visionFrames} 帧）。请换一段人物更清晰、更靠近镜头的素材再试，或者在编辑页自己多标几帧。`,
          // ★ 不变量：**凡是 `billed:true` 的回包都带 visionFrames**（那一位就是"看帧这笔花了"，
          //   而这个数就是那笔花在几帧上）。反过来 billed:false 的一律不带 —— 没花钱就没有账要对。
          { billed: true, visionFrames },
        );
      }

      // ── ⑥ 点名：发 r2v edit（这一发是真实付费出片）──────────────────
      const taskOut = await chargedArkCall({
        user: req.user,
        modelAllowed: (m) => m === BLOCKOUT_MODEL,
        kind: "task",
        path: "/contents/generations/tasks",
        body: {
          model: BLOCKOUT_MODEL,
          content: [
            { type: "text", text: blockout.blockoutPrompt(roles) },
            { type: "video_url", role: "reference_video", video_url: { url: clipUrl } },
          ],
          // ★ 三件套与计价假设绑死（与 app 的 BLOCKOUT_TASK、服务端 resolveR2v 的钉子同一组）：
          //   edit 子任务 + duration:-1（输出≈输入）+ adaptive。F2 实测：edit 路上显式传
          //   duration/ratio 是同步 400（InvalidParameter.TaskTypeConstraint）。
          omni_reference_task_type: "edit",
          duration: -1,
          ratio: "adaptive",
          resolution: "720p",
          watermark: false,
        },
        // ★ 计价输入时长 = **服务端自己拼 URL 时用的那个 durSec**，不是客户端报的数。
        //   公式仍只在 config/tokens.r2vTokens 一处（这里只把结论递进去）。
        r2v: { templateId: null, durationSec: durSec, sourcePublicId: publicId },
        timeoutMs: T_CREATE,
      });
      // ★★ 这两条路都在**看帧之后**，所以 `billed` 一律是 true（理由见 VISION_BILLED_NOTE）。
      //   2026-08-15 对抗审查抓到这里原来回 billed:false，而同一个文件里「roles 为空」
      //   那条（同样发生在看帧之后）标的是 true —— 两条自相矛盾，客户端照 false 会告诉
      //   用户"一分钱没动"，用户按虚高的余额再开一发，第二次照样被扣看帧那笔钱。
      if (!taskOut.ok) {
        // r2v 那一笔连发都没发出去（套餐门禁 / 余额不足 / 不在册）：它一分钱没动，
        // 但看帧那一笔已经花了。把服务层的整句理由原样留着，后面缀上钱的实情。
        const why = String(taskOut.body?.message || "白模出片这一步没能开始");
        return res.status(taskOut.status).json({
          ...taskOut.body,
          message: `${why}。出片那一笔一分钱没动，但${VISION_BILLED_NOTE}。`,
          billed: true,
          visionFrames,
        });
      }
      if (!taskOut.accepted) {
        // 受理**前**失败（F3 不满足、敏感词、限流）：r2v 那一笔 W2 已原路退回，
        // 看帧那一笔照旧不退。把上游原文透出去，再把两笔钱分别交代清楚。
        let why = "";
        try {
          why = String(JSON.parse(taskOut.text || "{}")?.error?.message || "").slice(0, 300);
        } catch {
          /* 上游不是 JSON：不猜，让下面的通用句子兜住 */
        }
        return fail(
          res,
          502,
          `AI 没有受理这次白模生成${why ? `（${why}）` : ""}。出片那一笔的费用已原路退回，但${VISION_BILLED_NOTE}。本次没有产生任何模板。`,
          { billed: true, visionFrames },
        );
      }
      let taskId = "";
      try {
        taskId = String(JSON.parse(taskOut.text || "{}")?.id || "");
      } catch {
        /* 见下：拿不到任务 id 与"任务没受理"是两件事 */
      }
      if (!taskId) {
        // 已受理却读不到任务 id：钱已经花出去了，只能照实说（不退是事实，不许粉饰）
        console.error("[blockoutize] r2v 任务受理但响应里没有任务 id");
        return fail(res, 502, "AI 已经开始生成，但我们没能拿到任务编号，无法跟进这一发的结果。这一发的费用已经产生、无法退回。", { billed: true, visionFrames });
      }

      // ── ⑦ 落取件凭据：**两阶段的分界线就在这里** ──────────────────────
      //
      // ★★ 到这一行为止钱已经全花掉了（看帧一笔 + r2v 受理一笔，受理后失败不退）。
      //   凭据落不下去 = 用户付了钱却拿不到任何能取回结果的句柄 —— 所以它必须在返回
      //   之前落库成功，落不下要**响亮到能人工兜底**（把 taskId 交给用户），
      //   绝不能只在日志里叹口气然后回 500（那就是把一笔钱静默扔了，铁律八）。
      const startedAt = Date.now();
      let job;
      try {
        job = await BlockoutJob.create({
          ownerId: req.user._id,
          taskId,
          status: "pending",
          expiresAt: new Date(startedAt + BlockoutJob.TTL_MS),
          // ★★ 建模板需要的一切都存在这里，finish **不许让客户端再报一遍**：
          //   durSec 是 r2v 的计价输入时长（重报 = 开炼按 4 秒报价、取件按 30 秒建模板），
          //   roles 是套用者挂卡的唯一依据（重报 = 让提交方自己写"1 号位是谁"）。
          source: { publicId, startSec, durSec, crop },
          roles,
          // ★ 存下来只为**回执能重放**：阶段一重试撞上既有凭据时走的是 startedPayload(exist)，
          //   不存的话那条路回出来的帧数是空的，而 App 拿它对账 —— 一条路对得上、另一条对不上，
          //   两边看着都没错（这正是"同一件事两处各说各的"的形状）。
          visionFrames,
          title,
          intro,
          coverUrl,
          videoTier,
          ...(aspect ? { aspect } : {}),
          // 产物的落点在这里就定死：取回结果是可以重来的一步，每次现取新 id 会在
          // 云端散出孤儿资产（零症状，只有配额账单看得见）
          outPublicId: `${userId}-${startedAt}`,
        });
      } catch (e) {
        if (e?.code === 11000) {
          // taskId 唯一索引：这个方舟任务已经有一张取件单了（只可能是重试撞上）。
          // 回既有那一张 —— 回 500 会让客户端以为这一发废了，而它好好地在方舟那边跑
          const exist = await BlockoutJob.findOne({ taskId, ownerId: req.user._id }).lean();
          if (exist) return res.status(202).json(startedPayload(exist));
        }
        console.error(`[blockoutize] 取件凭据落库失败 task=${taskId}:`, e.message);
        return fail(
          res,
          500,
          `白模生成已经交给 AI 了，但我们没能记下这一发的取件凭据，暂时没法帮你把结果取回来。这一发的费用已经产生、无法退回。请把这个任务编号发给我们：${taskId}`,
          { billed: true, taskId, visionFrames },
        );
      }

      // ★ 202 而不是 201：**什么都还没建出来**。老客户端（等着 201 + template 的那一版）
      //   会当场判失败并把整句 message 显示出来 —— 这正是我们要的"响亮"：它拿不到模板，
      //   就绝不能让它以为拿到了（铁律八）。
      return res.status(202).json(startedPayload(job));
    } catch (err) {
      return next(err);
    }
  },
);

/** 阶段一的受理回执 —— **一处实现**（首次受理与"撞上既有凭据"两条路共用）。
 *  ★ `billed: true`：r2v 已经被方舟受理，这笔钱就已经花了、失败也不退（F11）。
 *    这一位在阶段一是"钱花了没有"，在阶段二是"这一次调用花钱了没有"（恒 false），
 *    两边的措辞都要写满，别让 App 自己去猜。
 *
 *  ★★ `visionFrames` = **这一发实际喂进视觉模型的帧数**（App 拿它对账报价的前一半）。
 *    帧数不再是写死的 3：自动模式按时长算（每 1.5s 一帧、下限 3 上限 8），用户也可以
 *    在编辑页自己标（`frameTimes`）。报价与抽帧共用 blockout.visionFrameTimes 一处规则，
 *    但**中间可能有帧取不到** —— 所以真值只能由服务端回，不能让 App 照自己那半边算完就当真。
 *  ★ 存量凭据（这个字段之前落库的那些）没有这一位，于是**没有就不出**：
 *    回一个 0 会被 App 读成"这一发一帧都没看"，那是句假话。客户端判它一律用存在性。 */
function startedPayload(job) {
  const frames = Number(job.visionFrames);
  return {
    ok: true,
    state: "accepted",
    jobId: String(job._id),
    taskId: job.taskId,
    durSec: job.source.durSec,
    roles: rolesPayload(job.roles),
    expiresAt: job.expiresAt,
    billed: true,
    ...(Number.isFinite(frames) && frames > 0 ? { visionFrames: frames } : {}),
    message:
      "白模生成已经交给 AI 了，费用在这一步就已经产生（AI 受理之后失败也不退费）。" +
      `出片之后回来点「取回结果」才会建成模板；产物只保 ${BlockoutJob.TTL_HOURS} 小时，过期这一发就没法挽回了。`,
  };
}

// ── 阶段二：取回结果 ────────────────────────────────────────────────
//
// POST /api/branch/templates/blockoutize/finish   body { jobId }
//
// 做 ⑦ 向方舟核实 → ⑧ 产物转存 Cloudinary（F12）→ ⑨ 建模板 status=pending。
//
// ★★ 四条硬规矩，每一条拆掉都不报错：
//   ① **自己向方舟核实**，绝不信客户端一句「成功了」（与试炼闸 provenAt 同一条理由）；
//   ② **幂等**：重复取回只会拿到同一个模板。靠两层 —— 先原子认领（status→claimed，
//      挡住并发），再由 `BranchTemplate.blockoutJobId` 的唯一索引兜底。
//      ⚠ 只靠 refVideo.url 的唯一索引是**不够的**：每次转存都是一次新的 Cloudinary
//      上传，secure_url 里带着**新的 version**，两条 URL 并不相等 —— 索引根本不会撞；
//   ③ **归属只认凭据的 ownerId**：别人拿到 jobId 也取不走（且回 404 不回 403，
//      403 等于承认"这个 id 存在但不是你的"）；
//   ④ **这一步不花钱**：核实任务状态与转存都不计费，所以失败一律 `billed:false` ——
//      它是「这次没取到」，不是「又花了一笔」。用户敢重试，两阶段才有意义。

/** 放开认领：这一发还能再取（任务还在跑、转存抖了一下）。
 *  ★ 不放开的话凭据会一直卡在 claimed 到 CLAIM_STALE_MS 超时为止 ——
 *    用户点一次「取回结果」就要罚站 5 分钟，而他什么错都没犯。 */
async function releaseJob(jobId) {
  await BlockoutJob.updateOne({ _id: jobId, status: "claimed" }, { $set: { status: "pending", claimedAt: null } });
}

/** 判定这一发**终局失败**（方舟明说没成 / 产物不合格）。整句理由存下来：
 *  用户可能几小时后才回来看列表，那时再去问方舟已经问不到了，而"为什么没了"必须还说得出口。 */
async function failJob(jobId, message) {
  await BlockoutJob.updateOne(
    { _id: jobId, status: { $in: ["pending", "claimed"] } },
    { $set: { status: "failed", failMessage: message, claimedAt: null } },
  );
}

/** 「这一发已经取回过了」的回法 —— 幂等路径与首次成功共用同一个形状。
 *  ★ 模板被作者删掉的情况要照实说：把它当成"还能再取"会让用户点一次、再点一次，
 *    每次都失败且不知道为什么（凭据里的产物地址早过期了，重取也拿不回来）。 */
async function respondDone(req, res, job, status = 200) {
  const doc = job.templateId ? await BranchTemplate.findById(job.templateId).lean() : null;
  if (!doc) {
    return fail(
      res,
      410,
      "这一发的结果早就取回过了，但那个模板现在已经不在了（多半是被删掉了）。要再来一份的话得重新做一发白模化（会重新计费）。",
      { billed: false, state: "gone" },
    );
  }
  return res.status(status).json({
    ok: true,
    state: "done",
    template: toTemplatePayload(doc, req.user),
    blockout: { jobId: String(job._id), taskId: job.taskId, durSec: job.source.durSec },
    billed: false,
  });
}

/** 非 pending 的状态怎么回 —— **一处实现**（进门那一次与"抢认领输了"重读那一次共用）。
 *  两处各写一遍的话，并发那条路迟早说出与列表不一样的话。
 *  @returns {boolean} true = 已经回过响应了，调用方直接返回 */
async function respondNonFinishable(req, res, job, st) {
  if (st.state === "done") {
    await respondDone(req, res, job, 200);
    return true;
  }
  if (st.state === "failed") {
    // ★ lost:true = 钱确实没了且拿不回任何东西。与 billed 分开两位：
    //   billed 说的是"这一次调用花钱没有"（没有），lost 说的是"开炼那笔还剩什么"（什么都没剩）。
    fail(res, 502, st.message, { billed: false, lost: true, state: "failed" });
    return true;
  }
  if (st.state === "expired") {
    // 只是备忘（判据永远是 expiresAt，见 stateOf）：让列表少算一次时间差
    await BlockoutJob.updateOne(
      { _id: job._id, status: { $in: ["pending", "claimed"] } },
      { $set: { status: "expired", claimedAt: null } },
    );
    // 410 Gone：这个资源确实**曾经存在、现在永久没了**，与 404「查无此物」不是一回事
    fail(res, 410, st.message, { billed: false, lost: true, state: "expired" });
    return true;
  }
  if (st.state === "working") {
    // 202：不是错误，是"另一发正在取，等几秒"
    res.status(202).json({ ok: false, state: "working", message: st.message, billed: false });
    return true;
  }
  return false;
}

router.post(
  "/templates/blockoutize/finish",
  requireAuth,
  blockoutFinishLimit,
  validate({ body: finishBlockoutizeBody }),
  async (req, res, next) => {
    try {
      const { jobId } = req.body;
      // ★ 「查不到」与「不是你的」回**同一句 404**：403 等于承认这个 jobId 存在，
      //   把别人凭据的存在性泄露成可枚举的事实（与 GET /templates/:id 同一条口径）。
      const gone = () =>
        fail(
          res,
          404,
          `找不到这一发的取件凭据（可能已经取回过了，或者超过 ${BlockoutJob.TTL_HOURS} 小时被清理了）。可以到「待取回的白模」里看看还有哪些没取。`,
          { billed: false, state: "gone" },
        );
      if (!mongoose.isValidObjectId(jobId)) return gone();
      const job = await BlockoutJob.findOne({ _id: jobId, ownerId: req.user._id });
      if (!job) return gone();

      const now = new Date();
      // 状态判据只有 BlockoutJob.stateOf 一处（列表与这里读同一份结论）
      if (await respondNonFinishable(req, res, job, BlockoutJob.stateOf(job, now))) return;

      // ── 原子认领：pending（或已经卡死的 claimed）→ claimed ─────────────
      // ★★ 这一步是幂等的第一层：并发的第二发 finish 抢不到认领，就不会同时走到
      //   "转存 + 建模板"，也就不会建出第二个模板、多传一份 100MB 的资产。
      // ★ 允许抢走**卡死**的认领（claimedAt 老于 CLAIM_STALE_MS）：进程被 pm2 重启掉时
      //   凭据会永远停在 claimed，而两阶段的全部意义就是"取得回来"。
      const staleBefore = new Date(now.getTime() - BlockoutJob.CLAIM_STALE_MS);
      const claimed = await BlockoutJob.findOneAndUpdate(
        {
          _id: job._id,
          ownerId: req.user._id,
          $or: [{ status: "pending" }, { status: "claimed", claimedAt: { $lt: staleBefore } }],
        },
        { $set: { status: "claimed", claimedAt: now } },
        { new: true },
      );
      if (!claimed) {
        // 抢输了（另一发刚刚认领/刚刚取完）。重读一次照实说，别猜
        const fresh = await BlockoutJob.findById(job._id);
        if (!fresh) return gone();
        if (await respondNonFinishable(req, res, fresh, BlockoutJob.stateOf(fresh, new Date()))) return;
        // 窄竞态：抢认领与重读之间那一发又把它放开了。措辞走同一个常量（别在这儿另写一句）
        return res.status(202).json({
          ok: false,
          state: "working",
          message: BlockoutJob.WORKING_HINT,
          billed: false,
        });
      }

      // ── ⑦ 向方舟核实（★ 绝不信客户端一句「成功了」）─────────────────
      const verdict = await blockout.fetchTaskState(claimed.taskId);
      if (verdict.state === "running") {
        await releaseJob(claimed._id);
        // ★ 内存里那份也要跟着放开再问 stateOf：不然它会照着"我刚认领的"那一位
        //   回一句「正在取回」，与我们下面要说的「还没出片」自相矛盾（同一条响应里两种说法）
        claimed.status = "pending";
        claimed.claimedAt = null;
        const st = BlockoutJob.stateOf(claimed, new Date());
        // 202 + 整句「还没出片，稍后再来取」—— **不是报错**：任务好端端地在跑，
        // 回 4xx/5xx 会让 App 把一发正常的生成显示成失败，用户以为钱白花了
        return res.status(202).json({
          ok: false,
          state: "running",
          message: `AI 还没出片，这一发的结果暂时取不了。等出片之后再来点一次「取回结果」就行（产物 ${BlockoutJob.TTL_HOURS} 小时后过期，${st.remainingText}）。`,
          billed: false,
          jobId: String(claimed._id),
          taskId: claimed.taskId,
          expiresAt: claimed.expiresAt,
          remainingSec: st.remainingSec,
        });
      }
      if (verdict.state === "failed") {
        // 终局：方舟明说这一发没成（含 F11 真人脸）。钱不退，照实说，凭据钉成 failed
        await failJob(claimed._id, verdict.message);
        return fail(res, 502, verdict.message, { billed: false, lost: true, state: "failed" });
      }
      if (verdict.state !== "succeeded") {
        // unknown：我们**没问清楚**（上游抖动/回包读不懂）。不替方舟宣判 ——
        // 凭据放回 pending，用户过一会儿再取
        await releaseJob(claimed._id);
        return fail(res, 502, verdict.message, { billed: false, state: "retry" });
      }

      // ── ⑧ 转存（F12：方舟产物是 TOS 签名地址，24 小时过期）────────────
      const moved = await blockout.transferToCloudinary(verdict.videoUrl, claimed.outPublicId);
      if (!moved.ok) {
        // ★★ 这一条在拆两阶段之前是**终局**（"费用无法退回，请重来一次" = 再花一笔钱）。
        //   现在产物还在方舟那边（24h 内）、凭据也还在 —— 放回 pending 让他再取一次，
        //   这正是两阶段换来的东西，别把它写回成终局。
        await releaseJob(claimed._id);
        return fail(res, 502, moved.message, { billed: false, state: "retry" });
      }

      const outMeta = templateVideoMeta(moved.receipt);
      const outIssue = templateRefIssue(outMeta, "生成出来的白模视频");
      if (outIssue) {
        // 产物本身过不了下一发的输入窗口 —— 落库了也是个谁都用不了的模板。
        // 这是**确定性**的失败（再取一百次也是同一段产物），所以钉成 failed 而不是放回 pending。
        // 回收掉再拒（不回收就是永久占配额，零症状）
        await destroyQuietly(moved.receipt.public_id, "video", "[blockoutize] 不合格产物");
        const msg = `${outIssue}（这一发的费用已经产生、无法挽回，请换一段素材重做。）`;
        await failJob(claimed._id, msg);
        return fail(res, 502, msg, { billed: false, lost: true, state: "failed" });
      }

      // ── ⑨ 建模板（pending，试炼闸照旧）────────────────────────────────
      let doc;
      try {
        doc = await BranchTemplate.create({
          ownerId: claimed.ownerId,
          authorName: req.user.username || "",
          title: claimed.title,
          intro: claimed.intro,
          coverUrl: claimed.coverUrl,
          recipe: {
            styleHint: "",
            beats: [],
            // 经典降级路的镜像时长：白模路的真实时长以 refVideo.durationSec 为准
            durationSec: Math.max(3, Math.min(30, outMeta.duration)),
            videoTier: claimed.videoTier,
            ...(claimed.aspect ? { aspect: claimed.aspect } : {}),
            framePrompt: "",
          },
          refVideo: {
            url: moved.receipt.secure_url,
            durationSec: outMeta.duration,
            width: outMeta.width,
            height: outMeta.height,
            bytes: outMeta.bytes,
            cloudinaryPublicId: moved.receipt.public_id,
          },
          // ★ roles / source 全部来自**凭据**，不是客户端这一发的 body（body 里只有 jobId）
          roles: claimed.roles,
          source: claimed.source,
          blockoutJobId: claimed._id,
          status: "pending",
          provenAt: null,
        });
      } catch (e) {
        if (e?.code === 11000) {
          // ★★ 幂等的第二层（最后一道兜底）：同一张凭据已经建过模板了 ——
          //   两个 pm2 实例同时收到 finish、或者认领超时被抢走之后原来那发又活过来。
          //   回**既有那一条**，不是 500：用户要的是"我的模板呢"，不是一个错误码。
          const exist =
            (await BranchTemplate.findOne({ blockoutJobId: claimed._id }).lean()) ||
            (await BranchTemplate.findOne({ "refVideo.url": moved.receipt.secure_url }).lean());
          // 自己刚传的那一份是多余的，回收掉（不回收就是永久占配额，零症状）
          if (exist && String(exist.refVideo?.cloudinaryPublicId) !== String(moved.receipt.public_id)) {
            await destroyQuietly(moved.receipt.public_id, "video", "[blockoutize] 重复取回的多余产物");
          }
          if (exist) {
            await BlockoutJob.updateOne(
              { _id: claimed._id },
              { $set: { status: "done", templateId: exist._id, claimedAt: null } },
            );
            // ★ 回包形状走 respondDone 那一份（成功、幂等重取、这条兜底三处同一个形状）——
            //   在这里另拼一遍的话，以后往回包里加字段必漏一处，而客户端读不到时零报错
            claimed.templateId = exist._id;
            return respondDone(req, res, claimed, 200);
          }
          // 撞了唯一索引却找不到那一条（refVideo.url 被别的模板占着）——
          // 只能整句拒，但凭据放回 pending（说不定那条模板一会儿被删了）
          await destroyQuietly(moved.receipt.public_id, "video", "[blockoutize] 落库失败后回收产物");
          await releaseJob(claimed._id);
          return fail(res, 409, "这段白模视频已经登记过一个模板了，请直接使用那一个。", { billed: false, state: "retry" });
        }
        await destroyQuietly(moved.receipt.public_id, "video", "[blockoutize] 落库失败后回收产物");
        await releaseJob(claimed._id);
        throw e;
      }

      // 凭据收官。★ 失败只吼不抛：模板已经建好了，此时回 5xx 会让用户以为没建成、
      // 再点一次 —— 而幂等那一层会把他导到同一个模板上，不会重复建（但话要说得对）。
      try {
        await BlockoutJob.updateOne({ _id: claimed._id }, { $set: { status: "done", templateId: doc._id, claimedAt: null } });
      } catch (e) {
        console.error(`[blockoutize] 凭据收官失败 job=${claimed._id} tpl=${doc._id}:`, e.message);
      }

      // 201：这一发**确实建出了新东西**（重复取回那两条路回 200，客户端可据此分辨
      // "刚建好"与"早就建好了"）。形状与幂等那两条共用 respondDone 一份。
      claimed.templateId = doc._id;
      return respondDone(req, res, claimed, 201);
    } catch (err) {
      return next(err);
    }
  },
);

// ── 掉线兜底：还没取回结果的凭据 ────────────────────────────────────
//
// GET /api/branch/templates/blockoutize/pending
//
// ★★ **不做这条，两阶段就白拆了**：App 进程被系统回收之后 jobId 也跟着没了，
//   用户手里就什么都不剩 —— 与拆之前一样丢结果，只是多了一张他看不见的取件单。
//   App 必须有一个真入口把用户领回来取（不是藏在某个调试页里）。
// ★ 只出**还没取回**的（done 的不出：那些的结果已经在他的模板列表里了）。
//   过期与失败的**要出**，而且要整句说明钱已经没了 —— 这类"东西没了"如果直接从列表
//   消失，用户只会以为是我们把它弄丢了（铁律八：失败要响亮，不要静默）。
// ★ 这里**不去问方舟**每一发跑到哪了：那是 N 次出网、会把这个列表变成一个慢且贵的端点，
//   而客户端本来就在用既有的轮询端点跟进任务（不计费）。这里只回"凭据自己知道的事"。
router.get("/templates/blockoutize/pending", requireAuth, blockoutPendingLimit, async (req, res, next) => {
  try {
    const docs = await BlockoutJob.find({ ownerId: req.user._id, status: { $ne: "done" } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const now = new Date();
    return res.json({
      ok: true,
      jobs: docs.map((d) => {
        const st = BlockoutJob.stateOf(d, now);
        return {
          jobId: String(d._id),
          taskId: d.taskId,
          title: d.title || "",
          durSec: Number(d.source?.durSec || 0),
          roles: rolesPayload(d.roles),
          createdAt: d.createdAt,
          expiresAt: d.expiresAt,
          // 剩余时间两种形态都给：App 要画倒计时（秒），也要直接显示一句人话
          remainingSec: st.remainingSec,
          remainingText: st.remainingText,
          state: st.state, // pending | working | failed | expired
          canFinish: st.canFinish,
          message: st.message,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/** best-effort 回收。★ 失败只吼不抛：调用方那一路已经在报别的错了，
 *  在这里抛会把真正的原因盖住；但静默泄漏的配额没有任何症状（铁律八）。 */
async function destroyQuietly(publicId, resourceType, tag) {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (e) {
    console.error(`${tag} 回收失败 public_id=${publicId}:`, e?.error?.message || e.message);
  }
}

// ── 市场与详情 ──────────────────────────────────────────────────────
// ★ /templates/shared 必须排在 /templates/:id 之前，否则会被 :id 吃掉
//   （"shared" 当成 id → 查不到 → 市场永远是空的，而且返回 200，一点错都不报）。
//   与 branchAsset.routes 的 /cards/shared、/decks/shared 同一条排序坑。
router.get("/templates/shared", optionalAuth, async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    // 等值 { status: "published" } 是安全的：新集合、字段必填带默认，不存在缺字段的存量
    // （「否定式判存量字段」那条仓规针对的是往老数据上后加字段，这里不适用，见 model 注释）
    const docs = await BranchTemplate.find({ status: "published" })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ ok: true, templates: docs.map((d) => toTemplatePayload(d, req.user)) });
  } catch (err) {
    next(err);
  }
});

router.get("/templates/:id", optionalAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) invalidId("Invalid template id");
    const doc = await BranchTemplate.findById(id).lean();
    // 非 published 只有作者自己可见；对别人一律 404 而不是 403 ——
    // 403 等于承认「这个 id 存在但你不能看」，把私有模板的存在性泄露成可枚举的事实
    if (!doc) notFound("Template not found");
    const isOwner = req.user && String(doc.ownerId) === String(req.user._id);
    if (doc.status !== "published" && !isOwner) notFound("Template not found");
    res.json({ ok: true, template: toTemplatePayload(doc, req.user) });
  } catch (err) {
    next(err);
  }
});

// ── 发布 / 下架 ─────────────────────────────────────────────────────

router.patch("/templates/:id/publish", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) invalidId("Invalid template id");
    const doc = await BranchTemplate.findById(id);
    if (!doc) notFound("Template not found");
    if (String(doc.ownerId) !== String(req.user._id)) forbidden("Forbidden");
    if (doc.status === "blocked") {
      badRequest("这个模板已被平台下架，不能重新发布。如有疑问请联系平台。");
    }
    // ★★ 试炼闸：provenAt 由服务端在「作者本人的 r2v 任务真实出片成功」时写入
    //   （ark.routes.js 的轮询追踪），这里只认它非空。为什么必须有这道门：
    //   方舟任务**受理后**才失败（含真人人脸、内容审核）是不退费的 ——
    //   没这道门，一个坏模板会让每个套用的人各赔一次；有这道门，坏在作者自己那一次。
    if (!doc.provenAt) {
      badRequest("发布前请先用这个模板成功出一段片（在自己的工程里套用它跑通一次）——这一步能确保套用你模板的人不会白花钱。");
    }
    // ★★ 编号核对闸（白模 V2）：与上面的试炼闸是**两道独立的门**，别合并、别互相代替。
    //   试炼闸问的是「这个模板能不能出片」，这道门问的是「列表里的编号与画面上人偶头上
    //   的数字对得上吗」—— 试炼那一发作者自己可以一张卡都不挂，跑通了也说明不了编号对。
    //   编号错的后果没有任何报错：套用者点"3 号位"挂上张三，模型老老实实换了画面上的
    //   3 号（那可能是别人），钱照扣。判据只有 rolesNeedConfirm 一处（V1 模板天然为 false）。
    if (BranchTemplate.rolesNeedConfirm(doc)) {
      badRequest(BranchTemplate.ROLES_CONFIRM_HINT);
    }
    doc.status = "published";
    await doc.save();
    res.json({ ok: true, template: toTemplatePayload(doc.toObject(), req.user) });
  } catch (err) {
    next(err);
  }
});

router.patch("/templates/:id/unpublish", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) invalidId("Invalid template id");
    const doc = await BranchTemplate.findById(id);
    if (!doc) notFound("Template not found");
    if (String(doc.ownerId) !== String(req.user._id)) forbidden("Forbidden");
    // blocked 是平台的处置，作者的「下架」不能把它洗成 pending（否则 blocked → unpublish
    // → publish 两步就把平台下架绕过去了，provenAt 还在，第二步拦不住）
    if (doc.status === "blocked") {
      badRequest("这个模板已被平台下架，状态由平台管理。");
    }
    doc.status = "pending";
    await doc.save();
    res.json({ ok: true, template: toTemplatePayload(doc.toObject(), req.user) });
  } catch (err) {
    next(err);
  }
});

// ── 角色位编号的核对（白模 V2）───────────────────────────────────────
//
// PATCH /api/branch/templates/:id/roles   body: { roles: [{ label, desc }] }
//
// ★★ 为什么要有这条端点（F5 的直接后果）：白模化落库那一刻的 label 是**服务端按视觉
//   清单顺序编的猜测**（1..N），而成片上人偶头上的数字**稳定但不连续**（实测一发四人
//   实出 1/2/4/5）。两者错位时，套用者点"3 号位"挂上张三 —— 模型会老老实实换掉画面上
//   的 3 号（另一个人），**钱照扣、零报错**。所以编号必须由**看得见画面的人**确认：
//   这条端点收的不是数据，是作者的确认。
// ★ 它收得起客户端提交的 roles（与"建模板/白模化一律不收"不矛盾），因为这份输入
//   **碰不到钱**：refVideo/source/durSec 一个都不经它，r2v 的计价输入时长与它无关。
// ★ 三道门：仅作者（身份只认 ownerId）、仅 **pending**、仅**已有角色位**的模板。
//
// ★★ 「删掉一个角色位」是这条端点的**一等操作**，不是副作用（2026-08-15 明确）：
//   实测方舟画编号并不可靠 —— 同一段 5 人素材实出过 2/2/1/1/5（两组重号，3 和 4
//   整个没出现）与 3/1/1/4/5。也就是说**画面上可能有两个人偶印着同一个号，或者某个
//   登记了的号在画面上根本不存在**。作者对着画面能做的唯一修复就是：把找得到的号
//   改对，把**找不到的那几个位子删掉**（5 个位退成 3~4 个能用的）。
//   没有这条路，作者面对两个「1」时只剩"再花一次钱重炼整段"。
// ★★ 而"改号"与"删位"必须**同一次提交**，这直接决定了不新开 DELETE 端点：
//   要把库里的 1,2,3,4,5 改成画面真实的 2,1,5，任何"先改后删"的中间态都会撞下面
//   那道重号闸（把 1 号位改成 "2" 时库里已经有 "2"）；而"先删后改"是两次写，
//   第二次失败就留下一个**已被标成 labelConfirmed=true、编号却还是错的**模板 ——
//   作者从入口看它是"已核对"，实际挂卡全错，零报错。整份替换天然表达得了这一步。
// ★ 也因此「删一个不存在的号」这一格**没有错误路径**：它等于提交一份本来就不含
//   该号的数组 → 200、无操作。DELETE 端点则必须回答"404 还是幂等 204"，两个答案
//   各有坑（前者把"点了两次"变成报错，后者让"删错了模板 id"静默成功）。
router.patch(
  "/templates/:id/roles",
  requireAuth,
  validate({ body: patchRolesBody }),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) invalidId("Invalid template id");
      const doc = await BranchTemplate.findById(id);
      // ★ 这两句用中文整句：App 侧的核对面板是把服务端这句话**原样显示**给作者的
      //   （全 app 没有任何地方监听 emitApiError，面板 catch 到什么就印什么）。
      //   英文机器串印在界面上等于没解释 —— 作者只会以为功能坏了。
      if (!doc) notFound("这个模板在服务器上已经不存在了（可能已被删除）。");
      if (String(doc.ownerId) !== String(req.user._id)) {
        forbidden("这个模板不是你的，只有作者本人能改它的角色位编号。");
      }

      // ★ V1 老模板（整段只有一个红色小人）没有角色位可核对。静默建一份出来更糟：
      //   那等于凭空给一个没有编号人偶的视频编出"1 号位"，套用者点了只会换错东西。
      if (!Array.isArray(doc.roles) || doc.roles.length === 0) {
        badRequest("这个模板没有可挂角色卡的角色位（它是早期的白模模板，整段只有一个人偶），不需要核对编号。");
      }
      // ★★ 只许在 pending 时改。已发布的模板改编号 = **偷偷换掉别人正在用的映射**：
      //   套用者的工程里存的是 `label → 卡`，编号一变，同一份工程下次出片就把卡挂到
      //   别人身上，而他那边不会有任何提示。要改就先下架（unpublish），这一步会让
      //   市场上的条目先消失，是"改动可见"的最低要求。
      // ★ **删位比改号更狠**，所以同样归这道门管：改号是"卡挂到别人身上"，删位是
      //   "这张卡直接挂不上了" —— 套用者手里的 `cast[label]` 会突然指向一个不存在的
      //   位子，而市场条目还挂着、还在被新人套用。别给删位单开一个更宽的口子。
      if (doc.status !== "pending") {
        badRequest(
          doc.status === "blocked"
            ? "这个模板已被平台下架，状态由平台管理，不能再改角色位。"
            : "已发布的模板不能改角色位（包括删掉画面上找不到的那个号）——先「下架」再改：编号一变，正在用它的人手里那份「几号位挂谁」就全对不上了，而他们那边不会有任何提示。",
        );
      }

      const roles = req.body.roles.map((r) => ({ label: String(r.label).trim(), desc: String(r.desc || "").trim() }));

      // ★★ 下限：**至少留一个角色位**（2026-08-15 从 zod 的 .min(1) 挪到这里，为的是
      //   能说人话 —— 见 schemas 里那段 ★★）。为什么是 1 不是 0：删到 0 会触发一条
      //   **四段全静默**的降级链，每一段都不报错，作者与套用者谁都看不见：
      //     ① toTemplatePayload 只在 roles.length > 0 时才带 `roles` 这个键
      //        → 模板在响应里退化成 **V1 形状**；
      //     ② App 的 rolesOf 回空数组，本机镜像也不带 roles；
      //     ③ App 出片时 `blockout && !!input.roles?.length` 为假 → **静默退成 V1 泛指
      //        出片**：套用者付了 r2v 的钱，换来一段"AI 自己挑人换"的片；
      //     ④ rolesNeedConfirm 同时变 false → **发布闸失效**，一个没有任何挂卡入口的
      //        白模模板能上市场。
      //   所以"一个角色位都不留"不是一次合法的确认，它的正确表达是**删掉整个模板**
      //   （DELETE /api/branch/templates/:id，会连带回收 Cloudinary 上那段视频）。
      if (roles.length === 0) {
        badRequest(
          "至少要留一个角色位——一个都不留的话，套用你模板的人没有任何地方可以挂卡，这个模板会退回成「整段只有一个白模人偶」的老形态。整个模板不要了的话，请直接删除这个模板。",
        );
      }

      // 同一个编号只许出现一次：重了的话「label → 卡」这份映射在套用侧会**静默覆盖**
      // （后一条赢），用户看到的是"我明明给两个人各挂了一张卡，结果只换了一个"。
      // ★ 这句话必须带**下一步**：撞上它的作者多半正是遇到了"画面上两个人偶都印着
      //   同一个号"（实测 2/2/1/1/5），而他手上真正能做的事是删掉其中一个位子。
      //   只说"不许重复"等于把人堵在原地，他会以为唯一出路是重炼（再花一次钱）。
      const seen = new Set();
      const dup = roles.find((r) => (seen.has(r.label) ? true : (seen.add(r.label), false)));
      if (dup) {
        badRequest(
          `编号「${dup.label}」出现了两次。每个角色位的编号必须各不相同，否则套用你模板的人给它们挂卡时会互相覆盖。` +
            `如果画面上真的有两个人偶都印着「${dup.label}」，请把其中一个位子删掉——留下的那个照样能挂卡，但挂上的卡可能会把这两个人一起换掉。`,
        );
      }

      // ★ 整份替换而不是逐条打补丁：作者提交的就是他对着画面抄下来的**完整**那一份
      //   （可以增、可以删、可以改描述）。逐条 merge 的话，"AI 多认出一个人、作者删掉它"
      //   这种最常见的修正根本表达不出来。**"少给一条"就是删除的唯一表达形式。**
      //
      // ★★ 剩下的 label 一个字都不许动 —— 不排序、不补号、不重编、不改顺序：
      //   · label **就是画面上印在人偶头上的那个数字**，它是"把卡挂到这个人偶身上"的
      //     唯一连接键（roleSchema 连 _id 都没有，label 就是这个位子的全部身份）。
      //     删掉 3 号之后把 5 号顺手改成 4，等于把套用者挂给 5 号的卡换到另一个人身上，
      //     **而两边都不会报错** —— 模型不会拒绝一个"合法但指错人"的编号，钱照扣。
      //   · 实测编号本来就**不连续**（1/2/4/5 是正常输出，不是 bug）。删位之后剩下
      //     1/2/4/5 里的 1/4/5 完全正常，"看着不连续"不是要修的东西。
      //   · **顺序也不许动**：App 侧按 roles 原序落参考图（materials），这个顺序决定
      //     参考图预算不够时谁先被挤掉，也是编辑页挂卡列表的显示顺序。
      //   所以这里只做 map，绝不 sort、绝不按下标重新赋 label。测试里用**数组相等**
      //   （不是集合相等）钉住这一条 —— 集合相等漏得掉重排。
      // ★ labelConfirmed 一律 true —— 这一发的全部意义就是作者点了头。删位同理：
      //   作者删掉一个位子，正是因为他对着画面看清了"这个号不存在 / 这个号重了"，
      //   那就是确认动作本身，不该再要求他单独按一次"确认"。
      // ★ **不清 provenAt**：试炼证明的是"这个模板出得了片"，与角色位个数无关。
      //   顺手清掉 = 让作者为了删一个画面上根本不存在的号，再付一次 r2v 的钱。
      doc.roles = roles.map((r) => ({ ...r, labelConfirmed: true }));
      await doc.save();
      res.json({ ok: true, template: toTemplatePayload(doc.toObject(), req.user) });
    } catch (err) {
      next(err);
    }
  },
);

// ── 删除（连带回收云端资产）─────────────────────────────────────────

router.delete("/templates/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) invalidId("Invalid template id");
    const doc = await BranchTemplate.findById(id).lean();
    if (!doc) notFound("Template not found");
    if (String(doc.ownerId) !== String(req.user._id)) forbidden("Forbidden");

    // ★ 回收模板视频 —— 全仓第一个 uploader.destroy 调用（此前上传即永久占配额）。
    //   为什么必须删：不删的话热门模板删除后视频还挂在公网上，方舟侧任何拿到 URL 的人
    //   仍在消耗我们的流出流量；配额也只增不减。
    //   顺序讲究：**先云端后库**。先删库的话 destroy 失败就再也找不回 publicId，
    //   资产成了永久孤儿；先删云端失败则库还在，用户重试一次即可（destroy 幂等，
    //   "not found" 视同已删）。
    try {
      const out = await cloudinary.uploader.destroy(doc.refVideo.cloudinaryPublicId, { resource_type: "video" });
      if (out?.result && out.result !== "ok" && out.result !== "not found") {
        console.error(`[branchTemplate] 模板视频回收被拒 public_id=${doc.refVideo.cloudinaryPublicId}: ${out.result}`);
        return res.status(502).json({ ok: false, message: "云端视频回收失败，模板暂未删除，请稍后重试。" });
      }
    } catch (e) {
      console.error(`[branchTemplate] 模板视频回收失败 public_id=${doc.refVideo.cloudinaryPublicId}:`, e?.error?.message || e.message);
      return res.status(502).json({ ok: false, message: "云端视频回收失败，模板暂未删除，请稍后重试。" });
    }

    // 封面 best-effort 回收：只认「本账号传到我们空间」的资产（外链/认不出的不动）。
    // ★ 失败**不阻断**删除：视频已经回收掉了，此时中止会留下一个"视频已没、模板还在"
    //   的半状态，比漏删一张小封面糟得多。失败要留痕（铁律八：响，但局部）。
    const cover = ownedCloudinaryAsset(doc.coverUrl, req.user._id);
    if (cover) {
      await destroyQuietly(cover.publicId, cover.resourceType, "[branchTemplate] 封面");
    }

    // ★ 白模 V2：连原始素材一起回收（100MB 级）。V1 模板没有 source，这一段直接跳过。
    //   不回收的话每做一个白模模板就永久漏一份原片 —— 而 DELETE /api/uploads/template-video
    //   那个孤儿口在模板还在时是**拒绝**删它的（正是为了让这里能级联），
    //   删了模板之后又再也没有句柄能找到它。同样 best-effort、失败不阻断。
    if (doc.source?.publicId) {
      await destroyQuietly(doc.source.publicId, "video", "[branchTemplate] 原始素材");
    }

    await BranchTemplate.deleteOne({ _id: doc._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
