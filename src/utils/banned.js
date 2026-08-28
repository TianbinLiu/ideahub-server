// src/utils/banned.js
// 「这个账号封没封」与「封禁给用户看哪句话」的唯一出处（铁律六）。
//
// 消费方有两个：utils/jwt.js 的 signToken（登录侧：拒绝签发）与
// middleware/auth.js 的 requireAuth（请求侧：拦下每一次带 token 的请求）。
// 两边各写一遍的话，早晚出现「登录被拒说的是 A 原因、带旧 token 请求被拒说的是 B」，
// 或者一边判 banned 的有无、一边判 banned.at —— 用户看到的就是自相矛盾的两句话。
//
// ★ 判据看 **banned.at** 而不是 banned 本身，与 BranchVideo 的 TAKEN_DOWN 同一条理由：
//   解封走 $unset（整个子文档删掉），但万一哪天有人写成 `banned: null`，
//   `!!user.banned` 会把这个人判成「已封」且永远解不开。走 dot 路径的话，
//   坏数据的失败方向是「没封」—— 少拦一个人可以再封一次，多拦一个人是真事故。

/** @param {{banned?: {at?: Date}}|null|undefined} user */
function isBanned(user) {
  return !!(user && user.banned && user.banned.at);
}

/**
 * 同一条判据的 **Mongo 查询**写法（用户列表按封禁状态筛、统计数封禁人数）。
 * 与 isBanned 是一条规则的两种形态，改一处必须改另一处 ——
 * 形制照抄 branchVideo.controller 的 TAKEN_DOWN / NOT_TAKEN_DOWN。
 */
const BANNED_FILTER = { "banned.at": { $type: "date" } };
const NOT_BANNED_FILTER = { "banned.at": { $exists: false } };

/**
 * 给被封用户看的那句话。原因**必须**在里面 —— 「你被封了但不告诉你为什么」
 * 只会引来重复注册与客服轰炸；原因是封禁端点上必填的，这里兜底只是防坏数据。
 * ★ 这句话里**永不**出现 banned.by（是哪个管理员封的）：与 takedown.by 同一条理由，
 *   审核员不该被摆到被骚扰的位置上；库里存着，追责不受影响。
 */
function bannedMessage(banned) {
  const reason = String(banned?.reason || "").trim();
  return reason ? `账号已被封禁：${reason}` : "账号已被封禁";
}

/**
 * 已注销账号的对外说法（2026-08-28 中文化并收口到此）。
 * 消费方与封禁完全同构：utils/jwt.js 的 signToken（登录侧拒签）与
 * middleware/auth.js 的 requireAuth（请求侧拦旧 token）——两边各写一句迟早说岔。
 * ★ 恢复渠道要说出来：App 的注销页与隐私政策承诺的都是 support 邮箱，
 *   这里不带的话，被拒的用户只知道"门关了"、不知道钥匙在哪。
 */
const DEACTIVATED_MESSAGE = "账号已注销，无法登录。如需恢复，请发邮件到 support@ideahubs.org";

module.exports = { isBanned, bannedMessage, BANNED_FILTER, NOT_BANNED_FILTER, DEACTIVATED_MESSAGE };
