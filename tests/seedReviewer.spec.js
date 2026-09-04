// tests/seedReviewer.spec.js
// 覆盖：scripts/seedReviewer.js（应用市场审核员测试账号的备货脚本）。
//
// ★ 这个脚本的正确性全落在几条【做错了不报错】的性质上，所以它们必须被钉住：
//   S1 重跑一次不该把余额翻倍 —— 写成无条件 $inc 的话，跑五次就是 2500 万 token，
//      账本上还留着五笔来路不明的 grant，而脚本每次都"成功"。
//   S2 撞上真管理员必须停手 —— 不停的话，一次手滑的 REVIEWER_EMAIL 就把生产管理员
//      改了密码、降成普通用户，而输出看起来一切正常。
//   S3 被封 / 已注销的账号要能被救回来 —— 审核账号被误封时，表现是审核员看到封禁页
//      然后驳回，而重跑脚本本该修好它。
//   S4 弱密码要当场拒 —— 这个账号能登录、能发布内容，密码写在 Play Console 里。
//   S5 绝不预先同意用户协议 —— 协议前置正是要给审核员看的一项（脚本的取舍③）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const bcrypt = require("bcryptjs");

let mongod;
let User;
let seedReviewer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  User = require("../src/models/User");
  // ★ require 进来时脚本的 CLI 分支必须一行都不跑（require.main !== module）。
  //   跑了的话，这一句会拿测试进程的环境变量去连**真库**改数据。
  ({ seedReviewer } = require("../scripts/seedReviewer"));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
function envFor(extra = {}) {
  seq += 1;
  return {
    REVIEWER_EMAIL: `reviewer${seq}@test.local`,
    REVIEWER_PASSWORD: "a-long-enough-password",
    REVIEWER_USERNAME: `reviewer_${seq}`,
    REVIEWER_TOKENS: "1000000",
    ...extra,
  };
}

describe("审核账号 provisioning", () => {
  test("S1 幂等：重跑不会把余额越加越多，也不会把账号改坏", async () => {
    const env = envFor();
    const first = await seedReviewer(env);
    expect(first.role).toBe("user");
    expect(first.plan + first.addon).toBe(1_000_000);

    const second = await seedReviewer(env);
    // ★ 关键断言：跑第二遍余额**一分不多**。写成无条件 $inc 的话这里会是 200 万
    expect(second.plan + second.addon).toBe(1_000_000);
    expect(second.id).toBe(first.id);
    expect(await User.countDocuments({ email: env.REVIEWER_EMAIL })).toBe(1);
  });

  test("S1b 余额被花掉之后，重跑会补回目标水位", async () => {
    const env = envFor();
    await seedReviewer(env);
    const u = await User.findOne({ email: env.REVIEWER_EMAIL });
    // 模拟审核员真的出了几段片：把 addon 花掉一大半
    await User.updateOne({ _id: u._id }, { $set: { "tokenWallet.addon": 100_000, "tokenWallet.plan": 0 } });

    const again = await seedReviewer(env);
    expect(again.plan + again.addon).toBe(1_000_000);
  });

  test("S2 目标是管理员时整句拒绝，且**什么都不改**", async () => {
    const env = envFor();
    await seedReviewer(env);
    const before = await User.findOne({ email: env.REVIEWER_EMAIL }).lean();
    await User.updateOne({ _id: before._id }, { $set: { role: "admin" } });

    await expect(seedReviewer({ ...env, REVIEWER_PASSWORD: "another-long-password" })).rejects.toThrow(/管理员/);

    const after = await User.findOne({ email: env.REVIEWER_EMAIL }).lean();
    expect(after.role).toBe("admin"); // 没被降权
    expect(after.passwordHash).toBe(before.passwordHash); // 密码没被换
  });

  test("S3 被封 / 已注销的账号，重跑能救回来", async () => {
    const env = envFor();
    const first = await seedReviewer(env);
    await User.updateOne(
      { _id: first.id },
      { $set: { banned: { at: new Date(), reason: "误封" }, deactivatedAt: new Date() } },
    );

    const fixed = await seedReviewer(env);
    expect(fixed.banned).toBe(false);
    expect(fixed.deactivated).toBe(false);

    // 判据走 `banned.at` 的 dot 路径：解封必须是**键没了**，不是 banned:null
    const doc = await User.findById(first.id).lean();
    expect(doc.banned).toBeUndefined();
    expect(doc.deactivatedAt).toBeNull();
  });

  test("S4 密码每次都被重置成传进来的那一个（Play Console 里那串必须是真的）", async () => {
    const env = envFor();
    await seedReviewer(env);
    const next = "second-password-long";
    const out = await seedReviewer({ ...env, REVIEWER_PASSWORD: next });

    const doc = await User.findById(out.id).select("+passwordHash").lean();
    expect(await bcrypt.compare(next, doc.passwordHash)).toBe(true);
    expect(await bcrypt.compare(env.REVIEWER_PASSWORD, doc.passwordHash)).toBe(false);
  });

  test("S4b 弱密码 / 缺参数 / 坏 token 数当场拒", async () => {
    await expect(seedReviewer(envFor({ REVIEWER_PASSWORD: "short" }))).rejects.toThrow(/至少 12 位/);
    await expect(seedReviewer(envFor({ REVIEWER_EMAIL: "" }))).rejects.toThrow(/REVIEWER_EMAIL/);
    await expect(seedReviewer(envFor({ REVIEWER_TOKENS: "-1" }))).rejects.toThrow(/正数/);
    await expect(seedReviewer(envFor({ REVIEWER_TOKENS: "把钱给我" }))).rejects.toThrow(/正数/);
  });

  test("S5 不预先同意用户协议 —— 协议前置那一屏正是要给审核员看的", async () => {
    const out = await seedReviewer(envFor());
    expect(out.termsAccepted).toBe(false);
    const doc = await User.findById(out.id).lean();
    expect(doc.termsAcceptedAt ?? null).toBeNull();
  });
});
