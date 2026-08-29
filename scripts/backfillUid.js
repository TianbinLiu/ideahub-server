// scripts/backfillUid.js
// 给 UID 上线【之前】就存在的用户补公开数字 UID。幂等，可反复重跑。
//
//   npm run backfill:uid
//
// ★ 判据是「有没有 uid 字段」（$exists:false），与 phone/tokenWallet 同一套做法 ——
//   所以 User 模型里 uid 绝不能给 default（给了所有人都"有"，回填就找不到人了）。
// ★ 逐个 save 而不是批量 updateMany：生成要查重（utils/uid.js），而且走 save 会经过
//   pre-save 钩子之外的 schema 校验；量级是几十个用户，逐个完全无所谓。
require("dotenv").config();
const mongoose = require("mongoose");
const { generateUid } = require("../src/utils/uid");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI 未配置");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const User = require("../src/models/User");

  const missing = await User.find({ uid: { $exists: false } }).select("_id username");
  console.log(`缺 uid 的用户：${missing.length} 个`);

  let done = 0;
  for (const u of missing) {
    const uid = await generateUid(async (cand) => !!(await User.exists({ uid: cand })));
    // 条件更新防并发：这一刻如果别处（比如刚上线的 pre-save）已经给它补上了，就跳过
    const r = await User.updateOne({ _id: u._id, uid: { $exists: false } }, { $set: { uid } });
    if (r.modifiedCount === 1) {
      done += 1;
      console.log(`  ${u.username} -> ${uid}`);
    }
  }
  console.log(`补齐 ${done} 个；重跑应显示 0 个缺失。`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
