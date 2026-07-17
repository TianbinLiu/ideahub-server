// scripts/backfillPoints.js
// 给点数系统上线【之前】就存在的数据补齐新字段。幂等，可反复重跑。
//
//   npm run backfill:points
//
// ★为什么必须跑这个，而不是在代码里 (user.points ?? 1000) 兜底：
//   运行时兜底会让「余额」在 backfill 前后含义不同，而且和账本对不上 ——
//   写入侧是 {points:{$gte:X}} 的条件原子更新，缺字段的文档它根本匹配不到，
//   于是读出来显示 1000、一花就说「点数不足」。字段要么真的在库里，要么就不在。
//
// 做两件事：
//   1. User.points 缺失 → 补 1000（= SIGNUP_GRANT_POINTS）
//      ★不补 signup 分录：账本的对账式是 sum(所有 delta) === sum(signup 的 delta)，
//        老用户两边都不出现，等式照样成立。补了反而是无中生有一笔没发生过的赠送。
//   2. Bounty.escrowPoints 缺失 → 补 0
//      ★补 0 而不是 reward×slots：这些悬赏发布时【从来没有】从发布者账上扣过点数，
//        给它们凭空塞一笔托管就是凭空印钱。代价是这些老悬赏审批时会因「托管点数不足」被拒 ——
//        这是对的：平台确实没有为它们托管过任何点数。发布者可以编辑一次赏金来补上托管。
require("dotenv").config();
const mongoose = require("mongoose");
const { SIGNUP_GRANT_POINTS } = require("../src/config/points");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[backfillPoints] MONGO_URI 未设置");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const User = require("../src/models/User");
  const Bounty = require("../src/models/Bounty");

  // ★判据是【有没有 points 字段】而不是【有没有拿过赠送】—— 这里有个窗口：
  //   老用户若在 backfill 跑之前先作为猎人被入账，creditUser 的 $inc 会把 points 字段
  //   【创建】出来（= 入账金额），此后 {points:{$exists:false}} 再也匹配不到他，
  //   他那 1000 注册赠送就【永久丢失】。I1 抓不到（他的余额与自己的分录和仍然恒等），
  //   所以只能在这里挡。
  // 故：先按「缺字段」把老用户初始化为 0，再对【所有没有 signup 分录的用户】补发赠送
  //   —— 判据换成账本（signup 分录存在与否），它不会被 $inc 意外创建，也天然幂等。
  const init = await User.updateMany({ points: { $exists: false } }, { $set: { points: 0 } });
  console.log(`[backfillPoints] User.points 初始化为 0: matched=${init.matchedCount} modified=${init.modifiedCount}`);

  const PointsLedger = require("../src/models/PointsLedger");
  // 唯一索引（{user, reason:"signup"}）是注册赠送幂等的最后一道闸，先确保它真的建出来了，
  // 再去补发 —— 否则并发/重跑可能写出两条 signup（= 凭空印钱）。
  await PointsLedger.syncIndexes();

  const granted = await PointsLedger.distinct("user", { reason: "signup" });
  const grantedSet = new Set(granted.map(String));
  const allUsers = await User.find({}).select("_id").lean();
  const pending = allUsers.filter((u) => !grantedSet.has(String(u._id)));

  let ok = 0;
  for (const u of pending) {
    try {
      // 先写分录：唯一索引挡重复。写成功了才加余额 —— 反过来会「加了钱但分录没写」，账本对不上。
      await PointsLedger.create({
        user: u._id,
        delta: SIGNUP_GRANT_POINTS,
        reason: "signup",
        balanceAfter: null,
        memo: "backfill: 补发注册赠送",
      });
      const updated = await User.findOneAndUpdate(
        { _id: u._id },
        { $inc: { points: SIGNUP_GRANT_POINTS } },
        { new: true }
      ).select("points").lean();
      if (updated) {
        await PointsLedger.updateOne(
          { user: u._id, reason: "signup" },
          { $set: { balanceAfter: Number(updated.points) } }
        );
      }
      ok += 1;
    } catch (err) {
      if (err && err.code === 11000) continue; // 已有 signup 分录（并发/重跑）→ 跳过
      throw err;
    }
  }
  console.log(`[backfillPoints] 补发注册赠送: 候选=${pending.length} 实际补发=${ok}（已有 signup 分录的跳过）`);

  const bounties = await Bounty.updateMany({ escrowPoints: { $exists: false } }, { $set: { escrowPoints: 0 } });
  console.log(
    `[backfillPoints] Bounty.escrowPoints: matched=${bounties.matchedCount} modified=${bounties.modifiedCount}`
  );

  // 索引已在补发赠送【之前】同步过（必须先建索引再补发，否则并发/重跑可能写出两条 signup）
  await mongoose.disconnect();
  console.log("[backfillPoints] 完成（幂等，可重跑）");
}

main().catch(async (err) => {
  console.error("[backfillPoints] 失败:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
