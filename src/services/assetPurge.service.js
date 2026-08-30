// 「还欠着的云端资产」清扫器 —— PendingAssetPurge 的**唯一读方**。
//
// ★★ 为什么必须有它：`purgeVideo` 删作品时会把资产句柄先落进 PendingAssetPurge、
//   再逐条 `uploader.destroy`，失败的留在表里。但在这之前**没有任何东西会再去看那张表**
//   （2026-08-30 发版前复核抓到：写方唯一、读方为零）—— Cloudinary 抖一下，
//   那份成片就**永久留在公网**，而 App 的删除确认卡无条件承诺「云端存的视频与封面
//   也会一并删除」。删除是用户的隐私诉求，这句话必须是真的。
//
// ★ 用**惰性扫**而不是常驻 setInterval（照 middleware/rateLimit 的成方）：
//   ① 生产是 pm2 cluster 双实例，常驻定时器会两边同时跑；
//   ② 这活没有实时性要求 —— 晚几分钟删干净完全可以接受，"删不掉"才不行。
//   驱动点挂在删除路径自己身上（每次 purge 顺手带一轮），所以有删除就有清扫。
//
// ★ 每轮只处理少量、且**失败要退避**：Cloudinary 挂着的时候，一轮 500 条重试只会
//   把它捶得更死，而且会拖慢用户那次删除请求。
const { cloudinary } = require("../config/cloudinary");
const PendingAssetPurge = require("../models/PendingAssetPurge");

/** 一轮最多处理几条。小是有意的：它搭在用户请求的车上跑，不能拖慢那次删除 */
const BATCH = 5;
/** 试过这么多次还不成的，先放着（留在表里，等下一次退避窗口）—— 但**绝不删行** */
const MAX_ATTEMPTS = 8;
/** 第 n 次重试至少要等多久（毫秒）：指数退避，封顶 6 小时 */
function backoffMs(attempts) {
  return Math.min(6 * 60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1));
}

let sweeping = false;

/**
 * 扫一轮欠账。**永不抛**：它是搭车跑的，把调用方的请求带崩是最坏结果。
 * @returns {Promise<{tried:number, done:number}>}
 */
async function sweepPendingPurges() {
  if (sweeping) return { tried: 0, done: 0 }; // 同实例内不并发，省得一条被两处同时 destroy
  sweeping = true;
  let tried = 0;
  let done = 0;
  try {
    const now = Date.now();
    const rows = await PendingAssetPurge.find({ attempts: { $lt: MAX_ATTEMPTS } })
      .sort({ updatedAt: 1 }) // 最久没试过的排前面
      .limit(BATCH * 3) // 多取一些，下面按退避窗口过滤
      .lean();

    for (const row of rows) {
      if (done + tried >= BATCH) break;
      // 退避：还没到下一次该试的时间就跳过（updatedAt 就是上一次尝试的时刻）
      const since = now - new Date(row.updatedAt || 0).getTime();
      if (row.attempts > 0 && since < backoffMs(row.attempts)) continue;
      tried += 1;
      try {
        await cloudinary.uploader.destroy(row.publicId, {
          resource_type: row.resourceType,
          invalidate: true,
        });
        await PendingAssetPurge.deleteOne({ _id: row._id });
        done += 1;
      } catch (err) {
        await PendingAssetPurge.updateOne(
          { _id: row._id },
          { $inc: { attempts: 1 }, $set: { lastError: String(err?.message || err).slice(0, 500) } }
        ).catch(() => {});
      }
    }
  } catch (err) {
    // 连查询都失败（DB 抖了）：这一轮放弃，下次再说。绝不让它影响调用方
    console.warn("[asset-purge] 清扫失败:", err?.message || err);
  } finally {
    sweeping = false;
  }
  return { tried, done };
}

/**
 * 还欠着多少（监控用）。★ `attempts >= MAX_ATTEMPTS` 的那些**也算**：
 * 它们才是真正需要有人去看一眼的 —— 不算进来就等于把问题藏起来了。
 */
async function pendingPurgeCount() {
  return PendingAssetPurge.estimatedDocumentCount();
}

module.exports = { sweepPendingPurges, pendingPurgeCount, MAX_ATTEMPTS, backoffMs };
