// src/routes/arkPortrait.routes.js
// 真人肖像**授权**的两个端点：生成邀约二维码链接、查授权状态/asset id。
// 挂在 /api/ark 下（与 ark 代理同一 base，路径全在 /portrait 下，不重叠）。
//
// ★★ 这是「app 内授权」（LibTV 同款）的服务端一半：把控制台里"出示二维码"和"收授权结果"
//   两头搬进 app。活体认证/登录火山账号/传素材那一步永远在**火山自己的 H5** 上（我们搬不进，
//   LibTV 也没有），app 能做的就是这两头。调用走 arkOpenApi.service（AK/SK 只在服务端）。
//
// ★ 全部 requireAuth：这些调用花的是**我们企业账号**的资源额度（建邀约、占资产组名额），
//   不能裸奔。且未见公开文档 ⇒ 每个出口都把火山的 Error 原样透出，并在没配 AK/SK 时
//   明说"未开通"，让 app 能退回"去控制台手工操作 + 手工粘贴 asset id"那条老路（铁律八）。
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { z, validate } = require("../middleware/validate");
const {
  openApiConfigured,
  createAuthorizationInvite,
  listAuthorizationAssetGroups,
  listPortraitAssets,
} = require("../services/arkOpenApi.service");

/**
 * 邀约 H5 的完整前缀（被拍者扫码打开的那一页，在火山域名下）。
 * ★ 2026-08-27 从控制台生成的真二维码里抠出并核对：
 *   `https://ark.volcengine.com/region:cn-beijing/mobile/livenees-face-manage/index?uuid=<UUID>`
 *   —— 结尾是 **`/index`**（此前少了这段，扫了会是空白页；原文拼写 livenees 非笔误），
 *   query 参数名确实是 `uuid`。这两点都对着控制台真链接核过。
 */
const INVITE_H5_PREFIX = "https://ark.volcengine.com/region:cn-beijing/mobile/livenees-face-manage/index";

/** 邀约有效期上限。★ 控制台默认给到 1 年，这里也放到 366 天，不做更严的限制 */
const MAX_VALIDITY_DAYS = 366;

const inviteBody = z.object({
  /** 授权有效期天数。缺省 365（与控制台默认一致） */
  days: z.number().int().min(1).max(MAX_VALIDITY_DAYS).optional().default(365),
});

/**
 * POST /api/ark/portrait/invite —— 生成一条邀约，返回可渲染成二维码的 H5 链接。
 * body: { days?: number }  → { ok, uuid, url, startSec, endSec }
 */
router.post("/portrait/invite", requireAuth, validate({ body: inviteBody }), async (req, res, next) => {
  try {
    if (!openApiConfigured()) {
      // 明说未开通，让 app 退回"控制台手工 + 手工粘贴 asset id"
      return res.status(503).json({
        ok: false,
        code: "PORTRAIT_NOT_CONFIGURED",
        message: "真人肖像授权功能未开通（服务器未配置火山 AK/SK）——请在方舟控制台手工创建资产组",
      });
    }
    const startSec = Math.floor(Date.now() / 1000);
    const endSec = startSec + req.body.days * 24 * 60 * 60;

    const r = await createAuthorizationInvite({ startSec, endSec });
    if (!r.ok) {
      // 把火山的业务错原样透出（未见公开文档，别替它翻译）
      return res.status(502).json({
        ok: false,
        code: r.error ? r.error.Code : "ARK_OPENAPI_ERROR",
        message: r.error ? r.error.Message : `方舟返回 HTTP ${r.status}`,
        requestId: r.requestId,
      });
    }
    const uuid = r.result && r.result.UUID;
    if (!uuid) {
      return res.status(502).json({ ok: false, code: "NO_UUID", message: "方舟没有返回 UUID", requestId: r.requestId });
    }
    // url 格式已对着控制台真二维码核对（见 INVITE_H5_PREFIX 的 ★）
    res.json({ ok: true, uuid, url: `${INVITE_H5_PREFIX}?uuid=${encodeURIComponent(uuid)}`, startSec, endSec });
  } catch (err) {
    next(err);
  }
});

/** 未配 AK/SK 时的统一回法：明说未开通，让 app 退回"控制台手工 + 手填 asset id" */
function notConfigured(res) {
  return res.status(503).json({
    ok: false,
    code: "PORTRAIT_NOT_CONFIGURED",
    message: "真人肖像授权功能未开通（服务器未配置火山 AK/SK）",
  });
}

/** 火山业务错的统一透出：**原样**给 Code/Message，别替它翻译（铁律八） */
function passThroughArkError(res, r) {
  return res.status(502).json({
    ok: false,
    code: r.error ? r.error.Code : "ARK_OPENAPI_ERROR",
    message: r.error ? r.error.Message : `方舟返回 HTTP ${r.status}`,
    requestId: r.requestId,
  });
}

/**
 * GET /api/ark/portrait/groups —— 列**资产组**（授权状态那一层）。
 * → { ok, totalCount, items }
 *
 * ★ items[] 原样透传方舟的 `Items`（2026-08-28 已见真数据，形状见 service 注释）。
 *   刻意**不**在这里逐字段重建：重建就是"少写一行没有任何症状"的那类坑（CLAUDE.md
 *   「服务端给实体加了字段」那条），而这一层的消费方只需要"有几条、授没授权"。
 * ⚠⚠ 组 `Authorized` **不等于**有素材可用 —— 素材要单独过内容审核，可能整张 `Failed`。
 *   要判"能不能出片"请用 /portrait/assets，别拿这里的 totalCount 当依据。
 */
router.get("/portrait/groups", requireAuth, async (req, res, next) => {
  try {
    if (!openApiConfigured()) return notConfigured(res);
    const r = await listAuthorizationAssetGroups();
    if (!r.ok) return passThroughArkError(res, r);
    const result = r.result || {};
    res.json({
      ok: true,
      totalCount: result.TotalCount || 0,
      items: Array.isArray(result.Items) ? result.Items : [],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ark/portrait/assets —— 列**素材**（出片要用的 `asset-…` 就在这里）。
 * query: `groupId?`（只看某个组）
 * → { ok, totalCount, items: [{ id, name, assetType, groupId, status, error?, createTime }] }
 *
 * ★★ 这里是**逐字段挑**而不是原样透传，只为一件事：**把那个签名直链挡在服务端**。
 *   方舟回的 `Items[].URL` 是带签名的 TOS 直链（`X-Tos-Expires=41400`），指向的是
 *   **某个真人的肖像原图**。它对 app 一点用都没有（app 只需要知道 id 与能不能用），
 *   透出去却等于把肖像原图发到端上、还可能被截图/落盘/进日志。⇒ 白名单式挑字段。
 * ★ `error` 照抄方舟的 `{Code,Message}`：素材审核失败的**原因**必须一路走到用户眼前
 *   （铁律八）。实测第一发就是 `InputImageSensitiveContentDetected.PolicyViolation`
 *   「输入图片可能涉及版权限制」—— 如果这里把它吞掉，用户看到的就是"授权成功但用不了"。
 * ★ `status` 原样给，**不在服务端判可用性**：成功那个字符串我们还没见过（只见过 "Failed"），
 *   现在写任何 `=== "成功"` 的判断都是猜。上层只判得起"是不是 Failed"。
 */
router.get("/portrait/assets", requireAuth, async (req, res, next) => {
  try {
    if (!openApiConfigured()) return notConfigured(res);
    const groupId = typeof req.query.groupId === "string" ? req.query.groupId.trim() : "";
    const r = await listPortraitAssets(groupId ? { groupId } : {});
    if (!r.ok) return passThroughArkError(res, r);
    const result = r.result || {};
    const items = (Array.isArray(result.Items) ? result.Items : []).map((it) => ({
      id: it.Id,
      name: it.Name,
      assetType: it.AssetType,
      groupId: it.GroupId,
      status: it.Status,
      ...(it.Error ? { error: { code: it.Error.Code, message: it.Error.Message } } : {}),
      createTime: it.CreateTime,
      // ⚠ 故意不带 URL（见上 ★★）
    }));
    res.json({ ok: true, totalCount: result.TotalCount || 0, items });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ark/portrait/assets/:id/image —— 把某份授权素材的**图片本体**代取回来。
 * 造卡流程用它把授权照片自动填进卡面/图位（仓库主人 2026-08-28 两次点名要的）。
 *
 * ★ 签名直链仍然不出服务端：这里在服务端现列 ListAssets 拿到带签名的 TOS 直链、
 *   服务端去取字节、只把**图片内容**流回去 —— 链接本身（含签名与桶路径）一个字符不外泄。
 * ⚠⚠ 已知且**有意接受**的边界（主人在"本地重选 vs 服务端代取"两案里选了后者）：
 *   组↔用户目前无法归属（方舟没有归属字段，见 docs/backlog.md §1.6），所以这里只能
 *   requireAuth —— 也就是说**任何登录用户**都取得到平台账号下任何一份授权素材的照片。
 *   当前全部用户就是仓库主人本人，风险为零；**开放注册前必须先做归属**（invite 时记
 *   uuid→userId 或让用户绑自己的火山账号），这条钉在 backlog §1.6。
 * ★ 图片按方舟素材门最大 30MB，整体缓冲后回吐（不落盘、不缓存）。
 */
router.get("/portrait/assets/:id/image", requireAuth, async (req, res, next) => {
  try {
    if (!openApiConfigured()) return notConfigured(res);
    const id = String(req.params.id || "").trim();
    const r = await listPortraitAssets({});
    if (!r.ok) return passThroughArkError(res, r);
    const items = Array.isArray(r.result && r.result.Items) ? r.result.Items : [];
    const it = items.find((x) => x.Id === id);
    if (!it) {
      return res.status(404).json({ ok: false, code: "ASSET_NOT_FOUND", message: "方舟里没有这份素材（可能已被删除）" });
    }
    if (!it.URL) {
      return res.status(502).json({ ok: false, code: "NO_ASSET_URL", message: "方舟没有给这份素材的下载地址" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let up;
    try {
      up = await fetch(it.URL, { signal: controller.signal });
    } catch (e) {
      return res.status(502).json({
        ok: false,
        code: "ASSET_FETCH_FAILED",
        message: `取素材图片失败：${e instanceof Error ? e.message : e}`,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!up.ok) {
      // 签名直链会过期（X-Tos-Expires），过期就整句说清而不是回一张坏图
      return res.status(502).json({ ok: false, code: "ASSET_FETCH_FAILED", message: `素材源返回 HTTP ${up.status}（签名可能已过期，重试一次即可——每次都会现签）` });
    }
    const buf = Buffer.from(await up.arrayBuffer());
    res.set("Content-Type", up.headers.get("content-type") || "image/jpeg");
    // 私人肖像：任何一层都不许缓存
    res.set("Cache-Control", "private, no-store");
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
