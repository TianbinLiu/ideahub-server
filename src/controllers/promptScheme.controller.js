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
    // 无脸方案排前面：与客户端 listSchemes 的排序同一条产品决定
    .sort({ faceless: -1, updatedAt: -1 })
    .limit(SHARED_LIMIT)
    .lean();
  // 同一套被多人装走后库里有多份，广场按 schemeId 去重（留最早发布的那份，与卡片一致）
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
  const doc = await PromptScheme.findOneAndUpdate(
    { ownerId: req.user._id, schemeId: req.params.schemeId },
    { $set: { published: true } },
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
  const src = await PromptScheme.findOne({ schemeId: req.params.schemeId, published: true }).lean();
  if (!src) return res.status(404).json({ ok: false, error: "scheme not found or not published" });

  const own = await PromptScheme.findOne({ ownerId: req.user._id, schemeId: src.schemeId }).lean();
  if (own) return res.status(200).json({ ok: true, alreadyInstalled: true, scheme: toSchemePayload(own) });

  const doc = await PromptScheme.create({
    ownerId: req.user._id,
    schemeId: src.schemeId,
    // ★ 作者名跟着原作者走（不是装的人）：市场上要看得出这套是谁做的
    authorName: src.authorName || "",
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
