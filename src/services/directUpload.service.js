/**
 * @file directUpload.service.js - Cloudinary 签名直传的「一张票」——**这条规则的唯一实现**（铁律六）
 * @category Service
 *
 * 三个上传口共用：模板视频（/api/uploads/template-video/sign）、发布成片（/api/uploads/media/sign）、
 * Live2D 模型包（/api/live2d-models/bundle/sign）。在提成这份之前它已经有两份逐字重复的拷贝，
 * 第三个口再抄一遍就等于把下面三条安全纪律分散在三处 —— 只要有一处漏签，那一条路就有绕行洞，而且零报错。
 *
 * ★★★ 为什么必须直传（2026-08-22 实测）：**Cloudflare 的 Proxy Read Timeout = 125 秒**，
 *   nginx 默认 `proxy_request_buffering on` 要把整个 body 收完才回包，于是整段上传期间 CF 看到的是
 *   「源站零响应」，125 秒一到就掐（三发连续复现 rt=125.006/125.005/125.006）。⇒ 走我们自己服务器的
 *   老路真实上限不是「多少 MB」，是「125 秒内能推上去多少」——实测手机 5G 上行 0.126MB/s ≈ 15MB。
 *   这个 125 秒只有 Enterprise 能调，唯一根治办法是让文件字节根本不经过 CF 与源站。
 *
 * ★★ 安全面靠三条钉死，缺一条就有绕行路：
 *   ① **public_id 由服务端生成并签进签名**：客户端能自选 public_id = 能覆盖任何人的资产。
 *      形状必须与对应的归属判据（utils/templateVideoAsset.js 的 ownXxxPublicId）逐字吻合，
 *      否则文件传上去之后验收 / 登记 / 回收三处都会判它「不是你的」，而那时它已经在 Cloudinary 上了。
 *   ② **overwrite: false**：签名有效期 1 小时且可复用。不签这一项的话，用户可以先传一段干净素材、
 *      走完复核与登记、过审发布，**再用同一个签名把 Cloudinary 上那份原地换成别的** —— 数据库一个字段不动、
 *      全程零报错，而所有使用者拿到的已经是新内容（2026-08-22 实测：41.2s 的资产被换成 13.7s 的）。
 *   ③ **allowed_formats**：Cloudinary 算签名时**排除 resource_type**（它只在 URL 路径里），
 *      所以一张 `/video/upload` 的票把 URL 改成 `/raw/upload` 照样有效 —— 实测把一个 HTML 文件传进了
 *      `res.cloudinary.com/<我们的 cloud>/raw/upload/…`，等于在可信域上开了任意文件托管（钓鱼载荷记我们头上）。
 *      `overwrite:false` 拦不住它：三种 resource_type 是三套独立命名空间。加上格式白名单之后实测回
 *      `{"error":{"message":"Raw file format html not allowed"}}`。
 *      ⇒ **真正把票钉在某一种 resource_type 上的是 allowed_formats，不是 uploadUrl 里的那一段路径。**
 *      新开一个口时，格式白名单要窄到「换成别的 resource_type 也传不进有害东西」为止。
 *
 * ★ 元数据一律以服务端这边取回的那份为准（confirm / 取回步骤）：客户端现在能直接和 Cloudinary 对话，
 *   它报的时长、尺寸、体积完全可以伪造，而时长正是 r2v 的计价输入。
 */
const { cloudinary } = require("../config/cloudinary");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

/** 直传的分块大小。★ Cloudinary 的硬约束是「除最后一块外每块 > 5MB」（官方文档原文），
 *  官方 SDK 默认 20,000,000。这里取 6,000,000：够宽（>5MB）也够小 —— 手机慢网上
 *  一块几十秒，中途断了只重传这一块，而不是从头再来 47MB。 */
const DIRECT_UPLOAD_CHUNK_BYTES = 6_000_000;

/** Cloudinary 配好了没有。没配时三个口一律回 503（而不是签一张用不了的票让客户端在存储那边撞墙） */
function cloudinaryReady() {
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  return Boolean(cloud_name && api_key && api_secret);
}

/**
 * 签一张直传票。
 * @param {object} o
 * @param {"video"|"raw"|"image"} o.resourceType 上传 URL 里的那一段；★ 它不进签名，真正的闸是 allowedFormats
 * @param {string} o.publicId 服务端生成的 public_id（不带扩展名），形状 `<folder>/<userId>-<ts>`
 * @param {string[]} o.allowedFormats 格式白名单，窄到「换 resource_type 也传不进有害东西」
 * @param {number} o.maxSizeBytes 只是回给客户端让它先自查；真正的体积闸在验收/取回那一步
 * @returns {{uploadUrl: string, publicId: string, params: object, chunkBytes: number, maxSizeBytes: number}|null}
 *   null = Cloudinary 没配（调用方回 503）
 */
function signDirectUpload({ resourceType, publicId, allowedFormats, maxSizeBytes }) {
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  // ★ 这里**抛**而不是回 null：调用方都是 `res.json({ ok: true, ...signDirectUpload(...) })` 这个形状，
  //   回 null 展开出来是 `{ ok: true }` —— 一个「成功但没有票」的响应，客户端只会在下一步莫名其妙地失败
  //   （铁律八：失败要响）。三个调用点前面都还有一道 cloudinaryReady() 把它翻成中文 503，这里是兜底。
  if (!cloud_name || !api_key || !api_secret) {
    throw new AppError({ code: CODES.SERVER_ERROR, status: 503, message: "服务器还没配好文件存储，暂时不能上传。" });
  }
  const timestamp = Math.round(Date.now() / 1000);
  // ★★ 签名与「要发哪些字段」**用同一个对象**：多签一个没发、或发了一个没签，Cloudinary 都只回
  //   一句 Invalid Signature，而那是最难查的一类错。客户端拿到 params 之后原样逐字段转发，
  //   不许自己拼、也不许增删。
  const params = {
    allowed_formats: allowedFormats.join(","),
    overwrite: false,
    public_id: publicId,
    timestamp,
  };
  const signature = cloudinary.utils.api_sign_request(params, api_secret);
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloud_name}/${resourceType}/upload`,
    publicId,
    // 客户端要原样发出去的表单字段（file / Content-Range / X-Unique-Upload-Id 另加）
    params: { ...params, api_key, signature },
    // 分块大小由服务端说了算
    chunkBytes: DIRECT_UPLOAD_CHUNK_BYTES,
    maxSizeBytes,
  };
}

/**
 * 直传资产的公开投递地址（服务端自己拼，不问客户端要）。
 * ★ 为什么不走 `cloudinary.api.resource()` 拿 secure_url：那是 **Admin API**，免费档全局 500 次/小时，
 *   而取回这一步挂在 inspect（10 次/分钟/人）后面 —— 单个账号就能把全站的 Admin 预算打空，
 *   连带别处读元数据的功能一起挂，且那些功能的失败话术说的都是别的原因。
 *   公开投递地址不花 Admin 配额，取不到就是 404（= 上传没真的完成），语义反而更准。
 * @param {"raw"|"video"|"image"} resourceType
 * @param {string} publicIdWithExt raw 资产的 public_id **带扩展名**（Cloudinary 对 raw 会把扩展名并进 id）
 */
function directDeliveryUrl(resourceType, publicIdWithExt) {
  const { cloud_name } = cloudinary.config();
  if (!cloud_name) return "";
  return `https://res.cloudinary.com/${cloud_name}/${resourceType}/upload/${publicIdWithExt}`;
}

module.exports = { DIRECT_UPLOAD_CHUNK_BYTES, cloudinaryReady, signDirectUpload, directDeliveryUrl };
