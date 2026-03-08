const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { contentImageUpload, MAX_IMAGE_SIZE_BYTES } = require("../middleware/upload");

router.post("/image", requireAuth, contentImageUpload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "No file uploaded" });
    }

    const baseUrl = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
    const imageUrl = `${baseUrl}/uploads/content-images/${req.file.filename}`;

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

module.exports = router;
