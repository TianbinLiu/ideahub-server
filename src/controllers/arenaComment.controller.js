// src/controllers/arenaComment.controller.js
// 情景 / 人格 详情页讨论区的通用控制器工厂。
// 用法：makeCommentHandlers({ targetType, loadTarget }) -> { list, create, remove }
//   - targetType: "scenario" | "persona"（写进 ArenaComment.targetType，也用于隔离父评论）
//   - loadTarget(id): 返回目标文档（至少含 _id/author/shared）或 null
const mongoose = require("mongoose");
const ArenaComment = require("../models/ArenaComment");
const { forbidden, notFound, invalidId } = require("../utils/http");

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;

const TARGET_LABEL = { scenario: "Scenario", persona: "Persona" };

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function readPage(req) {
  const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit || String(LIMIT_DEFAULT), 10) || LIMIT_DEFAULT, 1),
    LIMIT_MAX
  );
  return { page, limit };
}

// 与 bounty.controller 的 normalizeSafeUrl 同规则：只放行站内相对路径与 http(s) 绝对地址，
// 挡掉 javascript:/data: 等会在前端 <img src> / <a href> 上变成 XSS 的协议。
function normalizeSafeUrl(input) {
  const raw = String(input || "").trim().slice(0, 500);
  if (!raw || /[\x00-\x1f\x7f]/.test(raw)) return "";

  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return "";
  }

  return "";
}

function serializeUserRef(u) {
  if (u && typeof u === "object" && u.username !== undefined) {
    return { _id: u._id, username: u.username };
  }
  return u;
}

function serializeComment(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    author: serializeUserRef(doc.author),
    content: doc.content || "",
    imageUrl: doc.imageUrl || "",
    parentId: doc.parentId || null,
    createdAt: doc.createdAt,
  };
}

function ownedBy(doc, user) {
  return !!user && String(user._id) === String(doc.author?._id || doc.author);
}

function makeCommentHandlers({ targetType, loadTarget }) {
  const label = TARGET_LABEL[targetType] || "Target";

  // 目标存在性 + 可见性门禁：未 shared 且请求者不是目标作者一律 403，
  // 否则任何人拿到 id 就能读到别人私有情景/人格下的讨论。
  async function requireVisibleTarget(req) {
    const { id } = req.params;
    if (!isValidId(id)) invalidId(`Invalid ${targetType} id`);

    const target = await loadTarget(id);
    if (!target) notFound(`${label} not found`);
    if (!target.shared && !ownedBy(target, req.user)) forbidden("Forbidden");

    return target;
  }

  // parentId 校验：非法 id -> 400；父评论必须【属于同一 targetType + 同一 target】，
  // 否则可以拿情景 A 的评论 id 当人格 B 的父级，把评论注入到别人的楼里。
  // 只允许一层楼中楼：回复楼中楼时归到它所在的那个顶楼，不产生第三层。
  async function resolveParentId(rawParentId, targetId) {
    if (rawParentId === undefined || rawParentId === null || String(rawParentId).trim() === "") {
      return null;
    }

    const parentId = String(rawParentId).trim();
    if (!isValidId(parentId)) invalidId("Invalid parent comment id");

    const parent = await ArenaComment.findOne({ _id: parentId, targetType, target: targetId })
      .select("_id parentId")
      .lean();
    if (!parent) notFound("Parent comment not found");

    return parent.parentId ? parent.parentId : parent._id;
  }

  async function list(req, res, next) {
    try {
      await requireVisibleTarget(req);

      const { id } = req.params;
      const { page, limit } = readPage(req);
      const filter = { targetType, target: id };

      const total = await ArenaComment.countDocuments(filter);
      const totalPages = Math.max(Math.ceil(total / limit), 1);

      // 讨论区按自然顺序（发表先后）升序
      const items = await ArenaComment.find(filter)
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", "_id username")
        .lean();

      res.json({
        ok: true,
        comments: items.map(serializeComment),
        total,
        page,
        limit,
        totalPages,
      });
    } catch (err) {
      next(err);
    }
  }

  async function create(req, res, next) {
    try {
      await requireVisibleTarget(req);

      const { id } = req.params;
      const parentId = await resolveParentId(req.body.parentId, id);

      const doc = await ArenaComment.create({
        targetType,
        target: id,
        author: req.user._id,
        content: String(req.body.content || "").trim().slice(0, 2000),
        imageUrl: normalizeSafeUrl(req.body.imageUrl),
        parentId,
      });

      const populated = await ArenaComment.findById(doc._id).populate("author", "_id username").lean();
      res.status(201).json({ ok: true, comment: serializeComment(populated) });
    } catch (err) {
      next(err);
    }
  }

  async function remove(req, res, next) {
    try {
      const { id, commentId } = req.params;
      if (!isValidId(id)) invalidId(`Invalid ${targetType} id`);
      if (!isValidId(commentId)) invalidId("Invalid comment id");

      const target = await loadTarget(id);
      if (!target) notFound(`${label} not found`);

      const comment = await ArenaComment.findOne({ _id: commentId, targetType, target: id })
        .select("_id author parentId")
        .lean();
      if (!comment) notFound("Comment not found");

      // 授权：评论作者本人，或目标（情景/人格）的作者（版主）
      const isCommentAuthor = String(comment.author) === String(req.user._id);
      if (!isCommentAuthor && !ownedBy(target, req.user)) forbidden("Forbidden");

      await ArenaComment.deleteOne({ _id: commentId });
      // 删顶楼时级联删掉楼中楼，避免留下挂在不存在父级上的孤儿
      let cascaded = 0;
      if (!comment.parentId) {
        const r = await ArenaComment.deleteMany({ targetType, target: id, parentId: commentId });
        cascaded = (r && r.deletedCount) || 0;
      }

      // 返回【实际删除的总条数】。前端不能自己推算：它只加载了分页里的那部分楼中楼，
      // 按「已加载的回复数」去减 total 会少减 → 计数偏高、冒出「幽灵加载更多」。
      res.json({ ok: true, deleted: 1 + cascaded });
    } catch (err) {
      next(err);
    }
  }

  return { list, create, remove };
}

module.exports = { makeCommentHandlers };
