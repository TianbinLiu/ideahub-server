// scripts/backfillAssetUrls.js
// 给存量 BranchVideo 回填 `assetUrls`（= utils/branchAssetRefs.assetUrlsOfVideo(doc)）。
//
// ★★ **必须在服务端上线之后、App 发版之前跑完**，并确认
//   `db.branchvideos.countDocuments({ assetUrls: { $exists: false } }) === 0`。
//   漏了这一步的后果不是"功能不好用"，而是：`assetInUseByOthers` 查的就是这个字段，
//   没回填过的老作品在反查里**查不到** ⇒ 删掉/回炉一条新作品时，会 destroy 掉一条
//   老互动作品的分支段还在引用的资产 ⇒ 老作品当场黑屏，观众端零提示、不可逆。
//
// 用法：node scripts/backfillAssetUrls.js  [--dry|--all|--verify]
//   --dry    只统计不写库。
//   --all    全量重算（改过 branchAssetRefs 的枚举字段之后用）。
//            ⚠ 它没法用「更新条件带上 $exists:false」那招收口（语义就是覆盖），
//              所以 **--all 只许在停写窗口跑**，别在线上边接请求边跑。
//   --verify 只比对不写库：逐条比 stored 与按正文现算的集合是否相等，报对不上的条数与 _id。
//            ★ 回填跑完**应当再跑一次 --verify**：`$exists` 那个 0 只证明字段都有了。
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

/**
 * 一条 bulkWrite op（**唯一实现**，脚本与 tests/backfillAssetUrls.spec.js 共用）。
 *
 * ★★ 更新条件里**必须**带上查询侧那个 `assetUrls: { $exists: false }`（2026-09-08 复核挖出）。
 *   这个脚本是「游标读一批 → 攒够 500 条再 flush」，读与写之间隔着一个可观的窗口，
 *   而它按设计就是**服务端在线、正在接写请求时**跑的。只按 `_id` 定位的话，这期间运行时
 *   给同一条作品写过的 assetUrls（改壳换封面 / 回炉）会被「读那一刻的旧正文」算出来的数组
 *   整份覆盖 —— 覆盖之后字段仍然存在，`countDocuments({assetUrls:{$exists:false}})` 照样是 0，
 *   运维拿到一个**假的全绿**，而 assetInUseByOthers 的反查面已经缺了刚写进去的新地址
 *   （删一条打死另一条，正是这整套东西要防的那个事故）。
 * ⚠ `--all` 语义就是整份重算，没法用这招收口 ⇒ 它只许在停写窗口跑。
 */
function buildOp(doc, all) {
  return {
    updateOne: {
      filter: all ? { _id: doc._id } : { _id: doc._id, assetUrls: { $exists: false } },
      update: { $set: { assetUrls: assetUrlsOfVideo(doc) } },
    },
  };
}

async function main() {
  const dry = process.argv.includes("--dry");
  const all = process.argv.includes("--all");
  // ★ --verify：只比对不写库。`countDocuments({assetUrls:{$exists:false}}) === 0` 只能证明
  //   「字段都有了」，证明不了「字段是对的」—— 能签字的是这个数。
  const verify = process.argv.includes("--verify");
  const bad = [];
  let checked = 0;
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[backfill] 缺少 MONGO_URI");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const filter = all || verify ? {} : { assetUrls: { $exists: false } };
  const total = await BranchVideo.countDocuments(filter);
  console.log(`[backfill] 待处理 ${total} 条（${all ? "全量重算" : "只补缺失"}${dry ? "，dry-run" : ""}）`);

  // ★ 按 _id 升序游标遍历，不用 skip/limit：skip 在几十万条上是 O(n²)，
  //   而且中途有写入时会漏条（游标不会）。
  const cursor = BranchVideo.find(filter)
    .select("_id cover segments branchTree assetUrls")
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
    // ★ dry 时说清一个字都没写：这份脚本是要在生产终端上照着念的
    console.log(`[backfill] ${dry ? "（dry，未写库）已算过" : "已处理"} ${done}/${total}`);
  };

  for await (const doc of cursor) {
    if (verify) {
      const stored = Array.isArray(doc.assetUrls) ? doc.assetUrls : null;
      const want = assetUrlsOfVideo(doc);
      if (!stored || stored.length !== want.length || want.some((u) => !stored.includes(u))) {
        bad.push(String(doc._id));
      }
      checked += 1;
      continue;
    }
    ops.push(buildOp(doc, all));
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  if (verify) {
    console.log(`[backfill] 校验完成：比对 ${checked} 条，与正文对不上的 ${bad.length} 条`);
    if (bad.length) console.log(`[backfill] 对不上的 _id（最多列 20 条）：${bad.slice(0, 20).join(", ")}`);
    await mongoose.disconnect();
    return;
  }
  const left = await BranchVideo.countDocuments({ assetUrls: { $exists: false } });
  console.log(`[backfill] 完成。仍缺 assetUrls 的作品：${left}（上线前必须是 0）`);
  console.log("[backfill] ★ 再跑一次 `node scripts/backfillAssetUrls.js --verify` 确认「字段是对的」——");
  console.log("[backfill]   上面那个 0 只证明「字段都有了」，证明不了内容正确。");
  await mongoose.disconnect();
}

// ★ 被 require 进来时不自动跑（tests 只要 buildOp 那一份判据）
if (require.main !== module) {
  module.exports = { buildOp };
} else
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
