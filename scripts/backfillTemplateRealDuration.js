// scripts/backfillTemplateRealDuration.js
// 给白模模板补上 refVideo.realDurationSec（云端回执里的**真实时长**，小数）。
// 幂等、可反复重跑、带 --dry-run。
//
//   node scripts/backfillTemplateRealDuration.js --dry-run   # 只看表，不写库
//   node scripts/backfillTemplateRealDuration.js             # 真写
//
// ★★ 为什么必须回填（2026-08-16 事故的收尾）：
//   白模产出比输入短（实测 4.0s→3.712s），而当年 templateVideoMeta 对 duration 做了
//   `Math.round`，于是一段 3.712 秒的产物在库里写着 `durationSec: 4` ——
//   **光看那个数看不出坏**。线上 6 个模板有 3 个是这个状态（refVideo.durationSec=4，
//   真实 3.712s），作者反复试炼、反复撞方舟的英文 400，而我们这边一路绿灯。
//   回填之后，发布闸与套用闸（都读 BranchTemplate.refVideoSec = realDurationSec ?? durationSec）
//   才认得出它们，作者才会看到真正的原因。
//
// ★★ 明确**不做**的四件事（写在这里免得以后有人"顺手"加上）：
//   · 不改 durationSec —— 它是已发布模板的**计价锚点**，改了就是改报价（App 的报价镜像
//     读的是同一个数）。锚点与真实文件不等是设计如此（ceil，永远往"我们多收"那一侧偏）。
//   · 不删文档、不删云端资产 —— 东西静默消失，用户只会以为是我们弄丢了（铁律八）。
//   · 不改 status —— 那 3 条本来就卡在 pending，发布闸会用整句人话拦住它们。
//   · 不退费 —— 是不是补偿是产品决策，脚本不替产品做主。
//
// ★ Admin API 的 `media_metadata: true` **必须带**：它对视频默认只回 width/height/bytes，
//   **不回 duration**（2026-08-14 生产实测）。不带的话这个脚本会一条都填不上，且不报错。
require("dotenv").config();
const mongoose = require("mongoose");

const DRY = process.argv.includes("--dry-run");

/** 免费档 Admin API 是**全局** 500 次/小时，别把它一口气打光（那会让所有人建不了模板） */
const SLEEP_MS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[backfillRealDuration] MONGO_URI 未设置");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const BranchTemplate = require("../src/models/BranchTemplate");
  const { cloudinary } = require("../src/config/cloudinary");
  const { templateVideoMeta, TEMPLATE_REF_RULES, secText } = require("../src/middleware/upload");

  // ★ 幂等的判据是「**有没有这一位**」而不是「值对不对」：重跑不该再打一遍 Admin API。
  //   想强制重读就先把字段 unset 掉 —— 显式好过脚本自己猜。
  const docs = await BranchTemplate.find({
    "refVideo.cloudinaryPublicId": { $exists: true, $ne: "" },
    "refVideo.realDurationSec": { $exists: false },
  })
    .select("_id title status refVideo.cloudinaryPublicId refVideo.durationSec")
    .lean();

  console.log(`[backfillRealDuration] 待回填 ${docs.length} 条${DRY ? "（dry-run，不写库）" : ""}`);

  const rows = [];
  let filled = 0;
  let failed = 0;

  for (const d of docs) {
    const publicId = d.refVideo.cloudinaryPublicId;
    let real = null;
    try {
      const resource = await cloudinary.api.resource(publicId, { resource_type: "video", media_metadata: true });
      const meta = templateVideoMeta(resource);
      if (Number.isFinite(meta.duration) && meta.duration > 0) real = meta.duration;
    } catch (e) {
      // ★ 读不到不是"这条坏了"（资产可能早被回收），照实记一行、继续下一条 ——
      //   中途 throw 会让已经回填的那部分与没回填的混在一起，重跑还得从头猜
      console.error(`[backfillRealDuration] 读取失败 tpl=${d._id} public_id=${publicId}:`, e?.error?.message || e.message);
    }
    if (real === null) {
      failed += 1;
      rows.push({ id: String(d._id), title: d.title, status: d.status, 存的: d.refVideo.durationSec, 真实: "读不到", 坏: "?" });
      await sleep(SLEEP_MS);
      continue;
    }
    const bad = real < TEMPLATE_REF_RULES.minSec;
    rows.push({
      id: String(d._id),
      title: d.title,
      status: d.status,
      存的: d.refVideo.durationSec,
      真实: secText(real),
      坏: bad ? `是（< ${TEMPLATE_REF_RULES.minSec}s）` : "否",
    });
    if (!DRY) {
      await BranchTemplate.updateOne({ _id: d._id }, { $set: { "refVideo.realDurationSec": real } });
    }
    filled += 1;
    await sleep(SLEEP_MS);
  }

  console.table(rows);
  const badCount = rows.filter((r) => String(r.坏).startsWith("是")).length;
  console.log(
    `[backfillRealDuration] 完成：回填 ${filled} 条、读不到 ${failed} 条；其中**产物短于 ${TEMPLATE_REF_RULES.minSec} 秒**的有 ${badCount} 条` +
      `${DRY ? "（dry-run，一条都没写）" : ""}`,
  );
  if (badCount) {
    console.log(
      "[backfillRealDuration] 这几条的作者会在发布/套用时看到整句说明（是我们当时的校验漏掉了，不是他们操作错了）。" +
        "它们本来就发布不出去，回填只是让拒绝的**理由**指对方向。",
    );
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("[backfillRealDuration] 失败:", e);
  try {
    await mongoose.disconnect();
  } catch {
    /* 连接本来就没建起来 */
  }
  process.exit(1);
});
