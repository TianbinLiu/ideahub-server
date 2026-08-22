const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const {
  upload,
  uploadMedia,
  uploadToCloudinary,
  MAX_IMAGE_SIZE_BYTES,
  MAX_MEDIA_SIZE_BYTES,
  uploadTemplateVideo,
  MAX_TEMPLATE_VIDEO_BYTES,
  ALLOWED_TEMPLATE_VIDEO_FORMATS,
  templateVideoMeta,
  templateSourceIssue,
  templateRefIssue,
  TEMPLATE_REF_RULES,
} = require("../middleware/upload");
const { cloudinary } = require("../config/cloudinary");
const BranchTemplate = require("../models/BranchTemplate");
// 白模 V2 两阶段的取件凭据：**还没取回结果**的那一发也占着原始素材（见下面的第三道 exists）
const BlockoutJob = require("../models/BlockoutJob");
// 归属判据只有一处（utils/templateVideoAsset），此前这里手写过一份 startsWith 前缀
const {
  ownTemplateVideoPublicId,
  buildClipUrl,
  clipTransform,
  // 直传要在服务端拼 public_id，落点必须与归属判据认的那个 folder 是**同一个字符串**
  TEMPLATE_VIDEO_FOLDER,
} = require("../utils/templateVideoAsset");

// ★ 上传此前**一个限流器都没有**（2026-08-14 复查发现）：每一发都真实占用
//   Cloudinary 配额与出网带宽，且上传即永久留存（全服务端目前零 destroy 调用）——
//   一个脚本就能把配额刷满。按【账号】限不按 IP（NAT 后面的真实用户共享出口 IP，
//   与登录限流同一条理由）。20/分钟对真实使用绰绰有余：发布一条作品的
//   materializeDraft 串行传帧，一分钟传不到 20 张。
const uploadLimit = userRateLimit({ max: 20, windowMs: 60 * 1000, scope: "uploads" });

/** 直传的分块大小。★ Cloudinary 的硬约束是「除最后一块外每块 > 5MB」（官方文档原文），
 *  官方 SDK 默认 20,000,000。这里取 6,000,000：够宽（>5MB）也够小 —— 手机慢网上
 *  一块几十秒，中途断了只重传这一块，而不是从头再来 47MB。 */
const DIRECT_UPLOAD_CHUNK_BYTES = 6_000_000;

router.post("/image", requireAuth, uploadLimit, upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "No file uploaded" });
    }

    // 上传到 Cloudinary
    const imageUrl = await uploadToCloudinary(
      req.file.buffer,
      'content-images',
      req.user._id.toString()
    );

    res.json({
      ok: true,
      imageUrl,
      maxSizeBytes: MAX_IMAGE_SIZE_BYTES,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/media", requireAuth, uploadLimit, uploadMedia.single("media"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "No media uploaded" });
    }

    const resourceType = String(req.file.mimetype || "").startsWith("video/") ? "video" : "image";

    const mediaUrl = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "ideahub/workshop-media",
          public_id: `${req.user._id.toString()}-${Date.now()}`,
          resource_type: resourceType,
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      stream.end(req.file.buffer);
    });

    res.json({
      ok: true,
      mediaUrl,
      maxSizeBytes: MAX_MEDIA_SIZE_BYTES,
      mimeType: req.file.mimetype,
      size: req.file.size,
      resourceType,
    });
  } catch (err) {
    next(err);
  }
});

// ── 白模模板视频（V2 起：任意原始素材）──────────────────────────────
// ★ 比 /image /media 严得多（3 次/分 + 10 次/天，两个桶**串联**、scope 分开）：
//   一发就是 100MB 级出网 + 永久占 Cloudinary 配额，而且每个热门模板此后每被套用一次，
//   方舟都会从我们账户拉一遍这段视频（流出流量随使用次数线性涨）。
//   分钟桶挡手滑连点，天桶挡"整晚慢慢灌"——只有分钟桶的话，一晚上能灌 4000 发。
const tplVideoMinuteLimit = userRateLimit({ max: 3, windowMs: 60 * 1000, scope: "uploads:tplVideoMin" });
const tplVideoDailyLimit = userRateLimit({ max: 10, windowMs: 24 * 60 * 60 * 1000, scope: "uploads:tplVideoDay" });

// ── POST /api/uploads/template-video/derive ─────────────────────────────
//
// 「把我刚传的那段素材，按框选裁出一段（不够清晰就顺带放大），落成一个新素材」。
//
// ══ 为什么必须有这一步（2026-08-17 加，作者自带参考视频那条路的缺口）══════════
//   V1 登记（POST /templates）把**整段原片**直接当参考视频用，所以它必须满足方舟
//   edit 的硬约束：时长 ∈[4,30]、宽×高 ≥407,696、边长与比例也有窗口。而用户手上的
//   素材多半不满足 —— 实测作者那段 34.167s、836×480 = 401,280 像素，两条都差一点点：
//     · 超长那条 V2 有 BlockoutTrimmer 解决，**V1 没有对应的落地步骤**；
//     · 像素那条上传口会当场拒（拒得对），但**不给任何出路** —— 用户只能回去自己转码。
//   于是这条路在产品里事实上传不进任何一段真实素材。
//
// ★★ 变换由**服务端自己拼**（buildClipUrl / clipTransform，唯一实现），客户端只交
//   四组整数。与 V2 同一条纪律：能让客户端拼 URL，就等于让用户自己决定"方舟拿到多长"。
//   这里虽然不直接计价，但这段视频会成为**别人套用时的 r2v 输入时长**（segmentCost 读
//   refVideo.durationSec）—— 一样是钱。
// ★★ 放大只在**不够**时做，并且只放大到刚过线：放大不会凭空变清楚，它解决的是
//   "引擎拒收这个尺寸"。过度放大只是让文件更大、上传更慢。
// ★ 裁后**必须用参考视频那套严窗口复核**（templateRefIssue）：裁出来的这一段就是
//   将来喂给方舟的那一段，这里不卡住，就要等别人付费套用时才 400。
// ★ 新素材是一个正规形态的 `template-videos/<userId>-<ts>`（归属判据才认得），
//   与用户自己传上来的那种一模一样 —— 登记那条路一个字都不用改。
router.post("/template-video/derive", requireAuth, tplVideoMinuteLimit, tplVideoDailyLimit, async (req, res, next) => {
  try {
    const publicId = ownTemplateVideoPublicId(String(req.body?.publicId || ""), req.user._id);
    if (!publicId) {
      return res.status(400).json({ ok: false, message: "素材地址无效：只能裁你本人刚通过「上传视频」传到本站的素材。" });
    }
    const startSec = Math.max(0, Math.floor(Number(req.body?.startSec)));
    const durSec = Math.floor(Number(req.body?.durSec));
    const crop = req.body?.crop || {};
    const box = {
      x: Math.max(0, Math.floor(Number(crop.x) || 0)),
      y: Math.max(0, Math.floor(Number(crop.y) || 0)),
      w: Math.floor(Number(crop.w)),
      h: Math.floor(Number(crop.h)),
    };
    if (!Number.isFinite(startSec) || !Number.isFinite(durSec) || durSec <= 0 || !(box.w > 0) || !(box.h > 0)) {
      return res.status(400).json({ ok: false, message: "框选参数不完整（需要起点、时长与裁剪框）。" });
    }

    let src;
    try {
      src = await cloudinary.api.resource(publicId, { resource_type: "video", media_metadata: true });
    } catch {
      return res.status(400).json({ ok: false, message: "找不到这段素材（可能未上传成功或已被回收），请重新上传。" });
    }

    // ★ 放大倍数：只在裁后像素**不够**时才算，且只放到刚过线（留 2% 余量防取整掉下来）
    const cutPixels = box.w * box.h;
    const need = TEMPLATE_REF_RULES.minPixels;
    let scaleW = 0;
    if (cutPixels < need) {
      const k = Math.sqrt((need * 1.02) / cutPixels);
      scaleW = Math.min(TEMPLATE_REF_RULES.maxEdge, Math.round((box.w * k) / 2) * 2);
    }

    const clip = clipTransform({ startSec, durSec, crop: box });
    const url = buildClipUrl(publicId, { startSec, durSec, crop: box }, src.version);
    if (!url) {
      return res.status(502).json({ ok: false, message: "云存储没配好，暂时裁不了这段素材。" });
    }
    // ★★★ 缩放必须**接在裁剪之后**（`.../<clip>/c_scale,w_N/...`），不是插在最前面。
    //   Cloudinary 的链式变换**按书写顺序依次应用** —— 放在前面就是"先放大、再按原尺寸
    //   裁一块出来"，结果又变回原来的大小。2026-08-17 第一版就是这么写的，
    //   表现是"放大了但尺寸没变、裁后复核照旧拒"，而两条变换单独看都对。
    const finalUrl = scaleW ? url.replace(`/${clip}/`, `/${clip}/c_scale,w_${scaleW}/`) : url;

    const newId = `ideahub/template-videos/${req.user._id.toString()}-${Date.now()}`;
    let receipt;
    try {
      receipt = await cloudinary.uploader.upload(finalUrl, { resource_type: "video", public_id: newId });
    } catch (e) {
      console.error(`[uploads] 裁剪落库失败 ${publicId} -> ${newId}:`, e?.error?.message || e.message);
      return res.status(502).json({ ok: false, message: "裁这一段的时候云端出错了，请稍后重试。" });
    }

    // ★★ 裁后用**参考视频**那套严窗口复核（不是上传口那套松的）：这一段就是将来喂给
    //   方舟的那一段。不过就先回收再拒 —— 不回收的话每一次失败都永久占着配额。
    const meta = templateVideoMeta(receipt);
    const issue = templateRefIssue(meta);
    if (issue) {
      try {
        await cloudinary.uploader.destroy(receipt.public_id, { resource_type: "video" });
      } catch (e) {
        console.error(`[uploads] 裁后不合格、回收失败 public_id=${receipt.public_id}:`, e.message);
      }
      return res.status(400).json({ ok: false, message: issue });
    }

    res.json({
      ok: true,
      publicId: receipt.public_id,
      url: receipt.secure_url,
      durationSec: meta.duration,
      width: meta.width,
      height: meta.height,
      bytes: meta.bytes,
      ...(scaleW ? { upscaledTo: scaleW } : {}),
    });
  } catch (err) {
    next(err);
  }
});

// ══ 直传 Cloudinary（2026-08-22 加）══════════════════════════════════════════
//
// ★★★ 为什么必须绕开我们自己的服务器：**Cloudflare 的 Proxy Read Timeout = 125 秒**。
//   nginx 默认 `proxy_request_buffering on` —— 要把整个 body 收完才回包，于是整段上传
//   期间 CF 看到的是"源站零响应"，125 秒一到就掐断连接（nginx 记 499、客户端只拿到一个
//   没有状态码的 fetch 失败）。2026-08-22 三发连续复现，`rt=125.006 / 125.005 / 125.006`
//   精确到毫秒一致。⇒ 走 /template-video 那条老路的真实上限**不是 100MB，是「125 秒内
//   能推上去多少」**：实测手机 5G 上行 0.126MB/s ⇒ 约 15MB；而服务端这边还要同步等
//   Cloudinary 吃完才回包（11.6MB 那发就占了约 79 秒），可用体积还要再打折。
//   ⚠ 这个 125 秒**只有 Enterprise 套餐能调**，升到 Pro/Business 一样是 125 秒。
//   ⇒ 唯一的根治办法是让**文件字节根本不经过 CF 与我们的源站**：客户端拿服务端签的名，
//     直接分块传给 api.cloudinary.com。
//
// ★★ 安全面靠三条钉死，缺一条就有绕行路：
//   ① **public_id 由服务端生成并签进签名**（客户端改一个字签名就失效）——
//      它就是「这段视频是谁传的」的唯一判据（ownTemplateVideoPublicId）。
//      客户端能自选 public_id = 能覆盖任何人的资产。
//   ② **限流仍在服务端**（签名端点上挂的就是老路那两个 scope，额度共用）——
//      没有签名就传不上去，所以刷 Cloudinary 必须先过这道闸。
//   ③ **元数据以服务端向 Cloudinary 取回的那份为准**（confirm 里的 api.resource），
//      客户端报的数一个都不信 —— 它现在能直接和 Cloudinary 对话，回执完全可以伪造。
//
// ★ 老路 `POST /template-video` **保留不删**：已经装在用户手机上的旧版 App 只认它，
//   删掉等于让所有没更新的人当场失去上传能力（而更新是他们自己决定的）。
router.post("/template-video/sign", requireAuth, tplVideoMinuteLimit, tplVideoDailyLimit, async (req, res, next) => {
  try {
    const { cloud_name, api_key, api_secret } = cloudinary.config();
    if (!cloud_name || !api_key || !api_secret) {
      return res.status(503).json({ ok: false, message: "服务器还没配好视频存储，暂时不能上传。" });
    }
    // ★★ public_id 在**这里**生成，不接受客户端传任何一部分：形状必须与
    //   ownTemplateVideoPublicId 的 `^<userId>-\d+$` 完全吻合，否则传上去之后
    //   confirm、登记、回收三处都会判它"不是你的"，而那时文件已经在 Cloudinary 上了。
    const userId = req.user._id.toString();
    const publicId = `${TEMPLATE_VIDEO_FOLDER}/${userId}-${Date.now()}`;
    const timestamp = Math.round(Date.now() / 1000);
    // ★ 只签这两项：签名覆盖的是"要写到哪个 id 上"这件事本身。resource_type 不参与
    //   签名（它在 URL 路径里），但直传地址只给 /video/upload —— 而且就算客户端改成
    //   别的 resource_type，confirm 那一步用 resource_type: "video" 去取就取不到。
    // ★★★ `overwrite: false` 是这条新路**必须**签进去的一项（2026-08-22 实测确认）：
    //   签名有效期是 1 小时且可复用 ⇒ 不加这一项的话，用户可以先传一段干净素材、
    //   走完复核与登记、模板过审发布，**再用同一个签名把 Cloudinary 上那份原地换成别的**：
    //   数据库里一个字段都不动、全程零报错，而所有套用者拿到的已经是新内容。
    //   实测：不带它时同一签名把 41.2s 的资产换成了 13.7s 的（version 变了、DB 不会知道）；
    //   带上它时回的是 `existing: true` + 旧资产元数据，新内容写不进去。
    //   ⚠ 老路没有这个洞不是因为它更安全，而是因为 public_id 由服务端每次新生成、
    //     客户端从来拿不到"再写一次同一个 id"的机会 —— 直传把这个机会给出去了。
    //   ⚠ 也实测过它**不影响分块**：中间块照常回 `{done:false}`，末块照常回完整资产。
    const params = { overwrite: false, public_id: publicId, timestamp };
    // ★★ 签名与"要发哪些字段"**用同一个对象**：多签一个没发、或发了一个没签，
    //   Cloudinary 都只回一句 Invalid Signature，而那是最难查的一类错。
    //   客户端拿到 params 之后**原样逐字段转发**，不许自己拼、也不许增删。
    const signature = cloudinary.utils.api_sign_request(params, api_secret);
    res.json({
      ok: true,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloud_name}/video/upload`,
      publicId,
      // 客户端要原样发出去的表单字段（file / Content-Range / X-Unique-Upload-Id 另加）
      params: { ...params, api_key, signature },
      // 分块大小由服务端说了算：Cloudinary 要求"除最后一块外每块 > 5MB"，
      // 这里给 6,000,000（十进制），够宽也够小 —— 慢网上一块几十秒，断了只重传一块。
      chunkBytes: DIRECT_UPLOAD_CHUNK_BYTES,
      maxSizeBytes: MAX_TEMPLATE_VIDEO_BYTES,
    });
  } catch (err) {
    next(err);
  }
});

// 直传完成后的**服务端验收**。客户端只报一个 public_id，其余一个字都不信。
// ★★ 这一步等价于老路里"回执复核"那一段，而且更该有：老路的回执是**我们自己**从
//   Cloudinary 拿到的，直传的回执是**客户端**给的 —— 不复核就等于让用户自报时长与尺寸，
//   而时长正是 r2v 的计价输入（让用户自己标价）。
// ★ 不过就 destroy 再拒：不回收的话每一次被拒的上传都永久占着配额（零症状，只有月底
//   的用量报表知道）—— 与老路那段同一条纪律。
router.post("/template-video/confirm", requireAuth, uploadLimit, async (req, res, next) => {
  try {
    const raw = String(req.body?.publicId ?? "").slice(0, 300);
    const publicId = ownTemplateVideoPublicId(raw, req.user._id.toString());
    if (!publicId) {
      return res.status(400).json({ ok: false, message: "这段视频不是本账号传的（或者地址被改过），不能用来做模板。" });
    }
    let resource;
    try {
      resource = await cloudinary.api.resource(publicId, { resource_type: "video", media_metadata: true });
    } catch (e) {
      const code = e?.error?.http_code ?? e?.http_code;
      if (code === 404) {
        return res.status(404).json({
          ok: false,
          message: "没在服务器上找到这段视频——多半是上传没真的完成（中途断了）。请重新选一次文件再传。",
        });
      }
      console.error(`[uploads] 直传验收取资源失败 public_id=${publicId}:`, e?.message || e);
      return res.status(502).json({ ok: false, message: "视频存储暂时取不到这段视频的信息，请稍后重试。" });
    }
    const meta = templateVideoMeta(resource);
    // ★★ 格式与大小这两道闸在老路上是 **multer** 把的（MIME 白名单 + fileSize），
    //   而直传那条路上 multer 根本不在链上 —— 不在这里补回来就等于两条路的验收标准不一样，
    //   且松的那条零症状（一个 webm/avi 能进来，套用时才在方舟那边 400）。
    const format = String(resource?.format || "").toLowerCase();
    const issue =
      (!ALLOWED_TEMPLATE_VIDEO_FORMATS.includes(format)
        ? `模板视频只收 ${ALLOWED_TEMPLATE_VIDEO_FORMATS.join(" / ")} 格式（AI 出片引擎只认这两种），这段是 ${format || "未知格式"}，请转码后重试。`
        : null) ||
      (meta.bytes > MAX_TEMPLATE_VIDEO_BYTES
        ? `视频最大 ${Math.round(MAX_TEMPLATE_VIDEO_BYTES / 1024 / 1024)}MB（当前约 ${Math.round(meta.bytes / 1024 / 1024)}MB），请先压小再传。`
        : null) ||
      templateSourceIssue(meta);
    if (issue) {
      try {
        await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
      } catch (e) {
        console.error(`[uploads] 直传验收不过、回收失败 public_id=${publicId}:`, e?.message || e);
      }
      return res.status(400).json({ ok: false, message: issue });
    }
    res.json({
      ok: true,
      url: resource.secure_url,
      publicId: resource.public_id,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      bytes: meta.bytes,
      maxSizeBytes: MAX_TEMPLATE_VIDEO_BYTES,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/template-video",
  requireAuth,
  tplVideoMinuteLimit,
  tplVideoDailyLimit,
  uploadTemplateVideo.single("video"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, message: "没有收到视频文件，请重新选择一个 mp4 / mov 文件。" });
      }

      // public_id 以本账号 _id 开头（/media 同款）——这就是「这段视频是谁传的」的判据，
      // 建模板时的三重白名单靠它把归属钉死
      const receipt = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "ideahub/template-videos",
            public_id: `${req.user._id.toString()}-${Date.now()}`,
            resource_type: "video",
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );
        stream.end(req.file.buffer);
      });

      // ★★ 回执复核 —— 服务端自己的验收，不信客户端预检（客户端那份只是省用户时间的
      //   提前量，改一行前端就能跳过）。
      // ★ 这里用的是**原始素材**那套窗口（templateSourceIssue），不是参考视频那套：
      //   V2 起真正要满足方舟约束的是"编辑页框选、服务端裁出来的那一段"，
      //   拿严窗口卡上传口的话，一段 3 分钟素材连传都传不上来，而它裁出的 8 秒完全合格。
      //   两套窗口都在 middleware/upload.js 一处（建模板/裁剪后复核走 templateRefIssue）。
      const meta = templateVideoMeta(receipt);
      const issue = templateSourceIssue(meta);
      if (issue) {
        // ★ 先 destroy 再拒：不回收的话，每一次被拒的上传都永久占着配额
        //   （此前全服务端零 destroy 调用，上传即永久留存）。回收失败不改变拒收结论，
        //   但必须吼出来 —— 静默泄漏的配额没有任何症状，只有月底的用量报表知道。
        try {
          await cloudinary.uploader.destroy(receipt.public_id, { resource_type: "video" });
        } catch (e) {
          console.error(`[uploads] 模板视频复核不过、回收失败 public_id=${receipt.public_id}:`, e.message);
        }
        return res.status(400).json({ ok: false, message: issue });
      }

      // 元数据随回执返回：客户端拿去显示与预检报价，但**作数的**是建模板时服务端
      // 自己再向 Cloudinary 取的那份（见 branchTemplate.routes.js）——响应里这几个数
      // 只是镜像，不是契约锚点
      res.json({
        ok: true,
        url: receipt.secure_url,
        publicId: receipt.public_id,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        bytes: meta.bytes,
        maxSizeBytes: MAX_TEMPLATE_VIDEO_BYTES,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── 未登记模板视频的回收（孤儿治理）─────────────────────────────────
// ★ 为什么要有这个端点：上传成功 ≠ 建成模板。视觉分析挂了、登记接口一直失败、
//   用户干脆放弃 —— 这几条路走完，Cloudinary 上都会留下一段无人引用的 20MB 级
//   公开视频，而 destroy 此前只在「复核不过」与「删已登记模板」两处调，
//   这类资产两处都够不着：配额与流出流量只增不减、零症状（正是限流注释里说的
//   那种只有月底用量报表知道的泄漏）。客户端在放弃/删除未登记模板时调这里兜底。
// ★ 归属判据 = public_id 形状（上传时就是 `${userId}-${ts}`），**唯一实现在
//   utils/templateVideoAsset.ownTemplateVideoPublicId** —— 此前这里手写了一份
//   `startsWith(前缀)`，比建模板那份松（后缀不限数字），两份分叉时没有任何症状。
// ★ 已被模板引用的资产整句拒：那些的生命周期归 DELETE /api/branch/templates/:id 级联管，
//   从这里删等于把别人在用的模板抽底。**两种引用都要挡**：
//     refVideo.cloudinaryPublicId —— 参考视频本体（删了模板直接废）；
//     source.publicId            —— 白模 V2 的原始素材（删了模板还能用，但再也重做不了）。
router.delete("/template-video", requireAuth, uploadLimit, async (req, res, next) => {
  try {
    const raw = String(req.body?.publicId ?? req.query?.publicId ?? "").slice(0, 300);
    const publicId = ownTemplateVideoPublicId(raw, req.user._id.toString());
    if (!publicId) {
      return res.status(400).json({ ok: false, message: "只能回收本账号上传的模板视频。" });
    }
    const refUsed = await BranchTemplate.exists({ "refVideo.cloudinaryPublicId": publicId });
    if (refUsed) {
      return res.status(400).json({ ok: false, message: "这段视频已登记为白模模板，请改用删除模板（会连带回收视频）。" });
    }
    const srcUsed = await BranchTemplate.exists({ "source.publicId": publicId });
    if (srcUsed) {
      return res.status(400).json({
        ok: false,
        message: "这段视频是某个白模模板的原始素材（重做时还要用它），请改用删除那个模板（会连带回收）。",
      });
    }
    // ★★ 第四种引用（2026-08-20 分段登记）：切过段的源视频是**整组的音轨来源** ——
    //   合并成片时客户端按 group.sourceUrl 回填原片音轨。从这里删掉它，组里每一段照常
    //   能出片，**只有合并那一步的音轨拉不到**，而且是所有套用者一起坏、零报错可查。
    //   组员被逐段删光时它由模板删除级联回收（branchTemplate.routes 的 DELETE）。
    const groupUsed = await BranchTemplate.exists({ "group.sourcePublicId": publicId });
    if (groupUsed) {
      return res.status(400).json({
        ok: false,
        message: "这段视频已被分段登记成一组模板（合并成片时还要用它的音轨），请改用删除那些模板（最后一段删除时会连带回收）。",
      });
    }
    // ★★ 白模 V2 拆成两阶段之后多出的第三种引用：**还没取回结果**的那一发。
    //   从受理到取回之间世上还没有模板，上面两条 exists 都落空 —— 而方舟那边可能
    //   还要去拉这段素材的变换地址（懒生成），此刻删掉它，用户那一发就会莫名其妙失败，
    //   **而钱已经花了**（受理后失败不退），且没有任何一层会说这是他自己删的。
    const jobUsed = await BlockoutJob.exists({
      "source.publicId": publicId,
      status: { $in: ["pending", "claimed"] },
      expiresAt: { $gt: new Date() },
    });
    if (jobUsed) {
      return res.status(400).json({
        ok: false,
        message: "这段视频正在做白模化（费用已经产生），现在删掉会让那一发白花钱。请先到「待取回的白模」里把结果取回来。",
      });
    }
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
    // Cloudinary 对不存在的资源回 "not found" 而不是报错 —— 对回收来说这就是目标态，
    // 一样算成功（幂等：客户端重试第二次不该看到失败）
    return res.json({ ok: true, result: result?.result ?? "unknown" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
