const multer = require("multer");
const { cloudinary } = require("../config/cloudinary");

const ALLOWED_MIMES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_MEDIA_MIMES = [
  ...ALLOWED_MIMES,
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
];
const MAX_MEDIA_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// 使用内存存储，上传到 Cloudinary
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
    return;
  }
  cb(new Error("Only image files are allowed (jpeg, jpg, png, gif, webp)"), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
  },
});

const uploadMedia = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MEDIA_MIMES.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image/video files are allowed"), false);
  },
  limits: {
    fileSize: MAX_MEDIA_SIZE_BYTES,
  },
});

/**
 * 上传图片到 Cloudinary
 * @param {Buffer} buffer - 图片 buffer
 * @param {string} folder - Cloudinary 文件夹名称（avatars 或 content-images）
 * @param {string} userId - 用户 ID（用于生成唯一文件名）
 * @returns {Promise<string>} Cloudinary URL
 */
async function uploadToCloudinary(buffer, folder, userId) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `ideahub/${folder}`, // Cloudinary 文件夹路径
        public_id: `${userId}-${Date.now()}`, // 唯一文件名
        resource_type: 'image',
        transformation: [
          { quality: 'auto', fetch_format: 'auto' }, // 自动优化
        ],
      },
      (error, result) => {
        if (error) {
          console.error('[Cloudinary] Upload error:', error);
          reject(error);
        } else {
          console.log('[Cloudinary] Upload success:', result.secure_url);
          resolve(result.secure_url);
        }
      }
    );
    
    // 将 buffer 写入上传流
    uploadStream.end(buffer);
  });
}

module.exports = {
  upload,
  uploadMedia,
  uploadToCloudinary,
  ALLOWED_MIMES,
  MAX_IMAGE_SIZE_BYTES,
  ALLOWED_MEDIA_MIMES,
  MAX_MEDIA_SIZE_BYTES,
};
