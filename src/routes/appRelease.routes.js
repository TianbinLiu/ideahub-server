// src/routes/appRelease.routes.js
// 安卓 App 的版本清单与下载入口，base /api/app：
//   GET /api/app/latest.json         启梦的清单（**历史地址，永远不能改语义**）
//   GET /api/app/download            启梦的安装包 302
//   GET /api/app/:app/latest.json    指定 App 的清单（qimeng / shihui）
//   GET /api/app/:app/download       指定 App 的安装包 302
//
// ★★ 为什么服务端要转一手，而不是让 App 直接去 GitHub 拿：
//   ① **国内快**。App 每次冷启动都要拉一次这个清单去比版本号；直连 GitHub
//      在国内经常几秒甚至超时，而超时的后果是**静默的**——用户永远收不到更新提示，
//      而且没有任何症状可看。走这台 ECS 是几百字节的秒回。
//   ② **下载源以后能换，不用重新出包**。App 里那个清单地址是**构建期常量**，
//      一旦发出去就钉死在每个用户的包里了。清单本身在服务端，就等于留了个开关。
//
// ★★ 两个 App 的 Release 在**两个不同的 GitHub 仓库**，这是有意为之：
//   GitHub 的 /releases/latest 是**整个仓库**最新的正式 release。诗绘要是发在
//   ideahub-app，就会顶掉启梦在那里的位置，而诗绘的 release 里没有 latest.json
//   这个资产 → 每个已安装启梦的用户更新检查从此 404，**且是静默的**。
//
// ★ 这里**不重新计算任何东西**（版本号、sha256 的唯一出处仍是各自发版脚本生成的清单），
//   只做缓存与地址改写（铁律六）。
const router = require("express").Router();

/**
 * 每个 App 一条独立通道。
 * ★ 缓存必须**按 App 分开存**：共用一份的话，两个 App 的清单会互相覆盖，
 *   表现是「页面上写着诗绘 1.0，点下载给的是启梦的包」——这种错位没人会来报告。
 */
const APPS = {
  qimeng: {
    label: "启梦",
    upstream:
      process.env.APP_MANIFEST_UPSTREAM ||
      "https://github.com/TianbinLiu/ideahub-app/releases/latest/download/latest.json",
    apkBase: (process.env.APP_APK_BASE || "").replace(/\/+$/, ""),
    cache: null, // { at, body }
  },
  shihui: {
    label: "诗绘",
    upstream:
      process.env.SHIHUI_MANIFEST_UPSTREAM ||
      "https://github.com/TianbinLiu/ideahub-shihui/releases/latest/download/latest.json",
    apkBase: (process.env.SHIHUI_APK_BASE || "").replace(/\/+$/, ""),
    cache: null,
  },
};
/** 历史地址 /api/app/latest.json 指的是哪个 App。**改这一行等于让所有老用户换 App**，别动。 */
const DEFAULT_APP = "qimeng";

/** 缓存 60 秒。★ 不能太长：发完新版之后，发布脚本要立刻能验证到这里也变了；
 *  也不能没有：这是个匿名端点，每个用户每次冷启动都会打一次。 */
const TTL_MS = 60_000;
/** 上游抽风时，最多拿多旧的缓存顶着。★ 宁可回一份旧清单，也不要 5xx ——
 *  502 会让 App 的检查更新失败，而那是**静默的**；旧清单最多晚一版提示。 */
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

async function fetchUpstream(app) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    // 加随机串绕开 GitHub 的 CDN 缓存：不绕的话刚发的新版这里可能还看到上一版
    const url = `${app.upstream}${app.upstream.includes("?") ? "&" : "?"}cb=${Date.now()}`;
    const res = await fetch(url, { redirect: "follow", signal: ctl.signal });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
    const body = await res.json();
    if (typeof body?.versionCode !== "number") throw new Error("upstream manifest 缺 versionCode");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取一份可用的清单（缓存 → 上游 → 一天以内的旧缓存），拿不到就抛。
 *
 * ★ 抽出来是因为每个 App 都有**两个**端点要用（清单本身 + 下载跳转）。两边各拉各的话，
 *   缓存也会各存一份，于是出现「页面上写着 1.7，点下载给的是 1.6」这种
 *   没人会来报告的错位 —— 版本这件事必须只有一处出处（铁律六）。
 */
async function resolveManifest(key) {
  const app = APPS[key];
  const now = Date.now();
  if (app.cache && now - app.cache.at < TTL_MS) return { body: app.cache.body, cacheState: "hit" };

  try {
    const body = await fetchUpstream(app);
    app.cache = { at: now, body };
    return { body, cacheState: "miss" };
  } catch (err) {
    // ★ 上游挂了就发旧的，别 5xx。App 侧检查更新失败是静默的，
    //   回一份一天以内的旧清单，至少"有没有新版"这件事还答得上来。
    if (app.cache && now - app.cache.at < STALE_MAX_MS) {
      console.warn(`[app:${key}] 拉不到上游清单，回退到缓存:`, err.message);
      return { body: app.cache.body, cacheState: "stale" };
    }
    console.warn(`[app:${key}] 拉不到上游清单且无缓存可用:`, err.message);
    throw err;
  }
}

/** 下载源改写：只动主机+路径前缀，文件名仍然来自上游清单（版本号在文件名里） */
function withApkBase(key, body) {
  const base = APPS[key].apkBase;
  if (!base || typeof body.apkUrl !== "string") return body;
  return { ...body, apkUrl: `${base}/${body.apkUrl.split("/").pop()}` };
}

function sendManifest(res, key, body, cacheState) {
  res.set("Cache-Control", "public, max-age=60");
  res.set("X-Manifest-Cache", cacheState);
  res.json(withApkBase(key, body));
}

async function handleManifest(req, res, key) {
  try {
    const { body, cacheState } = await resolveManifest(key);
    sendManifest(res, key, body, cacheState);
  } catch {
    res.status(503).json({ ok: false, code: "UPSTREAM_UNAVAILABLE", message: "版本清单暂时取不到" });
  }
}

// GET /api/app/:app/download —— 官网下载页的按钮打这里，302 到**当前**版本的安装包。
//
// ★ 为什么要有这条跳转，而不是让页面直接用清单里的 apkUrl：
//   ① 它是个**不带版本号的固定地址**。清单里的 apkUrl 带着版本号，印在海报、
//      二维码、聊天记录里的每一份都会在下次发版之后变成旧包，且发出去就收不回来。
//   ② 换下载源（OSS/CDN）时只要在服务端配环境变量，官网一行都不用改。
//   ③ 下载量直接数 nginx access log 里这个路径的命中数即可。
async function handleDownload(req, res, key) {
  let body;
  try {
    ({ body } = await resolveManifest(key));
  } catch {
    res.status(503).json({ ok: false, code: "UPSTREAM_UNAVAILABLE", message: "安装包地址暂时取不到，稍后再试" });
    return;
  }

  const apkUrl = withApkBase(key, body).apkUrl;
  // ★ 上游清单被写坏（或 *_APK_BASE 配错）时**不能**把用户往一个野地址上送：
  //   这是个匿名端点，跳转目标一旦可控就是一枚开放重定向，还会把 App 的安装包
  //   变成钓鱼落点。清单本身是自家发布产物，所以这里只挡协议，不做白名单。
  if (typeof apkUrl !== "string" || !/^https?:\/\//i.test(apkUrl)) {
    console.warn(`[app:${key}] 清单里的 apkUrl 不是合法 http(s) 地址，拒绝跳转:`, apkUrl);
    res.status(502).json({ ok: false, code: "BAD_MANIFEST", message: "安装包地址异常" });
    return;
  }

  // ★ no-store：这条跳转的**指向会随发版改变**。让浏览器或中间 CDN 把 302 缓存下来，
  //   等于把点过一次的人钉死在旧版本上 —— 而且是静默的：用户下到的是旧包，没人会发现。
  res.set("Cache-Control", "no-store");
  res.redirect(302, apkUrl);
}

// ── 历史地址：启梦已安装用户的自更新与老版官网都打这两条，语义永远不变 ──
router.get("/latest.json", (req, res) => handleManifest(req, res, DEFAULT_APP));
router.get("/download", (req, res) => handleDownload(req, res, DEFAULT_APP));

// ── 按 App 分的地址 ──
// ★ 未知 app 一律 404，不要回落到默认 App：把 /api/app/typo/latest.json 回成启梦的清单，
//   等于让写错地址的客户端**静默地更新成另一个应用**。
const knownApp = (req, res) => {
  const key = String(req.params.app || "").toLowerCase();
  if (!Object.hasOwn(APPS, key)) {
    res.status(404).json({ ok: false, code: "UNKNOWN_APP", message: "没有这个应用" });
    return null;
  }
  return key;
};
router.get("/:app/latest.json", (req, res) => {
  const key = knownApp(req, res);
  if (key) handleManifest(req, res, key);
});
router.get("/:app/download", (req, res) => {
  const key = knownApp(req, res);
  if (key) handleDownload(req, res, key);
});

module.exports = router;
