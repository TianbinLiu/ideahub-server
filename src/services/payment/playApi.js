// Google Play Developer API 的出站适配层（D15 阶段 1）。**只做 HTTP，不做任何判断**：
// 判据（购买状态、账号、数量、测试购买…）全在 playBilling.service，那边有用例钉着。
//
// ★ 可注入：测试用 setPlayApiForTests 换成假传输（fixture 按 API 文档形状写），生产走真 HTTP ——
//   这样 13 类结局都能在 jest 里跑到，不需要真的在 Play 上买东西。
// ★ 不引整包 googleapis：只用 google-auth-library 换服务账号的 access token，REST 用原生 fetch
//   （规格 §2.6：ECS 大概率跑 Node 20，google-auth-library@10.9.1 的 engines 是 >=18）。
// ★ 404 / 410 单独成一类（PlayApiError.notFound）：那是「这个 token 在我们的包名下不存在」—— 假 token、
//   别的 App 的 token 都走这条。它与「Google 挂了」（网络 / 5xx）结局完全相反：前者回 not_purchased，
//   后者回 store_unavailable 让客户端稍后再试，**绝不能**把后者当成没买。
//
// 接口形状（2026-09-10 对着官方参考页核过）：
//   GET  …/applications/{packageName}/purchases/productsv2/tokens/{token}                      → ProductPurchaseV2
//   POST …/applications/{packageName}/purchases/products/{productId}/tokens/{token}:consume    → 空体
//   GET  …/applications/{packageName}/purchases/voidedpurchases?startTime&type&pageSelection.* → { voidedPurchases, tokenPagination }
const { playBillingConfig, parseServiceAccount } = require("../../config/playBilling");

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TIMEOUT_MS = 15_000;

class PlayApiError extends Error {
  constructor(message, { status = 0, notFound = false } = {}) {
    super(message);
    this.name = "PlayApiError";
    this.status = status;
    this.notFound = notFound;
  }
}

function realApi(cfg) {
  const sa = parseServiceAccount(cfg.saJsonB64);
  if (!sa) throw new PlayApiError("Google Play 服务账号没配好（PLAY_SA_JSON_B64）");
  // 懒加载：没开 GPB 的进程（含全部老用例）用不到它
  const { JWT } = require("google-auth-library");
  const client = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE] });
  const appBase = `${BASE}/${encodeURIComponent(cfg.packageName)}`;

  async function call(method, path, query) {
    const { token } = await client.getAccessToken();
    const url = new URL(appBase + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new PlayApiError(`Google Play API 没连上：${e?.message || e}`);
    }
    const text = await res.text().catch(() => "");
    if (res.status === 404 || res.status === 410) {
      throw new PlayApiError(`Google Play API ${res.status}`, { status: res.status, notFound: true });
    }
    if (!res.ok) throw new PlayApiError(`Google Play API ${res.status}：${text.slice(0, 200)}`, { status: res.status });
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new PlayApiError("Google Play API 回的不是 JSON", { status: res.status });
    }
  }

  return {
    /** purchases.productsv2.getproductpurchasev2 */
    getProductPurchaseV2: (purchaseToken) => call("GET", `/purchases/productsv2/tokens/${encodeURIComponent(purchaseToken)}`),
    /** purchases.products.consume。消耗型商品 consume 同时就是确认：三天内不 consume，Google 会自动退款 */
    consume: (productId, purchaseToken) =>
      call("POST", `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`),
    /** purchases.voidedpurchases.list。startTime 最早 30 天前；带分页 token 时 startTime 被忽略 */
    listVoided: ({ startTime, pageToken } = {}) =>
      call("GET", "/purchases/voidedpurchases", {
        startTime,
        type: 0,
        "pageSelection.maxResults": 1000,
        "pageSelection.token": pageToken,
      }),
  };
}

let override = null;
let cached = null;

/** 当前生效的适配器。服务账号解不开时抛 PlayApiError（调用方按 store_unavailable 处理） */
function playApi(env = process.env) {
  if (override) return override;
  const cfg = playBillingConfig(env);
  const key = `${cfg.packageName}|${cfg.saJsonB64.length}|${cfg.saJsonB64.slice(-24)}`;
  if (!cached || cached.key !== key) cached = { key, api: realApi(cfg) };
  return cached.api;
}

/** 测试专用：换成假传输（传 null 撤掉）。非 test 环境调它直接抛 —— 不许任何生产路径把真 API 换掉 */
function setPlayApiForTests(api) {
  if (process.env.NODE_ENV !== "test") throw new Error("setPlayApiForTests 只能在测试里用");
  override = api;
}

module.exports = { PlayApiError, playApi, setPlayApiForTests };
