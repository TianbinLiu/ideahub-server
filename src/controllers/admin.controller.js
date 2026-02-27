//admin.controller.js

const mongoose = require("mongoose");
const fs = require("fs").promises;
const path = require("path");
const User = require("../models/User");
const Idea = require("../models/Idea");
const TagLeaderboard = require("../models/TagLeaderboard");
const LeaderboardPost = require("../models/LeaderboardPost");
const TagVote = require("../models/TagVote");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
const Comment = require("../models/Comment");
const Interest = require("../models/Interest");
const { invalidId, notFound, badRequest } = require("../utils/http");

// 可选模型：有就删，没有就跳过（避免 require 报错）
let Notification, AiJob;
try { Notification = require("../models/Notification"); } catch { }
try { AiJob = require("../models/AiJob"); } catch { }
let IdeaView;
try { IdeaView = require("../models/IdeaView"); } catch { }

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

async function adminDeleteIdea(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      invalidId("Invalid idea id");
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      notFound("Idea not found");
    }

    await Promise.all([
      Like.deleteMany({ idea: idea._id }),
      Bookmark.deleteMany({ idea: idea._id }),
      Comment.deleteMany({ idea: idea._id }),
      Interest.deleteMany({ idea: idea._id }),
      Notification ? Notification.deleteMany({ ideaId: idea._id }) : Promise.resolve(),
      AiJob ? AiJob.deleteMany({ ideaId: idea._id }) : Promise.resolve(),
      IdeaView ? IdeaView.deleteMany({ idea: idea._id }) : Promise.resolve(),
    ]);

    await Idea.deleteOne({ _id: idea._id });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function adminDeleteLeaderboard(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      invalidId("Invalid leaderboard id");
    }

    const board = await TagLeaderboard.findById(id);
    if (!board) {
      notFound("Leaderboard not found");
    }

    const tagsKey = board.tagsKey || "";

    await Promise.all([
      Bookmark.deleteMany({ leaderboard: board._id, type: "leaderboard" }),
      LeaderboardPost.deleteMany({ tagsKey }),
      TagVote.deleteMany({ tagsKey }),
    ]);

    await TagLeaderboard.deleteOne({ _id: board._id });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function adminDeleteUser(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      invalidId("Invalid idea id");
    }

    const user = await User.findById(id);
    if (!user) {
      notFound("User not found");
    }

    // 防止误删最后一个 admin
    if (user.role === "admin") {
      const adminCount = await User.countDocuments({ role: "admin" });
      if (adminCount <= 1) {
        badRequest("Cannot delete the last admin");
      }
    }

    // 找出该用户作为作者创建的 ideas
    const myIdeas = await Idea.find({ author: user._id }).select("_id").lean();
    const ideaIds = myIdeas.map(i => i._id);

    await Promise.all([
      // 用户自己发出的 like/bookmark
      Like.deleteMany({ $or: [{ user: user._id }, { idea: { $in: ideaIds } }] }),
      Bookmark.deleteMany({ $or: [{ user: user._id }, { idea: { $in: ideaIds } }] }),

      // 用户自己写的评论 + 他创建 ideas 下的评论
      Comment.deleteMany({ $or: [{ author: user._id }, { idea: { $in: ideaIds } }] }),

      // Interest：用户作为 companyUser 发出的 + 以及他 ideas 收到的
      Interest.deleteMany({ $or: [{ companyUser: user._id }, { idea: { $in: ideaIds } }] }),

      // 通知 + AI Jobs（如果存在）
      Notification
        ? Notification.deleteMany({
          $or: [
            { userId: user._id },
            { actorId: user._id },
            { ideaId: { $in: ideaIds } },
          ],
        })
        : Promise.resolve(),
      AiJob
        ? AiJob.deleteMany({
          $or: [{ requesterId: user._id }, { ideaId: { $in: ideaIds } }],
        })
        : Promise.resolve(),
      IdeaView
        ? IdeaView.deleteMany({ $or: [{ user: user._id }, { idea: { $in: ideaIds } }] })
        : Promise.resolve(),
    ]);

    // 删除用户创建的 ideas
    await Idea.deleteMany({ author: user._id });

    // 删除用户
    await User.deleteOne({ _id: user._id });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function adminListUsers(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);
    const q = String(req.query.q || "").trim();

    const filter = {};
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ username: re }, { email: re }];
    }

    const [items, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("_id username email role createdAt")
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    next(err);
  }
}

async function adminListIdeas(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);
    const q = String(req.query.q || "").trim();

    const filter = {};
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { title: re },
        { summary: re },
        { content: re },
        { tags: re },
      ];
    }

    const [items, total] = await Promise.all([
      Idea.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", "_id username role")
        .select("_id title summary tags visibility createdAt author")
        .lean(),
      Idea.countDocuments(filter),
    ]);

    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    next(err);
  }
}

async function adminListLeaderboards(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);
    const q = String(req.query.q || "").trim();

    const filter = {};
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ tagsKey: re }, { tags: re }];
    }

    const [items, total] = await Promise.all([
      TagLeaderboard.find(filter)
        .sort({ computedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("_id tags tagsKey computedAt entries")
        .lean(),
      TagLeaderboard.countDocuments(filter),
    ]);

    const tagsKeys = items.map((b) => b.tagsKey).filter(Boolean);
    const postsCounts = await LeaderboardPost.aggregate([
      { $match: { tagsKey: { $in: tagsKeys } } },
      { $group: { _id: "$tagsKey", count: { $sum: 1 } } },
    ]);
    const postsCountMap = Object.fromEntries(postsCounts.map((p) => [p._id, p.count]));

    const payload = items.map((b) => ({
      _id: b._id,
      tags: b.tags,
      tagsKey: b.tagsKey,
      computedAt: b.computedAt,
      entriesCount: (b.entries || []).length,
      postsCount: postsCountMap[b.tagsKey] || 0,
    }));

    res.json({ ok: true, items: payload, total, page, limit });
  } catch (err) {
    next(err);
  }
}

async function adminUpdateFeedbackStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidId(id)) {
      invalidId("Invalid idea id");
    }

    const validStatuses = ["pending", "under_review", "adopted", "resolved", "rejected"];
    if (!validStatuses.includes(status)) {
      badRequest("Invalid feedback status");
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      notFound("Idea not found");
    }

    if (!idea.isFeedback) {
      badRequest("This idea is not a feedback submission");
    }

    idea.feedbackStatus = status;
    await idea.save();

    res.json({ ok: true, idea });
  } catch (err) {
    next(err);
  }
}

async function adminListFeedback(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);
    const type = req.query.type; // "bug" | "suggestion" | undefined (all)
    const status = req.query.status; // "pending" | "under_review" | etc. | undefined (all)

    const filter = { isFeedback: true };
    if (type && (type === "bug" || type === "suggestion")) {
      filter.feedbackType = type;
    }
    if (status && ["pending", "under_review", "adopted", "resolved", "rejected"].includes(status)) {
      filter.feedbackStatus = status;
    }

    const [items, total] = await Promise.all([
      Idea.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", "_id username role")
        .select("_id title summary aiSummary feedbackType feedbackStatus createdAt author stats")
        .lean(),
      Idea.countDocuments(filter),
    ]);

    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    next(err);
  }
}

/**
 * 获取项目架构文档 - 读取 PROJECT_STRUCTURE.md
 */
async function adminGetProjectDocs(req, res, next) {
  try {
    // 读取项目根目录的 PROJECT_STRUCTURE.md
    const docsPath = path.join(__dirname, "..", "..", "..", "PROJECT_STRUCTURE.md");
    const content = await fs.readFile(docsPath, "utf-8");
    
    res.json({ ok: true, content });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).json({ 
        ok: false, 
        error: "PROJECT_STRUCTURE.md not found. Please create this file in the project root." 
      });
    }
    next(err);
  }
}


module.exports = {
  adminListUsers,
  adminListIdeas,
  adminListLeaderboards,
  adminListFeedback,
  adminUpdateFeedbackStatus,
  adminDeleteIdea,
  adminDeleteLeaderboard,
  adminDeleteUser,
  adminGetProjectDocs,
};

