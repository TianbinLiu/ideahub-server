// tests/backfillAssetUrls.spec.js
// 盯 scripts/backfillAssetUrls.js 里**唯一**那条会造成不可逆后果的判据：bulkWrite 的更新条件。
//
// ★★ 2026-09-08 合并前复核挖出来的：更新条件此前只有 `{ _id }`。这个脚本按设计是
//   「服务端在线、正在接写请求时」跑的（PR 要求"上线后立刻跑"），而它是
//   「游标读一批 → 攒够 500 条再 flush」—— 读与写之间那段窗口里，只要运行时给同一条作品
//   写过一次 assetUrls（改壳换封面 / 回炉），flush 就会用「读那一刻的旧正文」算出来的数组
//   把它整份覆盖。覆盖之后字段仍然存在，`countDocuments({assetUrls:{$exists:false}})` 照样是 0，
//   运维拿到的是一个**假的全绿**，而 assetInUseByOthers 的反查面已经缺了刚写进去的新地址 ——
//   别的作品被删除/回炉时查不到本条在用它，就会 destroy 掉：观众端裂图、零提示、不可逆。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let BranchVideo;
let buildOp;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  BranchVideo = require("../src/models/BranchVideo");
  ({ buildOp } = require("../scripts/backfillAssetUrls"));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const OLD = "https://res.cloudinary.com/demo/video/upload/v1/ideahub/branch-videos/u-old.mp4";
const NEW = "https://res.cloudinary.com/demo/video/upload/v1/ideahub/branch-videos/u-new.mp4";

async function makeVideo(extra = {}) {
  const doc = await BranchVideo.create({
    title: "回填用例",
    author: new mongoose.Types.ObjectId(),
    segments: [{ title: "一段", videoUrl: OLD, durationSec: 5 }],
    ...extra,
  });
  // 造出「存量作品」：把 assetUrls 这个字段整个去掉（模型有默认值，得显式 unset）
  await BranchVideo.collection.updateOne({ _id: doc._id }, { $unset: { assetUrls: "" } });
  return doc._id;
}

test("默认档：读到写之间运行时写过 assetUrls 的，回填不许覆盖它", async () => {
  const id = await makeVideo();
  // ① 脚本的游标读到的是「还没有 assetUrls」的那一份
  const readSnapshot = await BranchVideo.findById(id).select("_id cover segments branchTree assetUrls").lean();
  expect(readSnapshot.assetUrls).toBeUndefined();

  // ② 读与写之间，运行时（改壳换封面 / 回炉）给它写了新的一份
  await BranchVideo.updateOne({ _id: id }, { $set: { assetUrls: [NEW], "segments.0.videoUrl": NEW } });

  // ③ 脚本 flush：用 ① 那一刻的旧正文算出来的数组去写
  const res = await BranchVideo.bulkWrite([buildOp(readSnapshot, false)], { ordered: false });
  expect(res.modifiedCount).toBe(0); // 条件里带了 $exists:false，这一条根本不该被改到

  const after = await BranchVideo.findById(id).lean();
  expect(after.assetUrls).toEqual([NEW]); // 运行时那份还在
  expect(after.assetUrls).not.toContain(OLD); // 没被旧正文覆盖
});

test("默认档：真正的存量作品（没有 assetUrls）照常被补上", async () => {
  const id = await makeVideo();
  const snapshot = await BranchVideo.findById(id).select("_id cover segments branchTree assetUrls").lean();
  const res = await BranchVideo.bulkWrite([buildOp(snapshot, false)], { ordered: false });
  expect(res.modifiedCount).toBe(1);
  const after = await BranchVideo.findById(id).lean();
  expect(after.assetUrls).toContain(OLD);
});

test("默认档幂等：同一条再跑一遍不会再写（已经有字段了）", async () => {
  const id = await makeVideo();
  const snapshot = await BranchVideo.findById(id).select("_id cover segments branchTree assetUrls").lean();
  await BranchVideo.bulkWrite([buildOp(snapshot, false)], { ordered: false });
  const again = await BranchVideo.bulkWrite([buildOp(snapshot, false)], { ordered: false });
  expect(again.modifiedCount).toBe(0);
});

test("--all 档：语义就是整份重算，条件里只有 _id（所以它只许在停写窗口跑）", async () => {
  const id = await makeVideo();
  await BranchVideo.updateOne({ _id: id }, { $set: { assetUrls: ["https://example.com/stale.mp4"] } });
  const snapshot = await BranchVideo.findById(id).select("_id cover segments branchTree assetUrls").lean();
  const res = await BranchVideo.bulkWrite([buildOp(snapshot, true)], { ordered: false });
  expect(res.modifiedCount).toBe(1);
  const after = await BranchVideo.findById(id).lean();
  expect(after.assetUrls).toEqual([OLD]);
});
