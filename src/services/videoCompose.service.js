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
  // 门槛要从 minClipSec 推（见 baseOnlyDuration），不在这儿另写一个数（铁律六）
  COMPOSE_LIMITS,
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

/**
 * 画中画那个陷阱的**特征长度**：产物恰好只有第 1 段裁剪后那么长。
 *
 * ★★ 为什么总时长比对拦不住它：容差是**绝对值**（0.35+0.12n），而段落可以很短。
 *   两段各 0.2 秒（minClipSec）时，画中画产物与期望只差 0.2 秒，而容差是 0.59 —— 照样判过。
 *   所以再加一条**方向性**判据：多段配方的产物不该正好等于第 1 段的长度。
 * ★ 不会误杀：每段至少 minClipSec，所以正常产物至少比第 1 段长 0.2 秒，
 *   而这里的门槛只有它的一半。
 */
const BASE_ONLY_MARGIN = COMPOSE_LIMITS.minClipSec / 2;

function baseOnlyDuration(clips) {
  return clips[0].endSec - clips[0].startSec;
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
async function settle(key, patch, inc = null) {
  try {
    const update = inc ? { $set: patch, $inc: inc } : { $set: patch };
    const r = await VideoCompose.updateOne({ key, state: "pending" }, update);
    return r.matchedCount ? "landed" : "taken";
  } catch (e) {
    // ★ 写失败与"被别人抢先"必须分开报：合成一个 false 的话，数据库抖一下我们就会
    //   **把好端端的成片删掉**，还在日志里写一句"另一趟已经写过了"——事后照着这句查，
    //   查到的是并发问题，而真正的原因是写库失败（铁律八：话要说对，不然比不说更坏）。
    console.error(`[compose] 状态落库失败 ${key}:`, e.message);
    return "error";
  }
}

/**
 * 真跑一趟：拼变换 → 让 Cloudinary 抓取落地 → 自检 → 落库。
 * 任何一步失败都写 failed + 整句中文原因（客户端原样显示，所以话要说得能行动）。
 */
async function runCompose(key, userId, recipe) {
  const expected = expectedDurationSec(recipe.clips);
  let transform;
  /** 活儿有没有真派给 Cloudinary。false 时抛的错 = 配置/配方问题：重试无用、也没花钱 */
  let dispatched = false;
  try {
    // ★ 起跑打一次心跳：僵尸判据看的是 updatedAt，而受理与真正起跑之间还隔着并发队列
    //   （MAX_CONCURRENT=2）。不打的话，排队久了的**活**任务会被判成死的、再跑一遍。
    // ★★ 心跳打不上（matchedCount=0）说明**这条已经不是 pending 了** —— 排队期间被
    //   轮询判了死、或被另一趟收了尾。这时候再跑就是白花一趟编码，产物还没人认领。
    //   原来这里把返回值丢了，等于"已经被宣告死亡的任务照样把钱花完"。
    const beat = await VideoCompose.updateOne({ key, state: "pending" }, { $set: { startedAt: new Date() } }).catch(() => null);
    if (!beat || !beat.matchedCount) {
      console.warn(`[compose] ${key} 起跑时已不是 pending（排队期间被判死或被别人收尾），这一趟不跑了`);
      return;
    }
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
    dispatched = true; // 从这一行往后，Cloudinary 那边就可能真的开始跑编码了（= 花钱了）
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

    // ══ 产物自检 ══
    // ★★ 一条不够。三个静默陷阱的共同点是「200 + 无错误头 + 产物是另一个东西」，
    //   而"另一个东西"在回执上有三种露馅方式，各拦各的：
    const actual = Number(receipt.duration);
    const tol = durationTolerance(recipe.clips.length);
    const baseOnly = baseOnlyDuration(recipe.clips);
    /** @type {string|null} 非 null = 自检没过，这句话就是原因 */
    let reject = null;
    if (!Number.isFinite(actual)) {
      reject = "云端没有返回成片时长，无法确认拼接结果是否正确";
    } else if (Math.abs(actual - expected) > tol) {
      // ① 总时长：裁剪被忽略（偏长）、图层整个丢了（偏短）都在这里露馅
      reject = `合并结果时长不对（应约 ${expected.toFixed(1)} 秒，实得 ${actual.toFixed(1)} 秒）`;
    } else if (recipe.clips.length > 1 && Math.abs(actual - baseOnly) <= BASE_ONLY_MARGIN) {
      // ② **方向性**判据：产物恰好只有第 1 段那么长 = 画中画那个陷阱的原样签名。
      //   为什么不能只靠①：容差是绝对值，两段各 0.2 秒时画中画产物与期望只差 0.2 秒，
      //   而容差 0.59 —— 照样判过（见 BASE_ONLY_MARGIN 的 ★★）。
      reject = `合并结果只有第 1 段那么长（${actual.toFixed(1)} 秒），后面几段没有接上`;
    } else if (!receipt.width || !receipt.height) {
      // ③ 时长对了不代表**是个视频**：没有画面尺寸的产物（纯音频/坏产物）时长照样对得上，
      //   而它会一路走到发布、被人点开才发现是黑的
      reject = "合并结果没有画面（云端返回的产物缺少宽高信息）";
    }
    if (reject) {
      // ★★ 这就是防静默失败那道闸真正合上的地方：产物是"另一件商品"，
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
        // ★ 不再无脑写"请重试"：能走到这一步说明**编码真跑过了**（钱花了），而这类失败
        //   对同一份配方是确定性的 —— 重试只会再花一次钱得到同一个结果（复审实测）。
        //   给的是能改变结果的动作：换个剪法。
        error: `${reject}，已丢弃。这条配方重试还会是同样的结果——把片段重新剪一下再试；若反复出现请反馈给我们`,
      });
      console.error(
        `[compose] 自检未过 ${key}: ${reject} | 期望 ${expected} 实得 ${actual} ${receipt.width}x${receipt.height} 变换=${transform.slice(0, 300)}`,
      );
      return;
    }
    // ★ 没有地址就不是"成功"：交出去的话客户端会拿到 url:null，然后在播放器那头炸开，
    //   而记录里写着 done —— 排查的人会从播放器一路往回找，找不到这里（同 arkTransfer
    //   对 cloudinary returned no url 的处理）
    if (!receipt.secure_url) throw new Error("云端没有返回成片地址");

    // ── BGM 落地自检 ────────────────────────────────────────────────
    // ★★ 这道检查**只在 replace 模式下成立**，别当成通用的"配乐上没上"：
    //   混音模式（replace 缺省）不给各段发 ac_none，各段自己的原声就是音轨 ——
    //   BGM 一个字没混进去，产物照样有 audio，判不出来。说得出口的只有 replace 那一路
    //   （原声全静音了，还有音轨就只可能是 BGM）。
    // ★ 判的是 `audio.codec` 不是 `audio` 本身：Cloudinary 对无音轨的产物回的是
    //   **`audio: {}`**（真值），写成 `!receipt.audio` 的话这道自检一次都不会响。
    // ★ 不毁掉整条成片（画面与时长都是对的），但**要让用户看见** —— 只 console.warn 的话
    //   等于没说：他会拿到一条哑片，以为是自己手机静音了（铁律八：响亮但局部）。
    let notice = null;
    if (recipe.bgm?.replace && !receipt.audio?.codec) {
      notice = "背景音乐没能混进成片（画面与时长都正常）——换一首再合一次试试";
      console.warn(`[compose] ${key} replace 模式下产物没有音轨（变换=${transform.slice(0, 200)}）`);
    }

    const landed = await settle(key, {
      state: "done",
      url: receipt.secure_url,
      publicId: receipt.public_id,
      expectedSec: expected,
      actualSec: actual,
      transform,
      // done 也可能带一句话：成片能用，但有件事得说（目前只有 BGM 这一种）
      error: notice,
    });
    if (landed === "taken") {
      // 另一趟（僵尸重认领）已经把这条写成终态了：我这份产物没有任何地方会引用它，
      // 留着就是一条永远没人回收、却一直按存储计费的孤儿资产
      console.warn(`[compose] ${key} 终态已被另一趟写过，销毁本趟产物 ${receipt.public_id}`);
      await cloudinary.uploader.destroy(receipt.public_id, { resource_type: "video" }).catch(() => {});
      return;
    }
    if (landed === "error") {
      // 写库失败：产物是好的，但没人记得它。**不删**（删了就真没了，而库可能只是抖了一下），
      // 把 public_id 吼进日志 —— 这是事后唯一能把它找回来的线索
      console.error(`[compose] ${key} 成片已生成但状态写不进库，产物保留待人工回收: ${receipt.public_id}`);
      return;
    }
    console.log(`[compose] done ${key} → ${String(receipt.secure_url).slice(-70)} ${actual}s ${(receipt.bytes / 1e6).toFixed(1)}MB`);
  } catch (e) {
    // Cloudinary 的错误对象把原因塞在 e.error.message 里；只取 e.message 会得到一句 "Error"
    const raw = (e && (e.error?.message || e.message)) || String(e);
    // ★★ 分界线不靠猜错误文案，靠**有没有真把活儿派出去**（dispatched）：
    //   派出去之前抛的，只可能是"这台机器没配置"或"这份配方本身拼不出来"（字符集/段数）——
    //   两者重试多少次都是同一个结果，而且**一秒编码都没跑过**。
    //   ① 话术不能邀请重试（那是让人反复撞同一堵墙）；
    //   ② 预约的额度要退回去（没花的钱不能记在人家账上 —— 否则配置坏掉的那台服务器
    //      会一边不能出片、一边把每个用户的当日额度吃光，而两件事看起来毫无关系）；
    //   ③ 日志要 error 不是 warn：这类失败是**运维要立刻知道**的（配置问题会打中所有人）。
    const permanent = !dispatched;
    if (permanent) console.error(`[compose] 配置/配方问题（未派发，不计费）${key}: ${raw}`);
    else console.warn(`[compose] failed ${key}: ${raw}`);
    await settle(
      key,
      {
        state: "failed",
        expectedSec: expected,
        transform: transform || null,
        error: permanent
          ? `合并没能开始：${String(raw).slice(0, 160)}。这条重试也是同样的结果，请反馈给我们`
          : `合并失败：${String(raw).slice(0, 160)}——可以再试一次`,
      },
      permanent ? { spentSec: -expected } : null,
    );
  }
}

/** 三态 → 交给客户端的形状（一处实现，路由与轮询都用它） */
function publicView(job) {
  if (!job) return { state: "none" };
  // ★ done 也可能带 message：成片能用，但有件事得说（目前只有"BGM 没混进去"这一种）。
  //   不带出去的话那句话就只活在服务端日志里，用户拿到一条哑片却不知道为什么。
  if (job.state === "done") return { jobId: job.key, state: "done", url: job.url, ...(job.error ? { message: job.error } : {}) };
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
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const match = {
    userId: new mongoose.Types.ObjectId(String(userId)),
    // ★★ 必须**同时**看 createdAt 与 updatedAt，只看 createdAt 有个大洞：
    //   登记行的 TTL 是 48 小时，而预算窗口是 24 小时 —— 一份 25 小时前建的失败配方
    //   还活着，复活重试时 $inc 加的那份 spentSec 落在一行 createdAt 已经出窗的记录上，
    //   于是**它自己都不算进自己的核账**：那条配方可以被无限免费重试（正是上一轮
    //   给"重试也计费"打的补丁没堵住的缝）。
    // ★ 代价是复活老行时会把它**早先**的消耗也算进这 24 小时（多算）。方向是对的：
    //   花钱的闸门宁可多算一点把人拦下，也不能少算一点让人白嫖（同 imageTokensOf
    //   认不出模型时按最贵档收的取舍）。
    $or: [{ createdAt: { $gte: since } }, { updatedAt: { $gte: since } }],
  };
  // upToId：并发受理时只算"排在我前面（含我自己）"的那些 —— 靠 _id 定序，
  // 一批并发里正好保留装得下的那个前缀，而不是要么全放要么全拒
  if (upToId) match._id = { $lte: upToId };
  const r = await VideoCompose.aggregate([{ $match: match }, { $group: { _id: null, sec: { $sum: { $max: ["$spentSec", "$expectedSec"] } } } }]);
  return (r[0] && r[0].sec) || 0;
}

/** 秒数 → 给人看的话。`up` 决定取整方向（见 deniedView 的第二条 ★）。
 *  不到一分钟就说秒：额度快见底时"0.1 分钟"谁也不知道是多少 */
function humanSec(sec, up) {
  const s = Math.max(0, sec);
  if (s < 60) return `${up ? Math.ceil(s) : Math.floor(s)} 秒`;
  // 整分钟就不带小数（上限那句是 15 分钟，写成"15.0 分钟"只会显得像机器算错了）
  return `${Number(((up ? Math.ceil(s / 6) : Math.floor(s / 6)) / 10).toFixed(1))} 分钟`;
}

/**
 * 拒绝话术。**必须同时拿到 want（这一条要多长）**，只报"已用多少"是不够的。
 *
 * ★★ 为什么：单发上限 maxTotalSec = 300 秒 = 全天额度的三分之一，所以拒绝**常常发生在
 *   额度还剩一大截的时候**。只说"上限 15 分钟、已用 10 分钟"的话，用户读到的是
 *   "还空着 5 分钟，凭什么不让我合"——同一份配方他会一小时后原样再投一次（滚动窗口那时
 *   几乎没动），拿到一模一样的一句话，最后得出"配额显示是坏的"。**一句话里的数字自相矛盾，
 *   比不给数字更坏**（铁律八：话要说得能行动）。要报的是能行动的两个数：这条要多长、还剩多长。
 * ★ 取整方向要钉死：剩余**向下**、需要**向上**。denial 的前提就是 want > 剩余，
 *   这么取整之后印出来的"要 X／只剩 Y"必然 X > Y；四舍五入则会印出"要 5.0 分钟、
 *   只剩 5.0 分钟"这种读起来像 bug 的句子（601 已用 + 300 秒配方，实测就是这句）。
 * @param {number} total 含这一趟预约的 24h 合计（调用方核账时手里就是它）
 * @param {number} want  这一条配方的输出秒数
 */
function deniedView(total, want) {
  // ★ 在这里把预约减回去，不在三个调用点各减一次（铁律六：口径只有一处）
  const remain = DAILY_OUTPUT_SEC_BUDGET - (total - want);
  return {
    state: "denied",
    // ★ 说"最近 24 小时"而不是"今天/明天"：窗口是**滚动**的，说"明天再来"会让人白等到第二天
    //   却发现还是不行（额度是随着那一发满 24 小时才一点点回来的）。
    message: `这条成片要 ${humanSec(want, true)}，最近 24 小时只剩 ${humanSec(remain, false)}（每 24 小时最多合成 ${humanSec(DAILY_OUTPUT_SEC_BUDGET, false)}）——把片子剪短一点就能现在合，或者过一阵再试（用掉的额度是随那一发满 24 小时才一点点回来的）`,
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
      return deniedView(over, want);
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
          // ★ 退预约的同时必须把状态写成 failed：只 $inc 回去的话，这一行还是 pending
          //   而且 updatedAt 刚被刷新过 —— 一个**没有任何人在跑**的"进行中"任务，
          //   客户端会对着它再转十分钟圈，然后才等到僵尸判定。
          await VideoCompose.updateOne(
            { key, state: "pending" },
            { $set: { state: "failed", error: deniedView(over, want).message }, $inc: { spentSec: -want } },
          );
          return deniedView(over, want);
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
      return deniedView(over, want);
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
