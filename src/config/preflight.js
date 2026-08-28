// 生产配置自检。
//
// 目的：把「配错了但能跑起来」变成「配错了就起不来」，并且允许在【部署之前】
// 单独跑一次（npm run check:config），而不是等部署失败才发现。
//
// 这些值以前缺了也照常启动、等第一个请求进来才炸（JWT_SECRET），
// 或者更糟——静默降级成开发模式：SMS_PROVIDER 漏配会退回把验证码
// 明文打进日志的 dev 通道，谁能看日志谁就能登录任意手机账号。

/**
 * 收集配置问题。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ problems: string[], isProd: boolean }}
 */
function collectConfigProblems(env = process.env) {
  const isProd = env.NODE_ENV === "production";
  const problems = [];

  // 支付：假渠道没有验签，生产环境开着等于任何人都能给自己发 token
  problems.push(...require("./payment").collectPaymentProblems(env));

  const secret = env.JWT_SECRET || "";
  if (!secret) problems.push("JWT_SECRET 未设置");
  else if (secret.length < 32) problems.push(`JWT_SECRET 过短（${secret.length} 字符，至少 32）`);
  else if (/^(replace|change|example|test|secret|dev)/i.test(secret)) problems.push("JWT_SECRET 仍是示例值");

  // QQ 登录是可选特性，不配就整个关掉——但**半配**要报出来：
  // 只填了 ID 没填 Key 时服务照常启动，App 里的 QQ 按钮也照常亮着（它只看跑没跑在壳里），
  // 用户点下去才拿到 503。这正是"配错了但能跑起来"那一类，所以在这里就拦住。
  const qqId = env.QQ_APP_ID || "";
  const qqKey = env.QQ_APP_KEY || "";
  if (Boolean(qqId) !== Boolean(qqKey)) {
    problems.push(`QQ 登录只配了一半（${qqId ? "有 QQ_APP_ID 缺 QQ_APP_KEY" : "有 QQ_APP_KEY 缺 QQ_APP_ID"}）`);
  }

  // 火山 AK/SK（真人肖像授权 OpenAPI）也是可选特性——不配就整个关掉（端点 503）。
  // 但**半配**要报出来：只填一个，签名一定失败，而 app 里"扫码授权"入口照常亮着
  // （它只看端点在不在），用户点下去才拿到 502。同 QQ 那条的"配错了但能跑起来"。
  const volcAk = env.VOLC_AK || "";
  const volcSk = env.VOLC_SK || "";
  if (Boolean(volcAk) !== Boolean(volcSk)) {
    problems.push(`火山 AK/SK 只配了一半（${volcAk ? "有 VOLC_AK 缺 VOLC_SK" : "有 VOLC_SK 缺 VOLC_AK"}）—— 真人肖像授权会签名失败`);
  }

  if (isProd) {
    if (!env.OTP_PEPPER || env.OTP_PEPPER === "dev_pepper_change_me") {
      problems.push("OTP_PEPPER 未设置或仍是默认值（6 位验证码的 sha256 可离线暴破）");
    }
    if (!env.SMS_PROVIDER || env.SMS_PROVIDER === "dev") {
      problems.push("SMS_PROVIDER 未配置真实短信通道（dev 通道会把验证码写进日志）");
    }
    if (!env.CORS_ORIGINS && !env.CLIENT_BASE_URL) {
      problems.push("CORS_ORIGINS / CLIENT_BASE_URL 均未设置，CORS 将对所有来源开放");
    }
  }

  return { problems, isProd };
}

/** 启动时调用：生产环境有问题则退出码 1，其余环境仅告警 */
function assertProductionConfig(env = process.env) {
  const { problems, isProd } = collectConfigProblems(env);
  if (!problems.length) return;

  const msg = problems.map((p) => `  - ${p}`).join("\n");
  if (isProd) {
    console.error(`❌ 生产配置自检未通过：\n${msg}`);
    process.exit(1);
  }
  console.warn(`⚠️  配置自检提示（非生产环境，仅告警）：\n${msg}`);
}

module.exports = { collectConfigProblems, assertProductionConfig };
