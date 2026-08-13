// src/utils/roles.js
// 「谁是管理员」的唯一判据（铁律六）。
//
// ★ 为什么单开一个文件而不是各处写 `user.role === "admin"`：
//   这个字符串现在有三类读者 —— 路由上的 requireRole(ADMIN_ROLE)、
//   controller 里的删除授权（assertCanDelete）、以及 ark 代理里的免单分支。
//   散着写的话，哪天角色名改了或者多出一个 "moderator"，漏改任何一处都**不会报错**，
//   只会静默地少一道或多一道权限。
//
// ★ 判据故意只认 `req.user.role` 这一个来源，而它是 **requireAuth / optionalAuth
//   每次请求从库里重读**的（不信 JWT 里的快照，见 middleware/auth.js）。
//   所以给某个账号加/撤管理员立刻生效，不需要用户重新登录，
//   也**不要**去涨 tokenVersion —— 那只会把人踢下线，跟权限一点关系都没有。
//
// ★ 传进来的可能是"半个用户"：branchVideo.controller 里判"某个被 @ 到的人看不看得见
//   这条作品"时，构造的是 `{ _id: userId }`（没有 role）。那种情况这里返回 false ——
//   方向是对的：拿不准时按**不是管理员**处置，少给权限而不是多给。
const ADMIN_ROLE = "admin";

/** @param {{role?: string}|null|undefined} user 当前请求的用户（req.user） */
function isAdmin(user) {
  return !!user && user.role === ADMIN_ROLE;
}

module.exports = { ADMIN_ROLE, isAdmin };
