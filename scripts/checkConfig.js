#!/usr/bin/env node
// 部署前预检：npm run check:config
//
// 在【不启动服务】的前提下检查生产配置是否齐备。
// 目的是把「部署上去起不来、再回滚」变成「部署前 2 秒就知道缺什么」。
//
// 用法（在服务器上，/var/www/ideahub-server）：
//     NODE_ENV=production npm run check:config
require("dotenv").config();

const { collectConfigProblems } = require("../src/config/preflight");

const { problems, isProd } = collectConfigProblems();

if (!problems.length) {
  console.log(`✅ 配置自检通过（NODE_ENV=${process.env.NODE_ENV || "未设置"}）`);
  process.exit(0);
}

console.error(`❌ 配置自检未通过（NODE_ENV=${process.env.NODE_ENV || "未设置"}）：`);
for (const p of problems) console.error(`  - ${p}`);

if (!isProd) {
  console.error(
    "\n提示：当前不是 production。上面这些在生产环境会【拒绝启动】，" +
      "部署前请用 NODE_ENV=production npm run check:config 再确认一次。",
  );
}

console.error(`
修复参考（在 /var/www/ideahub-server/.env 中设置）：
  JWT_SECRET     —— openssl rand -base64 48   （≥32 字符；换了会让所有人重新登录）
  OTP_PEPPER     —— openssl rand -base64 32   （换了会让已发出的验证码全部失效）
  SMS_PROVIDER   —— 真实短信通道标识，不能是 dev
  CORS_ORIGINS   —— https://ideahubs.org,https://www.ideahubs.org
改完记得 pm2 restart ideahub-server --update-env（不带 --update-env 不会重读 .env）
`);

process.exit(1);
