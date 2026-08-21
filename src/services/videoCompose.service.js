// src/services/videoCompose.service.js
// 「把 N 段成片拼成一条」的执行层：受理 → 去重 → 后台生成 → **自检** → 落成独立资产。
//
// 为什么是后台任务而不是同步应答（与 arkTransfer 同一课）：一次合并实测 3~17 秒
// （25 秒成片 16.6s、10 秒成片 6.6s），弱网手机上让客户端在线等这一趟，
// 重演的就是 2026-08-21 那次「180s 超时→静默失败→下游全坏」。客户端只受理+轮询。
//
// ══ 这一层最要紧的一件事：产物自检 ══
// 拼接的三个静默陷阱（见 utils/videoCompose 文件头）全都表现为「200 + 无错误头 + 产物
// 是另一个东西」。所以产物落地后必须拿**权威时长**与期望值比对，对不上一律判失败 ——
// 交出一条"看着像成片"的东西，比直接失败坏得多（铁律八）。
// 权威时长从哪来：拼接规则作为**入站变换**随上传请求发出，Cloudinary 直接把结果存成一份
// 独立资产，回执里就带着 duration/width/height/bytes（2026-08-21 实测：一次调用 4.9 秒，
// 回执 duration 5.708 对期望 5.68）。
//
// ★ 为什么要"落成独立资产"而不是把拼接 URL 直接交给客户端：
//   拼接产物本质是**第 1 段的派生资源** —— 第 1 段一旦被删/被回收，成片跟着死。
//   而成片是要发布、要被别人刷到的东西，生命周期不能挂在某一段素材上。
//   顺带还解决三件事：拿到权威时长做自检、URL 短且干净、发布链路原样沿用（非方舟域的
//   http(s) 地址 branchVideo 的 transferVideo 会原样保留，不再多搬一次）。
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const VideoCompose = require("../models/VideoCompose");
const { cloudinary } = require("../config/cloudinary");
const {
  BRANCH_VIDEO_FOLDER,
  buildComposeTransform,
  buildSourceUrl,
  expectedDurationSec,
} = require("../utils/videoCompose");

/** 让 Cloudinary 抓取并落地的超时。实测 25 秒成片约 17 秒生成 + 抓取，300s 是给
 *  "又长又赶上高峰"留的余量 —— 后台任务没人在线上等，宁可慢慢做成。 */
const MATERIALIZE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS || 300_000);

/** pending 多久没动静算僵尸（认领它的进程死在半路）——可被重新认领。
 *  ★ 从单趟超时推出来，不写死：MATERIALIZE_TIMEOUT_MS 可以用环境变量调大，而僵尸线一旦
 *    比它短，就会把**还在跑**的任务判死并重开一发（白花一份配额，还可能两份产物互相覆盖）。 */
const STALE_PENDING_MS = MATERIALIZE_TIMEOUT_MS * 2;

/** 单实例并发上限。每一发都在 Cloudinary 侧真跑编码、也占我们一条出网连接；
 *  合并不赶时间，排队比把配额和连接一起打满强。 */
const MAX_CONCURRENT = 2;

/**
 * 每人每天能拼出多少秒成片 —— **花钱的闸门，限流挡不住它**。
 *
 * ★★ 为什么单有限流不够：限流管的是**次数**，而 Cloudinary 按**输出秒数**计费
 *   （2026-08-21 实测 ≈0.0013 credits/输出秒）。6 次/分 × 每条最长 300 秒 = 1800 秒/分钟
 *   ≈ 2.3 credits/分钟，而免费版整月只有 25 credits（还要和存储、带宽共用）——
 *   一个账号十来分钟就能把全站的配额抽干，而超配额的终局是**账号被自动停用**（官方说法），
 *   不是降级。那正是这个项目最怕的形状：没有任何报错，某天全站的图和视频一起打不开。
 * ★ 900 秒 = 15 分钟成片/人/天，对真人用户绰绰有余（一条作品也就一两分钟），
 *   对刷子则是 ~1.2 credits/天的硬顶。
 * ★ 算的是**受理过的**秒数（含失败与重试），不是"成功产出"：失败的那一发同样在
 *   Cloudinary 侧跑过编码、同样花过钱。按成功算等于给"故意跑失败"开了一个免费口子。
 */
const DAILY_OUTPUT_SEC_BUDGET = Number(process.env.COMPOSE_DAILY_SEC || 900);

/**
 * 时长自检的容差。
 * ★ 不能太松：陷阱的信号就藏在时长里（画中画 = 只有基片那么长、裁剪被忽略 = 比期望长），
 *   松到几秒就等于把自检关了。
 * ★ 也不能太紧：Cloudinary 按关键帧/帧率对齐，实测 10 秒期望得 10.046、2×5.042 得 10.083，
 *   偏差都在 0.1 秒量级；每段各带一点对齐误差，所以按段数放宽。
 */
function durationTolerance(clipCount) {
  return 0.35 + 0.12 * clipCount;
}

let running = 0;
const queue = [];
const inflight = new Set();

/** 配方指纹：同一份配方 = 同一条任务（连点两次合并不会跑两遍、不会烧两份配额） */
function recipeKey(userId, recipe) {
  const canon = JSON.stringify({
    u: String(userId),
    c: recipe.clips.map((c) => [c.publicId, Math.round(c.startSec * 1000), Math.round(c.endSec * 1000)]),
    w: recipe.width,
    h: recipe.height,
    q: recipe.quality,
    b: recipe.bgm ? [recipe.bgm.publicId, recipe.bgm.volume, !!recipe.bgm.replace] : null,
  });
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const { task, resolve, reject } = queue.shift();
    running += 1;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

function schedule(key, userId, recipe) {
  const p = enqueue(() => runCompose(key, userId, recipe)).catch((e) => {
    console.error(`[compose] 未捕获的合并异常 ${key}:`, (e && e.message) || e);
  });
  inflight.add(p);
  p.finally(() => inflight.delete(p));
}

/**
 * 结果（含失败）**必须**落库：落不下去客户端会一直看到 pending 干等（比报错更坏）。
 *
 * ★★ 只从 pending 迁出（与 arkTransfer.runTransfer 的守卫同款，那边的注释写的是同一件事）：
 *   僵尸重认领会让同一个 key 有两个 runner，晚到的那个不许把另一趟刚写的终态打翻 ——
 *   否则库里会出现 state=failed 却留着别人的 url，用户被告知失败，而那条成片没人认领、
 *   照样按存储计费（TTL 回收的是**库里那行**，不是 Cloudinary 上的资产）。
 * @returns {Promise<boolean>} 这次终态是不是自己写上的
 */
async function settle(key, patch) {
  const r = await VideoCompose.updateOne({ key, state: "pending" }, { $set: patch }).catch((e) => {
    console.error(`[compose] 状态落库失败 ${key}:`, e.message);
    return null;
  });
  return !!(r && r.matchedCount);
}

/**
 * 真跑一趟：拼变换 → 让 Cloudinary 抓取落地 → 自检 → 落库。
 * 任何一步失败都写 failed + 整句中文原因（客户端原样显示，所以话要说得能行动）。
 */
async function runCompose(key, userId, recipe) {
  const expected = expectedDurationSec(recipe.clips);
  let transform;
  try {
    // ★ 起跑打一次心跳：僵尸判据看的是 updatedAt，而受理与真正起跑之间还隔着并发队列
    //   （MAX_CONCURRENT=2）。不打的话，排队久了的**活**任务会被判成死的、再跑一遍。
    await VideoCompose.updateOne({ key, state: "pending" }, { $set: { startedAt: new Date() } }).catch(() => {});
    transform = buildComposeTransform(recipe);
    const source = buildSourceUrl(recipe.clips[0].publicId);
    if (!source) throw new Error("这台服务器没有配置云存储（CLOUDINARY_*），合并功能不可用");

    // ★ 源 = 第 1 段的原始地址，拼接规则作为**入站变换**随这次（已签名的）上传请求发出。
    //   理由全在 utils/videoCompose.buildSourceUrl 的注释上 —— 一句话：这是三种做法里
    //   唯一既不产生派生垃圾、又保证存下来是常规 MP4（不是播放器读不出时长的分片容器）的。
    // ★ 名字里必须带**配方指纹**。只有 `<userId>-<毫秒>` 的话，同一个人并发的两发
    //   （不同配方 = 不同任务，指纹去重管不着，而 MAX_CONCURRENT=2 明确允许两发同时在跑）
    //   会在同一毫秒算出**同一个** public_id，而上传默认 overwrite —— 后一发把前一发的成片
    //   静默换掉：两条记录都还是 done（各自的自检只对自己的回执），用户发布出去的是另一条片子。
    const publicId = `${userId}-${Date.now()}-${key.slice(0, 8)}-merged`;
    const receipt = await cloudinary.uploader.upload(source, {
      resource_type: "video",
      folder: BRANCH_VIDEO_FOLDER,
      public_id: publicId,
      raw_transformation: transform,
      // ★ 打标：登记行 48h 后就被 TTL 回收了，届时这些成片在 Cloudinary 上再没有任何把手。
      //   带上 tag，将来要盘点/回收"没被任何作品引用的成片"时才找得到它们。
      tags: ["ideahub-merged"],
      timeout: MATERIALIZE_TIMEOUT_MS,
    });

    const actual = Number(receipt.duration);
    const tol = durationTolerance(recipe.clips.length);
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
      // ★★ 这就是防静默失败那道闸真正合上的地方。走到这里说明拼接的形状出了问题
      //   （图层被当成画中画 / 某一段的裁剪被忽略），产物是"另一件商品"——
      //   宁可整单失败也不能交出去。产物已经落地，顺手删掉，别留一个没人认领的资产。
      await cloudinary.uploader
        .destroy(receipt.public_id, { resource_type: "video" })
        .catch(() => {});
      await settle(key, {
        state: "failed",
        expectedSec: expected,
        actualSec: Number.isFinite(actual) ? actual : null,
        transform,
        url: null,
        publicId: null,
        error: `合并结果时长不对（应约 ${expected.toFixed(1)} 秒，实得 ${Number.isFinite(actual) ? actual.toFixed(1) : "未知"} 秒），已丢弃——请重试；若反复出现请反馈给我们`,
      });
      console.error(`[compose] 时长自检未过 ${key}: 期望 ${expected} 实得 ${actual} 变换=${transform.slice(0, 300)}`);
      return;
    }
    // BGM 要了却没音轨：同样是"看着像成片、其实缺东西"，但它不该毁掉整条成片 ——
    // 画面是对的、时长是对的，只是配乐没上。吼出来并把成片交出去（铁律八：响亮但局部）。
    if (recipe.bgm && !receipt.audio) {
      console.warn(`[compose] ${key} 要了 BGM 但产物没有音轨（变换=${transform.slice(0, 200)}）`);
    }

    const landed = await settle(key, {
      state: "done",
      url: receipt.secure_url,
      publicId: receipt.public_id,
      expectedSec: expected,
      actualSec: actual,
      transform,
      error: null,
    });
    if (!landed) {
      // 另一趟（僵尸重认领）已经把这条写成终态了：我这份产物没有任何地方会引用它，
      // 留着就是一条永远没人回收、却一直按存储计费的孤儿资产
      console.warn(`[compose] ${key} 终态已被另一趟写过，销毁本趟产物 ${receipt.public_id}`);
      await cloudinary.uploader.destroy(receipt.public_id, { resource_type: "video" }).catch(() => {});
      return;
    }
    console.log(`[compose] done ${key} → ${String(receipt.secure_url).slice(-70)} ${actual}s ${(receipt.bytes / 1e6).toFixed(1)}MB`);
  } catch (e) {
    // Cloudinary 的错误对象把原因塞在 e.error.message 里；只取 e.message 会得到一句 "Error"
    const raw = (e && (e.error?.message || e.message)) || String(e);
    console.warn(`[compose] failed ${key}: ${raw}`);
    await settle(key, {
      state: "failed",
      expectedSec: expected,
      transform: transform || null,
      error: `合并失败：${String(raw).slice(0, 200)}`,
    });
  }
}

/** 三态 → 交给客户端的形状（一处实现，路由与轮询都用它） */
function publicView(job) {
  if (!job) return { state: "none" };
  if (job.state === "done") return { jobId: job.key, state: "done", url: job.url };
  if (job.state === "failed") return { jobId: job.key, state: "failed", message: job.error || "合并失败" };
  return { jobId: job.key, state: "pending" };
}

/**
 * 「这条 pending 是不是僵尸」—— **判据只有这一处**（铁律六）。
 * 受理侧（要不要重新开跑）与轮询侧（要不要判它死了）问的必须是同一个函数：
 * 分家的话会出现"轮询说还在跑、再点一次却重开了一发"这种自相矛盾。
 * ★ 阈值从 MATERIALIZE_TIMEOUT_MS 推出来而不是写死：那个数可以用环境变量调，
 *   写死的僵尸线一旦比它短，就会把**还活着**的任务判死并重跑一遍（白花一份配额）。
 */
function isStale(job) {
  return job.state === "pending" && Date.now() - new Date(job.updatedAt).getTime() > STALE_PENDING_MS;
}

/**
 * 滚动 24 小时内这个人**预约掉**的产出秒数。
 * ★ 求和用 `max(spentSec, expectedSec)`：spentSec 是"这份配方真跑过几趟"的累计
 *   （受理一次 + 每次复活/僵尸重认领各再加一份）；老行没有这一位时退回 expectedSec，
 *   至少不会白算成 0。**不能用 $ifNull**：mongoose 的 `default: 0` 会让新行拿到 0 而不是 null。
 */
async function spentSec24h(userId, upToId = null) {
  const match = {
    userId: new mongoose.Types.ObjectId(String(userId)),
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  };
  // upToId：并发受理时只算"排在我前面（含我自己）"的那些 —— 靠 _id 定序，
  // 一批并发里正好保留装得下的那个前缀，而不是要么全放要么全拒
  if (upToId) match._id = { $lte: upToId };
  const r = await VideoCompose.aggregate([{ $match: match }, { $group: { _id: null, sec: { $sum: { $max: ["$spentSec", "$expectedSec"] } } } }]);
  return (r[0] && r[0].sec) || 0;
}

function deniedView(spent) {
  return {
    state: "denied",
    // ★ 说"最近 24 小时"而不是"今天/明天"：窗口是**滚动**的，说"明天再来"会让人白等到第二天
    //   却发现还是不行（额度是随着那一发满 24 小时才一点点回来的）。
    message: `最近 24 小时的合并额度用完了（每 24 小时最多合成 ${Math.round(DAILY_OUTPUT_SEC_BUDGET / 60)} 分钟成片，已用 ${Math.round(spent / 60)} 分钟）——过一阵再试，或先把已经合好的发布掉`,
  };
}

/**
 * 受理一份配方：没跑过就认领并后台开跑；跑过就把现成结果给回去。
 * ★ failed 会**复活重试**：合并失败往往是一次性的（上游抖动/生成超时），
 *   而用户主动再点一次合并就是明确的重试意图（同 arkTransfer.requestTransfer 的取舍）。
 *
 * ★★ 预算是**先预约再核账**（不是先查后写）：
 *   查完再写中间隔着三个 await，并发的几发各读各的旧值，实测 6 发并行能放进 1799.99 秒
 *   （上限 900）。现在的顺序是"先把这一趟记进账（create 或 $inc），再回头核对排在自己
 *   前面的总和"，超了就**回滚**。多花的那一次数据库往返换的是"额度真的是额度"。
 * ★★ 复活与僵尸重认领**同样要计费**：它们都会在 Cloudinary 上真跑一趟编码。
 *   只按登记行数算的话，一份稳定失败的配方可以被无限重试（复审实测：6 次真编码、
 *   预算只记 1 份），花钱的闸门等于不存在。
 */
async function requestCompose(userId, recipe) {
  const key = recipeKey(userId, recipe);
  const want = expectedDurationSec(recipe.clips);

  /** 预约之后核账；装不下就把预约退掉（回滚交给调用方，因为三条路退法不同） */
  async function overBudget(docId) {
    const spent = await spentSec24h(userId, docId);
    return spent > DAILY_OUTPUT_SEC_BUDGET ? spent : 0;
  }

  // ① failed → 复活重试（先把这一趟计进账）
  const revived = await VideoCompose.findOneAndUpdate(
    { key, state: "failed" },
    { $set: { state: "pending", error: null, url: null, publicId: null }, $inc: { spentSec: want } },
    { returnDocument: "after" },
  ).lean();
  if (revived) {
    const over = await overBudget(revived._id);
    if (over) {
      // 退回预约并恢复失败态：这一发没被受理，不该占额度，也不该看起来像在跑
      await VideoCompose.updateOne(
        { key, state: "pending" },
        { $set: { state: "failed", error: revived.error }, $inc: { spentSec: -want } },
      );
      return deniedView(over - want);
    }
    schedule(key, userId, recipe);
    return publicView(revived);
  }

  // ② 已有记录：done 直接给结果；pending 看是不是僵尸
  const found = await VideoCompose.findOne({ key }).lean();
  if (found) {
    if (isStale(found)) {
      // 僵尸认领：按 updatedAt 原子抢（两个实例同时抢，只有一个改得动），同样计一份账
      const claimed = await VideoCompose.findOneAndUpdate(
        { key, state: "pending", updatedAt: found.updatedAt },
        { $set: { error: null }, $inc: { spentSec: want } }, // timestamps 顺手刷新 updatedAt = 新的认领时刻
        { returnDocument: "after" },
      ).lean();
      if (claimed) {
        const over = await overBudget(claimed._id);
        if (over) {
          await VideoCompose.updateOne({ key }, { $inc: { spentSec: -want } });
          return deniedView(over - want);
        }
        schedule(key, userId, recipe);
        return publicView(claimed);
      }
    }
    return publicView(found);
  }

  // ③ 全新配方：先登记（= 预约），再核账，装不下就删掉这行
  try {
    const doc = await VideoCompose.create({ key, userId, state: "pending", expectedSec: want, spentSec: want });
    const over = await overBudget(doc._id);
    if (over) {
      await VideoCompose.deleteOne({ _id: doc._id });
      return deniedView(over - want);
    }
    schedule(key, userId, recipe);
    return publicView(doc.toObject());
  } catch (e) {
    if (e && e.code === 11000) {
      // 并发的另一个请求刚认领：读它的就是
      const again = await VideoCompose.findOne({ key }).lean();
      if (again) return publicView(again);
    }
    throw e;
  }
}

/**
 * 查进展。**必须带 userId**：jobId 是配方指纹，虽然含 userId 但仍是可猜测的字符串，
 * 不按人过滤就等于谁猜中谁就能看到别人的成片地址。
 *
 * ★★ 轮询路径要**自愈**：进程被 kill（优雅退出不等后台任务）或实例中途没了，登记行会
 *   永远停在 pending —— 而客户端只会一直转圈，直到 48h TTL 把那行删掉、变成一句
 *   「没有这个合并任务」。僵尸在这里翻成 failed，用户至少知道该重试（铁律八）。
 *   判据与受理侧共用 isStale（阈值 > 单趟超时，所以不会误伤还在跑的那一发）。
 */
async function statusOf(userId, jobId) {
  const key = String(jobId || "").slice(0, 64);
  const job = await VideoCompose.findOne({ key, userId }).lean();
  if (job && isStale(job)) {
    const msg = "合并没能跑完（服务重启或任务中断）——再点一次合并会重新开始";
    // 只从 pending 迁出：万一那一发其实刚写完 done，这次更新就该落空
    const r = await VideoCompose.updateOne({ key, state: "pending" }, { $set: { state: "failed", error: msg, url: null, publicId: null } });
    if (r.matchedCount) {
      console.warn(`[compose] 僵尸任务判失败 ${key}（pending 超过 ${Math.round(STALE_PENDING_MS / 1000)}s 没动静）`);
      return { jobId: key, state: "failed", message: msg };
    }
    return publicView(await VideoCompose.findOne({ key, userId }).lean());
  }
  return publicView(job);
}

/** 等所有在途任务收尾（测试断言最终状态用；生产请求路径不调它） */
async function idle() {
  while (inflight.size > 0 || queue.length > 0) {
    await Promise.allSettled([...inflight]);
    if (queue.length > 0) await new Promise((r) => setTimeout(r, 20));
  }
}

module.exports = {
  STALE_PENDING_MS,
  MAX_CONCURRENT,
  DAILY_OUTPUT_SEC_BUDGET,
  durationTolerance,
  recipeKey,
  requestCompose,
  statusOf,
  idle,
};
