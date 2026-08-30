// src/controllers/promptScheme.controller.js
// 「提示词方案」的库与广场：存自己的、发布、装别人的。
//
// ★ 形状照 branchAsset 的卡片那套（publish / install / shared），因为它已经把
//   本仓踩过的坑都固化进去了：路由顺序（/shared 必须排在 /:id 前）、装卡幂等、
//   序列化逐字段重建。
const PromptScheme = require("../models/PromptScheme");
const { MAX_EXAMPLES } = require("../schemas/promptScheme.schemas");

/** 广场一次给多少套 */
const SHARED_LIMIT = 60;

/**
 * 「同一个 schemeId 在广场上以谁那份为准」—— 排序口径**唯一实现**（与卡片那条路同型）。
 *
 * ★★ 2026-08-31 补。在这之前广场排的是 `updatedAt: -1`、去重留**最新**那份，而注释
 *   写的却是「留最早发布的那份，与卡片一致」—— 代码与注释相反。后果：B 装走 A 的方案
 *   （得到自己一行、published:false），再点一下「发布到市场」，B 那行 updatedAt 更新，
 *   广场上这一行**当场换成 B 的文档**；B 接着改标题时 upsert 顺手把 authorName 也写成 B。
 *   A 的方案从广场消失，A 的「已分享」按钮仍是成功态、收不到任何提示，
 *   两边都是 200、零报错。而且位子会随两人各自编辑来回翻。
 * ★ `publishedAt` 是后加的，存量没有这一位 ⇒ 用 `_id` 兜底（ObjectId 单调递增 = 创建顺序）。
 * ⚠ 广场去重与 install **必须用同一个排序**：不然"看到的"和"装到手的"可以是两个人的两份。
 */
const AUTH_SORT = { publishedAt: 1, _id: 1 };

/** 这个 schemeId 在广场上的权威那份（没有 = 还没有人分享过） */
function findAuthoritative(id) {
  return PromptScheme.findOne({ schemeId: id, published: true }).sort(AUTH_SORT).lean();
}

/**
 * 文档 → 回包。**逐字段重建**，所以这里是最容易"漏一行"的地方。
 *
 * ★★ 图位的六个字段一个都不能少：漏 `ref` 的表现是装回来的方案参考图从脸变成主裁剪，
 *   漏 `fromCrop` 的表现是原本不花钱的那一格开始花钱 —— 两种都**零报错**，
 *   用户只会觉得"这套方案在我这儿效果不一样"。
 */
function toSchemePayload(doc) {
  return {
    schemeId: doc.schemeId,
    title: doc.title,
    intro: doc.intro || "",
    faceless: !!doc.faceless,
    author: doc.authorName || "",
    slots: (doc.slots || []).map((s) => ({
      tag: s.tag,
      role: s.role,
      prompt: s.prompt || "",
      // ★ 缺省的**不写这一位**（而不是补个默认值）：缺省的语义是"用主裁剪 / 用卡面画布"，
      //   客户端有唯一实现（slot.ref ?? "body"、slotSize），在这里补就是第二处默认值。
      ...(s.ref ? { ref: s.ref } : {}),
      ...(s.size ? { size: s.size } : {}),
      ...(s.fromCrop ? { fromCrop: true } : {}),
    })),
    examples: (doc.examples || []).slice(0, MAX_EXAMPLES),
    published: !!doc.published,
    updatedAt: doc.updatedAt,
  };
}

/** GET /schemes —— 我自己的方案库 */
async function listSchemes(req, res) {
  const rows = await PromptScheme.find({ ownerId: req.user._id }).sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ ok: true, schemes: rows.map(toSchemePayload) });
}

/**
 * POST /schemes —— 存一套自己的（新建或改）。
 * ★ upsert 按 (ownerId, schemeId)：同一套改十次也只有一行。
 * ★ **不动 published**：改内容不该把已经下架的方案偷偷再发布出去。
 */
async function upsertScheme(req, res) {
  const b = req.body;
  const $set = {
    title: b.title,
    intro: b.intro || "",
    faceless: !!b.faceless,
    slots: b.slots,
    examples: (b.examples || []).slice(0, MAX_EXAMPLES),
    authorName: req.user.displayName || req.user.username || "",
  };
  const doc = await PromptScheme.findOneAndUpdate(
    { ownerId: req.user._id, schemeId: b.schemeId },
    { $set, $setOnInsert: { ownerId: req.user._id, schemeId: b.schemeId, published: false } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  res.status(201).json({ ok: true, scheme: toSchemePayload(doc) });
}

/** DELETE /schemes/:schemeId */
async function removeScheme(req, res) {
  const r = await PromptScheme.deleteOne({ ownerId: req.user._id, schemeId: req.params.schemeId });
  if (r.deletedCount === 0) return res.status(404).json({ ok: false, error: "scheme not found" });
  res.json({ ok: true });
}

/** GET /schemes/shared —— 广场。★ 路由必须排在 /schemes/:schemeId 之前（否则 "shared" 被当成 id） */
async function listSharedSchemes(req, res) {
  const rows = await PromptScheme.find({ published: true })
    // ★ 无脸方案排前面（产品决定）；同一个 schemeId 之内按 AUTH_SORT 定权威那份
    //   —— 去重与 install 共用同一把尺（见 AUTH_SORT 的 ★★）
    .sort({ faceless: -1, ...AUTH_SORT })
    .limit(SHARED_LIMIT)
    .lean();
  // 同一套被多人装走后库里有多份，广场按 schemeId 去重 —— 留**最早发布**那份（AUTH_SORT），
  // ⚠ 这条注释 2026-08-31 之前与代码相反（排的是 updatedAt，留的是最新那份），别再改回去
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.schemeId)) continue;
    seen.add(r.schemeId);
    out.push(toSchemePayload(r));
  }
  res.json({ ok: true, schemes: out });
}

/** POST /schemes/:schemeId/publish */
async function publishScheme(req, res) {
  // ★ publishedAt 只在**这份文档第一次**发布时写：下架再上架不该把先来后到的次序洗掉。
  const own = await PromptScheme.findOne({ ownerId: req.user._id, schemeId: req.params.schemeId })
    .select("publishedAt sourceOwner")
    .lean();
  if (!own) return res.status(404).json({ ok: false, error: "scheme not found" });

  // ★★ 两道闸，顺序有讲究（与卡片那条路同型，2026-08-31 补）。在补它们之前，
  //   "装走 → 再发布一次"会把原作者那一行**顶掉**：广场按 schemeId 去重而排的是 updatedAt，
  //   于是位子归最后编辑的人，A 的方案从广场消失、A 的「已分享」仍是成功态、
  //   收不到任何提示，两边都是 200、零报错（见 AUTH_SORT 的 ★★）。
  // ① 装来的副本一律不许再分享（判**有值**：老数据没这一位 = 当作原创）
  if (own.sourceOwner) {
    return res.status(400).json({
      ok: false,
      error: "这套方案是从别人那儿装来的，不能再分享一遍：广场上显示的始终是最早分享那份，你发出去也没人看得见。想让别人看到你的版本，改完另存一套自己的。",
    });
  }
  // ② 第二道闸，覆盖**没有来源标记**的那批（本次改动之前装走的存量副本）。
  //    ⚠ 只在"我从没发布过这一套"时才拦：我自己下架再上架不该被自己挡在门外
  //    （那个窗口里别人可能抢发过一次，但我的 publishedAt 更早，AUTH_SORT 会把位子还给我）。
  if (!own.publishedAt) {
    const first = await findAuthoritative(req.params.schemeId);
    if (first && String(first.ownerId) !== String(req.user._id)) {
      return res.status(400).json({
        ok: false,
        error: "这套方案已经有人先分享到市场了，广场上显示的是最早那份 —— 你再发一遍不会多出一行，也没人看得见。",
      });
    }
  }
  const doc = await PromptScheme.findOneAndUpdate(
    { ownerId: req.user._id, schemeId: req.params.schemeId },
    { $set: { published: true, ...(own.publishedAt ? {} : { publishedAt: new Date() }) } },
    { new: true }
  ).lean();
  if (!doc) return res.status(404).json({ ok: false, error: "scheme not found" });
  res.json({ ok: true, scheme: toSchemePayload(doc) });
}

/** DELETE /schemes/:schemeId/publish —— 下架（不删自己那份） */
async function unpublishScheme(req, res) {
  const doc = await PromptScheme.findOneAndUpdate(
    { ownerId: req.user._id, schemeId: req.params.schemeId },
    { $set: { published: false } },
    { new: true }
  ).lean();
  if (!doc) return res.status(404).json({ ok: false, error: "scheme not found" });
  res.json({ ok: true, scheme: toSchemePayload(doc) });
}

/**
 * POST /schemes/:schemeId/install —— 把广场上那套装进自己的库。
 * ★ **幂等**：已经装过就直接把自己那份回给他（`alreadyInstalled`），不重复建行、
 *   也不覆盖他可能已经改过的内容 —— 覆盖等于把用户自己的修改悄悄抹掉。
 * ★ 装走的那份 `published:false`：装了不等于替对方转发。
 */
async function installScheme(req, res) {
  // ★ 与广场**同一把尺**（AUTH_SORT）：不排序的 findOne 会让"看到的"和"装到手的"
  //   可能是两个人的两份（同一个 schemeId 库里有多行）
  const src = await findAuthoritative(req.params.schemeId);
  if (!src) return res.status(404).json({ ok: false, error: "scheme not found or not published" });

  const own = await PromptScheme.findOne({ ownerId: req.user._id, schemeId: src.schemeId }).lean();
  if (own) return res.status(200).json({ ok: true, alreadyInstalled: true, scheme: toSchemePayload(own) });

  const doc = await PromptScheme.create({
    ownerId: req.user._id,
    schemeId: src.schemeId,
    // ★ 作者名跟着原作者走（不是装的人）：市场上要看得出这套是谁做的
    authorName: src.authorName || "",
    // ★ 记下"这是装来的"：装来的副本永远不许再分享一遍（见 model 里 sourceOwner 的 ★）
    sourceOwner: src.ownerId,
    title: src.title,
    intro: src.intro,
    faceless: !!src.faceless,
    slots: src.slots,
    examples: src.examples,
    published: false,
  });
  res.status(201).json({ ok: true, scheme: toSchemePayload(doc.toObject()) });
}

module.exports = {
  listSchemes,
  upsertScheme,
  removeScheme,
  listSharedSchemes,
  publishScheme,
  unpublishScheme,
  installScheme,
};
