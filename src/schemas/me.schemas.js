// src/schemas/me.schemas.js
// 当前用户账号级操作的请求校验。
const { z } = require("../middleware/validate");

// 注销账号 body：确认用户名。
// 注意这里【不加 .trim()】——控制器要求与本人用户名严格全等，
// 若在此静默 trim，" alice " 就会被当成 "alice" 通过确认，削弱这道确认门槛。
const deactivateBody = z.object({
  confirmUsername: z.string().min(1).max(200),
});

module.exports = { deactivateBody };
