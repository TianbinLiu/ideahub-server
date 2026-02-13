const mongoose = require("mongoose");
const User = require("../models/User");
const Idea = require("../models/Idea");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
const Comment = require("../models/Comment");
const Interest = require("../models/Interest");

// 可选模型：有就删，没有就跳过（避免 require 报错）
let Notification, AiJob;
try { Notification = require("../models/Notification"); } catch {}
try { AiJob = require("../models/AiJob"); } catch {}

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

async function adminDeleteIdea(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      res.status(400);
      throw new Error("Invalid idea id");
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      res.status(404);
      throw new Error("Idea not found");
    }

    await Promise.all([
      Like.deleteMany({ idea: idea._id }),
      Bookmark.deleteMany({ idea: idea._id }),
      Comment.deleteMany({ idea: idea._id }),
      Interest.deleteMany({ idea: idea._id }),
      Notification ? Notification.deleteMany({ ideaId: idea._id }) : Promise.resolve(),
      AiJob ? AiJob.deleteMany({ ideaId: idea._id }) : Promise.resolve(),
    ]);

    await Idea.deleteOne({ _id: idea._id });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function adminDeleteUser(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      res.status(400);
      throw new Error("Invalid user id");
    }

    const user = await User.findById(id);
    if (!user) {
      res.status(404);
      throw new Error("User not found");
    }

    // 防止误删最后一个 admin
    if (user.role === "admin") {
      const adminCount = await User.countDocuments({ role: "admin" });
      if (adminCount <= 1) {
        res.status(400);
        throw new Error("Cannot delete the last admin");
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

module.exports = { adminDeleteIdea, adminDeleteUser };
