const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const {
  upload,
  uploadMedia,
  uploadToCloudinary,
  MAX_IMAGE_SIZE_BYTES,
  MAX_MEDIA_SIZE_BYTES,
  uploadTemplateVideo,
  MAX_TEMPLATE_VIDEO_BYTES,
  templateVideoMeta,
  templateSourceIssue,
} = require("../middleware/upload");
const { cloudinary } = require("../config/cloudinary");
const BranchTemplate = require("../models/BranchTemplate");
// 归属判据只有一处（utils/templateVideoAsset），此前这里手写过一份 startsWith 前缀
const { ownTemplateVideoPublicId } = require("../utils/templateVideoAsset");

// ★ 上传此前**一个限流器都没有**（2026-08-14 复查发现）：每一发都真实占用
//   Cloudinary 配额与出网带宽，且上传即永久留存（全服务端目前零 destroy 调用）——
//   一个脚本就能把配额刷满。按【账号】限不按 IP（NAT 后面的真实用户共享出口 IP，
//   与登录限流同一条理由）。20/分钟对真实使用绰绰有余：发布一条作品的
//   materializeDraft 串行传帧，一分钟传不到 20 张。
const uploadLimit = userRateLimit({ max: 20, windowMs: 60 * 1000, scope: "uploads" });

router.post("/image", requireAuth, uploadLimit, upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "No file uploaded" });
    }

    // 上传到 Cloudinary
    const imageUrl = await uploadToCloudinary(
      req.file.buffer,
      'content-images',
      req.user._id.toString()
    );

    res.json({
      ok: true,
      imageUrl,
      maxSizeBytes: MAX_IMAGE_SIZE_BYTES,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/media", requireAuth, uploadLimit, uploadMedia.single("media"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "No media uploaded" });
    }

    const resourceType = String(req.file.mimetype || "").startsWith("video/") ? "video" : "image";

    const mediaUrl = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "ideahub/workshop-media",
          public_id: `${req.user._id.toString()}-${Date.now()}`,
          resource_type: resourceType,
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      stream.end(req.file.buffer);
    });

    res.json({
      ok: true,
      mediaUrl,
      maxSizeBytes: MAX_MEDIA_SIZE_BYTES,
      mimeType: req.file.mimetype,
      size: req.file.size,
      resourceType,
    });
  } catch (err) {
    next(err);
  }
});

// ── 白模模板视频（V2 起：任意原始素材）──────────────────────────────
// ★ 比 /image /media 严得多（3 次/分 + 10 次/天，两个桶**串联**、scope 分开）：
//   一发就是 100MB 级出网 + 永久占 Cloudinary 配额，而且每个热门模板此后每被套用一次，
//   方舟都会从我们账户拉一遍这段视频（流出流量随使用次数线性涨）。
//   分钟桶挡手滑连点，天桶挡"整晚慢慢灌"——只有分钟桶的话，一晚上能灌 4000 发。
const tplVideoMinuteLimit = userRateLimit({ max: 3, windowMs: 60 * 1000, scope: "uploads:tplVideoMin" });
const tplVideoDailyLimit = userRateLimit({ max: 10, windowMs: 24 * 60 * 60 * 1000, scope: "uploads:tplVideoDay" });

router.post(
  "/template-video",
  requireAuth,
  tplVideoMinuteLimit,
  tplVideoDailyLimit,
  uploadTemplateVideo.single("video"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, message: "没有收到视频文件，请重新选择一个 mp4 / mov 文件。" });
      }

      // public_id 以本账号 _id 开头（/media 同款）——这就是「这段视频是谁传的」的判据，
      // 建模板时的三重白名单靠它把归属钉死
      const receipt = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "ideahub/template-videos",
            public_id: `${req.user._id.toString()}-${Date.now()}`,
            resource_type: "video",
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        stream.end(req.file.buffer);
      });

      // ★★ 回执复核 —— 服务端自己的验收，不信客户端预检（客户端那份只是省用户时间的
      //   提前量，改一行前端就能跳过）。
      // ★ 这里用的是**原始素材**那套窗口（templateSourceIssue），不是参考视频那套：
      //   V2 起真正要满足方舟约束的是"编辑页框选、服务端裁出来的那一段"，
      //   拿严窗口卡上传口的话，一段 3 分钟素材连传都传不上来，而它裁出的 8 秒完全合格。
      //   两套窗口都在 middleware/upload.js 一处（建模板/裁剪后复核走 templateRefIssue）。
      const meta = templateVideoMeta(receipt);
      const issue = templateSourceIssue(meta);
      if (issue) {
        // ★ 先 destroy 再拒：不回收的话，每一次被拒的上传都永久占着配额
        //   （此前全服务端零 destroy 调用，上传即永久留存）。回收失败不改变拒收结论，
        //   但必须吼出来 —— 静默泄漏的配额没有任何症状，只有月底的用量报表知道。
        try {
          await cloudinary.uploader.destroy(receipt.public_id, { resource_type: "video" });
        } catch (e) {
          console.error(`[uploads] 模板视频复核不过、回收失败 public_id=${receipt.public_id}:`, e.message);
        }
        return res.status(400).json({ ok: false, message: issue });
      }

      // 元数据随回执返回：客户端拿去显示与预检报价，但**作数的**是建模板时服务端
      // 自己再向 Cloudinary 取的那份（见 branchTemplate.routes.js）——响应里这几个数
      // 只是镜像，不是契约锚点
      res.json({
        ok: true,
        url: receipt.secure_url,
        publicId: receipt.public_id,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        bytes: meta.bytes,
        maxSizeBytes: MAX_TEMPLATE_VIDEO_BYTES,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 未登记模板视频的回收（孤儿治理）─────────────────────────────────
// ★ 为什么要有这个端点：上传成功 ≠ 建成模板。视觉分析挂了、登记接口一直失败、
//   用户干脆放弃 —— 这几条路走完，Cloudinary 上都会留下一段无人引用的 20MB 级
//   公开视频，而 destroy 此前只在「复核不过」与「删已登记模板」两处调，
//   这类资产两处都够不着：配额与流出流量只增不减、零症状（正是限流注释里说的
//   那种只有月底用量报表知道的泄漏）。客户端在放弃/删除未登记模板时调这里兜底。
// ★ 归属判据 = public_id 形状（上传时就是 `${userId}-${ts}`），**唯一实现在
//   utils/templateVideoAsset.ownTemplateVideoPublicId** —— 此前这里手写了一份
//   `startsWith(前缀)`，比建模板那份松（后缀不限数字），两份分叉时没有任何症状。
// ★ 已被模板引用的资产整句拒：那些的生命周期归 DELETE /api/branch/templates/:id 级联管，
//   从这里删等于把别人在用的模板抽底。**两种引用都要挡**：
//     refVideo.cloudinaryPublicId —— 参考视频本体（删了模板直接废）；
//     source.publicId            —— 白模 V2 的原始素材（删了模板还能用，但再也重做不了）。
router.delete("/template-video", requireAuth, uploadLimit, async (req, res, next) => {
  try {
    const raw = String(req.body?.publicId ?? req.query?.publicId ?? "").slice(0, 300);
    const publicId = ownTemplateVideoPublicId(raw, req.user._id.toString());
    if (!publicId) {
      return res.status(400).json({ ok: false, message: "只能回收本账号上传的模板视频。" });
    }
    const refUsed = await BranchTemplate.exists({ "refVideo.cloudinaryPublicId": publicId });
    if (refUsed) {
      return res.status(400).json({ ok: false, message: "这段视频已登记为白模模板，请改用删除模板（会连带回收视频）。" });
    }
    const srcUsed = await BranchTemplate.exists({ "source.publicId": publicId });
    if (srcUsed) {
      return res.status(400).json({
        ok: false,
        message: "这段视频是某个白模模板的原始素材（重做时还要用它），请改用删除那个模板（会连带回收）。",
      });
    }
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
    // Cloudinary 对不存在的资源回 "not found" 而不是报错 —— 对回收来说这就是目标态，
    // 一样算成功（幂等：客户端重试第二次不该看到失败）
    return res.json({ ok: true, result: result?.result ?? "unknown" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
