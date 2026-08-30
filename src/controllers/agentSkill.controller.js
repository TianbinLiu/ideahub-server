// src/controllers/agentSkill.controller.js
// 「出片技能」的库与广场：存自己的、发布、装别人的。
// ★ 形状逐条照 promptScheme.controller（那套已把路由顺序/装取幂等/逐字段重建的坑固化）。
const AgentSkill = require("../models/AgentSkill");

/** 广场一次给多少条 */
const SHARED_LIMIT = 60;

/**
 * 「同一个 skillId 在广场上以谁那份为准」—— 排序口径**唯一实现**（与卡片那条路同型）。
 *
 * ★★ 2026-08-31 补。在这之前广场排的是 `updatedAt: -1`、去重留**最新**那份，而注释
 *   写的却是「留最早发布的那份，与卡片一致」—— 代码与注释相反。后果：B 装走 A 的技能
 *   （得到自己一行、published:false），再点一下「发布到市场」，B 那行 updatedAt 更新，
 *   广场上这一行**当场换成 B 的文档**；B 接着改标题时 upsert 顺手把 authorName 也写成 B。
 *   A 的技能从广场消失，A 的「已分享」按钮仍是成功态、收不到任何提示，
 *   两边都是 200、零报错。而且位子会随两人各自编辑来回翻。
 * ★ `publishedAt` 是后加的，存量没有这一位 ⇒ 用 `_id` 兜底（ObjectId 单调递增 = 创建顺序）。
 * ⚠ 广场去重与 install **必须用同一个排序**：不然"看到的"和"装到手的"可以是两个人的两份。
 */
const AUTH_SORT = { publishedAt: 1, _id: 1 };

/** 这个 skillId 在广场上的权威那份（没有 = 还没有人分享过） */
function findAuthoritative(id) {
  return AgentSkill.findOne({ skillId: id, published: true }).sort(AUTH_SORT).lean();
}

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
  // ★ 按 AUTH_SORT 排：去重要留**最早发布**那份，且与 install 共用同一把尺（见 AUTH_SORT 的 ★★）
  const rows = await AgentSkill.find({ published: true }).sort(AUTH_SORT).limit(SHARED_LIMIT).lean();
  // 同一条被多人装走后库里有多份，广场按 skillId 去重 —— 留**最早发布**那份（AUTH_SORT），
  // ⚠ 这条注释 2026-08-31 之前与代码相反（排的是 updatedAt，留的是最新那份），别再改回去
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
  // ★ publishedAt 只在**这份文档第一次**发布时写：下架再上架不该把先来后到的次序洗掉。
  const own = await AgentSkill.findOne({ ownerId: req.user._id, skillId: req.params.skillId })
    .select("publishedAt sourceOwner")
    .lean();
  if (!own) return res.status(404).json({ ok: false, error: "skill not found" });

  // ★★ 两道闸，顺序有讲究（与卡片那条路同型，2026-08-31 补）。在补它们之前，
  //   "装走 → 再发布一次"会把原作者那一行**顶掉**：广场按 skillId 去重而排的是 updatedAt，
  //   于是位子归最后编辑的人，A 的技能从广场消失、A 的「已分享」仍是成功态、
  //   收不到任何提示，两边都是 200、零报错（见 AUTH_SORT 的 ★★）。
  // ① 装来的副本一律不许再分享（判**有值**：老数据没这一位 = 当作原创）
  if (own.sourceOwner) {
    return res.status(400).json({
      ok: false,
      error: "这条技能是从别人那儿装来的，不能再分享一遍：广场上显示的始终是最早分享那份，你发出去也没人看得见。想让别人看到你的版本，改完另存一条自己的。",
    });
  }
  // ② 第二道闸，覆盖**没有来源标记**的那批（本次改动之前装走的存量副本）。
  //    ⚠ 只在"我从没发布过这一条"时才拦：我自己下架再上架不该被自己挡在门外
  //    （那个窗口里别人可能抢发过一次，但我的 publishedAt 更早，AUTH_SORT 会把位子还给我）。
  if (!own.publishedAt) {
    const first = await findAuthoritative(req.params.skillId);
    if (first && String(first.ownerId) !== String(req.user._id)) {
      return res.status(400).json({
        ok: false,
        error: "这条技能已经有人先分享到市场了，广场上显示的是最早那份 —— 你再发一遍不会多出一行，也没人看得见。",
      });
    }
  }
  const doc = await AgentSkill.findOneAndUpdate(
    { ownerId: req.user._id, skillId: req.params.skillId },
    { $set: { published: true, ...(own.publishedAt ? {} : { publishedAt: new Date() }) } },
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
  // ★ 与广场**同一把尺**（AUTH_SORT）：不排序的 findOne 会让"看到的"和"装到手的"
  //   可能是两个人的两份（同一个 skillId 库里有多行）
  const src = await findAuthoritative(req.params.skillId);
  if (!src) return res.status(404).json({ ok: false, error: "skill not found or not published" });

  const own = await AgentSkill.findOne({ ownerId: req.user._id, skillId: src.skillId }).lean();
  if (own) return res.status(200).json({ ok: true, alreadyInstalled: true, skill: toSkillPayload(own) });

  const doc = await AgentSkill.create({
    ownerId: req.user._id,
    skillId: src.skillId,
    // 作者名跟着原作者走（不是装的人）：市场上要看得出这条是谁做的
    authorName: src.authorName || "",
    // ★ 记下"这是装来的"：装来的副本永远不许再分享一遍（见 model 里 sourceOwner 的 ★）
    sourceOwner: src.ownerId,
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
