// src/services/arkTransfer.service.js
// 方舟成片 → Cloudinary 的**后台异步转存**：认领、去重、执行、查询进展，只有这一份实现。
//
// 为什么从"客户端 POST 一下、服务端同步搬完再应答"改成后台任务（2026-08-21 真机实测）：
// 手机端等这一趟要跨三段网络（手机→server→TOS→Cloudinary），弱网（美国 Cricket）下
// 180s 的客户端超时根本不够——超时后客户端只能静默退回方舟直链，随后预览黑屏、合并
// 抓 blob 也超时。而"搬 20MB 去 Cloudinary"这件事其实与客户端毫无关系：server 在轮询
// 端点看到 succeeded 的那一刻就有全部输入，自己搬完把结果记下来，客户端下次轮询顺手
// 拿走就是。客户端从"傻等一次 HTTP"变成"读一个状态"，弱网只影响读状态那几十字节。
//
// 三个入口（全在 routes/ark.routes.js）：
//   · 轮询端点带 ?transfer=1 看到 succeeded → ensureTransfer（幂等，去重后后台开搬）
//   · POST /transfer-video {wait:false}      → requestTransfer（受理式 202，失败会重试）
//   · POST /transfer-video（老客户端阻塞式）  → waitTransfer（同一份登记上等结果）
//
// ★ 拉取/上传本体仍在 videoAsset.service（铁律六）：这里只管"谁搬、搬没搬过、结果在哪"。
const ArkVideoTransfer = require("../models/ArkVideoTransfer");
const videoAsset = require("./videoAsset.service");
const { assertPublicUrl } = require("../utils/ssrfGuard");

/** 后台搬运的下载/上传超时。比 videoAsset 的默认 60s 宽得多是刻意的：这是后台任务，
 *  没有任何人在线上等它——宁可慢慢搬成，也不要为了快而把弱链路上的大文件掐死
 *  （2026-08-21 实测：ECS 拉 TOS 跨境 + 传 Cloudinary 跨境，两跳都可能过分钟）。 */
const TRANSFER_FETCH_TIMEOUT_MS = Number(process.env.ARK_TRANSFER_FETCH_TIMEOUT_MS || 300_000);
const TRANSFER_UPLOAD_TIMEOUT_MS = Number(process.env.ARK_TRANSFER_UPLOAD_TIMEOUT_MS || 300_000);

/** pending 多久没动静算"僵尸"（认领它的进程死在半路）——可被重新认领。
 *  取值要 > 上面两个超时之和的常态（正常一趟几十秒到几分钟）；太短会把还活着的搬运
 *  抢过来重搬一遍（不致错，只是白花带宽）。 */
const STALE_PENDING_MS = 10 * 60 * 1000;

/** 单实例并发上限。downloadToBuffer 是整段进内存的（最大 80MB/段），不设限的话
 *  几个用户同时出片就能把实例内存顶穿——超出的排队慢慢来，后台任务不赶时间。 */
const MAX_CONCURRENT = 3;

let running = 0;
const queue = [];
/** 在途搬运的 promise 集合：优雅退出与测试（idle()）用 */
const inflight = new Set();

/**
 * 产物身份键：协议//主机/路径，**不含 query**。
 * TOS 的签名参数每次轮询可能重签——同一个成片，轮询自动转存看到的 URL 和老客户端
 * POST 过来的 URL 只有 query 不同；按整串去重等于没去重（20MB 白搬两遍）。
 */
function sourceKeyOf(rawUrl) {
  const u = new URL(String(rawUrl));
  return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname}`;
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

/** 后台开搬（fire-and-forget）。异常已在 runTransfer 里落库+打日志，这里只兜进程级意外 */
function schedule(key, url, userId) {
  const p = enqueue(() => runTransfer(key, url, userId)).catch((e) => {
    console.error(`[ark-transfer] 未捕获的转存异常 ${key.slice(0, 120)}:`, (e && e.message) || e);
  });
  inflight.add(p);
  p.finally(() => inflight.delete(p));
}

/** 真正搬一趟：拉 TOS → 传 Cloudinary → 结果落库。结果（含失败）**必须**落库——
 *  轮询端点报的就是库里这份，落不下去客户端会一直看到 pending 干等（铁律八）。 */
async function runTransfer(key, url, userId) {
  try {
    // 防御两道与 /asset 同款：url 来自方舟响应或已过路由校验，这里再收一次口不花钱
    if (!videoAsset.isArkVideoUrl(url)) throw new Error("not an ark video url");
    await assertPublicUrl(url);
    const buf = await videoAsset.downloadToBuffer(url, { timeoutMs: TRANSFER_FETCH_TIMEOUT_MS });
    const cldKey = `${userId || "anon"}-${Date.now()}-seg`;
    const permanent = await videoAsset.uploadVideoBuffer(buf, cldKey, { timeoutMs: TRANSFER_UPLOAD_TIMEOUT_MS });
    if (!permanent) throw new Error("cloudinary returned no url");
    await ArkVideoTransfer.updateOne({ sourceKey: key }, { $set: { state: "done", url: permanent, error: null } });
    console.log(`[ark-transfer] done ${key.slice(0, 120)} -> ${permanent.slice(0, 100)}`);
  } catch (e) {
    const msg = ((e && e.message) || String(e)).slice(0, 300);
    console.warn(`[ark-transfer] failed ${key.slice(0, 120)}: ${msg}`);
    // 只在还 pending 时写 failed：僵尸重认领的场景下，别把另一个进程刚写的 done 打翻
    await ArkVideoTransfer.updateOne({ sourceKey: key, state: "pending" }, { $set: { state: "failed", error: msg } }).catch(
      (e2) => console.error(`[ark-transfer] 连失败状态都没落下去 ${key.slice(0, 120)}:`, e2.message)
    );
  }
}

/**
 * 幂等登记：没登记过就认领并后台开搬；登记过就原样返回进展。
 * 轮询端点每 5s 打一次，所以常态路径只有一次 findOne（索引等值查询）。
 * @returns {Promise<{state:string,url?:string,error?:string}>} lean 文档
 */
async function ensureTransfer(rawUrl, userId) {
  const key = sourceKeyOf(rawUrl);
  const found = await ArkVideoTransfer.findOne({ sourceKey: key }).lean();
  if (found) {
    const staleAt = new Date(found.updatedAt).getTime() + STALE_PENDING_MS;
    if (found.state === "pending" && Date.now() > staleAt) {
      // 僵尸认领：按 updatedAt 原子抢（两个实例同时抢，findOneAndUpdate 只有一个改得动）
      const claimed = await ArkVideoTransfer.findOneAndUpdate(
        { sourceKey: key, state: "pending", updatedAt: found.updatedAt },
        { $set: { sourceUrl: rawUrl } }, // timestamps 会顺手刷新 updatedAt = 新的认领时刻
        { returnDocument: "after" }
      ).lean();
      if (claimed) {
        schedule(key, rawUrl, userId);
        return claimed;
      }
      return (await ArkVideoTransfer.findOne({ sourceKey: key }).lean()) || found;
    }
    return found;
  }
  try {
    const doc = await ArkVideoTransfer.create({ sourceKey: key, sourceUrl: rawUrl, state: "pending", userId });
    schedule(key, rawUrl, userId);
    return doc.toObject();
  } catch (e) {
    // 唯一索引撞车 = 并发的另一个请求刚认领：读它的就是
    if (e && e.code === 11000) {
      const again = await ArkVideoTransfer.findOne({ sourceKey: key }).lean();
      if (again) return again;
    }
    throw e;
  }
}

/**
 * 显式请求转存（POST /transfer-video 两种形态都走这里）：与 ensureTransfer 的唯一区别是
 * **failed 会复活重试**——自动路径失败后不无限重试（每 5s 轮询一次，重试风暴），
 * 但用户/客户端主动再要一次（合并前自救、老客户端再 POST）就该再搬一趟。
 */
async function requestTransfer(rawUrl, userId) {
  const key = sourceKeyOf(rawUrl);
  const revived = await ArkVideoTransfer.findOneAndUpdate(
    { sourceKey: key, state: "failed" },
    { $set: { state: "pending", sourceUrl: rawUrl, error: null } },
    { returnDocument: "after" }
  ).lean();
  if (revived) {
    schedule(key, rawUrl, userId);
    return revived;
  }
  return ensureTransfer(rawUrl, userId);
}

/**
 * 老客户端的阻塞语义：登记（或重试）后在库上等结果，直到出结果或预算用完。
 * 2s 一读是跨实例安全的（结果可能是别的实例搬出来的）；预算用完返回的还是 pending，
 * 由路由翻译成 502——搬运本身**不会**被取消，下次再问就是现成的。
 */
async function waitTransfer(rawUrl, userId, budgetMs) {
  const key = sourceKeyOf(rawUrl);
  const t0 = Date.now();
  let doc = await requestTransfer(rawUrl, userId);
  while (doc && doc.state === "pending" && Date.now() - t0 < budgetMs) {
    await new Promise((r) => setTimeout(r, 2000));
    doc = await ArkVideoTransfer.findOne({ sourceKey: key }).lean();
  }
  return doc;
}

/** 批量查进展（只读，不登记）。返回按**传入的原串**作键——客户端存的就是那串。 */
async function statusOf(urls) {
  const pairs = urls.map((u) => {
    try {
      return { url: u, key: sourceKeyOf(u) };
    } catch {
      return { url: u, key: null };
    }
  });
  const keys = [...new Set(pairs.filter((p) => p.key).map((p) => p.key))];
  const docs = keys.length ? await ArkVideoTransfer.find({ sourceKey: { $in: keys } }).lean() : [];
  const byKey = new Map(docs.map((d) => [d.sourceKey, d]));
  const out = {};
  for (const { url, key } of pairs) {
    const d = key ? byKey.get(key) : null;
    out[url] = d
      ? d.state === "done"
        ? { state: "done", url: d.url }
        : d.state === "failed"
          ? { state: "failed", message: d.error || "转存失败" }
          : { state: "pending" }
      : { state: "none" };
  }
  return out;
}

/** 等所有在途搬运收尾（测试断言最终状态、进程优雅退出用）。生产请求路径不调它。 */
async function idle() {
  while (inflight.size > 0 || queue.length > 0) {
    await Promise.allSettled([...inflight]);
    // queue 里还有没起跑的任务时，上面的 allSettled 可能等的是旧一批——转一圈再看
    if (queue.length > 0) await new Promise((r) => setTimeout(r, 20));
  }
}

module.exports = {
  STALE_PENDING_MS,
  sourceKeyOf,
  ensureTransfer,
  requestTransfer,
  waitTransfer,
  statusOf,
  idle,
};
