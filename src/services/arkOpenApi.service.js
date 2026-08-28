// src/services/arkOpenApi.service.js
// 火山方舟 **OpenAPI**（`open.volcengineapi.com`）的调用层 —— **V4 签名的唯一实现**。
//
// 与 arkGateway.service 的区别（别混）：
//   · arkGateway 走的是**推理网关** `ark.cn-beijing.volces.com/api/v3`，用 **API Key**
//     （Bearer）认证，管的是"出图/出视频/对话"这类烧 token 的调用，且带一整套钱包记账。
//   · **本文件**走的是**管控 OpenAPI** `open.volcengineapi.com`，用 **AK/SK**（IAM 密钥）
//     做**火山 V4 签名**，管的是"真人肖像素材库"这类**资源管理**调用（建邀约、查授权状态）。
//     这些调用**不烧 token、不进钱包** —— 所以这里没有任何记账，也**不许**照抄 chargedArkCall。
//
// ★★ 密钥只在服务端（`VOLC_AK`/`VOLC_SK`）：它是 IAM 管理密钥，泄到端上等于把整个方舟资源
//   管控权交出去。所以本文件**绝不**被 app 直接触达，只由 routes/arkPortrait 这类受 requireAuth
//   的端点内部调用。
//
// ★ 签名照火山官方 V4（与 AWS SigV4 同构，唯一差别是 credential scope 的 terminator 用
//   `request` 而不是 `aws4_request`）。2026-08-27 用一次性探针实证过：
//   service=`ark`、region=`cn-beijing`、Version=`2024-01-01`，签名头
//   `content-type;host;x-content-sha256;x-date` → `ListAuthorizationAssetGroup` 200。
//   这套接口**未见公开文档**，所以调用方一律要能整句报错并退回"去控制台手工操作"（铁律八）。
const crypto = require("crypto");

const OPENAPI_HOST = "open.volcengineapi.com";
const REGION = "cn-beijing";
const SERVICE = "ark";
const DEFAULT_VERSION = "2024-01-01";
/** OpenAPI 都是小响应（UUID / 资产列表），30s 绰绰有余；给足重试余量也不至于挂住请求 */
const T_OPENAPI = 30_000;

/** 这台服务器有没有配 AK/SK。缺了就整个功能关掉，而不是半开着到调用点才 500 */
function openApiConfigured() {
  return Boolean((process.env.VOLC_AK || "").trim() && (process.env.VOLC_SK || "").trim());
}

function hmac(key, str) {
  return crypto.createHmac("sha256", key).update(str, "utf8").digest();
}
function sha256hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

/** ISO basic 格式的 UTC 时间戳（20260827T081234Z）。签名与 X-Date 头必须**同一个值** */
function amzDate(now) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  );
}

/**
 * 调一个方舟 OpenAPI Action。**唯一实现** —— 别在别处再拼一遍签名。
 *
 * @param {string} action  如 "CreateAuthorizationUUID"
 * @param {object} body    请求体（会 JSON 序列化）
 * @param {object} [opts]  { version, timeoutMs }
 * @returns {Promise<{ ok:boolean, status:number, result?:any, error?:{Code:string,Message:string}, requestId?:string }>}
 *
 * ★ 不 throw：把 HTTP 状态与火山的 Error 结构化回给调用方，让上层能把
 *   "InvalidParameter.xxx" 这类业务错**原样说给用户**（铁律八），而不是笼统 500。
 *   只有网络层失败（连不上）才 reject。
 */
async function callOpenApi(action, body, opts = {}) {
  const AK = (process.env.VOLC_AK || "").trim();
  const SK = (process.env.VOLC_SK || "").trim();
  if (!AK || !SK) {
    const err = new Error("VOLC_AK/VOLC_SK 未配置：真人肖像授权功能未开通");
    err.code = "OPENAPI_NOT_CONFIGURED";
    throw err;
  }
  const version = opts.version || DEFAULT_VERSION;
  const payload = JSON.stringify(body ?? {});
  const now = new Date();
  const xDate = amzDate(now);
  const dateStamp = xDate.slice(0, 8);
  const query = `Action=${action}&Version=${version}`;
  const bodyHash = sha256hex(payload);

  // ★ canonical headers 必须**字典序**且与 signedHeaders 一一对应，逐字节参与签名
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${OPENAPI_HOST}\n` +
    `x-content-sha256:${bodyHash}\n` +
    `x-date:${xDate}\n`;
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalRequest = ["POST", "/", query, canonicalHeaders, signedHeaders, bodyHash].join("\n");

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256hex(canonicalRequest)].join("\n");

  let signingKey = hmac(SK, dateStamp);
  signingKey = hmac(signingKey, REGION);
  signingKey = hmac(signingKey, SERVICE);
  signingKey = hmac(signingKey, "request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `HMAC-SHA256 Credential=${AK}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || T_OPENAPI);
  let res;
  try {
    res = await fetch(`https://${OPENAPI_HOST}/?${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: OPENAPI_HOST,
        "X-Date": xDate,
        "X-Content-Sha256": bodyHash,
        Authorization: authorization,
      },
      body: payload,
      signal: controller.signal,
    });
  } catch (e) {
    // 网络层失败（含超时 abort）——这条 reject，调用方按"连不上"处理
    const err = new Error(`Ark OpenAPI ${action} 网络失败: ${e instanceof Error ? e.message : e}`);
    err.code = "OPENAPI_NETWORK";
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let json = {};
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应（极少）—— 下面按 status 判 */
  }
  const meta = json.ResponseMetadata || {};
  const error = meta.Error || null;
  return {
    ok: res.status >= 200 && res.status < 300 && !error,
    status: res.status,
    result: json.Result,
    error: error ? { Code: error.Code, Message: error.Message } : undefined,
    requestId: meta.RequestId,
  };
}

// ── 真人肖像授权（素材库）──────────────────────────────────────────────
//
// 三个 Action 的入参 schema 均 2026-08-27 逐字段实证（见 docs/backlog.md §1.6）。
// 「接收授权」的 Action 尚未抓到（要等真有人扫码授权后控制台才出现那颗按钮），留 TODO。

/**
 * 生成一条**邀约**（被拍者扫码授权用）。返回 UUID —— 邀约 H5 链接就靠它拼。
 *
 * @param {object} o { startSec:number, endSec:number }  授权有效期，**秒级 Unix 时间戳**
 *   ★ 实测只收秒级时间戳：日期串 / ISO8601 / 毫秒 全部 `InvalidParameter.Validity.Start`。
 */
async function createAuthorizationInvite({ startSec, endSec }) {
  return callOpenApi("CreateAuthorizationUUID", {
    Validity: { Start: Math.floor(startSec), End: Math.floor(endSec) },
  });
}

/**
 * 列出资产组（查授权状态 + asset id）。
 * ★ `AssetOwnership` 是枚举且**大小写敏感**，实测只有 `"All"` 收（Owned/Authorized/Self 全 Invalid）。
 * ⚠ `result.Items[]` 的字段要等**真有一条授权入库**后才看得到（现在 TotalCount:0）——
 *   接 app 轮询前用一条真授权把字段名抠准，别猜（docs/backlog.md §1.6 的 TODO）。
 */
async function listAuthorizationAssetGroups() {
  return callOpenApi("ListAuthorizationAssetGroup", { Filter: { AssetOwnership: "All" } });
}

module.exports = {
  OPENAPI_HOST,
  openApiConfigured,
  callOpenApi,
  createAuthorizationInvite,
  listAuthorizationAssetGroups,
};
