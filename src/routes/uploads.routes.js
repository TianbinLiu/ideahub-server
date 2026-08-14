const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { upload, uploadMedia, uploadToCloudinary, MAX_IMAGE_SIZE_BYTES, MAX_MEDIA_SIZE_BYTES } = require("../middleware/upload");
const { cloudinary } = require("../config/cloudinary");

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

module.exports = router;
