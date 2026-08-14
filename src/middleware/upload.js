const multer = require("multer");
const { cloudinary } = require("../config/cloudinary");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

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

// ── 白模模板视频（blockout r2v 的参考视频）────────────────────────────
// ★ 不复用 uploadMedia：方舟 r2v 官方只认 mp4/mov —— /media 白名单里的 webm/ogg
//   传上去也没用，会在用户付费出片那一步才 400。专用 multer 实例把无效格式挡在上传口。
const ALLOWED_TEMPLATE_VIDEO_MIMES = ["video/mp4", "video/quicktime"];
// 20MB 顶：白模是大色块 H.264，压缩率极高，15s/720p 实际 5-8MB，20MB 绰绰有余
const MAX_TEMPLATE_VIDEO_BYTES = 20 * 1024 * 1024;

/**
 * 白模视频的验收窗口 —— **这条规则的唯一实现**（铁律六）。
 * 两个调用方：/api/uploads/template-video 的回执复核、POST /api/branch/templates
 * 建模板时的资源详情复核。两处如果窗口变了必须同时变，所以只能有这一份。
 *
 * 各数值的出处（都不是拍脑袋）：
 *   [4,15]s   —— 下限 4 保住方舟 edit 子任务的时长窗口 [4,30]；上限 15 对齐
 *               Seedance 2.0 系列单发上限（将来 hd 档也吃得下），且封住单次成本上界
 *               （输入时长计进 r2v token，越长越贵）。
 *   [300,6000] / 比例 [0.4,2.5] —— 方舟官方对输入视频的边长与宽高比约束。
 *   宽×高 ≥ 407,696 —— 2026-08-14 A2 探针第一发 400 实测出的**像素数硬门**
 *               （官方文档没写，方舟直接拒单），不预检的话用户会在付费那一步才撞墙。
 */
const TEMPLATE_VIDEO_RULES = Object.freeze({
  minSec: 4,
  maxSec: 15,
  minEdge: 300,
  maxEdge: 6000,
  minRatio: 0.4,
  maxRatio: 2.5,
  minPixels: 407_696,
});

/**
 * Cloudinary 回执/资源详情 → 归一化的视频元数据。两处复核共用（同一份数、同一种取法）。
 * duration 取整：Cloudinary 视频回执的 duration 实测给整数秒（2026-08 B1），
 * Math.round 只是防它哪天开始给小数。
 */
function templateVideoMeta(receipt) {
  return {
    duration: Math.round(Number(receipt?.duration)),
    width: Math.round(Number(receipt?.width)),
    height: Math.round(Number(receipt?.height)),
    bytes: Math.round(Number(receipt?.bytes)) || 0,
  };
}

/**
 * 白模视频过不过验收窗口。
 * @returns {string|null} null = 合格；字符串 = **能直接显示给用户的整句中文原因**
 *   （全 app 没人监听 emitApiError，只回错误码就是让用户对着转圈干等 —— 铁律八）。
 */
function templateVideoIssue(meta) {
  const { duration, width, height } = meta || {};
  const R = TEMPLATE_VIDEO_RULES;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    // 回执缺字段不是用户的错，但也不能放行 —— 元数据是 r2v 结算的锚点，缺了就没法定价
    return "云端没有返回这段视频的时长或尺寸，无法登记为模板，请换一个 mp4/mov 文件重试。";
  }
  if (duration < R.minSec) {
    return `模板视频至少要 ${R.minSec} 秒（当前约 ${duration} 秒）：低于 ${R.minSec} 秒会低于 AI 出片任务的时长下限。`;
  }
  if (duration > R.maxSec) {
    return `模板视频最长 ${R.maxSec} 秒（当前约 ${duration} 秒），请剪短后重试——模板越长，套用者每次出片的费用也越高。`;
  }
  if (width < R.minEdge || height < R.minEdge || width > R.maxEdge || height > R.maxEdge) {
    return `视频边长要在 ${R.minEdge}~${R.maxEdge} 像素之间（当前 ${width}×${height}），AI 引擎不接受这个尺寸。`;
  }
  if (width * height < R.minPixels) {
    return `视频分辨率太低：宽×高至少要 ${R.minPixels.toLocaleString("en-US")} 像素（当前 ${width}×${height} = ${(width * height).toLocaleString("en-US")}），AI 引擎会拒绝这样的输入。`;
  }
  const ratio = width / height;
  if (ratio < R.minRatio || ratio > R.maxRatio) {
    return `视频宽高比要在 ${R.minRatio}~${R.maxRatio} 之间（当前约 ${ratio.toFixed(2)}），过于细长的画幅 AI 引擎不接受。`;
  }
  return null;
}

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

const uploadTemplateVideo = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TEMPLATE_VIDEO_MIMES.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    // ★ 用 AppError 带 400，不学上面两个裸 new Error：裸 Error 没有 .status，
    //   errorHandler 会把它当 500「服务器错误」—— 用户明明只是选错了格式，
    //   却看到"服务器炸了"，两边都被误导（铁律八：错要响，但要指对方向）。
    cb(
      new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "模板视频只收 mp4 / mov 格式（AI 出片引擎只认这两种），请转码后重试。",
      }),
      false
    );
  },
  limits: {
    fileSize: MAX_TEMPLATE_VIDEO_BYTES,
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
  uploadTemplateVideo,
  ALLOWED_TEMPLATE_VIDEO_MIMES,
  MAX_TEMPLATE_VIDEO_BYTES,
  TEMPLATE_VIDEO_RULES,
  templateVideoMeta,
  templateVideoIssue,
};
