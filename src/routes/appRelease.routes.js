// src/routes/appRelease.routes.js
// 安卓 App（ideahub-app）的版本清单与下载入口，base /api/app：
//   GET /api/app/latest.json  版本清单（App 自更新用；官网下载页也用它显示版本/大小/更新说明）
//   GET /api/app/download     302 到当前版本的安装包（官网下载页的按钮、二维码用）
//
// ★★ 为什么服务端要转一手，而不是让 App 直接去 GitHub 拿：
//   ① **国内快**。App 每次冷启动都要拉一次这个清单去比版本号；直连 GitHub
//      在国内经常几秒甚至超时，而超时的后果是**静默的**——用户永远收不到更新提示，
//      而且没有任何症状可看。走这台 ECS 是几百字节的秒回。
//   ② **下载源以后能换，不用重新出包**。App 里那个清单地址是**构建期常量**
//      （VITE_UPDATE_MANIFEST），一旦发出去就钉死在每个用户的包里了。
//      清单本身在服务端，就等于留了个可以随时改的开关：哪天想把 95MB 的 APK
//      挪到 OSS/CDN，配一个环境变量就行，已经装了 App 的人立刻生效。
//
// ★ 上游仍是 GitHub Release 的固定地址（/releases/latest/download/latest.json），
//   由 ideahub-app 的 `npm run release` 生成并校验。这里**不重新计算任何东西**，
//   只做缓存与地址改写——版本号、sha256 的唯一出处仍然只有一处（铁律六）。
const router = require("express").Router();

/** 上游清单。App 仓的发版脚本保证这个地址永远指向最新一版 */
const UPSTREAM =
  process.env.APP_MANIFEST_UPSTREAM ||
  "https://github.com/TianbinLiu/ideahub-app/releases/latest/download/latest.json";

/**
 * 下载地址的替换前缀。留空 = 原样用清单里的 GitHub 地址。
 * 想把 APK 挪到 OSS/CDN 时，设成例如 https://cdn.example.com/app/ 即可 ——
 * **不需要重新出包**，已经装了 App 的用户下次检查更新就会拿到新地址。
 */
const APK_BASE = (process.env.APP_APK_BASE || "").replace(/\/+$/, "");

/** 缓存 60 秒。★ 不能太长：发完新版之后，发布脚本要立刻能验证到这里也变了；
 *  也不能没有：这是个匿名端点，每个用户每次冷启动都会打一次。 */
const TTL_MS = 60_000;
/** 上游抽风时，最多拿多旧的缓存顶着。★ 宁可回一份旧清单，也不要 5xx ——
 *  502 会让 App 的检查更新失败，而那是**静默的**；旧清单最多晚一版提示。 */
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

let cache = null; // { at, body }

async function fetchUpstream() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    // 加随机串绕开 GitHub 的 CDN 缓存：不绕的话刚发的新版这里可能还看到上一版
    const res = await fetch(`${UPSTREAM}${UPSTREAM.includes("?") ? "&" : "?"}cb=${Date.now()}`, {
      redirect: "follow",
      signal: ctl.signal,
    });
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
 * ★ 抽出来是因为下面有**两个**端点要用（清单本身 + 下载跳转）。两边各拉各的话，
 *   缓存也会各存一份，于是出现「页面上写着 1.7，点下载给的是 1.6」这种
 *   没人会来报告的错位 —— 版本这件事必须只有一处出处（铁律六）。
 */
async function resolveManifest() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return { body: cache.body, cacheState: "hit" };

  try {
    const body = await fetchUpstream();
    cache = { at: now, body };
    return { body, cacheState: "miss" };
  } catch (err) {
    // ★ 上游挂了就发旧的，别 5xx。App 侧检查更新失败是静默的，
    //   回一份一天以内的旧清单，至少"有没有新版"这件事还答得上来。
    if (cache && now - cache.at < STALE_MAX_MS) {
      console.warn("[app] 拉不到上游清单，回退到缓存:", err.message);
      return { body: cache.body, cacheState: "stale" };
    }
    console.warn("[app] 拉不到上游清单且无缓存可用:", err.message);
    throw err;
  }
}

/** 下载源改写：只动主机+路径前缀，文件名仍然来自上游清单（版本号在文件名里） */
function withApkBase(body) {
  if (!APK_BASE || typeof body.apkUrl !== "string") return body;
  return { ...body, apkUrl: `${APK_BASE}/${body.apkUrl.split("/").pop()}` };
}

// GET /api/app/latest.json —— 无需登录（检查更新发生在登录之前）
router.get("/latest.json", async (req, res) => {
  try {
    const { body, cacheState } = await resolveManifest();
    send(res, body, cacheState);
  } catch {
    res.status(503).json({ ok: false, code: "UPSTREAM_UNAVAILABLE", message: "版本清单暂时取不到" });
  }
});

// GET /api/app/download —— 官网下载页的按钮打这里，302 到**当前**版本的安装包。
//
// ★ 为什么要有这条跳转，而不是让页面直接用清单里的 apkUrl：
//   ① 它是个**不带版本号的固定地址**。清单里的 apkUrl 长这样：
//      …/releases/download/v1.7/qimeng-1.7.apk —— 印在海报、二维码、聊天记录里的
//      每一份都会在下次发版之后变成旧包，而且发出去就收不回来了。
//   ② 换下载源（OSS/CDN）时只要在服务端配 APP_APK_BASE，官网一行都不用改
//      （和 App 自更新换源是同一个开关，仍然只有一处实现）。
//   ③ 下载量直接数 nginx access log 里这个路径的命中数即可。**故意不在这里
//      自己再记一份计数**：pm2 跑的是 cluster 模式，进程内计数器天生分裂成 4 份，
//      而入口那层本来就把每一次请求都记全了 —— 多记一份只会多出一个会对不上的数。
router.get("/download", async (req, res) => {
  let body;
  try {
    ({ body } = await resolveManifest());
  } catch {
    res.status(503).json({ ok: false, code: "UPSTREAM_UNAVAILABLE", message: "安装包地址暂时取不到，稍后再试" });
    return;
  }

  const apkUrl = withApkBase(body).apkUrl;
  // ★ 上游清单被写坏（或 APP_APK_BASE 配错）时**不能**把用户往一个野地址上送：
  //   这是个匿名端点，跳转目标一旦可控就是一枚开放重定向，还会把 App 的安装包
  //   变成钓鱼落点。清单本身是自家发布产物，所以这里只挡协议，不做白名单。
  if (typeof apkUrl !== "string" || !/^https?:\/\//i.test(apkUrl)) {
    console.warn("[app] 清单里的 apkUrl 不是合法 http(s) 地址，拒绝跳转:", apkUrl);
    res.status(502).json({ ok: false, code: "BAD_MANIFEST", message: "安装包地址异常" });
    return;
  }

  // ★ no-store：这条跳转的**指向会随发版改变**。让浏览器或中间 CDN（线上前面挂着
  //   Cloudflare）把 302 缓存下来，等于把点过一次的人钉死在旧版本上 —— 而且和
  //   本文件里其它坑一样，它是静默的：用户下到的是旧包，没人会发现。
  //   代价只是每次点击多一次几百字节的回源。
  res.set("Cache-Control", "no-store");
  res.redirect(302, apkUrl);
});

function send(res, body, cacheState) {
  res.set("Cache-Control", "public, max-age=60");
  res.set("X-Manifest-Cache", cacheState);
  res.json(withApkBase(body));
}

module.exports = router;
