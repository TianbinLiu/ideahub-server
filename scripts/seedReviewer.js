/**
 * scripts/seedReviewer.js —— 给应用市场审核员用的测试账号（Google Play「应用访问权限」那一栏）。
 *
 * ★★ 为什么必须有：Play 要求"需要登录才能用的 App"在 App access 里给一组**能真正走完
 *   全部功能**的凭据。给不出、或者给了但登不上，是**直接驳回**的理由，而且驳回信里
 *   只会说「审核员无法访问应用的部分内容」——看不出是密码错了还是功能坏了。
 *
 * ★★ 为什么是脚本而不是"手动注册一个"：这个账号会**过期**（token 用完、密码忘了、
 *   哪天被误封），而每次重新提交审核都要它是活的。手动建的那一个，三个月后没人说得清
 *   密码是什么、当时改过什么。这份脚本**幂等**：随时重跑一次，账号一定回到「能登、
 *   没被封、有钱、是普通用户」这个状态。
 *
 * ── 四条刻意的取舍 ────────────────────────────────────────────────
 * ① **绝不给 admin**。管理员走的是免扣费通道（noteAdminFree），审核员就体验不到
 *    真实的「报价 → 扣费 → 出片」那条路；更要紧的是 admin 能看见举报队列（里面有举报人、
 *    被举报内容正文、以及全系统唯一透出弹幕作者的地方）。把那些交到一个外部审核账号
 *    手里，比"审核不通过"严重得多。脚本发现目标账号已经是 admin 会**当场停下**，
 *    不会把一个真管理员改密码降权。
 * ② **每次都重置密码**。不重置的话，Play Console 里填的那串字与库里那份会慢慢分叉，
 *    而分叉的表现就是上面那封看不出原因的驳回信。⇒ 脚本跑完，Console 里那串一定是真的。
 * ③ **不预先同意用户协议**（不碰 termsAcceptedAt）。协议前置本身就是 Play 要看的一项，
 *    替审核员点掉等于把要给他看的东西藏起来。他自己点一下就过。
 * ④ **不碰 emailVerified**。全仓没有任何一处拿它当门禁（只有邮箱验证码登录会写它），
 *    把它设成 true 只是往库里写一句"这个地址验过了"的假话。
 *
 * ── 怎么跑 ────────────────────────────────────────────────────────
 * 这台开发机的 Atlas 账号是**只读**的，所以要在生产服务器上跑：
 *
 *   ssh deploy@8.217.8.225
 *   cd <server 目录>
 *   read -s -p "password: " P; REVIEWER_EMAIL=... REVIEWER_PASSWORD="$P" node scripts/seedReviewer.js; unset P
 *
 * `read -s` 是为了别把密码留进 shell history。脚本自己**永远不打印密码** ——
 * 日志会被 pm2 收走、会被翻。
 */
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");
const wallet = require("../src/services/tokenWallet.service");

/**
 * 给审核账号备到多少 add-on token。
 *
 * ★ 免费版每月 300,000 —— 大约只够两段标准档，而审核员要试的是「推演三套方案 → 出片」
 *   这条完整的路，真人档单发就 270,000。备少了的表现是他点到一半被"余额不足"挡住，
 *   然后如实写下「部分功能无法使用」。
 * ★ 进 addon 而不是 plan：plan 是当月额度、跨月清零 —— 而审核跨月是常事。
 */
const DEFAULT_TOKENS = 5_000_000;

/** 密码至少这么长。给审核账号配一个弱密码 = 把一个能发布内容的账号挂在公网上 */
const MIN_PASSWORD = 12;

function required(name, env) {
  const v = env[name];
  if (!v || !String(v).trim()) throw new Error(`缺少环境变量 ${name}`);
  return String(v).trim();
}

/**
 * 干活的那一半。
 *
 * ★ 与 CLI 分开是为了**能被测**：这个脚本的正确性全落在几条「错了不会有任何症状」的
 *   性质上 —— 幂等（重跑不会把余额翻倍）、撞上 admin 会停手、补到目标而不是每次加一遍。
 *   这些错了都不报错，只在几个月后表现成「余额怎么多了」或「审核员登不上」。
 * ★ 连接由调用方负责（测试用内存库）。
 */
async function seedReviewer(env = process.env) {
  const email = required("REVIEWER_EMAIL", env).toLowerCase();
  const password = required("REVIEWER_PASSWORD", env);
  const username = (env.REVIEWER_USERNAME || "play_reviewer").trim();
  const wantTokens = Number(env.REVIEWER_TOKENS || DEFAULT_TOKENS);

  if (password.length < MIN_PASSWORD) {
    throw new Error(`REVIEWER_PASSWORD 至少 ${MIN_PASSWORD} 位（这个账号能登录、能发布内容）`);
  }
  if (!Number.isFinite(wantTokens) || wantTokens <= 0) {
    throw new Error(`REVIEWER_TOKENS 不是一个正数：${env.REVIEWER_TOKENS}`);
  }

  let user = await User.findOne({ email });

  // ★ 取舍①：撞上真管理员就停手，别把人家改密码降权
  if (user && user.role === "admin") {
    throw new Error(
      `${email} 已经是管理员账号。审核账号绝不能是 admin（免扣费 + 能看举报队列），` +
        `而这个脚本也不会去改一个真管理员。换一个邮箱。`,
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);

  if (user) {
    user.passwordHash = passwordHash; // 取舍②：每次都重置
    user.role = "user";
    user.deactivatedAt = null;
    // ★ 解封用 $unset 语义（mongoose 里是 set(undefined)），绝不 $set null ——
    //   与 User.banned 的注释同一条规矩：坏数据该往"没封"的方向倒。
    if (user.banned) user.set("banned", undefined);
    await user.save();
    console.log(`[reviewer] 已刷新既有账号：${email}`);
  } else {
    user = await User.create({ username, email, passwordHash, role: "user", bio: "应用市场审核用账号" });
    console.log(`[reviewer] 已创建：${email}（username=${user.username}）`);
  }

  // ── 备货 ──────────────────────────────────────────────────────
  // ★ 补到 wantTokens，而不是每次都加一个 wantTokens：脚本是要能反复跑的，
  //   无条件 $inc 的话跑五次就是 2500 万，账本上还留着五笔来路不明的 grant。
  const before = await wallet.getWallet(user._id);
  const have = (before?.plan ?? 0) + (before?.addon ?? 0);
  if (have < wantTokens) {
    const add = wantTokens - have;
    await wallet.credit(user._id, add, "grant", "应用市场审核账号备货（scripts/seedReviewer.js）");
    console.log(`[reviewer] 补了 ${add.toLocaleString()} token（原有 ${have.toLocaleString()}）`);
  } else {
    console.log(`[reviewer] 余额已有 ${have.toLocaleString()} token，不用补`);
  }

  const after = await wallet.getWallet(user._id);
  const summary = {
    id: String(user._id),
    email: user.email,
    username: user.username,
    role: user.role,
    banned: !!user.banned,
    deactivated: !!user.deactivatedAt,
    // ★ 刻意打出来：审核员**应该**看到协议前置那一屏（取舍③），这里要是 true 就是有人改错了
    termsAccepted: !!user.termsAcceptedAt,
    plan: after?.plan ?? 0,
    addon: after?.addon ?? 0,
  };
  console.log("[reviewer] 结果：", summary);
  console.log("[reviewer] 密码不打印。Play Console → 政策 → 应用内容 → 应用访问权限，填这个邮箱与你刚设的密码。");
  return summary;
}

module.exports = { seedReviewer, DEFAULT_TOKENS, MIN_PASSWORD };

// ── CLI ────────────────────────────────────────────────────────────
// ★ 只有直接 `node scripts/seedReviewer.js` 时才连库。被 require 进来（测试）时一行都不跑
//   —— 否则跑一次测试就会真的去连生产库并按测试的环境变量改数据。
if (require.main === module) {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[reviewer] 失败：缺少 MONGO_URI");
    process.exit(1);
  }
  mongoose
    .connect(uri)
    .then(() => seedReviewer(process.env))
    .catch((err) => {
      console.error("[reviewer] 失败：", err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
