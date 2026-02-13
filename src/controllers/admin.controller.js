const mongoose = require("mongoose");
const User = require("../models/User");
const Idea = require("../models/Idea");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
const Comment = require("../models/Comment");
const Interest = require("../models/Interest");

let Notification, AiJob;
try { Notification = require("../models/Notification"); } catch {}
try { AiJob = require("../models/AiJob"); } catch {}

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

async function adminDeleteIdea(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) { res.status(400); throw new Error("Invalid idea id"); }

    const idea = await Idea.findById(id);
    if (!idea) { res.status(404); throw new Error("Idea not found"); }

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
  } catch (e) { next(e); }
}

async function adminDeleteUser(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) { res.status(400); throw new Error("Invalid user id"); }

    const user = await User.findById(id);
    if (!user) { res.status(404); throw new Error("User not found"); }

    // 防止删最后一个 admin（强烈建议）
    if (user.role === "admin") {
      const adminCount = await User.countDocuments({ role: "admin" });
      if (adminCount <= 1) { res.status(400); throw new Error("Cannot delete the last admin"); }
    }

    const myIdeas = await Idea.find({ author: user._id }).select("_id").lean();
    const ideaIds = myIdeas.map(x => x._id);

    await Promise.all([
      Like.deleteMany({ $or: [{ user: user._id }, { idea: { $in: ideaIds } }] }),
      Bookmark.deleteMany({ $or: [{ user: user._id }, { idea: { $in: ideaIds } }] }),
      Comment.deleteMany({ $or: [{ author: user._id }, { idea: { $in: ideaIds } }] }),
      Interest.deleteMany({ $or: [{ companyUser: user._id }, { idea: { $in: ideaIds } }] }),
      Notification ? Notification.deleteMany({ $or: [{ userId: user._id }, { actorId: user._id }, { ideaId: { $in: ideaIds } }] }) : Promise.resolve(),
      AiJob ? AiJob.deleteMany({ $or: [{ requesterId: user._id }, { ideaId: { $in: ideaIds } }] }) : Promise.resolve(),
    ]);

    await Idea.deleteMany({ author: user._id });
    await User.deleteOne({ _id: user._id });

    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { adminDeleteIdea, adminDeleteUser };
