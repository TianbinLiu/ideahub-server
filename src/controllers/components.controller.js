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

/**
 * 全站挂件的默认模型 = **官方看板娘小梦**，用**空串**表示（2026-09-18 起）。
 * 与模型市场 `official-mascot` 同一个约定（见 live2dMarket.service）：服务端不知道官网的域名，所以不存地址，
 * 官网把空串解析成随站点打包的 /live2d/mascot/mascot.model3.json（client live2d/sampleCredit.activeLive2dModelUrl）。
 *
 * ★ 为什么不再是 Hiyori：Hiyori 是 Live2D 官方示例数据，按 Live2D Free Material License Agreement v1.6
 *   （日文正本），运营方最近一个会计年度的商业活动销售额达到 1,000 万日元时，示例数据只能用于内部或监修目的，
 *   不能放在公开网站上。
 */
const DEFAULT_MODEL_JSON_URL = "";
/**
 * 2026-09-18 之前的默认地址。★ 在设置页点过「保存」的人，存进库里的正是它（设置页把默认值原样填进输入框再发回来），
 * 光改上面那个默认值管不到这些人 —— 读的时候把**逐字等于它**的值当成「没选过」，下一次写入时顺手落成空串。
 * 只认逐字相等：用户自己填的别的地址（哪怕也是示例）原样保留，那是他的选择，官网照样会给示例挂版权声明。
 */
const LEGACY_DEFAULT_MODEL_JSON_URL =
  "https://fastly.jsdelivr.net/gh/Live2D/CubismWebSamples/Samples/Resources/Hiyori/Hiyori.model3.json";
const LIVE2D_UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads", "live2d-models");
function serializeLive2dSettings(raw = {}) {
  const stored = String(raw.modelJsonUrl || "").trim();
  return {
    enabled: raw.enabled !== false,
    source: raw.source === "uploaded" ? "uploaded" : "remote",
    modelJsonUrl: !stored || stored === LEGACY_DEFAULT_MODEL_JSON_URL ? DEFAULT_MODEL_JSON_URL : stored,
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

function ensureValidModelJsonUrl(url, fieldName, { allowEmpty = false } = {}) {
  const value = String(url || "").trim();
  if (!value) {
    // 远程地址留空 = 用官方看板娘（见 DEFAULT_MODEL_JSON_URL）；只有调用方声明允许时才放行
    if (allowEmpty) return DEFAULT_MODEL_JSON_URL;
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
                ? ensureValidModelJsonUrl(live2dInput.modelJsonUrl, "modelJsonUrl", { allowEmpty: true })
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
  DEFAULT_MODEL_JSON_URL,
  getMyComponents,
  updateMyComponents,
  uploadLive2dBundle,
  uploadMyLive2dBundle,
};