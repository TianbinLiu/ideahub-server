const mongoose = require("mongoose");
const Idea = require("../models/Idea");
const Interest = require("../models/Interest");
const { createNotification } = require("../services/notification.service");


function isValidId(id) {
  return mongoose.isValidObjectId(id);
}
function isOwner(idea, user) {
  return idea.author.toString() === user._id.toString();
}

async function toggleInterest(req, res, next) {
  try {
    const { id } = req.params; // idea id
    if (!isValidId(id)) {
      res.status(400);
      throw new Error("Invalid idea id");
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      res.status(404);
      throw new Error("Idea not found");
    }

    // 只有企业用户能操作（也可以用 requireRole("company")）
    if (req.user.role !== "company") {
      res.status(403);
      throw new Error("Only company users can mark interest");
    }

    const message = (req.body?.message || "").toString();

    const existing = await Interest.findOne({ companyUser: req.user._id, idea: idea._id });
    if (existing) {
      await Interest.deleteOne({ _id: existing._id });
      return res.json({ ok: true, interested: false });
    }

    await Interest.create({
      companyUser: req.user._id,
      idea: idea._id,
      message,
    });

    const row = await Interest.create({
      companyUser: req.user._id,
      idea: idea._id,
      message,
    });

    await createNotification({
      userId: idea.author,
      actorId: req.user._id,
      ideaId: idea._id,
      type: "INTEREST",
      payload: { interestId: row._id, message },
    });

    res.json({ ok: true, interested: true });
  } catch (err) {
    // 并发下 duplicate key 认为已 interested
    if (err?.code === 11000) return res.json({ ok: true, interested: true });
    next(err);
  }
}

async function listIdeaInterests(req, res, next) {
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

    // 只有作者能看谁对我感兴趣（保护创作者隐私）
    if (!isOwner(idea, req.user)) {
      res.status(403);
      throw new Error("Only the author can view interests");
    }

    const interests = await Interest.find({ idea: idea._id })
      .sort({ createdAt: -1 })
      .populate("companyUser", "username email role")
      .lean();

    res.json({ ok: true, interests });
  } catch (err) {
    next(err);
  }
}

async function listCompanyInterests(req, res, next) {
  try {
    if (req.user.role !== "company") {
      res.status(403);
      throw new Error("Only company users can view their interests");
    }

    const rows = await Interest.find({ companyUser: req.user._id })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate({
        path: "idea",
        populate: { path: "author", select: "username role" },
      })
      .lean();

    const ideas = rows.map(r => ({ ...r.idea, interestMessage: r.message, interestedAt: r.createdAt })).filter(Boolean);
    res.json({ ok: true, ideas });
  } catch (err) {
    next(err);
  }
}

async function listReceivedInterests(req, res, next) {
  try {
    // 找出“我作为作者的全部 ideas”，再查 Interest
    const myIdeas = await Idea.find({ author: req.user._id }).select("_id title").lean();
    const ideaIds = myIdeas.map(i => i._id);

    const interests = await Interest.find({ idea: { $in: ideaIds } })
      .sort({ createdAt: -1 })
      .populate("companyUser", "username email role")
      .populate("idea", "title visibility")
      .lean();

    res.json({ ok: true, interests });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  toggleInterest,
  listIdeaInterests,
  listCompanyInterests,
  listReceivedInterests,
};
