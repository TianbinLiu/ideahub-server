// src/routes/branchCompose.routes.js
// 成片合并端点：把已经在 Cloudinary 上的 N 段成片按时间轴拼成一条，产出独立资产。
// 挂在 /api/branch 下（与 branchVideo / branchTemplate 同一 base，路径不重叠）。
//
// 为什么要有它（2026-08-21 真机复盘）：App 剪辑页原来用 MediaRecorder 在端上实时重录，
// 弱网 + 低端机上不可靠 —— 那天的成片是拿本机 ffmpeg 救回来的。段落早就都转存到
// Cloudinary 了，拼接交给 CDN 做，客户端只受理 + 轮询。
//
// 三道边界，每一道都有它挡住的具体坏事：
//  ① requireAuth + **逐段归属校验** —— 不校归属的话，任何登录用户拿到别人的 public_id
//     就能把别人的成片拼成自己的作品，还顺手烧我们的变换配额（同 resolveR2v 那道闸）。
//  ② 限流 6 次/分 —— 每一发都在 Cloudinary 侧真跑编码（按输出秒数计费）。
//  ③ 产物**时长自检** —— 在 service 里，防的是拼接的三个静默陷阱（见 utils/videoCompose）。
//
// ★ 不计费（不动 token 钱包）：合并不调用任何 AI，端上原本也是免费的。成本落在
//   Cloudinary 配额上，由限流与段数/时长上限兜着。改成收费前先想清楚"端上自己合并"
//   这条免费路还在不在 —— 一边免费一边收费，用户只会绕道。
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { composeBody } = require("../schemas/branchCompose.schemas");
const { badRequest, notFound } = require("../utils/http");
const { cloudinary } = require("../config/cloudinary");
const { COMPOSE_LIMITS, expectedDurationSec, isBranchVideoUrl, parseOwnBranchVideoUrl } = require("../utils/videoCompose");
// 「这条地址是不是本账号在我们空间里的资产」判据复用 templateVideoAsset 那一份（铁律六）
const { ownedCloudinaryAsset } = require("../utils/templateVideoAsset");
const compose = require("../services/videoCompose.service");

/** 合并很重（每发都真跑编码）；6 次/分对真人绰绰有余 —— 一次合并要等十几秒才出结果 */
const composeLimit = userRateLimit({ max: 6, windowMs: 60 * 1000, scope: "branch-compose" });
/** 轮询便宜且高频（每 3~5 秒一次），与受理分开一个桶，别让正常轮询把自己的合并挤爆 */
const pollLimit = userRateLimit({ max: 90, windowMs: 60 * 1000, scope: "branch-compose-poll" });

/**
 * POST /api/branch/compose —— 受理一次合并。
 * body: { clips:[{url,startSec,endSec}], width, height, quality?, audio?{url,volume,replace?} }
 * → 202 { jobId, state:"pending" } | 200 { jobId, state:"done", url }
 *
 * ★ 受理式而不是同步等：一次合并实测 3~17 秒（25 秒成片 16.6s）。让弱网手机在线等这一趟，
 *   重演的就是 2026-08-21 那次「客户端超时→静默失败→下游全坏」。
 */
router.post("/compose", requireAuth, composeLimit, validate({ body: composeBody }), async (req, res, next) => {
  try {
    const userId = String(req.user._id);
    const { clips: rawClips, quality, audio } = req.body;

    // ★ 宽高取偶（向下）。**不是**把奇数判错：客户端 720p 竖屏算出来的就是 405×720
    //   （outSize 里 round(720×9/16)=405），这是最常见的一种请求，拒掉等于功能不可用。
    //   2026-08-21 实测：Cloudinary 收下奇数宽会自己产出 404×720 —— 既然它必定取偶，
    //   就在这里先取好：① 请求的尺寸与实际产出一致；② 405 和 404 命中**同一条**任务
    //   （配方指纹一致），不会因为差一像素而白跑一遍、白花一份配额。
    const width = req.body.width - (req.body.width % 2);
    const height = req.body.height - (req.body.height % 2);

    // ── 逐段：归属 + 裁剪区间 ───────────────────────────────────────────
    // ★ 报错要说清**第几段**：这条链路上"某一段不合格"是最常见的失败，
    //   而客户端只会把 message 原样显示（全 app 没有地方监听 emitApiError）。
    const notReady = [];
    const clips = [];
    for (let i = 0; i < rawClips.length; i++) {
      const c = rawClips[i];
      const own = parseOwnBranchVideoUrl(c.url, userId);
      if (!own) {
        // ★ 两种"解不出来"要分开说，否则用户会照着一句错话去做无用功：
        //   · 还挂在方舟临时链接（或压根不是我们空间里的地址）= **素材没到位**，等转存就行；
        //   · 是我们空间里的段落但不是本人的 = **归属不对**，等多久都没用。
        //   混成一句「稍等重试」的话，第二种情况会让人一直重试到放弃。
        if (isBranchVideoUrl(c.url)) {
          return badRequest(`第 ${i + 1} 段不是你自己的素材，不能用来合并`);
        }
        notReady.push(i + 1);
        continue;
      }
      const dur = c.endSec - c.startSec;
      if (dur < COMPOSE_LIMITS.minClipSec) {
        return badRequest(`第 ${i + 1} 段选取的区间太短（至少 ${COMPOSE_LIMITS.minClipSec} 秒）`);
      }
      clips.push({ publicId: own.publicId, startSec: c.startSec, endSec: c.endSec });
    }
    if (notReady.length) {
      // ★ 这条**不是**参数错，是"素材还没到位"：段落还挂在方舟临时链接上（转存没成或还没成），
      //   服务端这边根本没有可拼的东西。给一个专门的 code，客户端据此退回端上合并或稍后重试
      //   —— 混在普通 400 里的话，客户端只能把一句话显示出来，用户不知道该等还是该换路。
      return res.status(400).json({
        ok: false,
        code: "CLIPS_NOT_READY",
        message: `第 ${notReady.join("、")} 段还没转存到长期地址，暂时不能在服务端合并——稍等片刻重试，或用本机合并`,
      });
    }

    // ★ 用 util 那一份，不在这儿再写一遍求和：预算闸与产物自检问的都是它，
    //   这里自己算的话，三处口径分叉时**没有任何症状**（铁律六）
    const total = expectedDurationSec(clips);
    if (total > COMPOSE_LIMITS.maxTotalSec) {
      return badRequest(`成片总时长 ${total.toFixed(1)} 秒，超过上限 ${COMPOSE_LIMITS.maxTotalSec} 秒`);
    }

    // ── BGM（可选）：归属 + 时长（时长只从 Cloudinary 取，不收客户端报的数）──
    let bgm = null;
    if (audio) {
      const own = ownedCloudinaryAsset(audio.url, userId);
      if (!own || own.resourceType !== "video") {
        return badRequest("背景音乐必须是你自己上传到本平台的音频/视频资源");
      }
      let meta;
      try {
        meta = await cloudinary.api.resource(own.publicId, { resource_type: "video", media_metadata: true });
      } catch (e) {
        const http = e?.error?.http_code ?? e?.http_code;
        if (http === 404) return badRequest("找不到这段背景音乐（可能已被删除），请重新选一首");
        console.error(`[compose] BGM 元信息读取失败 ${own.publicId}:`, e?.error?.message || e.message);
        return res.status(502).json({ ok: false, message: "背景音乐信息读取失败，请稍后重试" });
      }
      const durationSec = Number(meta.duration);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return badRequest("这段背景音乐没有可用的时长信息，换一首再试");
      }
      // ★ 太短的整句拒，不悄悄夹：`e_loop` 是实测行为不是文档契约，而我们只实测到 e_loop:3。
      //   一段 0.1 秒的"音乐"铺满 300 秒会算出 e_loop:2999 —— 那是个谁都没验过的形状，
      //   悄悄替用户改成别的次数则是另一种骗人（他听到的循环节奏不是他选的那段）。
      if (durationSec < COMPOSE_LIMITS.minBgmSec) {
        return badRequest(`背景音乐太短了（${durationSec.toFixed(1)} 秒），至少要 ${COMPOSE_LIMITS.minBgmSec} 秒`);
      }
      bgm = { publicId: own.publicId, durationSec, volume: audio.volume, replace: !!audio.replace };
    }

    const view = await compose.requestCompose(userId, { clips, width, height, quality: quality || "good", bgm });
    // ★ 每日产出秒数预算（花钱的闸门，限流只管次数不管量 —— 理由在 service 那个常量上）。
    //   429 而不是 403：这是"稍后再来"，不是"你没资格"，客户端据此提示明天再试而不是去升级套餐。
    if (view.state === "denied") {
      return res.status(429).json({ ok: false, code: "COMPOSE_QUOTA", message: view.message });
    }
    // done 用 200（客户端可以直接拿地址走人），pending 用 202（受理了，去轮询）
    // ★ 带上 ok:true —— 全仓约定「成功 {ok:true,…}／失败 {ok:false,code,message}」，
    //   api/client.ts 正是按 `data.ok === false` 判失败的。少这一位今天不会出错，
    //   但下一个照着别处写判断的人会踩空（铁律六：约定也是规则）
    return res.status(view.state === "done" ? 200 : 202).json({ ok: true, ...view });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/branch/compose/:jobId —— 查进展。
 * ★ 按 { key, userId } 查，不是只按 key：jobId 是配方指纹，可猜测；
 *   不按人过滤就等于谁猜中谁就能拿到别人的成片地址。
 */
router.get("/compose/:jobId", requireAuth, pollLimit, async (req, res, next) => {
  try {
    const view = await compose.statusOf(String(req.user._id), req.params.jobId);
    if (view.state === "none") return notFound("没有这个合并任务");
    return res.json({ ok: true, ...view });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
