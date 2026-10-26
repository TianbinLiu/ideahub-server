/**
 * @file videoZone.routes.js - 这次请求按哪个出片地区算、这台服务器在这个地区给得出哪几家视频供应商
 * @category Route
 * @base_path /api/video
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节
 *
 * API端点:
 * @endpoint GET /zone - → { ok: true, v: 1, zone, country, providers, gate }（免登录；带了 token 就认人；限流约 60 次/分钟 → 429）
 *
 * 为什么有这个端点（2026-10-26）：主人要求出片模型按地区给 —— 境内 Seedance 与 MiniMax 都能选，海外只给 MiniMax。
 * 地区只在服务端判（utils/geo + config/videoRegion.requestZone），App 只照着画：它拿这里的 providers 决定摆哪几档，
 * 真正拦人的是出片那一发上的地区门禁（被拦回 403 REGION_UNAVAILABLE，不扣钱）。
 *
 * 回包（v1）：
 *   zone      —— "cn" | "intl" | "blocked"（blocked = 受全面制裁的地区：门禁 on 时一家都不给）；
 *   country   —— 判出来的两位国家码，判不出 / Tor 是 ""（开发用的 VIDEO_ZONE_FORCE 只钉 zone，country 照实报）；
 *   providers —— 这台服务器**此刻对这个请求放行**哪几家（"ark" = 火山方舟 Seedance、"minimax"；没配 key 的那家永远不报）。
 *                **跟着 gate 走**（config/videoRegion.offeredProviders 一处算）：gate 是 "on" 时 = 这个地区按政策给的 ∩ 配了的；
 *                "off" / "observe" 时服务端一发都不拦，就报配了的全部几家、不看地区。App **只照 providers 摆档**，不必自己再看 gate ——
 *                ★ 2026-10-26 审核改的：原来 providers 不跟 gate，「gate 不是 on 就别拿 providers 藏档」只是 App 自己的决定，
 *                  有一个版本的 App 没照做，服务端切 off 这个急停开关就救不回海外的 Seedance，而服务端这一侧毫无办法；
 *                ★ MiniMax 连站一起判：海外只准国际站 —— 这台服务器的 MiniMax 走中国站时，gate 为 on 的海外回包里没有 "minimax"；
 *   gate      —— 地区门禁此刻开到哪一档："off" | "observe" | "on"（VIDEO_REGION_GATE，缺省 observe），只作说明与排查用。
 *   v         —— 回包形状的版本：以后加字段（比如按型号单独关）不升，改了已有字段的意思才升
 *                （providers 跟着 gate 走是 v1 发布之前、同一批里改的，所以还是 v1）。
 *
 * ★ Cache-Control: no-store（每一种回包都带，429 也是）：地区跟着出口 IP 走，开关 VPN 就会在会话中途变；
 *   任何一层缓存（WebView、Cloudflare）记住一次，人就会对着另一个地区的档位出片。
 * ★ App 先看 `GET /api/ark/health` 的 `videoZone: true` 再来问这里：老服务端上这条路是 404，而 Capacitor 对
 *   未命中路径回 200 + index.html —— 判断「有没有这个端点」只看能力位，不看状态码。
 * ★ 免登录：探地区发生在登录之前（开机就要决定摆哪几档）。optionalAuth 先认人，只为两件事：
 *   限流按账号分桶（见下）、以后做「账号级例外」时有人可认（今天不做，等主人定）。
 *
 * 依赖:
 * @uses config/videoRegion.js - requestZone / offeredProviders / gateMode（地区、此刻放行哪几家、门禁的唯一判定）
 * @uses middleware/auth.js - optionalAuth
 * @uses middleware/rateLimit.js - rateLimit + clientIp（取真实 IP 的唯一实现）
 *
 * 认证要求:
 * - public（optionalAuth）
 *
 * 被注册于:
 * @registered_in app.js - `app.use("/api/video", …)`
 */
const router = require("express").Router();
const { optionalAuth } = require("../middleware/auth");
const { rateLimit, clientIp } = require("../middleware/rateLimit");
const { requestZone, offeredProviders, gateMode } = require("../config/videoRegion");

/** 回包形状的版本（见文件头「v」） */
const ZONE_RESPONSE_VERSION = 1;

// 每一种回包都不许缓存（理由见文件头）。挂在最前面：限流的 429、出错的 500 也带上
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/**
 * 限流约 60 次/分钟：登录了按**账号**分桶，没登录按 IP。
 * ★ 不用 aiRateLimit / userRateLimit：它们按账号计、没登录时 keyFor 回 null = **直接放行** ——
 *   挂在这个免登录端点上等于对游客完全不限（middleware/rateLimit 的 userRateLimit 注释）。
 * ★ 登录的人按账号分桶，是为了 CGNAT：一个出口 IP 后面成百上千个真人，按 IP 计会互相挤掉。
 *   游客只能按 IP 计 —— 60 次/分钟对一台正常的手机绰绰有余（开机、回前台、联网、每 10 分钟各问一次），
 *   挤掉了也只是那一次没问到（App 退回本机上次的结论），出片那一发服务端还会再判一次地区。
 */
const zoneLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  scope: "video-zone",
  keyFor: (req) => (req.user?._id ? `u:${req.user._id}` : `ip:${clientIp(req)}`),
});

router.get("/zone", optionalAuth, zoneLimit, (req, res) => {
  const { zone, country } = requestZone(req);
  // gate 只现读一次：providers 是照它算的，两次现读之间改了配置就会报出一对互相矛盾的值
  const gate = gateMode();
  res.json({
    ok: true,
    v: ZONE_RESPONSE_VERSION,
    zone,
    country,
    providers: offeredProviders(zone, gate),
    gate,
  });
});

module.exports = router;
