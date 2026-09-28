// src/workers/tutor.worker.js
// 老师人格的长活（tutor 仓 docs/05 §4.8、§5.5）：① 生成作业（TutorJob pending → runGenerate，串行、检查点续跑）；
// ② 30 分钟无动作的那一次蒸馏（扫 TutorRun.lastTurnAt；参考实现里是进程内计时器，进程一重启就丢，这里改成扫表）。
// ★ 只在 0 号实例跑（index.js 里判 NODE_APP_INSTANCE，与 AI worker 同一处）；开关就是 TUTOR_ENABLED=true —— 没开等于整个模块没挂。
// ★ 同时只跑一个生成（教材蒸馏是最重的 AI 调用，docs/05 §4.8）；失败只记日志，绝不让它把进程带崩（铁律八）。
const TutorRun = require("../models/TutorRun");
const { runNextJob } = require("../services/tutorAi.service");
const { runDistill } = require("../services/tutorDistill.service");
const { CourseCtx } = require("../services/tutorStore.service");
const { DISTILL_IDLE_MS } = require("../tutor/core/session/index");

const POLL_MS = Number(process.env.TUTOR_WORKER_POLL_MS || 3000);
const IDLE_SWEEP_MS = 60 * 1000;
let busy = false;

async function tickJobs() {
  if (busy) return;
  busy = true;
  try { for (;;) { const job = await runNextJob(); if (!job) break; console.log(`[tutor] generate ${job.course} → ${job.status}${job.error ? `（${job.error}）` : ""}`); } }
  catch (e) { console.error("[tutor] worker 抢作业失败:", (e && e.message) || e); }
  finally { busy = false; }
}

/** 30 分钟没动作 = 下课 → 蒸馏一次（docs/02 3.11 / 4.1）；同一个 lastTurnAt 只处理一次（distill.idleFor） */
async function sweepIdle(now = new Date()) {
  const cutoff = new Date(now.getTime() - DISTILL_IDLE_MS);
  const runs = await TutorRun.find({ lastTurnAt: { $lte: cutoff }, $expr: { $gt: ["$turnSeq", { $ifNull: ["$distill.upTo", 0] }] } }).limit(20);
  let n = 0;
  for (const run of runs) {
    if (run.distill && run.distill.idleFor && run.distill.idleFor.getTime() >= run.lastTurnAt.getTime()) continue;
    try {
      const ctx = await CourseCtx.load(run.course, { _id: run.user });
      if (ctx && ctx.doc) { const r = await runDistill(ctx, { _id: run.user }, { reason: "idle" }); n++; if (r.status !== "nothing") console.log(`[tutor] 蒸馏（idle）${ctx.id}：${r.status}`); }
    } catch (e) { console.error(`[tutor] 蒸馏（idle）${run.course} 失败:`, (e && e.message) || e); }
    await TutorRun.updateOne({ _id: run._id }, { $set: { "distill.idleFor": run.lastTurnAt } });
  }
  return n;
}

function startTutorWorker() {
  const jobs = setInterval(() => { tickJobs(); }, POLL_MS);
  jobs.unref?.();
  const idle = setInterval(() => { sweepIdle().catch((e) => console.error("[tutor] idle 清扫失败:", (e && e.message) || e)); }, IDLE_SWEEP_MS);
  idle.unref?.();
  console.log(`[tutor] worker 已启动（作业每 ${POLL_MS}ms 抢一次，30 分钟无动作蒸馏每分钟扫一次）`);
  return () => { clearInterval(jobs); clearInterval(idle); };
}

module.exports = { startTutorWorker, tickJobs, sweepIdle };
