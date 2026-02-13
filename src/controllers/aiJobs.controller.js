const mongoose = require("mongoose");
const AiJob = require("../models/AiJob");

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

// GET /api/ai-jobs/:id
async function getAiJob(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      res.status(400);
      throw new Error("Invalid job id");
    }

    const job = await AiJob.findById(id).lean();
    if (!job) {
      res.status(404);
      throw new Error("Job not found");
    }

    // 只允许请求者看（你也可允许 idea 作者看）
    if (String(job.requesterId) !== String(req.user._id)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    res.json({ ok: true, job });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAiJob };
