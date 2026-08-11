// src/routes/appRelease.routes.js
// 安卓 App（ideahub-app）的版本清单，base /api/app。
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

// GET /api/app/latest.json —— 无需登录（检查更新发生在登录之前）
router.get("/latest.json", async (req, res) => {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return send(res, cache.body, "hit");

  try {
    const body = await fetchUpstream();
    cache = { at: now, body };
    send(res, body, "miss");
  } catch (err) {
    // ★ 上游挂了就发旧的，别 5xx。App 侧检查更新失败是静默的，
    //   回一份一天以内的旧清单，至少"有没有新版"这件事还答得上来。
    if (cache && now - cache.at < STALE_MAX_MS) {
      console.warn("[app] 拉不到上游清单，回退到缓存:", err.message);
      return send(res, cache.body, "stale");
    }
    console.warn("[app] 拉不到上游清单且无缓存可用:", err.message);
    res.status(503).json({ ok: false, code: "UPSTREAM_UNAVAILABLE", message: "版本清单暂时取不到" });
  }
});

function send(res, body, cacheState) {
  const out = { ...body };
  // 下载源改写：只动主机+路径前缀，文件名仍然来自上游清单（版本号在文件名里）
  if (APK_BASE && typeof out.apkUrl === "string") {
    out.apkUrl = `${APK_BASE}/${out.apkUrl.split("/").pop()}`;
  }
  res.set("Cache-Control", "public, max-age=60");
  res.set("X-Manifest-Cache", cacheState);
  res.json(out);
}

module.exports = router;
