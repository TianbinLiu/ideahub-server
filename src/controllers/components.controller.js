const path = require("path");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
// zip 接收 / 安全解压 / 入口识别 / 对外 URL 全在 live2dBundle.service.js（与模型市场共用一份白名单与记账）
const {
  uploadLive2dBundle,
  MAX_BUNDLE_SIZE_BYTES,
  safeSlug,
  removeDirectoryIfExists,
  walkFiles,
  buildPublicUrl,
  findModelEntryFile,
  extractZipToDirectory,
} = require("../services/live2dBundle.service");

const DEFAULT_REMOTE_MODEL_URL =
  "https://fastly.jsdelivr.net/gh/Live2D/CubismWebSamples/Samples/Resources/Hiyori/Hiyori.model3.json";
const LIVE2D_UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads", "live2d-models");
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