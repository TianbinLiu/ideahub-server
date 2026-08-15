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

// ── 白模模板视频（blockout r2v）────────────────────────────────────────
// ★ 不复用 uploadMedia：方舟 r2v 官方只认 mp4/mov —— /media 白名单里的 webm/ogg
//   传上去也没用，会在用户付费出片那一步才 400。专用 multer 实例把无效格式挡在上传口。
const ALLOWED_TEMPLATE_VIDEO_MIMES = ["video/mp4", "video/quicktime"];
/**
 * 上传口的大小上限。
 * ★ 2026-08-15 从 20MB 提到 100MB（白模 V2）：V1 传的是自己做的白模预演片
 *   （大色块 H.264，15s/720p 才 5-8MB），V2 传的是**任意实拍视频**，
 *   一分钟 1080p 就 60MB 级。
 * ⚠⚠ 跨组件：nginx 的 `client_max_body_size` 必须 ≥ 110m（留 multipart 边界与头部的余量），
 *   否则**请求根本到不了 Node** —— 用户看到的是 nginx 那张 413 静态页，
 *   服务端日志里一条记录都没有（查起来完全没有线索）。见 ALIYUN_HK_DEPLOYMENT_RUNBOOK.md。
 */
const MAX_TEMPLATE_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * ① **原始素材**的验收窗口（上传口）。白模 V2 起放宽。
 *
 * ★★ 为什么要有两套窗口：V1 的上传口传的就是最终参考视频本体，一套窗口够用。
 *   V2 起用户传的是**任意视频**，真正要满足方舟约束的是「编辑页框选、服务端裁出来的
 *   那一段」（见下面的 TEMPLATE_REF_RULES），原片本身不再直接进方舟。
 *   继续拿参考视频那套严窗口卡上传口，等于「一段 3 分钟的素材连传都传不上来，
 *   而它裁出来的 8 秒完全合格」—— 用户根本没法开始。
 *
 * 放宽/保留各自的理由：
 *   时长 (0,600]   —— 上限 10 分钟只是封住上传成本与存储，与方舟无关（裁剪后才进方舟）。
 *   边长 ≥300      —— **必要条件**：裁剪框不可能比原片大，原片任一边 <300 时
 *                     裁出来的边长必然也 <300，永远过不了 F3。早拒比让他白传 100MB 好。
 *   宽×高 ≥407,696 —— 同上，也是必要条件（裁剪面积 ≤ 原片面积）。
 *   **不再校宽高比** —— 比例正是裁剪框能修的那一项（16:9 的原片裁出竖版完全合理）。
 *   **不设边长上限** —— 4K/8K 原片没问题，裁出来的那块 ≤6000 即可。
 */
const TEMPLATE_SOURCE_RULES = Object.freeze({
  minSec: 0, // 开区间，见 templateSourceIssue（只要求 >0）
  maxSec: 600,
  minEdge: 300,
  minPixels: 407_696,
});

/**
 * ② **参考视频**（真正喂给方舟 r2v 的那一段）的验收窗口 ——
 *    **这条规则的唯一实现**（铁律六）。三个调用方：
 *      · POST /api/branch/templates 建模板（V1：整段原片就是参考视频）
 *      · POST /api/branch/templates/blockoutize 裁剪后复核（V2 第 4 步）
 *      · 同一端点里对**白模化产物**转存后的复核（产物要当下一发的参考视频）
 *    三处如果窗口变了必须同时变，所以只能有这一份。
 *
 * 各数值的出处（都不是拍脑袋）：
 *   [4,30]s   —— 方舟 `edit` 子任务的时长硬窗口，**2026-08-15 实测**错误原文
 *               "the video selected must satisfy the duration requirement of 4 to 30 seconds"（F1）。
 *               ★ 上限从 15 放宽到 30 是 V2 的一部分：V1 那个 15 是"对齐 2.0 系列单发上限 +
 *               封住成本上界"的自我约束，不是方舟的约束；V2 由用户在编辑页自己框选，
 *               成本在开炼前整句报出。放宽时 config/tokens.js 的 r2vTokens 夹取区间
 *               **必须一起改**（那里夹到 15 的话，20s 的模板会按 15s 计价 = 报价 < 实收，
 *               本仓头号事故形状）。
 *   [300,6000] / 比例 [0.4,2.5] —— 方舟官方对输入视频的边长与宽高比约束（F3 实测拿到原文）。
 *   宽×高 ≥ 407,696 —— 2026-08-14 A2 探针第一发 400 实测出的**像素数硬门**
 *               （官方文档没写，方舟直接拒单），不预检的话用户会在付费那一步才撞墙。
 */
const TEMPLATE_REF_RULES = Object.freeze({
  minSec: 4,
  maxSec: 30,
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

/** 元数据齐不齐。两套窗口共用（缺了就没法定价，也没法判窗口） */
function metaMissingIssue(meta, what) {
  const { duration, width, height } = meta || {};
  if (
    !Number.isFinite(duration) || duration <= 0 ||
    !Number.isFinite(width) || width <= 0 ||
    !Number.isFinite(height) || height <= 0
  ) {
    // 回执缺字段不是用户的错，但也不能放行 —— 元数据是 r2v 结算的锚点，缺了就没法定价
    return `云端没有返回${what}的时长或尺寸，无法继续，请换一个 mp4/mov 文件重试。`;
  }
  return null;
}

/**
 * ① 原始素材过不过上传口的窗口。
 * @returns {string|null} null = 合格；字符串 = **能直接显示给用户的整句中文原因**
 *   （全 app 没人监听 emitApiError，只回错误码就是让用户对着转圈干等 —— 铁律八）。
 */
function templateSourceIssue(meta) {
  const miss = metaMissingIssue(meta, "这段视频");
  if (miss) return miss;
  const { duration, width, height } = meta;
  const R = TEMPLATE_SOURCE_RULES;
  if (duration > R.maxSec) {
    return `视频最长 ${R.maxSec} 秒（当前约 ${duration} 秒），请先剪短再上传——超长素材只会让上传和裁剪都更慢。`;
  }
  if (width < R.minEdge || height < R.minEdge) {
    return `视频边长至少 ${R.minEdge} 像素（当前 ${width}×${height}）：裁剪框不可能比原片更大，这样的素材裁出来也过不了 AI 引擎的尺寸下限。`;
  }
  if (width * height < R.minPixels) {
    return `视频分辨率太低：宽×高至少要 ${R.minPixels.toLocaleString("en-US")} 像素（当前 ${width}×${height} = ${(width * height).toLocaleString("en-US")}），裁剪只会更小，AI 引擎会拒绝这样的输入。`;
  }
  // ★ 刻意不校宽高比：比例正是裁剪框能修的那一项（见 TEMPLATE_SOURCE_RULES 的说明）
  return null;
}

/**
 * ② 参考视频（真正喂给方舟的那一段）过不过窗口。
 * @param {object} meta { duration, width, height }
 * @param {string} [what] 出现在文案里的主语（"这一段"/"模板视频"），让用户知道说的是哪一步
 * @returns {string|null} null = 合格；字符串 = 整句中文原因
 */
function templateRefIssue(meta, what = "模板视频") {
  const miss = metaMissingIssue(meta, what);
  if (miss) return miss;
  const { duration, width, height } = meta;
  const R = TEMPLATE_REF_RULES;
  if (duration < R.minSec) {
    return `${what}至少要 ${R.minSec} 秒（当前约 ${duration} 秒）：低于 ${R.minSec} 秒会低于 AI 出片任务的时长下限。`;
  }
  if (duration > R.maxSec) {
    return `${what}最长 ${R.maxSec} 秒（当前约 ${duration} 秒），请缩短后重试——越长，每次出片的费用也越高。`;
  }
  if (width < R.minEdge || height < R.minEdge || width > R.maxEdge || height > R.maxEdge) {
    return `${what}的边长要在 ${R.minEdge}~${R.maxEdge} 像素之间（当前 ${width}×${height}），AI 引擎不接受这个尺寸。`;
  }
  if (width * height < R.minPixels) {
    return `${what}分辨率太低：宽×高至少要 ${R.minPixels.toLocaleString("en-US")} 像素（当前 ${width}×${height} = ${(width * height).toLocaleString("en-US")}），AI 引擎会拒绝这样的输入。`;
  }
  const ratio = width / height;
  if (ratio < R.minRatio || ratio > R.maxRatio) {
    return `${what}的宽高比要在 ${R.minRatio}~${R.maxRatio} 之间（当前约 ${ratio.toFixed(2)}），过于细长的画幅 AI 引擎不接受。`;
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
  // ★ 两套窗口是**两件事**，名字必须分得开：一个名字管两种含义，正是"改一处漏一处"的温床。
  //   TEMPLATE_SOURCE_* = 用户传上来的原始素材；TEMPLATE_REF_* = 真正喂给方舟的那一段。
  TEMPLATE_SOURCE_RULES,
  TEMPLATE_REF_RULES,
  templateVideoMeta,
  templateSourceIssue,
  templateRefIssue,
};
