const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { upload, uploadMedia, uploadToCloudinary, MAX_IMAGE_SIZE_BYTES, MAX_MEDIA_SIZE_BYTES } = require("../middleware/upload");
const { cloudinary } = require("../config/cloudinary");

router.post("/image", requireAuth, upload.single("image"), async (req, res, next) => {
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

router.post("/media", requireAuth, uploadMedia.single("media"), async (req, res, next) => {
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
