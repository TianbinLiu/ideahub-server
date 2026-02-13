const AiJob = require("../models/AiJob");
const Idea = require("../models/Idea");
const { runAiReview } = require("../services/aiReview.service");

const POLL_MS = Number(process.env.AI_WORKER_POLL_MS || 4000);
const MAX_ATTEMPTS = Number(process.env.AI_JOB_MAX_ATTEMPTS || 3);

async function pickOneJob() {
  // 原子抢占
  return AiJob.findOneAndUpdate(
    { status: "pending", attempts: { $lt: MAX_ATTEMPTS } },
    { $set: { status: "running", startedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true }
  );
}

async function processJob(job) {
  const idea = await Idea.findById(job.ideaId);
  if (!idea) {
    await AiJob.updateOne(
      { _id: job._id },
      { $set: { status: "failed", finishedAt: new Date(), lastError: "Idea not found" } }
    );
    return;
  }

  try {
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
  } catch (err) {
    const msg = err?.message || "AI review failed";
    const attempts = job.attempts || 1;
    const isLast = attempts >= MAX_ATTEMPTS;

    await AiJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: isLast ? "failed" : "pending",
          finishedAt: isLast ? new Date() : undefined,
          lastError: msg,
        },
      }
    );
  }
}

function startAiWorker() {
  if (process.env.ENABLE_AI_WORKER !== "true") {
    console.log("AI worker disabled. Set ENABLE_AI_WORKER=true to enable.");
    return;
  }

  console.log(`AI worker started. poll=${POLL_MS}ms maxAttempts=${MAX_ATTEMPTS}`);

  setInterval(async () => {
    try {
      const job = await pickOneJob();
      if (!job) return;
      await processJob(job);
    } catch (e) {
      console.error("AI worker tick error:", e?.message || e);
    }
  }, POLL_MS);
}

module.exports = { startAiWorker };
