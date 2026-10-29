/**
 * @file videoRegion.js - 出片按地区：每个地区准用哪几个上游、地区门禁开到哪一档、被拦时对用户说什么
 * @category Config
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md + .env.example + docs/ONBOARDING.md
 *
 * 主人原话（2026-10-26）：美国境内不能用 Seedance、只能用 MiniMax 国际版；中国境内 IP 可以选；
 * 海外由于政策原因只能用 MiniMax。
 *   ⚠ 「政策原因」的出处（条款原文或供应商书面答复）还没落进文档 —— 在那之前这是「按主人要求的产品限制」，
 *     注释、文档、对用户说的话里都别写成「法规要求」（所以下面那句拒绝话也没有写原因）。
 *
 * 分工（一条规则一处实现，铁律六）：
 *   · 请求方在哪个国家、国家码落到哪个地区（cn / intl / blocked）—— utils/geo（countryOf / videoZoneOf），这里不再判一遍；
 *   · 这一个请求按哪个地区算（geo 的结论 + 开发用的 VIDEO_ZONE_FORCE）—— 本文件 requestZone；
 *   · 每个地区按政策准用哪几个上游（ZONE_UPSTREAMS）、门禁开着时实际给得出哪几家（allowedProviders = 政策 ∩ 这台服务器接着的上游）、
 *     此刻对 App 说给哪几家（offeredProviders，跟着 gate 走）—— 本文件；
 *   · 门禁开到哪一档（off / observe / on）—— 本文件 gateMode；
 *   · 「这一发按地区该不该拦、拦了说什么」—— 本文件 regionDenial（纯判定，不看 gate，见它的注释）。
 *
 * ★ 2026-10-26 先定下的默认（**等主人拍板**，都写成能改的一处）：
 *   ① 只拦**出视频**：Seedance（方舟）按地区拦；MiniMax 出片（真人档 `minimax_video`、H3 的 V2 `minimax_v2`）按「地区 + 站」拦 ——
 *     海外只准国际站，受全面制裁的地区一家都不给（gatedProviderOf）。出图（Seedream）、对话 / 推演 / 客服（豆包）、TTS、Seed3D、
 *     真人肖像授权邀约（arkPortrait）、Runway 都**不拦** —— 海外要全拦的话这几样都没有替代供应商，要另起一期。
 *     ⚠ MiniMax 那一半是 2026-10-26 审核补的（原来只认 Seedance）：不拦的话 blocked 区「一家都不给」只是 App 上看不见、
 *       服务端照收照转（/api/video/zone 说没有，出片那一发却放行 —— 正是本文件要防的「一处说能用、一处说不能用」）；
 *       「海外只能用 MiniMax 国际版」也只有连站一起判才兑现得了。
 *   ② 只有 CN 判境内；港澳台 / 未知 / Tor 判境外（判定在 utils/geo 的 CN_ZONE_COUNTRIES）。
 *   ③ 门禁 VIDEO_REGION_GATE 缺省 observe（只记日志不拦）；on 才拦；off 完全不管。什么时候切 on 等主人定。
 *     切 on 之前**先做完**（.env.example 那一节同一张单子，全文在 docs/api-contract.md「出片地区」→「切 on 之前」）：
 *       · 旁加载包用发版脚本的 `--min-version-code` 把强制更新门槛抬到认得 REGION_UNAVAILABLE、会读 /api/video/zone 的那一版 App
 *         （Play 版等那一版铺开）—— 老 App 照旧摆 Seedance 档，到视频那一发才吃 403，而推演、出片前补画设定帧都不归门禁管、
 *         各自先扣钱：App 2.62 起补画好的帧随失败留在这一段上（SegmentGenFailed.kept），重试不重画、不再收图钱，推演是另一步、
 *         重试不会再推演 —— 白付的是每段一轮；2.61 及更早每重试一次都重画、再收一遍图钱；
 *       · `curl /api/minimax/health` 确认 region 是 intl —— 走中国站的话，海外连 MiniMax 也没有（见 ①）；
 *       · 当面核 cf-ipcountry 伪造不了（在中国以外、非数据中心的网络上带 `cf-ipcountry: CN` 问 /api/video/zone，country 不能回 CN）——
 *         observe 的 would-deny 日志只记该拦的，伪造成 CN 的那一发一行都不留，核不了这一条；
 *       · 做完源站那一道加固（细节在运维的私有笔记，utils/geo.countryOf 的 ⚠ 点了名）；
 *       · 已经付过钱的片子上的后续出片（样片第二步、片段重拍、往后延长）今天照拦，豁不豁免等主人定（api-contract「等主人拍板」第 7 条）；
 *       · 海外的免费用户（2026-10-26 定，api-contract「等主人拍板」第 8 条已定）：免费档里加了 MiniMax H3-Lite · 480P
 *         （「草稿」在 MiniMax 上的对标，tokens.FREE_VIDEO_ALLOW），所以切 on 之后海外的免费用户还有这一档 ——
 *         **前提是 V2 出片在这台服务器上开着**（config/minimax.minimaxV2Enabled：只在国际站）。没开的话海外免费用户一档都没有
 *         （Seedance 被地区拦、真人档只给付费用户），拒绝话也跟着说「MiniMax 要付费」（swapVariant）。
 *   ④ blocked（受全面制裁的四国）：Seedance 与 MiniMax 出视频都拦（门禁 on 时）；出图 / 对话等按 ① 不拦。
 *
 * ★ 本文件顶层只 require 纯配置（tokens / minimax / logSafe 都不碰网络、不连库）：`npm run check:config`
 *   经 config/preflight 会 require 这里，而那个脚本的约定是「不 require 任何业务模块」（deploy.sh 的装载自检另跑）。
 *   所以 utils/geo（启动时把 geoip 库整份读进内存）与 arkGateway.service（连着钱包与模型）都在用到的那一刻才 require ——
 *   后者另有一个理由：arkGateway 顶层 require 本文件做门禁（regionGate），顶层互相 require 就是半初始化的模块。
 */

const { isVideoGeneration, videoPlanDenial, MINIMAX_REAL_MODELS, MINIMAX_SEC_COST } = require("./tokens");
const { minimaxRegion, minimaxV2Enabled } = require("./minimax");
const { logSafe } = require("../utils/logSafe");

/**
 * 出片的上游：准不准用按这个粒度判（MiniMax 连站一起算）。
 *   provider —— 下发给 App 的名字：App 只管「哪家」（"ark" = 火山方舟 Seedance、"minimax"），走哪个站是服务端的事；
 *               "minimax" 同时管真人档（minimax_video）与 H3 三档（minimax_v2）：两种都打到这台服务器走的那一个站、按同一个站判
 *               （gatedProviderOf），拆成两个名字就是同一个答案报两遍。H3 三档摆不摆，App 再看 /api/ark/health 的 minimaxV2
 *               （开没开 V2 是这台服务器的能力，判据只在 config/minimax.minimaxV2Enabled；契约见 routes/videoZone.routes 文件头）；
 *   live     —— 这台服务器此刻接着的是不是这个上游。只转问各自唯一的判据（铁律六），这里不再读 env：
 *               方舟问 arkGateway.arkConfigured（用到才 require，理由见文件头）；MiniMax 问 config/minimax.minimaxRegion
 *               —— 一台服务器的 MiniMax 只走一个站，中国站与国际站是两套账号、两个域名。
 * ★ MiniMax 为什么分站（2026-10-26 审核）：主人原话是海外「只能用 MiniMax 国际版」。只写一个 "minimax" 的话，
 *   一台配着中国站 key（MINIMAX_API_KEY，或 MINIMAX_REGION=cn）的服务器会对海外说「换 MiniMax」，请求却打到中国站。
 */
const UPSTREAMS = Object.freeze({
  ark: Object.freeze({ provider: "ark", live: () => require("../services/arkGateway.service").arkConfigured() }),
  "minimax:cn": Object.freeze({ provider: "minimax", live: () => minimaxRegion() === "cn" }),
  "minimax:intl": Object.freeze({ provider: "minimax", live: () => minimaxRegion() === "intl" }),
});

/**
 * 每个出片地区**按政策**准用哪几个上游。key 就是 utils/geo.videoZoneOf 能回的三个地区。
 * ★ 写成代码里的冻结常量、不做环境变量：这是拦人的边界，放宽它应当过一次评审（与 geo 的两份名单同一条理由）。
 * ★ 这是「准不准用」，不是「有没有」：某一家没配 key 时由 allowedProviders 再筛掉，门禁判定（regionDenial）只看这张表 ——
 *   没配 key 不该让门禁放宽或收紧，那一发自己会 501。
 */
const ZONE_UPSTREAMS = Object.freeze({
  cn: Object.freeze(["ark", "minimax:cn", "minimax:intl"]),
  intl: Object.freeze(["minimax:intl"]),
  // 受全面制裁（geo.BLOCKED_COUNTRIES）：MiniMax 国际站协议的出口管制条款也管到「把客户数据交给终端用户」—— 一家都不给
  blocked: Object.freeze([]),
});

/** 地区门禁的三档。缺省 observe（等主人拍板什么时候切 on） */
const GATE_MODES = Object.freeze(["off", "observe", "on"]);
const DEFAULT_GATE = "observe";

/** 被地区拦下时回包里的 code（App 认码不认文案） */
const REGION_UNAVAILABLE = "REGION_UNAVAILABLE";

/**
 * 地区名是不是这张表里的。漏传 / 传错一律当编程错误抛 ——
 * ★ 不给缺省值：漏传 zone 是零症状的（按哪个缺省都是「悄悄放行」或「悄悄全拦」其中之一），抛出来才看得见。
 */
function assertZone(zone) {
  if (typeof zone !== "string" || !Object.hasOwn(ZONE_UPSTREAMS, zone)) {
    throw new TypeError(`videoRegion: zone 必须是 ${Object.keys(ZONE_UPSTREAMS).join(" / ")} 之一，收到 ${logSafe(zone, 32)}`);
  }
}

/** 一串上游 → 对外的供应商名（去重、保持表里的先后）；onlyLive = 只留这台服务器此刻接着的 */
function providersOf(upstreams, onlyLive) {
  const out = [];
  for (const u of upstreams) {
    const { provider, live } = UPSTREAMS[u];
    if (onlyLive && !live()) continue;
    if (!out.includes(provider)) out.push(provider);
  }
  return out;
}

/** 这个地区**按政策**给哪几家（对外的名字；新数组，调用方改不动常量） */
function zoneProviders(zone) {
  assertZone(zone);
  return providersOf(ZONE_UPSTREAMS[zone], false);
}

/**
 * 门禁开着（on）时，这个地区**在这台服务器上**实际给得出哪几家 = 政策 ∩ 这台服务器接着的上游。
 * ★ 被拦时回包里「换到哪一家走得通」用的是这一份（门禁只在 on 时真拦，所以只有这一份答案有意义）。
 * 每次现读（各家的判据本来就每次现读 env）—— 运维改完 key 重启即生效，测试也能切。
 */
function allowedProviders(zone) {
  assertZone(zone);
  return providersOf(ZONE_UPSTREAMS[zone], true);
}

/**
 * 此刻对这个地区的 App 说「给哪几家」—— GET /api/video/zone 下发的就是这一份。**跟着 gate 走**：
 *   on            —— allowedProviders(zone)：服务端真会拦，App 照着藏档；
 *   off / observe —— 这台服务器接着的**全部**几家、不看地区：服务端一发都不拦，App 就该照常全摆。
 * ★ 为什么由服务端按 gate 算、不让 App 自己看 gate 决定放不放开（2026-10-26 审核）：
 *   ① off 是急停开关 —— 要是靠 App 读 gate，只要有一个版本的 App 直接照 providers 藏档，服务端切 off 也救不回海外的 Seedance，
 *     而服务端这一侧一点办法都没有；照着服务端算好的答案画，这一条只有这一处实现；
 *   ② observe 期间新版 App 若照政策藏档，美国用户在切 on 之前就只剩「真人」一档 —— observe 的本意是「只记、不拦」，
 *     就该对 App 也不拦（要看的 would-deny 日志由老 App 与网页那几发照样记得到）。
 * ★ 没配 key 的那一家永远不报：没配 MiniMax 的服务器对海外说 ['minimax']，App 就会摆一个点下去必回 501 的档。
 * @param {"cn"|"intl"|"blocked"} zone
 * @param {"off"|"observe"|"on"} [gate] 缺省现读 gateMode()；调用方同一个回包里也要报 gate 时传进来，免得两次现读之间改了配置
 */
function offeredProviders(zone, gate = gateMode()) {
  assertZone(zone);
  return gate === "on" ? allowedProviders(zone) : providersOf(Object.keys(UPSTREAMS), true);
}

/**
 * 地区门禁开到哪一档：VIDEO_REGION_GATE = off | observe | on（大小写、首尾空白不计）。
 *   off     —— 完全不管（不判、不记；/api/video/zone 也照常全报）；
 *   observe —— 判，但只记一行 would-deny 日志、照常放行（缺省；/api/video/zone 也照常全报）；
 *   on      —— 判了就拦（403 REGION_UNAVAILABLE，扣钱之前）。切 on 之前的两件事见文件头 ③。
 * ★ 认不出的值当 observe（不当 on，也不当 off）并由启动自检报出来（collectVideoRegionProblems）：
 *   生产上写错一个字母就拒绝启动 —— 「以为开了、其实只在记日志」是配错了但能跑起来的那一类。
 * 每次现读 env（照 tokens.freeVideoGateOn）：改完重启即生效，测试也能切。
 */
function gateMode(env = process.env) {
  const raw = String(env.VIDEO_REGION_GATE ?? "").trim().toLowerCase();
  return GATE_MODES.includes(raw) ? raw : DEFAULT_GATE;
}

/** 同一句提醒一个进程只吼一次（每个请求都吼会把 pm2 日志淹掉，一次都不吼又看不见） */
const warned = new Set();
function warnOnce(key, log, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  log(msg);
}

/**
 * 开发用：把**每个请求**的出片地区钉死（VIDEO_ZONE_FORCE = cn | intl | blocked）。
 * 用途：在美国的开发机上测境内的 Seedance、在国内测境外的样子 —— 只配在本机服务端的 .env 里。
 * ★★ 生产环境配了它一律**不认**（回 null）：写 cn 就等于对海外放开 Seedance、整道地区门禁失效。
 *   启动自检在生产上见到它直接拒绝启动（collectVideoRegionProblems）；这里再不认一次，是给「自检没跑到」的路
 *   （比如有人直接 node 起了某个脚本）留的第二道 —— 不认的方向是「按真实地区判」，不会把人放进来。
 * ★ 生效与不认都要在日志里看得见（各吼一次）：钉着地区却没人知道，测出来的东西就是错的。
 * @returns {"cn"|"intl"|"blocked"|null}
 */
function forcedZone(env = process.env) {
  const raw = String(env.VIDEO_ZONE_FORCE ?? "").trim().toLowerCase();
  if (!raw) return null;
  const shown = logSafe(raw, 32);
  if (env.NODE_ENV === "production") {
    warnOnce(`prod:${raw}`, console.error, `[video-region] 生产环境配了 VIDEO_ZONE_FORCE=${shown}：不认，按真实地区判（这一行应当删掉；启动自检本该拒绝启动）`);
    return null;
  }
  if (!Object.hasOwn(ZONE_UPSTREAMS, raw)) {
    warnOnce(`bad:${raw}`, console.warn, `[video-region] VIDEO_ZONE_FORCE=${shown} 认不出（只认 ${Object.keys(ZONE_UPSTREAMS).join(" / ")}）：按没配处理`);
    return null;
  }
  warnOnce(`on:${raw}`, console.warn, `[video-region] VIDEO_ZONE_FORCE=${raw}：每个请求的出片地区都按 ${raw} 算（只给开发用）`);
  return raw;
}

/**
 * 这一个请求按哪个出片地区算 —— **只有这一处**把 geo 的结论和 VIDEO_ZONE_FORCE 合起来
 * （/api/video/zone 下发、出片门禁拦人都从这里取，两处各合一遍就可能一个说能用、一个说不能用）。
 * @param {object} req Express 请求（没有 headers 也不抛，utils/geo 的约定）
 * @returns {{ zone: "cn"|"intl"|"blocked", country: string, source: "cf"|"geoip"|"", forced: boolean }}
 *   country / source 永远是**真实**判出来的那一份（钉了地区也照实报国家，排查时才对得上）
 */
function requestZone(req) {
  // 用到才 require：utils/geo 一加载就把 geoip 库整份读进内存（理由见文件头）
  const { countryOf, videoZoneOf } = require("../utils/geo");
  const { country, source } = countryOf(req);
  const forced = forcedZone();
  return { zone: forced || videoZoneOf(country), country, source, forced: Boolean(forced) };
}

/**
 * 这一发归不归地区门禁管、管的话打到哪个上游（ZONE_UPSTREAMS 里的名字）。null = 不归这道闸管（照常放行）。
 *   · kind 'task' 且是 Seedance 出视频 → "ark"。「是不是 Seedance 视频」直接问 tokens.isVideoGeneration
 *     （那一处判据，不在这里抄一份 VIDEO_MULT 的查法）：普通出片、带参考视频（r2v / 白模化）、样片两步都在内；
 *     Seed3D（kind 'task' 但不在 VIDEO_MULT）不在内。
 *   · kind 'minimax_video'（真人档）与 'minimax_v2'（H3 的 V2 出片，2026-10-26）→ "minimax:<这台服务器走的站>"。
 *     两种都按「这一发打到哪个站」判（一台服务器的 MiniMax 只走一个站，V2 也发到 config/minimax 那一个 base）——
 *     V2 只在国际站开（minimax.minimaxV2Enabled），走中国站的服务器上 V2 路由在扣费之前就 501 了，判成 minimax:cn 也不会错拦谁。
 *     没配 MiniMax 时回 null：路由在扣费之前就回 501 了，这一发根本到不了钱上，不归这道闸管。
 *     ⚠ 新加一种 MiniMax 出片的 kind（tokens.isVideoGeneration 认它的那一刻）要同时加在这里：
 *       漏了是零症状的 —— regionGate 见 null 就整个跳过（不拦、不记 would-deny、没带 req 也不抛），受全面制裁的地区照样出片
 *       （2026-10-26 审核抓到：minimax_v2 一度只进了 isVideoGeneration、没进这里）。tests/videoZone.spec 拿 isVideoGeneration 反过来核。
 *   · 出图 / 对话 / TTS / Runway 都不在内。范围等主人拍板（见文件头 ①）—— 改范围只改这一处。
 *
 * ★★ 有付费步骤排在出视频**之前**的路由，要在**第一笔付费调用之前**自己预检一次（2026-10-26 审核）：
 *   门禁挂在 chargedArkCall 上，只管那一发本身。白模化（branchTemplate.routes 的 POST …/blockoutize）先花一发看帧
 *   （kind 'chat'，这道闸不管），再发 Seedance r2v —— 只靠 chargedArkCall 的话，海外用户先被扣掉看帧那笔钱、
 *   再在 r2v 那一步吃 403，而 403 那句话说的却是「没有扣费」。所以那种路由要在套餐预检（tokens.videoPlanDenial）旁边、
 *   任何付费调用之前，调**同一个执行** arkGateway.regionGate 预检（参数与 chargedArkCall 里那一处相同：req / user / kind /
 *   model / at，带参考视频的再带 r2v —— 拒绝话按它挑句子；on 拦、回 billed:false；observe 只记 would-deny；off 不管）——
 *   别在路由里照着 regionDenial + gateMode 再拼一份执行。白模化已经这么接了；以后新加「先付一笔、再出视频」的路由同理。
 *   ★ 同一个理由的另一种：路由在 chargedArkCall **之前**另有会拒人的闸（不是付费，是「过一会儿再试」那类），也要在那些闸之前预检 ——
 *   H3 出片（minimax.routes 的 POST /v2/video）的两道并发闸排在 chargedArkCall 前面，池子满的时候受制裁地区的人听到的是
 *   「MiniMax 忙，过一会儿再点」，App 只在收到 REGION_UNAVAILABLE 之后才重探地区，于是叫人重试一件永远不会成的事（2026-10-26 审核）。
 */
function gatedProviderOf(kind, model) {
  if (kind === "task" && isVideoGeneration(kind, model)) return "ark";
  if (kind === "minimax_video" || kind === "minimax_v2") {
    const site = minimaxRegion();
    return site ? `minimax:${site}` : null;
  }
  return null;
}

/**
 * 被拦的这一发，拒绝话该不该指人去换 MiniMax —— **只问这一处**（2026-10-26 最终审核）。
 * 原来只看 providers 里有没有 minimax：海外每一发被拦的 Seedance 都说「换成 MiniMax」，包括 MiniMax 根本做不了的那几样，
 * 以及这个人的套餐用不了 MiniMax 的时候 —— 照着做的人换过去还是走不通，等于指了一条死路。
 *   "none"     —— 这个地区在这台服务器上给不出 MiniMax（providers 里没有），或被拦的本来就是 MiniMax（真人档 / H3 按站拦）；
 *   "noAlt"    —— 给得出 MiniMax，但这一发是我们在 MiniMax 上没接的：带参考视频（r2v —— 白模化、白模模板段、片段重拍、往后延长、素材参考）、
 *                 样片第二步（draftFinal，升 1080p）。真人档只做照片起拍；H3 的 V2 出片今天不收参考视频（tokens.MINIMAX_V2_ITEM_KEYS
 *                 里没有 video_url）、也没有样片两步 —— 这几样在 MiniMax 上没有对应的做法；
 *   "paidOnly" —— 普通出片、MiniMax 做得了，但这台服务器上的 MiniMax **没有一档**对这个人开着（minimaxOpenTo；判据与出片那一发
 *                 的套餐门禁同一个 tokens.videoPlanDenial）。只说「换 MiniMax」的话，他换过去就是 403 PLAN_REQUIRED，同一面墙撞两次；
 *   "swap"     —— 普通出片、MiniMax 做得了、至少有一档对他开着（或 paid 没传 = 不知道套餐，见 regionDenial 的 paid）。
 * ★ 样片第一步（draft:true）按普通出片算：换到 MiniMax 就是不走样片、直接出片，做得出来。
 * ★ 这一段能不能照搬过去要 App 那边看（真人档要照片起拍；服务端不知道这一段有没有照片、几张参考图），这句话只说到「有这个替代」。
 */
function swapVariant({ upstream, providers, r2v, draftFinal, paid }) {
  if (upstream !== "ark" || !providers.includes("minimax")) return "none";
  if (r2v || draftFinal) return "noAlt";
  if (paid === null || paid === undefined) return "swap";
  return minimaxOpenTo(paid === true) ? "swap" : "paidOnly";
}

/**
 * 这台服务器上的 MiniMax 出片有没有**哪一档**对这个人开着 —— swapVariant 挑「换 MiniMax」还是「MiniMax 要付费」只问它。
 * 判据与出片那一发的套餐门禁是同一个（tokens.videoPlanDenial，铁律六），挨个问这台服务器给得出的几种 MiniMax 出片：
 *   · 真人档（minimax_video，海螺 2.3）：videoPlanDenial 那一支不看具体型号，问一个在册的就够；
 *   · H3（minimax_v2）：只在 V2 开着时算（config/minimax.minimaxV2Enabled —— V2 路由开不开问的是同一个），
 *     价目表（tokens.MINIMAX_SEC_COST）里的每一格挨个问。2026-10-26 起 H3-Lite · 480P 在免费档里（tokens.FREE_VIDEO_ALLOW），
 *     所以国际站上海外的免费用户被拦 Seedance 时听到的是「换 MiniMax」。
 * ★ 2026-10-26 审核点名的就是这里：原来只问真人档。H3-Lite 免费之后，海外的免费用户被告知「MiniMax 要付费套餐」，
 *   而他们明明有一档免费的 —— 话把人往付钱那边推。
 * ★ 按「这家有没有一档对你开着」判，不按「被拦的这一档在 MiniMax 上对标哪一档」判：拒绝话只说到供应商（换成 MiniMax），
 *   哪几档点得动由 App 照 /api/ark/health 的 freeVideo 与钱包的 paid 画（会员档置灰 + 去升级）；
 *   Seedance 档位 → MiniMax 档位的对标是 App 档位表的事，服务端不再抄一份。
 * @param {boolean} paid 按套餐门禁算这个人算不算付费用户（regionDenial 的 paid，已经排除了「不知道」）
 */
function minimaxOpenTo(paid) {
  if (!videoPlanDenial({ paid, kind: "minimax_video", model: MINIMAX_REAL_MODELS[0] })) return true;
  if (!minimaxV2Enabled()) return false;
  return Object.entries(MINIMAX_SEC_COST).some(([model, row]) =>
    Object.keys(row).some((resolution) => !videoPlanDenial({ paid, kind: "minimax_v2", model, resolution })),
  );
}

/** 拒绝话里中英两半之间的分隔（不换行，理由见 DENIAL_TEXT） */
const DENIAL_SEP = " / ";

/**
 * 被地区拦下时那一整句话（四种，按 swapVariant 挑）：**英文在前、中文在后的一行**。
 * ★ 双语：老版 App 不认识 REGION_UNAVAILABLE，会把服务端这句原样显示 —— 而被拦的恰恰是海外用户，默认英文界面。
 *   新版 App 按 code 说自己的整句，不读这句。
 * ★★ 长度是量着老 App 定的（2026-10-26 审核，app 仓 studio/flowStore.genNode）：段卡上的报错是
 *   `why`（再接一小句钱上的话）截到 240 字，步骤日志截到 160 字。所以**英文在前、整句压在 200 字以内、英文那半在 150 字以内**
 *   （测试钉着）—— 老写法中文在前、整句 289 字，英文界面的人恰好看不到唯一能照着做的那半句「先更新 App」。
 *   「没受理、没扣费」与「接下来怎么办」两半各说一遍，截在哪儿都不丢。
 * ★★ 句子里只许出现「JSON 里不用转义」的字符：不许有 ASCII 双引号、反斜杠、换行 / 控制字符。
 *   老 App 用 `"message"\s*:\s*"([^"]+)"` 从**原始回包文本**里抠这句话（app 仓 ai/arkClient.billingDenialError）：
 *   带引号会被拦腰截断，换行会以 `\n` 两个字符原样上屏。所以中英之间用「 / 」隔开，不换行。
 * ★ 只说「这一发」没受理、没扣费：出片之前补画的帧、推演的方案各自已经结算过，这句话不替它们打包票。
 * ★ 不写原因（「政策原因」的出处还没落进文档，见文件头）。
 * ★ paidOnly 说「付费套餐，或充值过任意一次」：与 tokens.isPaidUser 的口径一致（付费套餐**或**付过任何一笔钱）。
 *   2026-10-26 起它只在「这台服务器上的 MiniMax 没有一档对这个人开着」时才说（minimaxOpenTo）：国际站上 V2 开着、
 *   免费档里有 H3-Lite 时，海外的免费用户听到的是 swap 那一句。
 */
const DENIAL_TEXT = Object.freeze({
  // ★ 「没有能用的就先更新 App」，不是「没有的话」（2026-10-26，H3-Lite 进免费档之后）：这句话只有老 App 会原样显示，
  //   而老 App 的 MiniMax 只有真人档 —— 海外的免费用户在那里看得见真人档、却是灰的「会员档」。原来只说「没有的话」，
  //   他们看见了就不会去更新，只会以为要付钱；免费的 H3-Lite 在新版 App 里。整句 199 字，贴着 200 的上限（测试钉着）。
  swap: Object.freeze({
    en: "Seedance is not available in your region; not accepted, not charged. Switch the model to MiniMax (update the app if none is usable).",
    zh: "你所在的地区暂不提供 Seedance 出片：这一发没有受理、也没有扣费。请换成 MiniMax（没有能用的就先更新 App）。",
  }),
  paidOnly: Object.freeze({
    en: "Seedance is not available in your region; not accepted, not charged. MiniMax works here with a paid plan or after any top-up.",
    zh: "你所在的地区暂不提供 Seedance 出片：这一发没有受理、也没有扣费。这里能用的 MiniMax 要付费套餐，或充值过任意一次。",
  }),
  noAlt: Object.freeze({
    en: "Seedance is not available in your region, and this kind of video has no other model here; not accepted, not charged.",
    zh: "你所在的地区暂不提供 Seedance 出片，这类片子（参考视频、模板、重拍、延长、样片定稿）也没有别的模型可换：这一发没有受理、也没有扣费。",
  }),
  none: Object.freeze({
    en: "Video generation is not available in your region; not accepted, not charged.",
    zh: "你所在的地区目前没有可用的出片模型：这一发没有受理、也没有扣费。",
  }),
});

/** 拒绝话与补在后面的话都只许用 JSON 里不用转义的字符（理由见 DENIAL_TEXT 的 ★★）；不是这样的当编程错误抛 */
function assertPlainText(s, what) {
  // 控制字符那一段是刻意的：换行会以两个字符原样上屏（老 App），见 DENIAL_TEXT
  if (typeof s !== "string" || !s || /["\\\u0000-\u001f\u007f]/.test(s) || s.includes(DENIAL_SEP)) {
    throw new TypeError(`videoRegion: ${what} 必须是非空的一行，且不含 ASCII 双引号 / 反斜杠 / 控制字符 / 「 / 」`);
  }
}

/**
 * 在一句拒绝话后面补一句别的实情：英文补在英文那半后面、中文补在中文那半后面，仍是「英文 / 中文」一行。
 * 拒绝话的格式只有本文件知道 —— 路由要补话只经这里，别自己拼字符串（2026-10-26 最终审核：白模化原来写
 * `${why}。出片那一笔…`，接在以「。」结尾的拒绝话后面就成了「。。」，补的那句钱上的话也只有中文）。
 * @param {string} message regionDenial(...).message（别的字符串当编程错误抛）
 * @param {{ en: string, zh: string }} note 两种语言各一句，各自带句末标点
 */
function withDenialNote(message, note) {
  const halves = String(message ?? "").split(DENIAL_SEP);
  if (halves.length !== 2) throw new TypeError("videoRegion.withDenialNote: 不是 regionDenial 拼出来的拒绝话（要恰好一处「 / 」）");
  assertPlainText(note?.en, "note.en");
  assertPlainText(note?.zh, "note.zh");
  return `${halves[0]} ${note.en}${DENIAL_SEP}${halves[1]}${note.zh}`;
}

/**
 * 「这一发按地区该不该拦」—— **纯判定**：只看政策表（ZONE_UPSTREAMS），**不看 gate**。
 * ★ 不看 gate 是刻意的：observe 档要的正是「本该拦、这次放行了」那一行日志，判定得照常算出来；
 *   怎么执行（off 不判 / observe 只记 / on 才拦）由门禁那一处（arkGateway.regionGate）按 gateMode() 决定，别在这里替它决定。
 * ★ 不看「配没配」：某一家没配 key 不改变准不准用（见 ZONE_UPSTREAMS 的注释）；回包里的 providers 才按配置筛 ——
 *   那是告诉 App「换到哪一家走得通」。（MiniMax 走哪个站不是「配没配」，是「这一发打到谁」，所以 gatedProviderOf 要问它。）
 * ★ 先问「归不归这道闸管」、再查 zone（2026-10-26 审核）：门禁挂在 arkGateway.chargedArkCall 上，而那里同时走
 *   出图 / 对话 / 真人档 / 服务端自己发起的调用 —— 有的手上根本没有 req。不归这道闸管的调用漏传 zone 无所谓，
 *   要是照样抛，就是把一个门禁根本不管的功能变成 500。归它管的照旧漏传就抛（零症状的漏传要响）。
 *
 * ★ r2v / draftFinal / paid **只影响说哪一句**（swapVariant），不影响拦不拦：拦不拦只看政策表。
 *
 * @param {object} o
 * @param {string} o.kind  priceOf 的 kind（task / image / chat / minimax_video / minimax_v2 …）
 * @param {string} o.model
 * @param {"cn"|"intl"|"blocked"} [o.zone] 归这道闸管的调用**必填**（一般是 requestZone(req).zone），漏传 / 认不出直接抛；
 *   不归它管的调用（gatedProviderOf 回 null）不看它
 * @param {object|null} [o.r2v]  与 chargedArkCall / tokens.videoPlanDenial 收的同一个（resolveR2v 的结论；白模化的预检传
 *   `{ kind: "blockout" }`，与它旁边那道套餐预检同一个记号）。有它 = 带参考视频，MiniMax 做不了
 * @param {object|null} [o.draftFinal] 同上（resolveDraftFinal 的结论）。有它 = 样片第二步，MiniMax 做不了
 * @param {boolean|null} [o.paid] 按套餐门禁算这个人算不算付费用户（arkGateway.regionGate 算：管理员算付费 —— billing.preAuthorize
 *   对管理员免套餐门禁）。null / 不传 = 不知道（只有白模化的预检不读钱包，而它带着 r2v、本来就说 noAlt）
 * @returns {null | { code: "REGION_UNAVAILABLE", reason: "region", zone: string, providers: string[], message: string }}
 *   null = 放行。否则 reason 与既有拒绝回包（model / plan / funds）同一个位、message 是能直接显示的整句（中英一行）、
 *   providers 是门禁开着时这个地区**换得过去**的供应商（可能是空的；有 minimax 也不等于这一发换得过去，那由 message 说）
 */
function regionDenial({ kind, model, zone, r2v = null, draftFinal = null, paid = null } = {}) {
  const upstream = gatedProviderOf(kind, model);
  if (!upstream) return null;
  assertZone(zone);
  if (ZONE_UPSTREAMS[zone].includes(upstream)) return null;
  const providers = allowedProviders(zone);
  const { en, zh } = DENIAL_TEXT[swapVariant({ upstream, providers, r2v, draftFinal, paid })];
  return { code: REGION_UNAVAILABLE, reason: "region", zone, providers, message: `${en}${DENIAL_SEP}${zh}` };
}

/**
 * 地区相关的配置问题。并进 config/preflight 的总检查（生产有问题 = 拒绝启动；别的环境只告警）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function collectVideoRegionProblems(env = process.env) {
  const problems = [];
  const gateRaw = String(env.VIDEO_REGION_GATE ?? "").trim();
  if (gateRaw && !GATE_MODES.includes(gateRaw.toLowerCase())) {
    problems.push(
      `VIDEO_REGION_GATE=${logSafe(gateRaw, 32)} 认不出（只认 ${GATE_MODES.join(" / ")}）：现在按 ${DEFAULT_GATE} 跑 —— 只记日志、一发都不拦`,
    );
  }
  const forceRaw = String(env.VIDEO_ZONE_FORCE ?? "").trim();
  if (forceRaw) {
    if (env.NODE_ENV === "production") {
      // ★ 生产直接拒绝启动、不是只告警：写 cn 就把所有人判成境内，地区门禁整个失效，而且零症状
      problems.push("生产环境配了 VIDEO_ZONE_FORCE：它把每个请求的出片地区钉死（写 cn = 对海外放开 Seedance，整道地区门禁失效）—— 只给本机开发用，生产删掉这一行");
    } else if (!Object.hasOwn(ZONE_UPSTREAMS, forceRaw.toLowerCase())) {
      problems.push(`VIDEO_ZONE_FORCE=${logSafe(forceRaw, 32)} 认不出（只认 ${Object.keys(ZONE_UPSTREAMS).join(" / ")}）：按没配处理`);
    }
  }
  return problems;
}

module.exports = {
  ZONE_UPSTREAMS,
  GATE_MODES,
  DEFAULT_GATE,
  REGION_UNAVAILABLE,
  zoneProviders,
  allowedProviders,
  offeredProviders,
  gateMode,
  forcedZone,
  requestZone,
  gatedProviderOf,
  regionDenial,
  withDenialNote,
  collectVideoRegionProblems,
};
