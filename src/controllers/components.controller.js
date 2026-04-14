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
    enabled: Boolean(raw.enabled),
    source: raw.source === "uploaded" ? "uploaded" : "remote",
    modelJsonUrl: String(raw.modelJsonUrl || DEFAULT_REMOTE_MODEL_URL),
    uploadedModelJsonUrl: String(raw.uploadedModelJsonUrl || ""),
    uploadedBundleName: String(raw.uploadedBundleName || ""),
  };
}

function serializeSimpleToggleSettings(raw = {}) {
  return {
    enabled: Boolean(raw.enabled),
  };
}

function serializeSiteComponents(user) {
  const live2d = serializeLive2dSettings(user?.siteComponents?.live2d || {});
  const tagRank = serializeSimpleToggleSettings(user?.siteComponents?.tagRank || {});
  return {
    ok: true,
    components: {
      live2d,
      tagRank,
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

  await fs.mkdir(targetDir, { recursive: true });

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

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, entry.getData());
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
    const currentUser = await User.findById(req.user._id).select("siteComponents");
    if (!currentUser) {
      throw new AppError({ code: CODES.UNAUTHORIZED, status: 401, message: "User not found" });
    }

    const currentLive2d = serializeLive2dSettings(currentUser.siteComponents?.live2d || {});
    const currentTagRank = serializeSimpleToggleSettings(currentUser.siteComponents?.tagRank || {});
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