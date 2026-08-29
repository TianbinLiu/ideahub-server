// src/controllers/agentSkill.controller.js
// 「出片技能」的库与广场：存自己的、发布、装别人的。
// ★ 形状逐条照 promptScheme.controller（那套已把路由顺序/装取幂等/逐字段重建的坑固化）。
const AgentSkill = require("../models/AgentSkill");

/** 广场一次给多少条 */
const SHARED_LIMIT = 60;

/** 文档 → 回包。逐字段重建 —— 加字段时这里是最容易"漏一行"的地方（schema 文件头 ⚠⚠） */
function toSkillPayload(doc) {
  return {
    skillId: doc.skillId,
    title: doc.title,
    intro: doc.intro || "",
    text: doc.text || "",
    author: doc.authorName || "",
    published: !!doc.published,
    updatedAt: doc.updatedAt,
  };
}

/** GET /skills —— 我自己的技能库 */
async function listSkills(req, res) {
  const rows = await AgentSkill.find({ ownerId: req.user._id }).sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ ok: true, skills: rows.map(toSkillPayload) });
}

/** POST /skills —— 存一条自己的（新建或改）。
 *  ★ upsert 按 (ownerId, skillId)；★ **不动 published**：改内容不许把已下架的偷偷再发出去 */
async function upsertSkill(req, res) {
  const b = req.body;
  const $set = {
    title: b.title,
    intro: b.intro || "",
    text: b.text,
    authorName: req.user.displayName || req.user.username || "",
  };
  const doc = await AgentSkill.findOneAndUpdate(
    { ownerId: req.user._id, skillId: b.skillId },
    { $set, $setOnInsert: { ownerId: req.user._id, skillId: b.skillId, published: false } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  res.status(201).json({ ok: true, skill: toSkillPayload(doc) });
}

/** DELETE /skills/:skillId */
async function removeSkill(req, res) {
  const r = await AgentSkill.deleteOne({ ownerId: req.user._id, skillId: req.params.skillId });
  if (r.deletedCount === 0) return res.status(404).json({ ok: false, error: "skill not found" });
  res.json({ ok: true });
}

/** GET /skills/shared —— 广场。★ 路由必须排在 /skills/:skillId 之前（S2 那条坑） */
async function listSharedSkills(req, res) {
  const rows = await AgentSkill.find({ published: true }).sort({ updatedAt: -1 }).limit(SHARED_LIMIT).lean();
  // 同一条被多人装走后库里有多份，广场按 skillId 去重（与方案/卡片一致）
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.skillId)) continue;
    seen.add(r.skillId);
    out.push(toSkillPayload(r));
  }
  res.json({ ok: true, skills: out });
}

/** POST /skills/:skillId/publish */
async function publishSkill(req, res) {
  const doc = await AgentSkill.findOneAndUpdate(
    { ownerId: req.user._id, skillId: req.params.skillId },
    { $set: { published: true } },
    { new: true }
  ).lean();
  if (!doc) return res.status(404).json({ ok: false, error: "skill not found" });
  res.json({ ok: true, skill: toSkillPayload(doc) });
}

/** DELETE /skills/:skillId/publish —— 下架（不删自己那份） */
async function unpublishSkill(req, res) {
  const doc = await AgentSkill.findOneAndUpdate(
    { ownerId: req.user._id, skillId: req.params.skillId },
    { $set: { published: false } },
    { new: true }
  ).lean();
  if (!doc) return res.status(404).json({ ok: false, error: "skill not found" });
  res.json({ ok: true, skill: toSkillPayload(doc) });
}

/** POST /skills/:skillId/install —— 装广场那条进自己的库。
 *  ★ 幂等且**不覆盖**：装过就把自己那份原样回来（用户可能已经改过它）；装走的
 *  published:false（装了不等于替对方转发） */
async function installSkill(req, res) {
  const src = await AgentSkill.findOne({ skillId: req.params.skillId, published: true }).lean();
  if (!src) return res.status(404).json({ ok: false, error: "skill not found or not published" });

  const own = await AgentSkill.findOne({ ownerId: req.user._id, skillId: src.skillId }).lean();
  if (own) return res.status(200).json({ ok: true, alreadyInstalled: true, skill: toSkillPayload(own) });

  const doc = await AgentSkill.create({
    ownerId: req.user._id,
    skillId: src.skillId,
    // 作者名跟着原作者走（不是装的人）：市场上要看得出这条是谁做的
    authorName: src.authorName || "",
    title: src.title,
    intro: src.intro,
    text: src.text,
    published: false,
  });
  res.status(201).json({ ok: true, skill: toSkillPayload(doc.toObject()) });
}

module.exports = {
  listSkills,
  upsertSkill,
  removeSkill,
  listSharedSkills,
  publishSkill,
  unpublishSkill,
  installSkill,
};
