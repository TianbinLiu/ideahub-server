// src/schemas/me.schemas.js
// 当前用户账号级操作的请求校验。
const { z } = require("../middleware/validate");

// 注销账号 body：确认用户名。
// 注意这里【不加 .trim()】——控制器要求与本人用户名严格全等，
// 若在此静默 trim，" alice " 就会被当成 "alice" 通过确认，削弱这道确认门槛。
const deactivateBody = z.object({
  confirmUsername: z.string().min(1).max(200),
});

// 同意协议 body：版本串就是 App 端 data/agreements 的 TERMS_UPDATED（日期形）。
// 限长只为防灌数据；不校验格式——协议正文与版本号都归客户端仓维护，服务端只留痕。
const acceptTermsBody = z.object({
  version: z.string().trim().min(1).max(32),
});

module.exports = { deactivateBody, acceptTermsBody };
