const mongoose = require("mongoose");
const Idea = require("../models/Idea");
const AiJob = require("../models/AiJob");
const { canReadIdea } = require("../utils/permissions");
const { runAiReview } = require("../services/aiReview.service");

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

async function requestAiReview(req, res, next) {
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

    // 权限：至少能 read（也可收紧成只有作者能请求）
    if (!canReadIdea(idea, req.user)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    // 已有未完成 job → 复用
    const existing = await AiJob.findOne({ ideaId: idea._id, status: { $in: ["pending", "running"] } }).lean();
    if (existing) {
      return res.status(202).json({ ok: true, jobId: existing._id, status: existing.status, reused: true });
    }

    const job = await AiJob.create({
      ideaId: idea._id,
      requesterId: req.user._id,
      status: "pending",
      attempts: 0,
    });

    // Fallback mode: if worker is not enabled, execute review synchronously to avoid "queued but never processed".
    if (process.env.ENABLE_AI_WORKER !== "true") {
      try {
        await AiJob.updateOne(
          { _id: job._id },
          { $set: { status: "running", startedAt: new Date() }, $inc: { attempts: 1 } }
        );

        const out = await runAiReview(idea);
        idea.aiReview = {
          feasibilityScore: out.feasibilityScore,
          profitPotentialScore: out.profitPotentialScore,
          analysisText: out.analysisText || "",
          model: out.model || "",
          createdAt: new Date(),
        };
        await idea.save();

        await AiJob.updateOne(
          { _id: job._id },
          { $set: { status: "succeeded", finishedAt: new Date(), lastError: "" } }
        );

        return res.status(202).json({ ok: true, jobId: job._id, status: "succeeded", inline: true });
      } catch (inlineErr) {
        await AiJob.updateOne(
          { _id: job._id },
          {
            $set: {
              status: "failed",
              finishedAt: new Date(),
              lastError: inlineErr?.message || "AI review failed",
            },
          }
        );
        return res.status(202).json({ ok: true, jobId: job._id, status: "failed", inline: true });
      }
    }

    res.status(202).json({ ok: true, jobId: job._id, status: job.status });
  } catch (err) {
    next(err);
  }
}

module.exports = { requestAiReview };
