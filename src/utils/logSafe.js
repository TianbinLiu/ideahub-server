// src/utils/logSafe.js
// 把客户端 / 第三方给的值写进日志前过一遍：只留可见 ASCII（控制字符、换行、非 ASCII 一律换成 `?`），可选限长。
// ★ 为什么要有：pm2 日志是按行读的，值里带一个换行就能伪造出一整行假日志（日志注入）。
//   2026-10-15 clientEvents 先写了一份；10-19 OAuth 回调出错那一行也要用（AuthorizationError 的 code 就是回调查询串里的 error，
//   谁都能填）—— 收成这一处，两边共用（铁律六）。
function logSafe(value, max = Infinity) {
  const s = String(value ?? "").replace(/[^\x21-\x7e]/g, "?");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

module.exports = { logSafe };
