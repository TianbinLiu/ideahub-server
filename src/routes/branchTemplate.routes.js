// src/routes/branchTemplate.routes.js
// 白模模板（blockout r2v）：建 / 市场列表 / 详情 / 发布 / 下架 / 删除。
// 挂在 /api/branch 下（与 branchVideo / branchAsset 同一 base，路径不重叠）：
//   app.use("/api/branch", require("./routes/branchTemplate.routes"));
//
// 生命周期与闸门（每道闸门只有一处实现，铁律六）：
//   上传视频（uploads.routes /template-video，回执复核）
//   → 建模板（本文件：videoUrl 三重白名单 + 服务端向 Cloudinary 取元数据）status=pending
//   → 作者自己付费出一次片（ark.routes 的 r2v 追踪在轮询到 succeeded 时置 provenAt）
//   → 发布（本文件：校 provenAt 非空）status=published → 上市场
//   平台下架（blocked）走管理端（后续另接），作者 publish/unpublish 都动不了它。
const router = require("express").Router();
const mongoose = require("mongoose");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { createTemplateBody } = require("../schemas/branchTemplate.schemas");
const BranchTemplate = require("../models/BranchTemplate");
const { cloudinary } = require("../config/cloudinary");
const { templateVideoMeta, templateVideoIssue } = require("../middleware/upload");
const { forbidden, notFound, invalidId, badRequest } = require("../utils/http");

/** 白模视频在 Cloudinary 里的家。与 uploads.routes 的上传 folder 是同一个字符串 ——
 *  这里的白名单校验与那边的落盘位置如果分叉，所有新模板都会 400，且两边各自看着都没错 */
const TEMPLATE_VIDEO_FOLDER = "ideahub/template-videos";

/**
 * videoUrl 的三重白名单：host + 目录 + public_id 归属。
 * 三道都要，缺一道就有一条绕行路：
 *   只校 host   → 能把别人的任何 Cloudinary 资源（头像、别人的模板视频）注册成自己的模板；
 *   只校目录   → 能把 /media 传的 webm（r2v 根本不认的格式）注册进来；
 *   只校归属   → 归属判据（basename 以 userId- 开头）在别的 folder 里同样成立，
 *                挡不住"拿自己传的头像当模板视频"。
 * @returns {{ publicId: string } | null} null = 不合格
 */
function parseOwnTemplateVideoUrl(rawUrl, userId) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  // ① host：只认 Cloudinary 的分发域（https）。new URL 已做路径归一化（../ 之类被折掉）
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null;
  // ② 目录：必须落在模板视频专用 folder 里
  const marker = `/${TEMPLATE_VIDEO_FOLDER}/`;
  const idx = parsed.pathname.indexOf(marker);
  if (idx === -1) return null;
  const name = parsed.pathname.slice(idx + marker.length);
  // folder 后必须正好一个文件段（多一层斜杠 = 伪造的路径，不是我们生成的形状）
  if (!name || name.includes("/")) return null;
  // ③ 归属：public_id 是上传时服务端生成的 `${userId}-${Date.now()}`，形状收死。
  //   ★ 用**形状整体匹配**而不是 startsWith(userId)：光判前缀的话，
  //     用户 A（id 以 B 的 id 为前缀是不可能的——ObjectId 定长 24——但文件名里
  //     混别的字符可以），收成 `^<本人id>-\d+$` 之后没有任何拼接花样可玩。
  const base = name.replace(/\.[A-Za-z0-9]+$/, ""); // 去扩展名
  const ownRe = new RegExp(`^${String(userId)}-\\d+$`);
  if (!ownRe.test(base)) return null;
  return { publicId: `${TEMPLATE_VIDEO_FOLDER}/${base}` };
}

/**
 * 封面回收用：这个 https URL 是不是「本账号传到我们 Cloudinary 空间」的资产。
 * 只用于 DELETE 时的 best-effort 回收 —— 认不出（外链、别人的资产）就不动它。
 * @returns {{ publicId: string, resourceType: string } | null}
 */
function ownedCloudinaryAsset(rawUrl, userId) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null;
  // 路径形如 /<cloud>/<resource_type>/upload/v123/ideahub/<folder>/<userId>-<ts>.<ext>
  const m = parsed.pathname.match(/^\/[^/]+\/(image|video)\/upload\/(?:v\d+\/)?(ideahub\/[^/]+\/([^/]+))$/);
  if (!m) return null;
  const base = m[3].replace(/\.[A-Za-z0-9]+$/, "");
  if (!new RegExp(`^${String(userId)}-\\d+$`).test(base)) return null;
  return { publicId: m[2].replace(/\.[A-Za-z0-9]+$/, ""), resourceType: m[1] };
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

    // 验收窗口复核（与上传回执复核是**同一份实现**，middleware/upload.js）。
    // 正常流程到不了"不合格"——上传口已经 destroy 过不合格的——这里是第二道保险：
    // 真撞上说明两步之间规则变了或有人绕过上传口，拒绝比带病登记好。
    const meta = templateVideoMeta(resource);
    const issue = templateVideoIssue(meta);
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
      try {
        await cloudinary.uploader.destroy(cover.publicId, { resource_type: cover.resourceType });
      } catch (e) {
        console.error(`[branchTemplate] 封面回收失败 public_id=${cover.publicId}:`, e?.error?.message || e.message);
      }
    }

    await BranchTemplate.deleteOne({ _id: doc._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
