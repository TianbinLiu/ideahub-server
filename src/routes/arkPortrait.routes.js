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

/**
 * GET /api/ark/portrait/groups —— 列资产组（查授权状态 + asset id）。
 * → { ok, totalCount, items }
 *
 * ⚠⚠ items[] 的字段名**尚未实证**（要等真有一条授权入库；现在恒 TotalCount:0）。
 *   这里**原样透传** result.Items，不在服务端硬造字段结构 —— 硬造的话等真数据回来时
 *   字段对不上，是"看起来有值其实全 undefined"那类静默错。app 侧同样先原样收，
 *   等真授权跑通再一起定 asset id / 状态 / 演员名 的读法（docs/backlog.md §1.6 TODO）。
 */
router.get("/portrait/groups", requireAuth, async (req, res, next) => {
  try {
    if (!openApiConfigured()) {
      return res.status(503).json({
        ok: false,
        code: "PORTRAIT_NOT_CONFIGURED",
        message: "真人肖像授权功能未开通（服务器未配置火山 AK/SK）",
      });
    }
    const r = await listAuthorizationAssetGroups();
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        code: r.error ? r.error.Code : "ARK_OPENAPI_ERROR",
        message: r.error ? r.error.Message : `方舟返回 HTTP ${r.status}`,
        requestId: r.requestId,
      });
    }
    const result = r.result || {};
    res.json({
      ok: true,
      totalCount: result.TotalCount || 0,
      // 原样透传，字段留给真数据定（见上 ⚠⚠）
      items: Array.isArray(result.Items) ? result.Items : [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
