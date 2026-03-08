const multer = require("multer");
const path = require("path");
const fs = require("fs");

const ALLOWED_MIMES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createStorage(subDir, namePrefixResolver) {
  const uploadDir = path.join(__dirname, `../../uploads/${subDir}`);
  ensureDir(uploadDir);

  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const prefix = namePrefixResolver(req);
      const timestamp = Date.now();
      const random = Math.floor(Math.random() * 10000);
      const ext = path.extname(file.originalname);
      cb(null, `${prefix}-${timestamp}-${random}${ext}`);
    },
  });
}

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
    return;
  }
  cb(new Error("Only image files are allowed (jpeg, jpg, png, gif, webp)"), false);
};

function createImageUpload(storage) {
  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: MAX_IMAGE_SIZE_BYTES,
    },
  });
}

const avatarStorage = createStorage("avatars", (req) => {
  return (req.user?._id || req.user?.id || "user").toString();
});

const contentImageStorage = createStorage("content-images", (req) => {
  return (req.user?._id || req.user?.id || "user").toString();
});

const upload = createImageUpload(avatarStorage);
const contentImageUpload = createImageUpload(contentImageStorage);

module.exports = {
  upload,
  contentImageUpload,
  ALLOWED_MIMES,
  MAX_IMAGE_SIZE_BYTES,
};
