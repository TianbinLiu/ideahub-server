// src/routes/branchTemplate.routes.js
// 白模模板（blockout r2v）：建 / 市场列表 / 详情 / 发布 / 下架 / 删除。
// 挂在 /api/branch 下（与 branchVideo / branchAsset 同一 base，路径不重叠）：
//   app.use("/api/branch", require("./routes/branchTemplate.routes"));
//
// 生命周期与闸门（每道闸门只有一处实现，铁律六）：
//   上传视频（uploads.routes /template-video，回执复核）
//   → 建模板（本文件：videoUrl 三重白名单 + 服务端向 Cloudinary 取元数据）status=pending
//   → 作者自己付费出一次片（ark.routes 的 r2v 追踪在轮询到 succeeded 时置 provenAt）
//   → （白模 V2 多一步）作者核对角色位编号（本文件：PATCH /templates/:id/roles）
//   → 发布（本文件：**两道独立的门** —— provenAt 非空 + 编号已核对）status=published → 上市场
//   平台下架（blocked）走管理端（后续另接），作者 publish/unpublish 都动不了它。
const router = require("express").Router();
const mongoose = require("mongoose");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { createTemplateBody, blockoutizeBody, patchRolesBody } = require("../schemas/branchTemplate.schemas");
const BranchTemplate = require("../models/BranchTemplate");
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
    //   `labelConfirmed` 一起出：作者那边要据它显示「编号待核对」并挡住发布按钮，
    //   套用者那边则是"这个模板的编号是作者亲自对过的"这句承诺的来源。
    ...(Array.isArray(doc.roles) && doc.roles.length
      ? {
          roles: doc.roles.map((r) => ({
            label: String(r.label || ""),
            desc: String(r.desc || ""),
            // 只有明确 true 才算核对过（存量 V2 模板那一项是 undefined —— 按未核对出，
            // 与 BranchTemplate.rolesNeedConfirm 同一条口径，两处分家会让界面与闸门打架）
            labelConfirmed: r.labelConfirmed === true,
          })),
        }
      : {}),
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

// ── 白模化：任意视频 → 带编号的白模模板（白模 V2）─────────────────────
//
// POST /api/branch/templates/blockoutize
//
// 用户在编辑页框出「哪一段 + 画面哪一块」，提交**四组数**（startSec/durSec/crop），
// 服务端走完九步：
//   ① 归属校验 → ② 服务端自己拼 Cloudinary 变换 URL → ③ 预热（F9）
//   → ④ 复核裁后元数据满足方舟约束（F1/F3）→ ⑤ chat vision 先看一眼列出画面里有谁（F4 的"先看"）
//   → ⑥ 点名式提示词发 r2v edit（F4 的"点名"）→ ⑦ 轮询 → ⑧ 产物转存 Cloudinary（F12）
//   → ⑨ 建模板 status=pending（试炼闸照旧）
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
/** 看几帧。★ 3 帧是"够认出人 + 别太贵"的折中：帧数越多越慢也越贵，
 *  而我们只需要知道"画面里有哪几个人、长什么样"。 */
const VISION_FRAMES = 3;

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
//   3 次抽帧、1 次 chat、1 次 r2v，还要占着一个连接轮询好几分钟。
//   3 次/10 分钟对真人足够（框选 + 等出片本身就要几分钟）。
const blockoutizeLimit = userRateLimit({ max: 3, windowMs: 10 * 60 * 1000, scope: "branchTemplate:blockoutize" });

/** 整句失败 —— 全 app 没有任何地方监听 emitApiError，只回错误码等于让用户对着转圈干等（铁律八）。
 *  `billed` 明确告诉客户端"这一次的钱退没退"，让它照实说，别自己猜。 */
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
      const { startSec, durSec, crop, title, intro, coverUrl, videoTier, aspect, note } = req.body;

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
      const times = [];
      for (let i = 0; i < VISION_FRAMES; i += 1) {
        const t = startSec + Math.min(durSec - 1, Math.floor((durSec * i) / VISION_FRAMES));
        if (!times.includes(t)) times.push(t);
      }
      const images = [];
      for (const atSec of times) {
        const url = buildFrameUrl(publicId, { atSec, crop }, resource.version);
        const got = await blockout.fetchFrameDataUrl(url);
        // 单帧取不到不算失败（3 帧取到 1 帧也认得出人）；一帧都没有才拒
        if (got.ok) images.push(got.dataUrl);
        else console.warn(`[blockoutize] 抽帧失败 ${publicId}@${atSec}s: ${got.reason}`);
      }
      if (!images.length) {
        return fail(res, 502, "没能从这段视频里取到画面（云端还没准备好），本次没有开始生成、也没有扣费，请稍后重试。", { billed: false });
      }

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
          `AI 没能在这段画面里认出任何人物，所以做不出可以挂角色卡的白模模板。出片那一笔一分钱没动，但${VISION_BILLED_NOTE}。请换一段人物更清晰、更靠近镜头的素材再试。`,
          { billed: true },
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
          { billed: true },
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
        return fail(res, 502, "AI 已经开始生成，但我们没能拿到任务编号，无法跟进这一发的结果。这一发的费用已经产生、无法退回。", { billed: true });
      }

      // ── ⑦ 轮询到出结果 ──────────────────────────────────────────────
      const done = await blockout.pollTask(taskId);
      if (!done.ok) return fail(res, 502, done.message, { billed: Boolean(done.billed) });

      // ── ⑧ 转存（F12：方舟产物是 TOS 签名地址，24 小时过期）────────────
      const moved = await blockout.transferToCloudinary(done.videoUrl, userId);
      // ★ 转存失败 → **模板不落库**：宁可让用户重来，也不留一个明天就打不开的模板
      //   （那种模板零症状，直到有人套用它出片时方舟拉不到参考视频才 400）
      if (!moved.ok) return fail(res, 502, moved.message, { billed: true });

      const outMeta = templateVideoMeta(moved.receipt);
      const outIssue = templateRefIssue(outMeta, "生成出来的白模视频");
      if (outIssue) {
        // 产物本身过不了下一发的输入窗口 —— 落库了也是个谁都用不了的模板。
        // 回收掉再拒（不回收就是永久占配额，零症状）
        await destroyQuietly(moved.receipt.public_id, "video", "[blockoutize] 不合格产物");
        return fail(res, 502, `${outIssue}（这一发的费用已经产生、无法退回，请换一段素材重试。）`, { billed: true });
      }

      // ── ⑨ 建模板（pending，试炼闸照旧）────────────────────────────────
      let doc;
      try {
        doc = await BranchTemplate.create({
          ownerId: req.user._id,
          authorName: req.user.username || "",
          title,
          intro,
          coverUrl,
          recipe: {
            styleHint: "",
            beats: [],
            // 经典降级路的镜像时长：白模路的真实时长以 refVideo.durationSec 为准
            durationSec: Math.max(3, Math.min(30, outMeta.duration)),
            videoTier,
            ...(aspect ? { aspect } : {}),
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
          roles,
          source: { publicId, startSec, durSec, crop },
          status: "pending",
          provenAt: null,
        });
      } catch (e) {
        await destroyQuietly(moved.receipt.public_id, "video", "[blockoutize] 落库失败后回收产物");
        if (e?.code === 11000) {
          return fail(res, 409, "这段白模视频已经登记过一个模板了，请直接使用那一个。", { billed: true });
        }
        throw e;
      }

      return res.status(201).json({
        ok: true,
        template: toTemplatePayload(doc.toObject(), req.user),
        blockout: { taskId, durSec },
      });
    } catch (err) {
      return next(err);
    }
  },
);

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
    //   试炼闸问的是「这个模板能不能出片」，这道门问的是「列表里的编号与画面上人偶胸口
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
//   清单顺序编的猜测**（1..N），而成片上人偶胸口的数字**稳定但不连续**（实测一发四人
//   实出 1/2/4/5）。两者错位时，套用者点"3 号位"挂上张三 —— 模型会老老实实换掉画面上
//   的 3 号（另一个人），**钱照扣、零报错**。所以编号必须由**看得见画面的人**确认：
//   这条端点收的不是数据，是作者的确认。
// ★ 它收得起客户端提交的 roles（与"建模板/白模化一律不收"不矛盾），因为这份输入
//   **碰不到钱**：refVideo/source/durSec 一个都不经它，r2v 的计价输入时长与它无关。
// ★ 三道门：仅作者（身份只认 ownerId）、仅 **pending**、仅**已有角色位**的模板。
router.patch(
  "/templates/:id/roles",
  requireAuth,
  validate({ body: patchRolesBody }),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) invalidId("Invalid template id");
      const doc = await BranchTemplate.findById(id);
      if (!doc) notFound("Template not found");
      if (String(doc.ownerId) !== String(req.user._id)) forbidden("Forbidden");

      // ★ V1 老模板（整段只有一个红色小人）没有角色位可核对。静默建一份出来更糟：
      //   那等于凭空给一个没有编号人偶的视频编出"1 号位"，套用者点了只会换错东西。
      if (!Array.isArray(doc.roles) || doc.roles.length === 0) {
        badRequest("这个模板没有可挂角色卡的角色位（它是早期的白模模板，整段只有一个人偶），不需要核对编号。");
      }
      // ★★ 只许在 pending 时改。已发布的模板改编号 = **偷偷换掉别人正在用的映射**：
      //   套用者的工程里存的是 `label → 卡`，编号一变，同一份工程下次出片就把卡挂到
      //   别人身上，而他那边不会有任何提示。要改就先下架（unpublish），这一步会让
      //   市场上的条目先消失，是"改动可见"的最低要求。
      if (doc.status !== "pending") {
        badRequest(
          doc.status === "blocked"
            ? "这个模板已被平台下架，状态由平台管理，不能再改角色位。"
            : "已发布的模板不能改角色位编号——先「下架」再改：编号一变，正在用它的人手里那份「几号位挂谁」就全对不上了，而他们那边不会有任何提示。",
        );
      }

      // 同一个编号只许出现一次：重了的话「label → 卡」这份映射在套用侧会**静默覆盖**
      // （后一条赢），用户看到的是"我明明给两个人各挂了一张卡，结果只换了一个"。
      const roles = req.body.roles.map((r) => ({ label: String(r.label).trim(), desc: String(r.desc || "").trim() }));
      const seen = new Set();
      const dup = roles.find((r) => (seen.has(r.label) ? true : (seen.add(r.label), false)));
      if (dup) {
        badRequest(`编号「${dup.label}」出现了两次。每个角色位的编号必须各不相同，否则套用你模板的人给它们挂卡时会互相覆盖。`);
      }

      // ★ 整份替换而不是逐条打补丁：作者提交的就是他对着画面抄下来的**完整**那一份
      //   （可以增、可以删、可以改描述）。逐条 merge 的话，"AI 多认出一个人、作者删掉它"
      //   这种最常见的修正根本表达不出来。
      // ★ labelConfirmed 一律 true —— 这一发的全部意义就是作者点了头。
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
