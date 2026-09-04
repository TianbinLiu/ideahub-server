/**
 * @file live2dBundle.service.js - Live2D 模型包（zip）的接收、安全解压、入口文件识别与对外 URL
 * @category Service
 *
 * 两个入口共用：`/api/me/components/live2d/upload`（全站挂件的私人模型，components.controller.js）与
 * `/api/live2d-models`（模型市场，live2dModel.controller.js）。解压规则原来写在 components.controller 里，
 * 市场上线后搬到这里 —— 同一份白名单、同一份 zip-bomb 记账，别让两处各自演化。
 *
 * ★ 为什么必须限制文件类型：解压产物落在 uploads/ 下，由 express.static 按【扩展名】推导 Content-Type
 *   对外提供，且该目录显式设了 Access-Control-Allow-Origin: *。zip 里塞一个 evil.html + payload.js，
 *   就得到一个同源、可执行的页面 —— helmet 的 script-src 'self' 拦不住它，因为它确实就在 self 上。
 *   API 与前端同域时即为完整的存储型 XSS（可直接读走 localStorage 里的 JWT）。.svg 同样危险：
 *   直接导航时以 image/svg+xml 渲染，内嵌 <script> 会执行。所以是白名单，不是黑名单。
 * ★ 市场只认 Cubism 4（.moc3 + model3.json）：前端运行时是 pixi-live2d-display 的 cubism4 构建，
 *   Cubism 2 的 .moc/.model.json 装上也画不出来 —— 上传时直接说清楚，别让用户装完才发现是空舞台。
 */
const fs = require("fs/promises");
const path = require("path");
const multer = require("multer");
const AdmZip = require("adm-zip");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

const UPLOADS_ROOT = path.join(__dirname, "..", "..", "uploads");
const MAX_BUNDLE_SIZE_BYTES = 25 * 1024 * 1024;
/** 解压总字节上限：25MB 的 zip 可以膨胀到几十 GB（zip bomb），必须按解压后体积记账 */
const MAX_EXTRACTED_BYTES = 60 * 1024 * 1024;
/** 条目数上限：几十万个空文件同样能把 inode 和目录遍历打死 */
const MAX_ENTRIES = 500;

// Live2D 运行时真正需要的文件类型。★这是白名单，不是黑名单 —— 新格式宁可报错也别放行。
const LIVE2D_ALLOWED_EXTENSIONS = new Set([
  ".json", ".moc", ".moc3", ".mtn", ".motion3", ".exp", ".exp3",
  ".png", ".jpg", ".jpeg", ".webp",
  ".physics3", ".cdi3", ".pose3", ".userdata3", ".txt",
]);

function validationError(message) {
  return new AppError({ code: CODES.VALIDATION_ERROR, status: 400, message });
}

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
    cb(validationError("Only .zip Live2D bundles are allowed"));
  },
});

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

/** uploads/ 之下的相对路径（posix 分隔），存库与拼 URL 都用它 */
function relativeToUploads(absoluteFilePath) {
  return path.relative(UPLOADS_ROOT, absoluteFilePath).split(path.sep).join("/");
}

/** 相对路径 → 对外 URL；host 取自当前请求（本地/线上域名不同，绝不把绝对 URL 写进库） */
function publicUrlFor(req, relativePath) {
  const protocol = String(req.headers["x-forwarded-proto"] || req.protocol || "http");
  const host = req.get("host");
  return `${protocol}://${host}/uploads/${relativePath}`;
}

function buildPublicUrl(req, absoluteFilePath) {
  return publicUrlFor(req, relativeToUploads(absoluteFilePath));
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

function isAllowedLive2DFile(name) {
  const base = path.basename(name).toLowerCase();
  if (base.startsWith(".")) return false; // .htaccess 之类
  // 复合扩展名（model3.json / motion3.json）取最后一段判断即可，
  // 但要挡住 "evil.png.html" 这种——所以判的是【最后】一个扩展名。
  const ext = path.extname(base);
  return LIVE2D_ALLOWED_EXTENSIONS.has(ext);
}

/** 解压到目录；返回 { bytes, files }（落盘的字节数与文件数） */
async function extractZipToDirectory(buffer, targetDir) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw validationError("The uploaded file is not a valid zip archive");
  }
  const entries = zip.getEntries();

  if (!entries.length) throw validationError("The uploaded Live2D bundle is empty");
  if (entries.length > MAX_ENTRIES) throw validationError(`The bundle contains too many files (max ${MAX_ENTRIES})`);

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
    if (written > MAX_EXTRACTED_BYTES) throw validationError("The bundle expands to too much data");

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, data);
    accepted += 1;
  }

  if (!accepted) throw validationError("The bundle contains no usable Live2D files");
  return { bytes: written, files: accepted };
}

/**
 * 读 model3.json，确认它是 Cubism 4 且引用的 moc3 / 贴图真的在包里。
 * 只查存在性，不解析 moc3 —— 能不能画出来由运行时说了算，这里挡的是「装上就是空舞台」那类明显错包。
 */
async function inspectModel3Json(absoluteEntryPath) {
  let json;
  try {
    json = JSON.parse(await fs.readFile(absoluteEntryPath, "utf8"));
  } catch {
    throw validationError("The model json file is not valid JSON");
  }
  const refs = json && typeof json === "object" ? json.FileReferences : null;
  const moc = refs && typeof refs.Moc === "string" ? refs.Moc : "";
  if (!moc) {
    // Cubism 2 的 model.json 用的是顶层 "model": "xxx.moc"
    const legacy = json && typeof json.model === "string" ? json.model : "";
    throw validationError(
      legacy
        ? "This is a Cubism 2 model (.moc); the market only supports Cubism 3/4 models (.moc3 + model3.json)"
        : "model3.json has no FileReferences.Moc"
    );
  }
  const baseDir = path.dirname(absoluteEntryPath);
  const resolveRef = (ref) => {
    const target = path.resolve(baseDir, String(ref));
    if (path.relative(baseDir, target).startsWith("..")) throw validationError(`model3.json references a file outside the bundle: ${ref}`);
    return target;
  };
  const mocPath = resolveRef(moc);
  if (!/\.moc3$/i.test(mocPath)) throw validationError("FileReferences.Moc must point to a .moc3 file");
  await fs.access(mocPath).catch(() => {
    throw validationError(`The moc3 file referenced by model3.json is missing: ${moc}`);
  });
  const textures = Array.isArray(refs.Textures) ? refs.Textures.filter((t) => typeof t === "string") : [];
  if (!textures.length) throw validationError("model3.json lists no textures");
  for (const tex of textures) {
    const texPath = resolveRef(tex);
    await fs.access(texPath).catch(() => {
      throw validationError(`A texture referenced by model3.json is missing: ${tex}`);
    });
  }
  return { moc, textures };
}

/**
 * 一条龙：解压 → 找入口 → 校验 model3.json。失败时目录已清理。
 * @returns {{ bundleDir: string, modelJsonPath: string, bytes: number, files: number }} 路径都是相对 uploads/ 的 posix 路径
 */
async function installBundle(buffer, { rootRelativeDir, originalName }) {
  const bundleDirName = `${Date.now()}-${safeSlug(originalName)}`;
  const bundleDirAbs = path.join(UPLOADS_ROOT, ...rootRelativeDir.split("/"), bundleDirName);
  await removeDirectoryIfExists(bundleDirAbs);
  try {
    const { bytes, files } = await extractZipToDirectory(buffer, bundleDirAbs);
    const entry = findModelEntryFile(await walkFiles(bundleDirAbs));
    if (!entry) throw validationError("No Live2D model json file was found in the uploaded bundle");
    const entryAbs = entry.replace(/\//g, path.sep);
    await inspectModel3Json(entryAbs);
    return {
      bundleDir: relativeToUploads(bundleDirAbs),
      modelJsonPath: relativeToUploads(entryAbs),
      bytes,
      files,
    };
  } catch (err) {
    await removeDirectoryIfExists(bundleDirAbs);
    throw err;
  }
}

/** 删除某个 uploads/ 下的相对目录（只允许删 uploads/ 之内的东西） */
async function removeBundleDir(relativeDir) {
  const abs = path.resolve(UPLOADS_ROOT, ...String(relativeDir || "").split("/"));
  if (!relativeDir || path.relative(UPLOADS_ROOT, abs).startsWith("..") || abs === UPLOADS_ROOT) return;
  await removeDirectoryIfExists(abs);
}

module.exports = {
  UPLOADS_ROOT,
  MAX_BUNDLE_SIZE_BYTES,
  MAX_EXTRACTED_BYTES,
  MAX_ENTRIES,
  uploadLive2dBundle,
  safeSlug,
  removeDirectoryIfExists,
  walkFiles,
  relativeToUploads,
  publicUrlFor,
  buildPublicUrl,
  findModelEntryFile,
  extractZipToDirectory,
  inspectModel3Json,
  installBundle,
  removeBundleDir,
};
