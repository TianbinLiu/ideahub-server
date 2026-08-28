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
// 入参 schema 全部逐字段实证（2026-08-27 前三个、2026-08-28 补 ListAssets；见 docs/backlog.md §1.6）。
//
// ★★ **组 ≠ 素材，两层**（2026-08-28 用真授权量出来的，之前一直以为是一层）：
//   · `ListAuthorizationAssetGroup` 给的是**资产组** `group-20260828131552-jlbz5` + 授权态；
//   · 出片时 `asset://` 要的是**素材** `asset-20260828131637-4872q`，在
//     `ListAssets` 里，`Items[].Id`。
//   ⇒ 只查到"组已授权"**不等于有素材可用**：素材要单独过内容审核，会 `Status:"Failed"`。
//     实测第一发就是这样（`InputImageSensitiveContentDetected.PolicyViolation`），
//     而组那一层依然写着 `Authorized` —— 只看组就是"看起来成了，其实一张都不能用"。
//
// 探针记录（`{}` 空 body 打一发就能分辨 Action 存不存在）：存在的有 `ListAssets`
// （必填 `Filter.GroupType` + `PageNumber`）、`GetAuthorizationAssetGroup`（必填 `GroupId`）、
// `GetAssetGroup`（必填 `Id`）；不存在的有 ListAuthorizationAsset(s) / ListAsset /
// ListAssetGroupAsset / ListLivenessFaceAsset / DescribeAuthorizationAssetGroup
// （全回 404 `InvalidActionOrVersion`）。
// 「接收授权」的 Action 仍未抓到 —— 本账号是自己授权自己（`AssetOwnership:"SelfUploaded"`），
// 走不到"接收别人授权"那颗按钮，留 TODO。

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
 * 列出**资产组**（授权状态那一层，不含素材）。
 * ★ `AssetOwnership` 是枚举且**大小写敏感**，实测只有 `"All"` 收（Owned/Authorized/Self 全 Invalid）。
 * ★ 2026-08-28 真数据的形状：`Items[] = { AssetGroup:{Id,Name,GroupType,ProjectName,
 *   CreateTime,UpdateTime}, Status:"Authorized", Validity:{Start,End}, AccountType:"Company",
 *   CompanyName, CreditCode, AssetOwnership:"SelfUploaded" }`。
 *   ⚠ `Validity.End` 实测回来是 `253399593600`（≈ 9999 年 = 永久），**不是**我们建邀约时给的
 *   那个一年 —— 有效期最终由授权人在火山那一页选，我们的 `days` 只是个建议值。
 * ⚠ 组 `Authorized` ≠ 有素材可用，见本节顶部 ★★。要 asset id 请用 listPortraitAssets。
 */
async function listAuthorizationAssetGroups() {
  return callOpenApi("ListAuthorizationAssetGroup", { Filter: { AssetOwnership: "All" } });
}

/** 真人肖像素材组的类型。`ListAssets` 的 `Filter.GroupType` 必填，实测这个值收 */
const LIVENESS_GROUP_TYPE = "LivenessFace";

/**
 * 列出**素材**（出片要用的 `asset-…` 就在这里）。
 *
 * @param {object} [o]
 * @param {string} [o.groupId]  只看某个资产组；不给 = 本账号该类型的全部
 * @param {number} [o.pageSize] 默认 50
 *
 * ★ 入参三处都是必需的，少一个就 400：`Filter.GroupType`、`PageNumber`、（`PageSize` 不给
 *   会走默认 10，我们显式给）。
 *
 * ⚠⚠ **`ListAssets` 对不认识的 `Filter` 键直接静默忽略**（实测 `AssetType:"__bogus__"` /
 *   `Status:"__bogus__"` 都照样 200 + 全量返回，不报错）。⇒ 按组过滤**只有复数
 *   `GroupIds:[…]` 生效，单数 `GroupId` 是被忽略的**：
 *     GroupType 全量 → 1 条；`GroupId`=空组 → **仍是 1 条**（被忽略）；
 *     `GroupIds`=[空组] → 0 条；`GroupIds`=[有料组] → 1 条。
 *   这条一开始写错过（用了单数），而它**零报错**：表现是"按某个组查"悄悄返回了**所有组**
 *   的素材 —— 拿去自动绑就会把别人那份肖像素材绑到这张卡上。
 *   ⇒ 以后给这个 Filter 加任何新键，都必须拿**反例数据**证一遍（用一个"结果应该为空"的
 *   条件去查），别拿"查到了预期那条"当证据 —— 生效与被忽略在那种测法下结果一模一样。
 * ★ 回来的 `Items[] = { Id:"asset-…", Name, URL, AssetType:"Image", GroupId, Status,
 *   Error?:{Code,Message}, Moderation:{Strategy}, CreateTime, UpdateTime, ProjectName }`。
 *   ⚠⚠ `URL` 是带签名的 TOS 直链（`X-Tos-Expires=41400` ≈ 11.5 小时），**别落库、别外传**：
 *   它是某个真人的肖像原图，签名过期后还会变成死链。我们只往上层传"有没有、能不能用"。
 * ⚠ `Status` 只实证到 `"Failed"` 这一个值（成功那个字符串还没见过，因为还没有一张过审的）。
 *   ⇒ **不许**在这一层按 Status 过滤或翻译，原样透出，判读留给上层并且只判得起
 *   "是不是 Failed"（判否定，同本仓那条老规矩）。
 */
async function listPortraitAssets(o = {}) {
  const filter = { GroupType: LIVENESS_GROUP_TYPE };
  // 复数形式，别改回单数：单数被静默忽略 = 悄悄返回所有组（见上 ⚠⚠）
  if (o.groupId) filter.GroupIds = [o.groupId];
  return callOpenApi("ListAssets", { Filter: filter, PageNumber: 1, PageSize: o.pageSize || 50 });
}

module.exports = {
  OPENAPI_HOST,
  LIVENESS_GROUP_TYPE,
  openApiConfigured,
  callOpenApi,
  createAuthorizationInvite,
  listAuthorizationAssetGroups,
  listPortraitAssets,
};
