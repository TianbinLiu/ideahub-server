// scripts/backfillAssetUrls.js
// 给存量 BranchVideo 回填 `assetUrls`（= utils/branchAssetRefs.assetUrlsOfVideo(doc)）。
//
// ★★ **必须在服务端上线之后、App 发版之前跑完**，并确认
//   `db.branchvideos.countDocuments({ assetUrls: { $exists: false } }) === 0`。
//   漏了这一步的后果不是"功能不好用"，而是：`assetInUseByOthers` 查的就是这个字段，
//   没回填过的老作品在反查里**查不到** ⇒ 删掉/回炉一条新作品时，会 destroy 掉一条
//   老互动作品的分支段还在引用的资产 ⇒ 老作品当场黑屏，观众端零提示、不可逆。
//
// 用法：node scripts/backfillAssetUrls.js  [--dry]
//   --dry 只统计不写库。
//
// ★ 幂等：反复跑没有副作用（每次都是按当下正文重算一遍整份数组）。
// ★ 默认**只补缺失的那些**（`assetUrls: { $exists: false }`）；`--all` 会重算全部
//   （给"改过 branchAssetRefs 的枚举字段"之后用）。
require("dotenv").config();
const mongoose = require("mongoose");
const BranchVideo = require("../src/models/BranchVideo");
const { assetUrlsOfVideo } = require("../src/utils/branchAssetRefs");

/** 一批多少条提交一次。★ 500 是 bulkWrite 的常用批量，再大只是把一次失败的代价拉高。 */
const BATCH = 500;

async function main() {
  const dry = process.argv.includes("--dry");
  const all = process.argv.includes("--all");
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[backfill] 缺少 MONGO_URI");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const filter = all ? {} : { assetUrls: { $exists: false } };
  const total = await BranchVideo.countDocuments(filter);
  console.log(`[backfill] 待处理 ${total} 条（${all ? "全量重算" : "只补缺失"}${dry ? "，dry-run" : ""}）`);

  // ★ 按 _id 升序游标遍历，不用 skip/limit：skip 在几十万条上是 O(n²)，
  //   而且中途有写入时会漏条（游标不会）。
  const cursor = BranchVideo.find(filter)
    .select("_id cover segments branchTree")
    .sort({ _id: 1 })
    .lean()
    .cursor();

  let ops = [];
  let done = 0;
  const flush = async () => {
    if (!ops.length) return;
    if (!dry) await BranchVideo.bulkWrite(ops, { ordered: false });
    done += ops.length;
    ops = [];
    console.log(`[backfill] 已处理 ${done}/${total}`);
  };

  for await (const doc of cursor) {
    ops.push({
      updateOne: { filter: { _id: doc._id }, update: { $set: { assetUrls: assetUrlsOfVideo(doc) } } },
    });
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  const left = await BranchVideo.countDocuments({ assetUrls: { $exists: false } });
  console.log(`[backfill] 完成。仍缺 assetUrls 的作品：${left}（上线前必须是 0）`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  // ★ 不许静默退出：这个脚本没跑成功而没人发现，正是上面那条 ★★ 描述的事故的起点
  console.error("[backfill] 失败:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* 断开失败无所谓，进程马上就退了 */
  }
  process.exit(1);
});
