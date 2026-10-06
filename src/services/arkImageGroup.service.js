// src/services/arkImageGroup.service.js
// 组图：一次请求让 Seedream 出一组内容关联的图（`sequential_image_generation: "auto"`），2026-10-05。
// App 的「跟着做 C · 九宫格分镜」拿它一次画出 4~9 个镜头的开头画面（app 仓 docs/guided-modes-design.md §七）。
//
// ★★ 为什么不能走单张出图那条代理（POST /api/ark/images/generations）：
//   ① 钱：那条路按**调用**收一张的钱，组图按**实际画出的张数**计费（官方：「仅对成功生成图片按张数进行计费」）。
//      所以这里是「按上限预扣 → 按拿到手的张数结算、多退」—— 与 ASR 的预扣多退同一个形状（billing.settleOverCharge）。
//   ② 时间：一组 6 张实测 249 秒、9 张约 6 分钟，客户端到我们之间挡着 Cloudflare 的 125 秒读超时 ——
//      同步等必断。于是「受理 → 后台画 → 客户端短轮询」，与视频任务同一个形状；每画好一张就追加进库，人边等边看。
//   ③ 上游：非流式要等**全部**画完才回响应头，Node 自带 fetch 300 秒等不到响应头就断（见 arkGateway.openArkStream），
//      所以对方舟走流式（SSE），一张一条事件。
//
// ★ 钱的序列仍只有 services/billing 那一份：preAuthorize（冻结 → 套餐门禁 → 每日上限 → 原子预扣）、
//   refundUnaccepted（一张没拿到 = 上游等于没受理，全退进 addon）、settleOverCharge（拿到 k 张，多扣的按扣的那一侧冲正回 plan）、
//   noteFreeCall（管理员免单照实记账）。这里不另写一套记账。
// ★ 「用户只为拿到手的图付钱」：结算按收到的图片张数，不按方舟 usage.generated_images（两者不等时只记日志对账）——
//   流中途断开时方舟那边可能还画了几张、也向我们收了钱，那几张用户拿不到，差价我们吃。
// ★ 进程在画到一半时没了（pm2 reload 部署、崩溃）：这一组会一直挂着 running。没有常驻扫描任务（cluster 两个实例，
//   扫描要做实例判断），改成**懒回收**：这个人下次查询 / 开新的一组时，把超过 STALE_MS 还没结束的按「画到哪张算哪张」结掉。
const mongoose = require("mongoose");
const ArkImageGroup = require("../models/ArkImageGroup");
const wallet = require("./tokenWallet.service");
const billing = require("./billing.service");
const { ADMIN_ROLE } = require("../utils/roles");
const { arkConfigured, openArkStream } = require("./arkGateway.service");
const {
  imageTokensOf,
  priceOf,
  paidOnlyDenial,
  GROUP_IMAGE_MODELS,
  GROUP_MAX_IMAGES,
  GROUP_MAX_REFS,
} = require("../config/tokens");

/** 一组最多等多久（整条流）。9 张约 6 分钟，15 张按 40 秒一张约 10 分钟，再留余量 */
const T_GROUP = 15 * 60_000;
/** 超过这么久还是 running = 跑它的进程没了（T_GROUP 到点一定会结束，所以必须比它长） */
const STALE_MS = 20 * 60_000;
/** 提示词上限：只是给内存设个顶，过不过得了方舟由方舟说（不过就全额退） */
const PROMPT_MAX = 6000;
/** 尺寸只收两种写法：WxH 像素，或 1K/2K/4K 档位（与单张出图同一套，方舟按模型再校验一次） */
const SIZE_RE = /^(?:\d{3,5}x\d{3,5}|[1-4]K)$/i;
/** 「这一组的 memo」：前缀与单张出图一致（`image <model>`），对账时按模型归类不用另写规则 */
const memoOf = (model, maxImages) => `image ${model} 组图×${maxImages}`;

/**
 * 校验并翻译成上游请求体（白名单：只有这几个键会被发出去）。
 * @returns {{issue:string}|{model:string,maxImages:number,upstream:object}}
 */
function parseGroupRequest(body) {
  const model = String(body?.model ?? "");
  if (!GROUP_IMAGE_MODELS.has(model)) return { issue: "这一档出不了组图（只有 Seedream 4.0 / 4.5 可以）" };
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return { issue: "缺少提示词" };
  if (prompt.length > PROMPT_MAX) return { issue: `提示词太长（最多 ${PROMPT_MAX} 字）` };
  const refs = body?.image === undefined ? [] : Array.isArray(body.image) ? body.image : [body.image];
  if (refs.some((u) => typeof u !== "string" || !/^(?:https:\/\/|data:image\/)/i.test(u))) {
    return { issue: "参考图只收 https 地址或图片的 dataURL" };
  }
  if (refs.length > GROUP_MAX_REFS) return { issue: `参考图最多 ${GROUP_MAX_REFS} 张` };
  // 只收真数字（"6" 这种字符串也拒）：张数就是价钱，形状不对的一律不猜
  const maxImages = typeof body?.max_images === "number" ? body.max_images : NaN;
  if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > GROUP_MAX_IMAGES) {
    return { issue: `一组只能画 1~${GROUP_MAX_IMAGES} 张` };
  }
  // 官方：参考图张数 + 出图张数 ≤ 15。超了方舟会少画，而我们按 max_images 预扣 —— 当场拒，不让钱白冻着
  if (refs.length + maxImages > GROUP_MAX_IMAGES) {
    return { issue: `参考图与要画的张数加起来不能超过 ${GROUP_MAX_IMAGES}（现在是 ${refs.length} + ${maxImages}）` };
  }
  const size = body?.size === undefined ? "2K" : String(body.size);
  if (!SIZE_RE.test(size)) return { issue: "画幅尺寸的写法不对" };
  return {
    model,
    maxImages,
    upstream: {
      model,
      prompt,
      ...(refs.length ? { image: refs.length === 1 ? refs[0] : refs } : {}),
      size,
      // 与 App 单张出图一致：这些是出片的中间物（当视频的开头画面），不单独对外展示
      watermark: false,
      response_format: "url",
      sequential_image_generation: "auto",
      sequential_image_generation_options: { max_images: maxImages },
      stream: true,
    },
  };
}

/** 方舟错误体 → { code, message }（认不出就 null） */
function errorOf(e) {
  if (!e || typeof e !== "object") return null;
  const code = String(e.code ?? "").slice(0, 80);
  const message = String(e.message ?? "").slice(0, 300);
  return code || message ? { code, message } : null;
}
function upstreamError(text) {
  try {
    const j = JSON.parse(text || "{}");
    return errorOf(j?.error) || errorOf(j);
  } catch {
    return null;
  }
}
function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
const imageOf = (ev, fallbackIndex) => ({
  index: Number.isInteger(ev?.image_index) ? ev.image_index : fallbackIndex,
  url: String(ev.url).slice(0, 2000),
  size: String(ev?.size ?? "").slice(0, 24),
});
const failureOf = (ev, fallbackIndex) => ({
  index: Number.isInteger(ev?.image_index) ? ev.image_index : fallbackIndex,
  ...(errorOf(ev?.error) || { code: "", message: "" }),
});

/**
 * SSE → 一条条 data 字符串（多行 data 按规范用 \n 拼）。事件类型以 JSON 里的 `type` 为准，`event:` 行忽略。
 * ★ 按字节流逐行切：一张图的事件可能被拆在两个 chunk 里，也可能一个 chunk 里有好几条。
 */
async function* sseData(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  let data = [];
  const takeLine = (line) => {
    if (line === "") {
      const out = data.length ? data.join("\n") : null;
      data = [];
      return out;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    return null;
  };
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const out = takeLine(buf.slice(0, nl).replace(/\r$/, ""));
      buf = buf.slice(nl + 1);
      if (out !== null) yield out;
    }
  }
  buf += decoder.decode();
  if (buf) {
    const out = takeLine(buf.replace(/\r$/, ""));
    if (out !== null) yield out;
  }
  if (data.length) yield data.join("\n");
}

/** 进度写库：失败只吼不断流（结束时会把全部图片整份写一遍） */
async function progress(jobId, update) {
  try {
    await ArkImageGroup.updateOne({ _id: jobId, status: "running" }, update);
  } catch (e) {
    console.error(`[ark-group] ${jobId} 进度写库失败：`, e.message);
  }
}

/** 「这个人」：后台结算 / 懒回收时手上没有 req.user，按受理那一刻记下的免单位还原（isAdmin 只认 role） */
const userOf = (job) => ({ _id: job.userId, ...(job.free ? { role: ADMIN_ROLE } : {}) });

/**
 * 按拿到手的张数把钱结掉。**调用前必须已经把这一组从 running 原子地改成了终态**（谁改成功谁结算，只结一次）。
 */
async function settleMoney(job, billable, snapshot = null) {
  const user = userOf(job);
  const memo = memoOf(job.model, job.maxImages);
  const actual = billable * job.unitCost;
  if (job.free) {
    if (billable > 0) await billing.noteFreeCall({ user, cost: actual, memo, snapshot });
    return;
  }
  // 一张没拿到 = 上游等于没受理：全退进 addon（W2，我们亏待了用户，月末不该蒸发）
  if (billable === 0) await billing.refundUnaccepted({ user, cost: job.prepaid, memo });
  // 拿到 k 张：多扣的冲正回 plan（不进 addon —— 否则「要 15 张、只画 1 张」就是把当月额度洗成永久余额的路）
  else await billing.settleOverCharge({ user, prepaid: job.prepaid, actual, memo });
}

/** 把一组结掉：原子地占住终态 → 结算。被懒回收抢先了就什么都不做 */
async function finish({ jobId, snapshot, images, failures, usage, fatal, broke }) {
  const job = await ArkImageGroup.findById(jobId).select("maxImages unitCost free").lean();
  if (!job) return;
  const sorted = [...images].sort((a, b) => a.index - b.index);
  const billable = Math.min(sorted.length, job.maxImages);
  const up = Number(usage?.generated_images);
  const upstreamGenerated = Number.isFinite(up) ? up : undefined;
  if (upstreamGenerated !== undefined && upstreamGenerated !== billable) {
    console.warn(`[ark-group] ${jobId} 方舟说画了 ${upstreamGenerated} 张、收到 ${billable} 张，按收到的结算（差价对账）`);
  }
  // 没等到「画完了」也没有明说失败 = 中途断了
  const interrupted = !usage && !fatal;
  const brokeNote = broke ? `（${broke}）` : "";
  const set = {
    status: billable > 0 ? "done" : "failed",
    images: sorted.slice(0, job.maxImages),
    failures,
    generated: billable,
    upstreamGenerated,
    code: fatal ? fatal.code : interrupted ? "INTERRUPTED" : "",
    message: fatal ? fatal.message : interrupted ? `没等到画完连接就断了${brokeNote}，画到哪张算哪张` : "",
    interrupted,
    // free 在受理那一拍就写定了（runGroup 起跑之前），这里读到的就是结算时的真值
    charged: job.free ? 0 : billable * job.unitCost,
    finishedAt: new Date(),
  };
  // ★ 普通 $set，不用聚合管道：管道里以美元符开头的字符串会被当成字段路径，而 url / message 是外面来的
  const claimed = await ArkImageGroup.findOneAndUpdate(
    { _id: jobId, status: "running" },
    { $set: set },
    { returnDocument: "after" },
  ).lean();
  if (!claimed) {
    console.warn(`[ark-group] ${jobId} 已被回收结算过，这次结果不再动钱`);
    return;
  }
  await settleMoney(claimed, billable, snapshot);
}

/** 后台画一组。自己兜住一切异常，保证 finish 一定跑到（钱一定结掉） */
async function runGroup({ jobId, upstream, snapshot }) {
  const images = [];
  const failures = [];
  let usage = null;
  let fatal = null;
  let broke = "";
  try {
    const up = await openArkStream({ path: "/images/generations", body: upstream, timeoutMs: T_GROUP });
    if (!up.stream) {
      // 非 2xx / 连不上：上游没受理（敏感词、尺寸不对、限流……），一张都不会有
      fatal = upstreamError(up.text) || { code: `HTTP_${up.status}`, message: `upstream ${up.status}` };
    } else if (/json/i.test(up.contentType)) {
      // 上游没走流式（不该发生）：按一次性回包读，data 里成功的是 url、失败的是 error
      const j = parseJson(await new Response(up.stream).text());
      (Array.isArray(j?.data) ? j.data : []).forEach((d, i) => {
        if (typeof d?.url === "string") images.push(imageOf(d, i));
        else if (d?.error) failures.push(failureOf(d, i));
      });
      usage = j?.usage ?? null;
      if (!images.length) fatal = errorOf(j?.error) || (usage ? null : { code: "BAD_REPLY", message: "upstream reply unreadable" });
    } else {
      for await (const raw of sseData(up.stream)) {
        if (raw === "[DONE]") break;
        const ev = parseJson(raw);
        if (!ev || typeof ev !== "object") continue;
        const type = String(ev.type ?? "");
        if (type.endsWith("partial_succeeded") && typeof ev.url === "string") {
          const it = imageOf(ev, images.length);
          images.push(it);
          await progress(jobId, { $push: { images: it } });
        } else if (type.endsWith("partial_failed")) {
          // 审核没过的那一张方舟会接着画下一张；内部错误（500）之后就不画了 —— 两种都只是记下来
          const f = failureOf(ev, -1);
          failures.push(f);
          await progress(jobId, { $push: { failures: f } });
        } else if (type.endsWith("completed")) {
          usage = ev.usage ?? {};
        } else if (ev.error) {
          fatal = errorOf(ev.error);
        }
      }
    }
  } catch (e) {
    broke = String((e && e.name) || e).slice(0, 80);
    console.error(`[ark-group] ${jobId} 流中途断开：${broke}（已收到 ${images.length} 张）`);
  }
  try {
    await finish({ jobId, snapshot, images, failures, usage, fatal, broke });
  } catch (e) {
    // ★ 结算失败要吼：这一组会挂在 running，STALE_MS 之后由懒回收按已写进库的图片结掉
    console.error(`[ark-group] ${jobId} 结算失败：`, e);
  }
}

/** 懒回收：超过 STALE_MS 还在 running 的，按已经写进库的图片张数结掉 */
async function reapStale(filter) {
  const cutoff = new Date(Date.now() - STALE_MS);
  const stale = await ArkImageGroup.find({ ...filter, status: "running", startedAt: { $lt: cutoff } })
    .select("_id images maxImages unitCost free")
    .limit(20)
    .lean();
  for (const s of stale) {
    const billable = Math.min((s.images || []).length, s.maxImages);
    const claimed = await ArkImageGroup.findOneAndUpdate(
      { _id: s._id, status: "running", startedAt: { $lt: cutoff } },
      {
        $set: {
          status: billable > 0 ? "done" : "failed",
          generated: billable,
          charged: s.free ? 0 : billable * s.unitCost,
          interrupted: true,
          code: "INTERRUPTED",
          message: "画这一组的服务中途重启了，画到哪张算哪张",
          finishedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    ).lean();
    if (!claimed) continue;
    console.warn(`[ark-group] ${s._id} 超时未结束，按 ${billable} 张结算`);
    await settleMoney(claimed, billable);
  }
}

/** 给客户端看的形状 */
function shapeGroup(g) {
  return {
    id: String(g._id),
    status: g.status,
    model: g.model,
    maxImages: g.maxImages,
    unitCost: g.unitCost,
    prepaid: g.prepaid,
    charged: g.charged,
    generated: g.generated,
    images: [...(g.images || [])].sort((a, b) => a.index - b.index).map(({ index, url, size }) => ({ index, url, size })),
    failures: (g.failures || []).map(({ index, code, message }) => ({ index, code, message })),
    interrupted: Boolean(g.interrupted),
    code: g.code || "",
    message: g.message || "",
    createdAt: g.createdAt,
    finishedAt: g.finishedAt ?? null,
  };
}

/**
 * 受理一组。返回的 status / body 可以直接回给客户端；wallet 由路由写进响应头。
 * @returns {Promise<{status:number, body:object, wallet?:object|null}>}
 */
async function startImageGroup({ user, body }) {
  if (!arkConfigured()) return { status: 501, body: { ok: false, message: "ark not configured" } };
  const req = parseGroupRequest(body);
  if (req.issue) {
    return { status: 400, body: { ok: false, code: "IMAGE_GROUP_PARAMS", message: `${req.issue}——当前请求未被受理，也没有扣费。` } };
  }
  await reapStale({ userId: user._id });

  const unitCost = imageTokensOf(req.model);
  // 「一组值多少」只在 config/tokens.imageCountCap 一处算（= 单价 × max_images）
  const cost = priceOf("image", req.upstream);
  const memo = memoOf(req.model, req.maxImages);

  // ★ 先占位、再扣钱：并发两发只有一发建得出来（部分唯一索引），输的那一发一分钱没动
  let job;
  try {
    job = await ArkImageGroup.create({ userId: user._id, model: req.model, maxImages: req.maxImages, unitCost });
  } catch (e) {
    if (e && e.code === 11000) {
      const running = await ArkImageGroup.findOne({ userId: user._id, status: "running" }).select("_id").lean();
      return {
        status: 409,
        body: {
          ok: false,
          code: "IMAGE_GROUP_BUSY",
          message: "上一组还在画，画完再开下一组——当前请求未被受理，也没有扣费。",
          id: running ? String(running._id) : null,
        },
      };
    }
    throw e;
  }

  let pre;
  try {
    // 套餐门禁的判据只有 paidOnlyDenial 一处（与 chargedArkCall 同一个读法）
    const before = await wallet.getWallet(user._id);
    pre = await billing.preAuthorize({ user, cost, memo, denyReason: paidOnlyDenial(before?.planId, req.model) || "" });
  } catch (e) {
    await ArkImageGroup.deleteOne({ _id: job._id }).catch(() => {});
    throw e;
  }
  if (!pre.ok) {
    await ArkImageGroup.deleteOne({ _id: job._id });
    return { status: pre.status, body: pre.body, wallet: pre.wallet };
  }
  const prepaid = pre.free ? 0 : cost;
  try {
    await ArkImageGroup.updateOne({ _id: job._id }, { $set: { prepaid, free: pre.free } });
  } catch (e) {
    // 钱扣了、账没记上：当场退、撤掉这一组（不然它挂着 running 挡住下一组，回收时又不知道该退多少）
    await billing.refundUnaccepted({ user, cost: prepaid, memo });
    await ArkImageGroup.deleteOne({ _id: job._id }).catch(() => {});
    throw e;
  }

  // 后台画：不 await —— 请求马上回任务号（runGroup 自己兜住一切异常并结算）
  void runGroup({ jobId: job._id, upstream: req.upstream, snapshot: pre.before });
  return { status: 202, body: { ok: true, id: String(job._id), maxImages: req.maxImages, unitCost, prepaid }, wallet: pre.wallet };
}

/** 查一组（只给本人）。顺手回收这一组（如果它跑的进程没了） */
async function getImageGroup({ user, id }) {
  if (!mongoose.isValidObjectId(id)) return null;
  await reapStale({ _id: new mongoose.Types.ObjectId(String(id)), userId: user._id });
  const g = await ArkImageGroup.findOne({ _id: id, userId: user._id }).lean();
  return g ? shapeGroup(g) : null;
}

/** 这个人最近 24 小时的几组（新的在前）：App 丢了任务号时据此接回来 */
async function listImageGroups({ user, limit = 5 }) {
  await reapStale({ userId: user._id });
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await ArkImageGroup.find({ userId: user._id, createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(20, limit)))
    .lean();
  return rows.map(shapeGroup);
}

module.exports = {
  T_GROUP,
  STALE_MS,
  parseGroupRequest,
  sseData,
  startImageGroup,
  getImageGroup,
  listImageGroups,
  // 测试用：不经过 HTTP 直接跑一组 / 回收
  runGroup,
  reapStale,
};
