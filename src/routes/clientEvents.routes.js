/**
 * @file clientEvents.routes.js - App 自报的客户端事件（白屏 / 没接住的 Promise / 更新失败 / IndexedDB 丢数据 / 开机被拦）
 * @category Route
 * @base_path /api/client-events
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节
 *
 * API端点:
 * @endpoint POST / - 记一条客户端事件 → 204（免登录；按 IP 10 次/分钟 → 429；形状不对 → 400）
 *
 * 为什么有这个端点（2026-10-15，教材人格评审 humble-delivery-4）：2.51～2.55 发出去的包一进工坊就整页白屏，**五天**里服务端
 * 没有任何痕迹 —— 白屏发生在 WebView 里，请求根本发不出来，pm2 日志里一行都没有；查到最后是出包的 worktree 缺了受保护模型。
 * 同类的还有应用内更新失败（校验不过、装不上）、IndexedDB 被 Chromium 判坏删库、开机装载被本机库拦住：
 * 全是「用户面前坏了、我们这边零信号」。这个端点只做一件事：让它们**在 pm2 日志里看得见**。
 *
 * ★★ 只写日志，**不落库、不读账号、不做任何判断**（与 X-App-Version 同一条纪律，见 middleware/appVersion 文件头）：
 *   免登录 = 谁都能打，正文是客户端写的、谁都能伪造；拿它做任何决定（计数、告警阈值、拦人）都是把方向盘交给对方。
 *   能从日志里得到的是「哪个版本、在哪一页、什么错、从哪儿来」—— 足够回答「这版是不是又白屏了」。
 * ★ 免登录是刻意的：白屏与开机被拦都发生在登录态水合**之前**，要求 token 等于把最该报的那几种事件挡在门外。
 *   代价是任何人都能灌日志 —— 所以按 IP 限流（10 次/分钟，同一台手机正常一天也报不到这个数）、每个字段都限长限字符
 *   （schemas/clientEvents.schemas.js），日志行再剥一遍控制字符（一个 `\n` 就能伪造出第二行日志）。
 * ★ 回 204 不回 JSON：App 发完就走（fire-and-forget），回什么都不看。老服务端上这条路是 404（Express 的 notFound），
 *   所以 App 先看 `GET /api/ark/health` 的 `clientEvents: true` 再发。
 *
 * 依赖:
 * @uses middleware/validate.js + schemas/clientEvents.schemas.js - 形状校验（400）
 * @uses middleware/rateLimit.js - 按 IP 限流 + clientIp（取真实 IP 的唯一实现，别在这里再手写一份）
 *
 * 认证要求:
 * - public（免登录，理由见上）
 *
 * 被注册于:
 * @registered_in app.js - `app.use("/api/client-events", …)`
 */
const router = require("express").Router();
const { validate } = require("../middleware/validate");
const { rateLimit, clientIp } = require("../middleware/rateLimit");
const { clientEventBody } = require("../schemas/clientEvents.schemas");

// 日志里只留可见 ASCII（where / name 由 schema 限了字符集，只有 version 要过它）—— 实现在 utils/logSafe，与 OAuth 回调出错那一行共用
const { logSafe } = require("../utils/logSafe");

router.post(
  "/",
  rateLimit({ windowMs: 60_000, max: 10, scope: "client-events" }),
  validate({ body: clientEventBody }),
  (req, res) => {
    const { kind, version, where, name } = req.body;
    console.warn(`[client-event] kind=${kind} version=${logSafe(version)} where=${where || "-"} name=${name || "-"} ip=${clientIp(req)}`);
    res.status(204).end();
  },
);

module.exports = router;
