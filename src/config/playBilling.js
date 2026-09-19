// Google Play 结算（GPB）的配置与自检 —— D15 阶段 1（服务端，统一执行顺序第 2 批）。
//
// ★ 默认关：PLAY_BILLING_ENABLED 不开时 /api/pay/play/* 一律 404（路由像不存在一样）。
//   上线要等主人把 Play Console / Google Cloud 那几步做完（规格 §0.3 第 1~8 项）。
// ★ 自检只查「配了一半」，**不出网**：商品映射与 Console 是否一致另做 —— 启动时出网查，Google 抖一下服务就起不来。
// ⚠ PLAY_ACCOUNT_SALT **永远不能轮换**：obfuscatedAccountId = HMAC(user._id, 盐)。客户端下单时把它交给 Google，
//   Google 在购买记录里原样带回来，服务端靠它认「这笔是不是这个账号买的」。换盐 = 之前每一笔在途 / 待补发的购买
//   都认不出主人（account_mismatch，不 consume，三天后 Google 自动退款）。
const EXPECTED_PACKAGE = "com.ideahub.branchvideo";

const on = (v) => /^(1|true)$/i.test(String(v || ""));

/** 现读环境（测试里要能切开关；生产进程里 env 不会变，现读的代价可以忽略） */
function playBillingConfig(env = process.env) {
  return {
    enabled: on(env.PLAY_BILLING_ENABLED),
    packageName: String(env.PLAY_PACKAGE_NAME || EXPECTED_PACKAGE),
    saJsonB64: String(env.PLAY_SA_JSON_B64 || ""),
    salt: String(env.PLAY_ACCOUNT_SALT || ""),
    allowTestPurchases: on(env.PLAY_ALLOW_TEST_PURCHASES),
  };
}

/** 服务账号 JSON 解不解得出来、两个关键字段在不在（不出网）。解不出回 null */
function parseServiceAccount(b64) {
  try {
    const sa = JSON.parse(Buffer.from(String(b64 || ""), "base64").toString("utf8"));
    if (sa && typeof sa.client_email === "string" && typeof sa.private_key === "string") return sa;
  } catch {
    /* 下面统一回 null */
  }
  return null;
}

/**
 * 配置问题，并进 preflight 的总检查（生产环境有问题就拒绝启动，其余环境只告警）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function collectPlayBillingProblems(env = process.env) {
  const c = playBillingConfig(env);
  const problems = [];
  const hasSa = Boolean(c.saJsonB64);
  const hasSalt = Boolean(c.salt);
  if (c.enabled && !(hasSa && hasSalt)) {
    const missing = [!hasSa && "PLAY_SA_JSON_B64", !hasSalt && "PLAY_ACCOUNT_SALT"].filter(Boolean).join(" / ");
    problems.push(`PLAY_BILLING_ENABLED 打开了，但缺 ${missing}（兑换一定失败，而客户端的购买入口照常亮着）`);
  } else if (hasSa !== hasSalt) {
    problems.push(
      `Google Play 结算只配了一半（${hasSa ? "有 PLAY_SA_JSON_B64 缺 PLAY_ACCOUNT_SALT" : "有 PLAY_ACCOUNT_SALT 缺 PLAY_SA_JSON_B64"}）`,
    );
  }
  if (hasSa && !parseServiceAccount(c.saJsonB64)) {
    problems.push("PLAY_SA_JSON_B64 解不出服务账号 JSON（要把整份 JSON 做 base64，里面要有 client_email 与 private_key）");
  }
  if (hasSalt && c.salt.length < 32) {
    problems.push(`PLAY_ACCOUNT_SALT 过短（${c.salt.length} 字符，至少 32）`);
  }
  if (env.PLAY_PACKAGE_NAME && env.PLAY_PACKAGE_NAME !== EXPECTED_PACKAGE) {
    problems.push(`PLAY_PACKAGE_NAME 是 ${env.PLAY_PACKAGE_NAME}，不是 ${EXPECTED_PACKAGE}（查到的会是别的 App 的购买记录）`);
  }
  return problems;
}

/** 启动时喊一嗓子：生产里放行测试购买是产品决定 4，不该只写在 .env 里没人看见 */
function warnPlayBillingMode(env = process.env) {
  const c = playBillingConfig(env);
  if (c.enabled && c.allowTestPurchases && env.NODE_ENV === "production") {
    console.warn("⚠️  PLAY_ALLOW_TEST_PURCHASES=1：生产环境里许可测试账号的购买也会发币（流水记 iap_test）。确认是主人定的再开。");
  }
}

module.exports = { EXPECTED_PACKAGE, playBillingConfig, parseServiceAccount, collectPlayBillingProblems, warnPlayBillingMode };
