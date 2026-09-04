/**
 * @file blocks.controller.js —— 「拉黑一个人」（UGC 域）
 *
 * ★★ 为什么另开一套端点，而不是复用 `/api/messages/blacklist`（2026-09-03）：
 *   那三个端点是**私信申请域**的，`blockDmUser` 前面串着三道防滥用闸
 *   （「对方回复过你才能拉黑」「你还有一条待处理的私信申请」「你私信过对方但对方没回」），
 *   任何一条不满足就是 403。那些闸对私信是有道理的，但对 **UGC 拉黑是灾难**：
 *   「我回过他一句、他开始骚扰我」恰恰是最该能拉黑的场景，却会被第一道闸拒掉 ——
 *   而 Google Play 的 UGC 政策要求这个功能存在，正是为了这种场景。
 *   ⇒ 两个用途、两套入口、**同一张表**（DmRequestBlock）：一个人只该有一份拉黑名单。
 *
 * ★★ 第二个理由是**回包形状**：那条列表端点回的是拉黑**记录**（populate 过的
 *   `blockedUserId`），客户端得自己去猜哪个字段是人。第一版就猜错了 —— 取到的 id 是
 *   记录 `_id` 而不是用户 `_id`，于是「解除」发出去删不掉任何东西、界面还乐观地把那行移走了
 *   （零报错的空操作）。所以这里**回客户端真正需要的形状**，别让调用方反向工程。
 */
const mongoose = require("mongoose");
const DmRequestBlock = require("../models/DmRequestBlock");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const errorCodes = require("../utils/errorCodes");

const USER_FIELDS = "username displayName avatarUrl";

function badRequest(message) {
  throw new AppError(message, 400, errorCodes.VALIDATION_ERROR || "VALIDATION_ERROR");
}

/** 把一条拉黑记录变成「一个人」。★ populate 失败（账号已注销）时返回 null，别摆一行鬼影 */
function toBlockedUser(row) {
  const u = row && row.blockedUserId;
  if (!u || typeof u !== "object" || !u._id) return null;
  return {
    id: String(u._id),
    name: u.displayName || u.username || "",
    avatar: u.avatarUrl || "",
    blockedAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
  };
}

/** GET /api/blocks —— 我拉黑了谁 */
async function listBlocks(req, res, next) {
  try {
    const rows = await DmRequestBlock.find({ blockerUserId: req.user._id })
      .sort({ createdAt: -1 })
      .populate("blockedUserId", USER_FIELDS)
      .lean();
    res.json({ ok: true, items: rows.map(toBlockedUser).filter(Boolean) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/blocks/:userId —— 拉黑。
 * ★ **幂等**：已经拉黑过再点一次也回 200（`created:false`）。UGC 拉黑不该因为"点重了"而报错。
 * ★ 不设任何"够不够格拉黑"的闸：见文件头 ★★。唯一的拒绝是自己拉黑自己、id 非法、人不存在。
 */
async function createBlock(req, res, next) {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) badRequest("Invalid user id");
    if (String(req.user._id) === String(userId)) badRequest("Cannot block yourself");
    const exists = await User.exists({ _id: userId });
    if (!exists) badRequest("User not found");

    const r = await DmRequestBlock.updateOne(
      { blockerUserId: req.user._id, blockedUserId: userId },
      { $setOnInsert: { blockerUserId: req.user._id, blockedUserId: userId } },
      { upsert: true },
    );
    res.json({ ok: true, created: (r.upsertedCount ?? 0) > 0 });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/blocks/:userId —— 解除。
 * ★ 回 `removed`：客户端据此判断"到底解没解掉"。只回 `{ok:true}` 的话，
 *   把一个**不存在**的 id 发过去也是成功 —— 而那正是上一版那个零报错空操作的形状。
 */
async function removeBlock(req, res, next) {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) badRequest("Invalid user id");
    const r = await DmRequestBlock.deleteOne({ blockerUserId: req.user._id, blockedUserId: userId });
    res.json({ ok: true, removed: (r.deletedCount ?? 0) > 0 });
  } catch (err) {
    next(err);
  }
}

module.exports = { listBlocks, createBlock, removeBlock };
