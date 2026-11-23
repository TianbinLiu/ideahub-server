/**
 * @file gameTicket.routes.js - 「工坊游戏券」的两个端点（挂在 /api/game）
 * @category Route
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节
 *
 * 设计来源：app 仓 `docs/g2-game-ui.md` §7 第 4 条（`GET /api/game/tickets`，形状照 `/api/me/wallet`）。
 *
 * | 方法 | 路径 | 鉴权 | 说明 |
 * |---|---|---|---|
 * | GET  | /api/game/tickets        | 登录 | 余额 + 本月已用 / 上限 + 下次重置时间。顺带完成**当月懒发** |
 * | POST | /api/game/tickets/grant  | **管理员** | 发券（share / invite / admin）。幂等靠 refId |
 *
 * ★ 出片**不在这里**：扣券挂在三条既有出片路由上（请求头 `X-Game-Ticket: 1` 或请求体
 *   `payWithTicket: true`），钱的那一段序列仍然只有 billing 一份。这里只读余额与发券。
 *
 * ★★ 为什么发券要管理员门（g2-game-ui.md §7 第 9 条）：今天「分享 App / 邀请新用户」**没有**
 *   服务端落点（邀请只有群邀请 GroupInvite、分享只有客户端壳）。开放给任何登录用户 =
 *   「自己给自己发券」= 平台无限印真金白银的出片额度。等那两件事真的落成服务端可判的事件
 *   （谁、哪天、指向谁）之后，改成由事件源直接调 `gameTicket.grant`，**这个端点仍然只留管理员**
 *   —— 它现在的作用是「补发 / 测试 / 客服兜底」，不是任务系统本身。
 *
 *   TODO（没做，别当成已做）：
 *     · 分享 / 邀请的事件源与防刷（同一人每天几次、被邀请人要不要先注册满 N 天）；
 *     · 全站熔断（连续 24 小时全站发券数超阈值 → 停发 + 给管理员发信），照 remixReward.alertFuse 的形状；
 *     · 券能不能滚存、付费套餐要不要多发 —— 等主人拍板（app 仓 g2-game-ui.md §8）。
 */
const express = require("express");
const mongoose = require("mongoose");
const { requireAuth, requireRole } = require("../middleware/auth");
const { ADMIN_ROLE } = require("../utils/roles");
const { aiRateLimit } = require("../middleware/rateLimit");
const gameTicket = require("../services/gameTicket.service");
const config = require("../config/gameTicket");

const router = express.Router();

/**
 * GET /api/game/tickets —— 我的券。
 * 回包：`{ ok, cycle, limit, granted, earned, spent, refunded, used, left, perGeneration, nextResetAt, enabled }`
 *  ★ 扁平回包（照设计稿 §7 第 4 条给的 `{ cycle, granted, used, left }`），App **只显示不计算**：
 *    上限、每发出一张、下次重置时间全由服务端说（价目表两仓各写一份必散，templateReward 那条纪律）。
 *  ★ 读一次就完成当月懒发：老 App 不认这个端点也没关系，第一次用券时 ensureTickets 会补上。
 *  ★ `enabled:false`（`GAME_TICKETS=off`）时余额照回：读是安全的，只是 /api/ark/health 那一位为 false，
 *    App 据此不摆「用券出片」；真发过来的券标记会被 403 GAME_TICKETS_OFF 拒（不静默改走 token）。
 */
router.get("/tickets", requireAuth, async (req, res, next) => {
  try {
    const t = await gameTicket.balance(req.user._id);
    if (!t) return res.status(404).json({ ok: false, code: "TICKETS_NOT_FOUND", message: "查不到这个账号的券" });
    res.json({ ok: true, ...t, enabled: config.enabled() });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/game/tickets/grant —— 发券（**仅管理员**，文件头 ★★）。
 *
 * 请求体：`{ userId?, source: "share"|"invite"|"admin"|"monthly", count?, refId?, memo? }`
 *   · `userId` 不给 = 给自己发（管理员测券用）
 *   · `source: "share"/"invite"` **必须**给 `refId`：它就是幂等键，没有它「点两次分享领两次」；
 *   · `source: "admin"` 不给 refId = 这次是故意的、不幂等（每次调用都是一笔新的）
 *   · `monthly` 一般不用手动发：`GET /api/game/tickets` 一到新月就懒发了；手动发同一个 refId（"YYYY-MM"）拿到的
 *     是 duplicate —— 正好可以拿来验证幂等
 *
 * 回包：201 `{ ok:true, granted:true, count, tickets }`；
 *   幂等命中 **200** `{ ok:true, granted:false, duplicate:true, tickets, message }`（不是错误，别重试）；
 *   参数 / 规则拒 **400** + `code`：`BAD_SOURCE` / `BAD_COUNT` / `BAD_USER` / `REF_ID_REQUIRED` / `DAY_CAP` / `TICKETS_OFF`
 */
router.post("/tickets/grant", requireAuth, requireRole(ADMIN_ROLE), aiRateLimit({ max: 30, scope: "game-ticket-grant" }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const target = String(body.userId ?? "").trim() || String(req.user._id);
    if (!mongoose.isValidObjectId(target)) {
      return res.status(400).json({ ok: false, code: "BAD_USER", message: "userId 不是合法的账号 id" });
    }
    const source = String(body.source ?? "admin").trim();
    if (!config.GRANT_SOURCES.includes(source)) {
      return res.status(400).json({ ok: false, code: "BAD_SOURCE", message: `source 只能是 ${config.GRANT_SOURCES.join(" / ")}` });
    }
    const count = body.count === undefined ? 1 : Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > config.MAX_GRANT_PER_CALL) {
      return res.status(400).json({ ok: false, code: "BAD_COUNT", message: `count 只能是 1~${config.MAX_GRANT_PER_CALL} 的整数` });
    }
    const refId = String(body.refId ?? "").trim();
    if ((source === "share" || source === "invite") && !refId) {
      return res.status(400).json({
        ok: false,
        code: "REF_ID_REQUIRED",
        message: "任务加券必须带 refId（那个事件的 id）：它是幂等键，没有它点两次就能领两次",
      });
    }
    const r = await gameTicket.grant({
      userId: target,
      source,
      refId,
      count,
      memo: String(body.memo ?? "").slice(0, 200),
      operator: req.user._id,
    });
    if (r.granted) return res.status(201).json({ ok: true, granted: true, count: r.count, tickets: r.ticket });
    // 幂等命中：同样的 refId 已经发过。200 而不是 409 —— 对调用方（事件重放）这是**成功**，不是冲突
    if (r.reason === "duplicate") {
      return res.json({ ok: true, granted: false, duplicate: true, count: r.count, tickets: r.ticket, message: "这一笔已经发过了（幂等，没有重复发）" });
    }
    const code = r.reason === "day_cap" ? "DAY_CAP" : r.reason === "disabled" ? "TICKETS_OFF" : r.reason === "no_user" ? "BAD_USER" : "BAD_REQUEST";
    const message =
      r.reason === "day_cap"
        ? `这个账号今天靠任务已经领满 ${config.TASK_GRANTS_PER_DAY} 张了（防刷上限，明天再来）`
        : r.reason === "disabled"
          ? "本服务器的工坊游戏券关着（GAME_TICKETS=off）"
          : r.reason === "no_user"
            ? "账号不存在"
            : "这一笔没发出去";
    res.status(400).json({ ok: false, code, message, reason: r.reason });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
