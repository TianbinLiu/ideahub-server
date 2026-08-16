const multer = require("multer");
const { cloudinary } = require("../config/cloudinary");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

const ALLOWED_MIMES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_MEDIA_MIMES = [
  ...ALLOWED_MIMES,
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
];
const MAX_MEDIA_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// ── 白模模板视频（blockout r2v）────────────────────────────────────────
// ★ 不复用 uploadMedia：方舟 r2v 官方只认 mp4/mov —— /media 白名单里的 webm/ogg
//   传上去也没用，会在用户付费出片那一步才 400。专用 multer 实例把无效格式挡在上传口。
const ALLOWED_TEMPLATE_VIDEO_MIMES = ["video/mp4", "video/quicktime"];
/**
 * 上传口的大小上限。
 * ★ 2026-08-15 从 20MB 提到 100MB（白模 V2）：V1 传的是自己做的白模预演片
 *   （大色块 H.264，15s/720p 才 5-8MB），V2 传的是**任意实拍视频**，
 *   一分钟 1080p 就 60MB 级。
 * ⚠⚠ 跨组件：nginx 的 `client_max_body_size` 必须 ≥ 110m（留 multipart 边界与头部的余量），
 *   否则**请求根本到不了 Node** —— 用户看到的是 nginx 那张 413 静态页，
 *   服务端日志里一条记录都没有（查起来完全没有线索）。见 ALIYUN_HK_DEPLOYMENT_RUNBOOK.md。
 */
const MAX_TEMPLATE_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * ③ **白模化的输入**（作者框选、要送去做白模的那一段）的时长下限。
 *
 * ★★ 这个 5 **不是方舟的窗口**。方舟 `edit` 的硬窗口永远是 [4,30]（见下面的
 *   TEMPLATE_REF_RULES），这里的 5 是白模这条路**自己推导出来的约束**：
 *   白模化的**产出**要接着当下一发（每一个套用者那一发）的**输入**，
 *   而 **edit 的产出比输入短**（2026-08-16 实测：4.0s→3.712s、5.0s→4.736s、
 *   14.04s→13.67s，最坏 0.37s，且不随时长成比例，像是固定的头尾帧损耗）。
 *   于是 4 秒进去 = 3.7 秒出来 = **低于方舟自己的 4 秒下限，谁都套用不了**，
 *   而作者已经付过钱了 —— 线上 6 个模板里有 3 个就是这么废掉的。
 *
 * ★ 为什么是整数 5 而不是 4.4 之类：下限只能是整数 —— schemas 的 durSec 是 `.int()`、
 *   变换 URL 的 `du_` 正则只认整数、App 的 TrimBar 全程整数秒。整数候选里 4 已知是坏的，
 *   5 的余量 = 1.0 − 0.37 ≈ 0.63s，约为最坏观测值的两倍。**别把 0.29 那个差值写死成常量**：
 *   它是观测值不是协议，方舟随时可能变（所以每一次 finish 都记一行真实差值，见
 *   routes/branchTemplate.routes.js 的取件那一步 —— 攒够分布之后才谈得上用数据调这个 5）。
 *
 * ★★ 而这个下限**不是承重的那一层**：它依赖"裁短量 ≈0.3s"这个观测值，方舟哪天多裁一点
 *   它就失效了。真正承重的是**产出验收**（finish 里对转存回执再跑一次 templateRefIssue），
 *   那一层只依赖方舟自己公布的 [4,30]，不会失效。两层都要，顺序也不能反：
 *   输入门是体验（省钱省时间），产出门是"坏模板绝不落库"。
 */
const BLOCKOUT_MIN_INPUT_SEC = 5;

/**
 * ① **原始素材**的验收窗口（上传口）。白模 V2 起放宽。
 *
 * ★★ 为什么要有两套窗口：V1 的上传口传的就是最终参考视频本体，一套窗口够用。
 *   V2 起用户传的是**任意视频**，真正要满足方舟约束的是「编辑页框选、服务端裁出来的
 *   那一段」（见下面的 TEMPLATE_REF_RULES），原片本身不再直接进方舟。
 *   继续拿参考视频那套严窗口卡上传口，等于「一段 3 分钟的素材连传都传不上来，
 *   而它裁出来的 8 秒完全合格」—— 用户根本没法开始。
 *
 * 放宽/保留各自的理由：
 *   时长 [5,600]   —— 上限 10 分钟只是封住上传成本与存储，与方舟无关（裁剪后才进方舟）。
 *                     ★★ 下限 2026-08-16 从"开区间 >0"抬到 BLOCKOUT_MIN_INPUT_SEC：
 *                     裁出来的那一段不可能比原片长，所以"原片 <5s"是"框选段 <5s"的
 *                     **必要条件** —— 在 App 本机预检（`<video>` 读元数据，上传之前）
 *                     就能拦下，用户连 100MB 都不用传。
 *                     ⚠ 代价要明说：V1 建模板（整段原片直接当参考视频）走的是同一个
 *                     上传口，抬完之后**再也登记不了 4 秒的 V1 模板**。V1 已经不是 App
 *                     的活路径（App 只走白模化 V2），接受这个代价；哪天要把 V1 救回来，
 *                     就把这一条退回 >0，改由阶段一那句话兜底 —— 但别忘了那样一来
 *                     用户要传完 100MB 才知道自己的素材太短。
 *   边长 ≥300      —— **必要条件**：裁剪框不可能比原片大，原片任一边 <300 时
 *                     裁出来的边长必然也 <300，永远过不了 F3。早拒比让他白传 100MB 好。
 *   宽×高 ≥407,696 —— 同上，也是必要条件（裁剪面积 ≤ 原片面积）。
 *   **不再校宽高比** —— 比例正是裁剪框能修的那一项（16:9 的原片裁出竖版完全合理）。
 *   **不设边长上限** —— 4K/8K 原片没问题，裁出来的那块 ≤6000 即可。
 */
const TEMPLATE_SOURCE_RULES = Object.freeze({
  minSec: BLOCKOUT_MIN_INPUT_SEC,
  maxSec: 600,
  minEdge: 300,
  minPixels: 407_696,
});

/**
 * ② **参考视频**（真正喂给方舟 r2v 的那一段）的验收窗口 ——
 *    **这条规则的唯一实现**（铁律六）。三个调用方：
 *      · POST /api/branch/templates 建模板（V1：整段原片就是参考视频）
 *      · POST /api/branch/templates/blockoutize 裁剪后复核（V2 第 4 步）
 *      · 同一端点里对**白模化产物**转存后的复核（产物要当下一发的参考视频）
 *    三处如果窗口变了必须同时变，所以只能有这一份。
 *
 * 各数值的出处（都不是拍脑袋）：
 *   [4,30]s   —— 方舟 `edit` 子任务的时长硬窗口，**2026-08-15 实测**错误原文
 *               "the video selected must satisfy the duration requirement of 4 to 30 seconds"（F1）。
 *               ★ 上限从 15 放宽到 30 是 V2 的一部分：V1 那个 15 是"对齐 2.0 系列单发上限 +
 *               封住成本上界"的自我约束，不是方舟的约束；V2 由用户在编辑页自己框选，
 *               成本在开炼前整句报出。放宽时 config/tokens.js 的 r2vTokens 夹取区间
 *               **必须一起改**（那里夹到 15 的话，20s 的模板会按 15s 计价 = 报价 < 实收，
 *               本仓头号事故形状）。
 *   [300,6000] / 比例 [0.4,2.5] —— 方舟官方对输入视频的边长与宽高比约束（F3 实测拿到原文）。
 *   宽×高 ≥ 407,696 —— 2026-08-14 A2 探针第一发 400 实测出的**像素数硬门**
 *               （官方文档没写，方舟直接拒单），不预检的话用户会在付费那一步才撞墙。
 */
const TEMPLATE_REF_RULES = Object.freeze({
  minSec: 4,
  maxSec: 30,
  minEdge: 300,
  maxEdge: 6000,
  minRatio: 0.4,
  maxRatio: 2.5,
  minPixels: 407_696,
});

/**
 * ③ **白模化输入**的验收窗口 = 参考视频那一套，只把时长下限抬到 BLOCKOUT_MIN_INPUT_SEC。
 *
 * ★★ 为什么非得是**另一条规则**、而不是把 TEMPLATE_REF_RULES.minSec 直接改成 5：
 *   templateRefIssue 有四个调用点，其中**两个站在同一次裁短的两侧**——
 *     · 阶段一（白模化的**输入**）：要 ≥5，才能保证产出还有 ≥4；
 *     · finish（白模化的**产出**）：只能要 ≥4，因为一段合法的 5s 输入产出就是 4.7s，
 *       拿 5 去卡它等于**把唯一正确的用法也封死**。
 *   一个数不可能同时满足这两侧。所以 TEMPLATE_REF_RULES 一个字不改（它仍是方舟窗口的
 *   唯一实现，继续服务 V1 建模板与产物验收），白模路另立这一条派生规则。
 */
const BLOCKOUT_INPUT_RULES = Object.freeze({
  ...TEMPLATE_REF_RULES,
  minSec: BLOCKOUT_MIN_INPUT_SEC,
});

/**
 * 时长写进句子时的显示形态。
 * ★ duration 现在是**小数**（见 templateVideoMeta 的 ★★），直接插值会印出
 *   "当前约 3.7119999999 秒" 这种东西 —— 一句话里出现机器味的长小数，用户第一反应
 *   是"这系统坏了"，而这句话本来是要解释清楚原因的。整数照原样，小数留一位。
 */
function secText(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return "?";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * 拒绝语里的秒数 —— **朝着"没过"的那一侧取整**。
 *
 * ★★ 为什么不能直接用 `secText`：`toFixed(1)` 是四舍五入，于是一条 4.97 秒、
 *   真的没过 5 秒下限的素材，会被印成
 *     「这段视频只有约 **5.0** 秒。白模模板要求素材至少 **5** 秒」
 *   —— 用户读到的是"我明明够了，是你们坏了"。而手机剪辑器口中的"5 秒"落在
 *   4.966/5.033 这种数上极其常见，所以这不是边角情况。
 * ★ 下限用 floor（4.97 → "4.9"），上限用 ceil（30.02 → "30.1"）：两边都让显示的数
 *   与"它确实越界了"这件事**方向一致**。宁可显示得比真实值更差一点，也不要显示成
 *   一个看起来合规的数 —— 这一句话的唯一作用就是让用户相信判断是对的。
 */
function secTextFloor(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return "?";
  return Number.isInteger(n) ? String(n) : String(Math.floor(n * 10) / 10);
}
function secTextCeil(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return "?";
  return Number.isInteger(n) ? String(n) : String(Math.ceil(n * 10) / 10);
}

/**
 * Cloudinary 回执/资源详情 → 归一化的视频元数据。两处复核共用（同一份数、同一种取法）。
 *
 * ★★★ duration **保留原始小数，绝不取整** —— 这一行的 `Math.round` 是 2026-08-16
 *   那次事故的**单点根因**，删掉它一次修好三件事：
 *     ① finish 里那道产物窗口闸门（branchTemplate.routes 的 templateRefIssue(outMeta)）
 *        复活：`Math.round(3.712) === 4` 让一段 3.712s 的白模产物顺利通过 `duration < 4`，
 *        于是坏模板照建、作者付了钱、**每一个想套用它的人都会撞方舟同步 400**，
 *        而作者永远不知道为什么（线上 6 个模板废了 3 个）；
 *     ② 上传口不再把 3.6s 的原片读成 4s 放行（同源的第二条活 bug：放行之后
 *        `du_4` 投递出去只有 3.6s，方舟在阶段一就 400，而看帧那笔钱已经花掉了）；
 *     ③ ark.routes 的 clipOutOfBounds 拿到真数。
 * ★ 原来那句注释（"Cloudinary 视频回执的 duration 实测给整数秒，Math.round 只是防它
 *   哪天开始给小数"）与实测**直接冲突**：Upload API 对视频回的本来就是小数
 *   （4.0s 输入的 edit 产出回执是 3.712），它不是在"防"，它现在就在吃小数。
 * ★ width/height/bytes 继续取整：像素与字节天然是整数，回执偶尔给浮点只是表示问题。
 */
function templateVideoMeta(receipt) {
  return {
    duration: Number(receipt?.duration),
    width: Math.round(Number(receipt?.width)),
    height: Math.round(Number(receipt?.height)),
    bytes: Math.round(Number(receipt?.bytes)) || 0,
  };
}

/** 元数据齐不齐。两套窗口共用（缺了就没法定价，也没法判窗口） */
function metaMissingIssue(meta, what) {
  const { duration, width, height } = meta || {};
  if (
    !Number.isFinite(duration) || duration <= 0 ||
    !Number.isFinite(width) || width <= 0 ||
    !Number.isFinite(height) || height <= 0
  ) {
    // 回执缺字段不是用户的错，但也不能放行 —— 元数据是 r2v 结算的锚点，缺了就没法定价
    return `云端没有返回${what}的时长或尺寸，无法继续，请换一个 mp4/mov 文件重试。`;
  }
  return null;
}

/**
 * ① 原始素材过不过上传口的窗口。
 * @returns {string|null} null = 合格；字符串 = **能直接显示给用户的整句中文原因**
 *   （全 app 没人监听 emitApiError，只回错误码就是让用户对着转圈干等 —— 铁律八）。
 */
function templateSourceIssue(meta) {
  const miss = metaMissingIssue(meta, "这段视频");
  if (miss) return miss;
  const { duration, width, height } = meta;
  const R = TEMPLATE_SOURCE_RULES;
  // ★ 下限那句话必须把**因果链整条讲完**（素材短 → 白模产出更短 → 短于方舟下限 → 谁都
  //   套用不了）。只说"至少 5 秒"的话，用户手里明明有一段方舟收得下的 4 秒素材，
  //   只会觉得我们的限制是拍脑袋定的，然后去别处传。
  if (duration < R.minSec) {
    return (
      `这段视频只有约 ${secTextFloor(duration)} 秒。白模模板要求素材至少 ${R.minSec} 秒：` +
      `AI 把画面里的人换成白模时会把成片截短零点几秒，${R.minSec} 秒进去才能保证做出来的模板还够 ` +
      `${TEMPLATE_REF_RULES.minSec} 秒——短于 ${TEMPLATE_REF_RULES.minSec} 秒的模板谁都套用不了。换一条长一点的素材吧。`
    );
  }
  if (duration > R.maxSec) {
    return `视频最长 ${R.maxSec} 秒（当前约 ${secTextCeil(duration)} 秒），请先剪短再上传——超长素材只会让上传和裁剪都更慢。`;
  }
  if (width < R.minEdge || height < R.minEdge) {
    return `视频边长至少 ${R.minEdge} 像素（当前 ${width}×${height}）：裁剪框不可能比原片更大，这样的素材裁出来也过不了 AI 引擎的尺寸下限。`;
  }
  if (width * height < R.minPixels) {
    return `视频分辨率太低：宽×高至少要 ${R.minPixels.toLocaleString("en-US")} 像素（当前 ${width}×${height} = ${(width * height).toLocaleString("en-US")}），裁剪只会更小，AI 引擎会拒绝这样的输入。`;
  }
  // ★ 刻意不校宽高比：比例正是裁剪框能修的那一项（见 TEMPLATE_SOURCE_RULES 的说明）
  return null;
}

/**
 * ②a 参考视频窗口里**只判时长**的那一半。
 *
 * ★ 为什么单独拆出来：有两个调用方手里**只有时长**（登记好的模板 refVideo 的
 *   宽高不在 select 里、也没有重查的必要）—— 发布闸与套用闸（resolveR2v 分支一）。
 *   它们不该为了判一个时长去把整套元数据凑齐，更不该各自手写一遍 `< 4 / > 30`
 *   （那就是第二份判据，铁律六）。数值与措辞仍然只有 TEMPLATE_REF_RULES 这一份。
 * ★★ **拿不到有限正数时返回 null（当成合格）**：这个函数会被喂"存量数据里可能压根
 *   没有的字段"（refVideo.realDurationSec）。后加的字段一律**判否定** —— 缺失就当好，
 *   否则老模板会被整批判成坏的，且不报错（本仓 visibility 踩过的同一个坑）。
 *   "元数据缺了怎么办"归 metaMissingIssue 管，不归这里。
 * @returns {string|null} null = 合格/无从判断；字符串 = 整句中文原因
 */
function templateRefDurationIssue(duration, what = "模板视频") {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return null;
  const R = TEMPLATE_REF_RULES;
  if (d < R.minSec) {
    return `${what}至少要 ${R.minSec} 秒（当前约 ${secTextFloor(d)} 秒）：低于 ${R.minSec} 秒会低于 AI 出片任务的时长下限。`;
  }
  if (d > R.maxSec) {
    return `${what}最长 ${R.maxSec} 秒（当前约 ${secTextCeil(d)} 秒），请缩短后重试——越长，每次出片的费用也越高。`;
  }
  return null;
}

/**
 * ② 参考视频（真正喂给方舟的那一段）过不过窗口。
 * @param {object} meta { duration, width, height }
 * @param {string} [what] 出现在文案里的主语（"这一段"/"模板视频"），让用户知道说的是哪一步
 * @returns {string|null} null = 合格；字符串 = 整句中文原因
 */
function templateRefIssue(meta, what = "模板视频") {
  const miss = metaMissingIssue(meta, what);
  if (miss) return miss;
  const { duration, width, height } = meta;
  const R = TEMPLATE_REF_RULES;
  const durIssue = templateRefDurationIssue(duration, what);
  if (durIssue) return durIssue;
  if (width < R.minEdge || height < R.minEdge || width > R.maxEdge || height > R.maxEdge) {
    return `${what}的边长要在 ${R.minEdge}~${R.maxEdge} 像素之间（当前 ${width}×${height}），AI 引擎不接受这个尺寸。`;
  }
  if (width * height < R.minPixels) {
    return `${what}分辨率太低：宽×高至少要 ${R.minPixels.toLocaleString("en-US")} 像素（当前 ${width}×${height} = ${(width * height).toLocaleString("en-US")}），AI 引擎会拒绝这样的输入。`;
  }
  const ratio = width / height;
  if (ratio < R.minRatio || ratio > R.maxRatio) {
    return `${what}的宽高比要在 ${R.minRatio}~${R.maxRatio} 之间（当前约 ${ratio.toFixed(2)}），过于细长的画幅 AI 引擎不接受。`;
  }
  return null;
}

/**
 * ③ **白模化的输入**（作者框选、要送去做白模的那一段）过不过窗口。
 *
 * 调用点两个，且**必须一起换**（差一秒就等于留了一条绕行路）：
 *   · routes/branchTemplate.js 阶段一（白模化开炼）
 *   · routes/ark.js resolveR2v 分支二（未登记素材 = 白模化的输入走 /api/ark 那条路）
 *
 * ★★ 实现形状是「**加一条 + 委托**」，不是抄一份七条判断：额外的时长下限只有这一处，
 *   其余六条（上限/边长/像素/比例/元数据齐不齐）原样问 templateRefIssue。
 *   抄一份的话，哪天 F3 的像素门变了就只改得动一处，而另一处**没有任何症状**。
 * ★ 顺序上把这条额外下限判在**委托之前**（设计稿里写的是"先委托再加一条"，这里刻意
 *   反过来）：一段 3 秒的选段委托出去会得到"至少要 4 秒"，用户照做改成 4 秒，
 *   回来又被拒一次 —— 一句**指向错误数字**的解释和一个坏功能长得一模一样（铁律八）。
 *   这么排不会漏判任何一条：非有限数/非正数在这里一律落空，照旧由 metaMissingIssue 接住。
 */
function blockoutInputIssue(meta, what = "选中的这一段") {
  const d = Number(meta?.duration);
  const R = BLOCKOUT_INPUT_RULES;
  if (Number.isFinite(d) && d > 0 && d < R.minSec) {
    return (
      `${what}只有 ${secTextFloor(d)} 秒。白模这条路要求至少 ${R.minSec} 秒：` +
      // ★ "4 秒进去只剩 3.7 秒"是 2026-08-16 的**实测观测值**，写成字面量是刻意的 ——
      //   它是讲给用户听的一个具体例子，不是协议常量，别改成从 minSec 算出来的表达式
      //   （方舟改了裁短量之后，那个算式会开始编造一个没人量过的数）。
      `AI 换白模时会把成片截短零点几秒（实测 4 秒进去只剩 3.7 秒），做出来的模板短于 AI 出片引擎的 ` +
      `${TEMPLATE_REF_RULES.minSec} 秒下限，谁都套用不了。请回编辑页把这一段拖够 ${R.minSec} 秒再来。`
    );
  }
  return templateRefIssue(meta, what);
}

// 使用内存存储，上传到 Cloudinary
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
    return;
  }
  cb(new Error("Only image files are allowed (jpeg, jpg, png, gif, webp)"), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
  },
});

const uploadMedia = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MEDIA_MIMES.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image/video files are allowed"), false);
  },
  limits: {
    fileSize: MAX_MEDIA_SIZE_BYTES,
  },
});

const uploadTemplateVideo = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TEMPLATE_VIDEO_MIMES.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    // ★ 用 AppError 带 400，不学上面两个裸 new Error：裸 Error 没有 .status，
    //   errorHandler 会把它当 500「服务器错误」—— 用户明明只是选错了格式，
    //   却看到"服务器炸了"，两边都被误导（铁律八：错要响，但要指对方向）。
    cb(
      new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "模板视频只收 mp4 / mov 格式（AI 出片引擎只认这两种），请转码后重试。",
      }),
      false
    );
  },
  limits: {
    fileSize: MAX_TEMPLATE_VIDEO_BYTES,
  },
});

/**
 * 上传图片到 Cloudinary
 * @param {Buffer} buffer - 图片 buffer
 * @param {string} folder - Cloudinary 文件夹名称（avatars 或 content-images）
 * @param {string} userId - 用户 ID（用于生成唯一文件名）
 * @returns {Promise<string>} Cloudinary URL
 */
async function uploadToCloudinary(buffer, folder, userId) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `ideahub/${folder}`, // Cloudinary 文件夹路径
        public_id: `${userId}-${Date.now()}`, // 唯一文件名
        resource_type: 'image',
        transformation: [
          { quality: 'auto', fetch_format: 'auto' }, // 自动优化
        ],
      },
      (error, result) => {
        if (error) {
          console.error('[Cloudinary] Upload error:', error);
          reject(error);
        } else {
          console.log('[Cloudinary] Upload success:', result.secure_url);
          resolve(result.secure_url);
        }
      }
    );
    
    // 将 buffer 写入上传流
    uploadStream.end(buffer);
  });
}

module.exports = {
  upload,
  uploadMedia,
  uploadToCloudinary,
  ALLOWED_MIMES,
  MAX_IMAGE_SIZE_BYTES,
  ALLOWED_MEDIA_MIMES,
  MAX_MEDIA_SIZE_BYTES,
  uploadTemplateVideo,
  ALLOWED_TEMPLATE_VIDEO_MIMES,
  MAX_TEMPLATE_VIDEO_BYTES,
  // ★ 三套窗口是**三件事**，名字必须分得开：一个名字管两种含义，正是"改一处漏一处"的温床。
  //   TEMPLATE_SOURCE_* = 用户传上来的原始素材；
  //   TEMPLATE_REF_*    = 真正喂给方舟的那一段（= 方舟窗口 [4,30] 的唯一实现）；
  //   BLOCKOUT_INPUT_*  = 白模化的输入（= ref 那套 + 时长下限抬到 5，理由见常量注释）。
  TEMPLATE_SOURCE_RULES,
  TEMPLATE_REF_RULES,
  BLOCKOUT_MIN_INPUT_SEC,
  BLOCKOUT_INPUT_RULES,
  templateVideoMeta,
  templateSourceIssue,
  templateRefIssue,
  templateRefDurationIssue,
  blockoutInputIssue,
  metaMissingIssue,
  secText,
};
