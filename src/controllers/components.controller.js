const fs = require("fs/promises");
const path = require("path");
const multer = require("multer");
const AdmZip = require("adm-zip");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

const DEFAULT_REMOTE_MODEL_URL =
  "https://fastly.jsdelivr.net/gh/Live2D/CubismWebSamples/Samples/Resources/Hiyori/Hiyori.model3.json";
const LIVE2D_UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads", "live2d-models");
const MAX_BUNDLE_SIZE_BYTES = 25 * 1024 * 1024;

const uploadLive2dBundle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BUNDLE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const fileName = String(file.originalname || "").toLowerCase();
    const mimeType = String(file.mimetype || "").toLowerCase();
    if (fileName.endsWith(".zip") || mimeType === "application/zip" || mimeType === "application/x-zip-compressed") {
      cb(null, true);
      return;
    }
    cb(
      new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "Only .zip Live2D bundles are allowed",
      })
    );
  },
});

function serializeLive2dSettings(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    source: raw.source === "uploaded" ? "uploaded" : "remote",
    modelJsonUrl: String(raw.modelJsonUrl || DEFAULT_REMOTE_MODEL_URL),
    uploadedModelJsonUrl: String(raw.uploadedModelJsonUrl || ""),
    uploadedBundleName: String(raw.uploadedBundleName || ""),
  };
}

function serializeSimpleToggleSettings(raw = {}) {
  return {
    enabled: raw.enabled !== false,
  };
}

function serializeSiteComponents(user) {
  const live2d = serializeLive2dSettings(user?.siteComponents?.live2d || {});
  const tagRank = serializeSimpleToggleSettings(user?.siteComponents?.tagRank || {});
  const siteTemplateEditor = serializeSimpleToggleSettings(user?.siteComponents?.siteTemplateEditor || {});
  return {
    ok: true,
    components: {
      live2d,
      tagRank,
      siteTemplateEditor,
    },
    catalog: [
      {
        key: "live2d",
        title: "Live2D 看板娘",
        description: "在全站右下角加载可切换模型的 Live2D 看板娘。",
        enabled: live2d.enabled,
        hasSettings: true,
        settingsPath: "/components/live2d",
      },
      {
        key: "tagRank",
        title: "Tag Rank 搜索",
        description: "启用后，首页 Idea 搜索区会出现 Tag Rank 搜索模式开关。",
        enabled: tagRank.enabled,
        hasSettings: true,
        settingsPath: "/components/tag-rank",
      },
      {
        key: "siteTemplateEditor",
        title: "创意工坊前端 UI 编辑",
        description: "启用后，可以进入全站前端 UI 编辑模式，并在创意工坊中创建或编辑站点模板。",
        enabled: siteTemplateEditor.enabled,
        hasSettings: false,
      },
    ],
  };
}

function ensureValidModelJsonUrl(url, fieldName) {
  const value = String(url || "").trim();
  if (!value) {
    throw new AppError({
      code: CODES.VALIDATION_ERROR,
      status: 400,
      message: `${fieldName} is required`,
    });
  }

  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Invalid protocol");
    }
  } catch {
    throw new AppError({
      code: CODES.VALIDATION_ERROR,
      status: 400,
      message: `${fieldName} must be a valid http(s) URL`,
    });
  }

  if (!/\.json($|\?)/i.test(value)) {
    throw new AppError({
      code: CODES.VALIDATION_ERROR,
      status: 400,
      message: `${fieldName} must point to a Live2D model json file`,
    });
  }

  return value;
}

function safeSlug(input) {
  return String(input || "bundle")
    .replace(/\.zip$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "bundle";
}

async function removeDirectoryIfExists(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
}

async function walkFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function buildPublicUrl(req, absoluteFilePath) {
  const uploadsRoot = path.join(__dirname, "..", "..", "uploads");
  const relativePath = path.relative(uploadsRoot, absoluteFilePath).split(path.sep).join("/");
  const protocol = String(req.headers["x-forwarded-proto"] || req.protocol || "http");
  const host = req.get("host");
  return `${protocol}://${host}/uploads/${relativePath}`;
}

function findModelEntryFile(files) {
  const normalized = files.map((filePath) => filePath.split(path.sep).join("/"));
  const preferredPatterns = [/\.model3\.json$/i, /\/index\.json$/i, /\.model\.json$/i, /\.json$/i];

  for (const pattern of preferredPatterns) {
    const found = normalized.find((filePath) => {
      if (!pattern.test(filePath)) return false;
      if (/textures\.cache$/i.test(filePath)) return false;
      if (/model_list\.json$/i.test(filePath)) return false;
      return true;
    });
    if (found) {
      return found;
    }
  }

  return "";
}

// Live2D 运行时真正需要的文件类型。★这是白名单，不是黑名单 —— 新格式宁可报错也别放行。
//
// 为什么必须限制：解压产物落在 uploads/ 下，由 express.static 按【扩展名】推导 Content-Type
// 对外提供，且该目录显式设了 Access-Control-Allow-Origin: *。zip 里塞一个 evil.html +
// payload.js，就得到一个同源、可执行的页面 —— helmet 的 script-src 'self' 拦不住它，
// 因为它确实就在 self 上。API 与前端同域时即为完整的存储型 XSS（可直接读走 localStorage 里的 JWT）。
// .svg 同样危险：直接导航时以 image/svg+xml 渲染，内嵌 <script> 会执行。
const LIVE2D_ALLOWED_EXTENSIONS = new Set([
  ".json", ".moc", ".moc3", ".mtn", ".motion3", ".exp", ".exp3",
  ".png", ".jpg", ".jpeg", ".webp",
  ".physics3", ".cdi3", ".pose3", ".userdata3", ".txt",
]);

/** 解压总字节上限：25MB 的 zip 可以膨胀到几十 GB（zip bomb），必须按解压后体积记账 */
const MAX_EXTRACTED_BYTES = 60 * 1024 * 1024;
/** 条目数上限：几十万个空文件同样能把 inode 和目录遍历打死 */
const MAX_ENTRIES = 500;

function isAllowedLive2DFile(name) {
  const base = path.basename(name).toLowerCase();
  if (base.startsWith(".")) return false; // .htaccess 之类
  // 复合扩展名（model3.json / motion3.json）取最后一段判断即可，
  // 但要挡住 "evil.png.html" 这种——所以判的是【最后】一个扩展名。
  const ext = path.extname(base);
  return LIVE2D_ALLOWED_EXTENSIONS.has(ext);
}

async function extractZipToDirectory(buffer, targetDir) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  if (!entries.length) {
    throw new AppError({
      code: CODES.VALIDATION_ERROR,
      status: 400,
      message: "The uploaded Live2D bundle is empty",
    });
  }

  if (entries.length > MAX_ENTRIES) {
    throw new AppError({
      code: CODES.VALIDATION_ERROR,
      status: 400,
      message: `The bundle contains too many files (max ${MAX_ENTRIES})`,
    });
  }

  await fs.mkdir(targetDir, { recursive: true });

  let written = 0;
  let accepted = 0;

  for (const entry of entries) {
    const normalizedName = path.normalize(entry.entryName).replace(/^([.][.][/\\])+/, "");
    if (!normalizedName || normalizedName.startsWith("__MACOSX")) {
      continue;
    }

    const destination = path.join(targetDir, normalizedName);
    const relative = path.relative(targetDir, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }

    if (entry.isDirectory) {
      await fs.mkdir(destination, { recursive: true });
      continue;
    }

    // 不在白名单的条目直接跳过（而不是报错）：真实的 Live2D 包常夹带
    // readme/psd/授权文件，为这些整包拒绝对用户太粗暴。危险的那些不落盘即可。
    if (!isAllowedLive2DFile(normalizedName)) {
      continue;
    }

    const data = entry.getData();
    written += data.length;
    if (written > MAX_EXTRACTED_BYTES) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "The bundle expands to too much data",
      });
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, data);
    accepted += 1;
  }

  if (!accepted) {
    throw new AppError({
      code: CODES.VALIDATION_ERROR,
      status: 400,
      message: "The bundle contains no usable Live2D files",
    });
  }
}

async function getMyComponents(req, res, next) {
  try {
    const user = await User.findById(req.user._id).select("siteComponents").lean();
    if (!user) {
      throw new AppError({ code: CODES.UNAUTHORIZED, status: 401, message: "User not found" });
    }

    res.json(serializeSiteComponents(user));
  } catch (err) {
    next(err);
  }
}

async function updateMyComponents(req, res, next) {
  try {
    const live2dInput = req.body?.live2d;
    const tagRankInput = req.body?.tagRank;
    const siteTemplateEditorInput = req.body?.siteTemplateEditor;
    const currentUser = await User.findById(req.user._id).select("siteComponents");
    if (!currentUser) {
      throw new AppError({ code: CODES.UNAUTHORIZED, status: 401, message: "User not found" });
    }

    const currentLive2d = serializeLive2dSettings(currentUser.siteComponents?.live2d || {});
    const currentTagRank = serializeSimpleToggleSettings(currentUser.siteComponents?.tagRank || {});
    const currentSiteTemplateEditor = serializeSimpleToggleSettings(currentUser.siteComponents?.siteTemplateEditor || {});
    const nextLive2d =
      live2dInput === undefined
        ? currentLive2d
        : {
            enabled: Boolean(live2dInput.enabled),
            source: live2dInput.source === "uploaded" ? "uploaded" : "remote",
            modelJsonUrl:
              live2dInput.modelJsonUrl !== undefined
                ? ensureValidModelJsonUrl(live2dInput.modelJsonUrl, "modelJsonUrl")
                : currentLive2d.modelJsonUrl,
            uploadedModelJsonUrl: currentLive2d.uploadedModelJsonUrl,
            uploadedBundleName: currentLive2d.uploadedBundleName,
          };
    const nextTagRank =
      tagRankInput === undefined
        ? currentTagRank
        : {
            enabled: Boolean(tagRankInput.enabled),
          };
    const nextSiteTemplateEditor =
      siteTemplateEditorInput === undefined
        ? currentSiteTemplateEditor
        : {
            enabled: Boolean(siteTemplateEditorInput.enabled),
          };

    if (nextLive2d.source === "uploaded" && !nextLive2d.uploadedModelJsonUrl) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "Upload a Live2D bundle before switching to uploaded mode",
      });
    }

    currentUser.siteComponents = {
      ...(currentUser.siteComponents?.toObject ? currentUser.siteComponents.toObject() : currentUser.siteComponents || {}),
      live2d: nextLive2d,
      tagRank: nextTagRank,
      siteTemplateEditor: nextSiteTemplateEditor,
    };
    await currentUser.save();

    res.json(serializeSiteComponents(currentUser));
  } catch (err) {
    next(err);
  }
}

async function uploadMyLive2dBundle(req, res, next) {
  const userId = String(req.user._id);
  const userRoot = path.join(LIVE2D_UPLOAD_ROOT, userId);
  let bundleDir = "";

  try {
    if (!req.file) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "No Live2D bundle uploaded",
      });
    }

    const user = await User.findById(req.user._id).select("siteComponents");
    if (!user) {
      throw new AppError({ code: CODES.UNAUTHORIZED, status: 401, message: "User not found" });
    }

    const bundleName = `${Date.now()}-${safeSlug(req.file.originalname)}`;
    bundleDir = path.join(userRoot, bundleName);
    await removeDirectoryIfExists(bundleDir);
    await extractZipToDirectory(req.file.buffer, bundleDir);

    const files = await walkFiles(bundleDir);
    const modelEntry = findModelEntryFile(files);
    if (!modelEntry) {
      await removeDirectoryIfExists(bundleDir);
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "No Live2D model json file was found in the uploaded bundle",
      });
    }

    const uploadedModelJsonUrl = buildPublicUrl(req, modelEntry.replace(/\//g, path.sep));
    const currentLive2d = serializeLive2dSettings(user.siteComponents?.live2d || {});

    user.siteComponents = {
      ...(user.siteComponents?.toObject ? user.siteComponents.toObject() : user.siteComponents || {}),
      live2d: {
        ...currentLive2d,
        source: "uploaded",
        uploadedModelJsonUrl,
        uploadedBundleName: req.file.originalname,
      },
    };

    await user.save();

    res.json({
      ok: true,
      uploadedModelJsonUrl,
      uploadedBundleName: req.file.originalname,
      maxSizeBytes: MAX_BUNDLE_SIZE_BYTES,
      components: serializeSiteComponents(user).components,
    });
  } catch (err) {
    if (bundleDir) {
      await removeDirectoryIfExists(bundleDir);
    }
    next(err);
  }
}

module.exports = {
  DEFAULT_REMOTE_MODEL_URL,
  getMyComponents,
  updateMyComponents,
  uploadLive2dBundle,
  uploadMyLive2dBundle,
};