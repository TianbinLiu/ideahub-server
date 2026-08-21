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

/** pending 多久没动静算僵尸（认领它的进程死在半路）——可被重新认领。同 arkTransfer 的取舍 */
const STALE_PENDING_MS = 10 * 60 * 1000;

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

/** 结果（含失败）**必须**落库：落不下去客户端会一直看到 pending 干等（比报错更坏） */
async function settle(key, patch) {
  await VideoCompose.updateOne({ key }, { $set: patch }).catch((e) =>
    console.error(`[compose] 状态落库失败 ${key}:`, e.message),
  );
}

/**
 * 真跑一趟：拼变换 → 让 Cloudinary 抓取落地 → 自检 → 落库。
 * 任何一步失败都写 failed + 整句中文原因（客户端原样显示，所以话要说得能行动）。
 */
async function runCompose(key, userId, recipe) {
  const expected = expectedDurationSec(recipe.clips);
  let transform;
  try {
    transform = buildComposeTransform(recipe);
    const source = buildSourceUrl(recipe.clips[0].publicId);
    if (!source) throw new Error("这台服务器没有配置云存储（CLOUDINARY_*），合并功能不可用");

    // ★ 源 = 第 1 段的原始地址，拼接规则作为**入站变换**随这次（已签名的）上传请求发出。
    //   理由全在 utils/videoCompose.buildSourceUrl 的注释上 —— 一句话：这是三种做法里
    //   唯一既不产生派生垃圾、又保证存下来是常规 MP4（不是播放器读不出时长的分片容器）的。
    const publicId = `${userId}-${Date.now()}-merged`;
    const receipt = await cloudinary.uploader.upload(source, {
      resource_type: "video",
      folder: BRANCH_VIDEO_FOLDER,
      public_id: publicId,
      raw_transformation: transform,
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

    await settle(key, {
      state: "done",
      url: receipt.secure_url,
      publicId: receipt.public_id,
      expectedSec: expected,
      actualSec: actual,
      transform,
      error: null,
    });
    console.log(`[compose] done ${key} → ${receipt.secure_url.slice(-70)} ${actual}s ${(receipt.bytes / 1e6).toFixed(1)}MB`);
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
 * 受理一份配方：没跑过就认领并后台开跑；跑过就把现成结果给回去。
 * ★ failed 会**复活重试**：合并失败往往是一次性的（上游抖动/生成超时），
 *   而用户主动再点一次合并就是明确的重试意图（同 arkTransfer.requestTransfer 的取舍）。
 */
async function requestCompose(userId, recipe) {
  const key = recipeKey(userId, recipe);

  // ★ 预算闸排在最前，但**已经跑过的配方不受它影响**（下面几条分支会直接返回现成结果）——
  //   不然用户第二天来看昨天那条成片的地址，会被告知"今天的额度用完了"，而那一发早就跑完了。
  //   所以这里只拦"要新开一发"的情况：先看有没有现成的。
  const existing = await VideoCompose.findOne({ key }).lean();
  const willSpend = !existing || existing.state === "failed" ||
    (existing.state === "pending" && Date.now() > new Date(existing.updatedAt).getTime() + STALE_PENDING_MS);
  if (willSpend) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const used = await VideoCompose.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(String(userId)), createdAt: { $gte: since } } },
      { $group: { _id: null, sec: { $sum: "$expectedSec" } } },
    ]);
    const spent = (used[0] && used[0].sec) || 0;
    const want = expectedDurationSec(recipe.clips);
    if (spent + want > DAILY_OUTPUT_SEC_BUDGET) {
      return {
        state: "denied",
        message: `今天的合并额度用完了（每天最多合成 ${Math.round(DAILY_OUTPUT_SEC_BUDGET / 60)} 分钟成片，已用 ${Math.round(spent / 60)} 分钟）——明天再来，或先把已经合好的发布掉`,
      };
    }
  }

  const revived = await VideoCompose.findOneAndUpdate(
    { key, state: "failed" },
    { $set: { state: "pending", error: null } },
    { returnDocument: "after" },
  ).lean();
  if (revived) {
    schedule(key, userId, recipe);
    return publicView(revived);
  }

  const found = await VideoCompose.findOne({ key }).lean();
  if (found) {
    const staleAt = new Date(found.updatedAt).getTime() + STALE_PENDING_MS;
    if (found.state === "pending" && Date.now() > staleAt) {
      // 僵尸认领：按 updatedAt 原子抢（两个实例同时抢，只有一个改得动）
      const claimed = await VideoCompose.findOneAndUpdate(
        { key, state: "pending", updatedAt: found.updatedAt },
        { $set: { error: null } }, // timestamps 顺手刷新 updatedAt = 新的认领时刻
        { returnDocument: "after" },
      ).lean();
      if (claimed) {
        schedule(key, userId, recipe);
        return publicView(claimed);
      }
    }
    return publicView(found);
  }

  try {
    const doc = await VideoCompose.create({ key, userId, state: "pending", expectedSec: expectedDurationSec(recipe.clips) });
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
 */
async function statusOf(userId, jobId) {
  const job = await VideoCompose.findOne({ key: String(jobId || "").slice(0, 64), userId }).lean();
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
