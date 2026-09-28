// src/services/tutorDistill.service.js
// 蒸馏（tutor 仓 docs/02 §4、docs/03 §7；参考实现 devServer.mjs 的 runDistill / autoDistill / revisionView 逐段搬来）。
// 一次 = 自上次以来的 turns → typed ops（模型 / 演示）→ 白名单 → profile.* 自动落、distill.* / card.* 进待点头 → 一条修订记录（TutorRevision）。
//   · 触发四条（docs/02 4.1）：手动 / 满 8 个一问一答（turns 端点 done 之后）/ 阶段完成（quiz 端点）/ 30 分钟无动作（tutor.worker 扫 lastTurnAt）；
//   · 钱：$ tutor_distill 走 billing.chargedCall，模型回了正文 = 受理、那一拍扣一次；读不出 / 形状不对**重试一次不再扣**，再拒就标 failed 当面说（已计费）；
//   · 同一窗口上次整批被拒（run.distill.failedFrom）不再自动重试 —— 每一发都计费，留给手动。
const { chat, aiConfig, parseStrictJson } = require("../tutor/core/ai/client");
const { validateOpsBatch, applyOps, appendRevision, readRevisions, appliedOpIds, summarize } = require("../tutor/core/ops/index");
const { currentStageId, distillDue, distillPrompt, demoDistillOps, describeOpValue } = require("../tutor/core/session/index");
const billing = require("./billing.service");
const { priceOf } = require("../config/tokens");
const { demoAllowed } = require("./tutorAi.service");

/** 一条修订记录给界面看的形状：每条 op 带一句人话正文与所在阶段 */
function revisionView(rec, doc) {
  const stageTitle = (id) => (doc && doc.map.stages.find((s) => s.stage_id === id) && doc.map.stages.find((s) => s.stage_id === id).title) || "";
  return {
    id: rec.id, kind: rec.kind, summary: rec.summary, review: rec.review, by: rec.by, created_at: rec.created_at, source: rec.source || {}, of: rec.of,
    ops: (rec.ops || []).map((op) => {
      const m = /^\/distill\/(stage-\d{2,3})\//.exec(op.path || "");
      const stage = m ? m[1] : (op.value && op.value.stage_id) || null;
      return { opId: op.opId, op: op.op, path: op.path, status: op.status, mode: op.mode, evidence: op.evidence || [], rationale: op.rationale, anchor: op.anchor, value: op.value, text: describeOpValue(op), stage, stageTitle: stage ? stageTitle(stage) : "", reviewed_at: op.reviewed_at, reverted_at: op.reverted_at };
    }),
  };
}
function learnedOf(rec) { const n = (st) => ((rec && rec.ops) || []).filter((o) => o.status === st).length; return { applied: n("applied"), pending: n("pending"), noop: n("noop") + n("skipped"), rejected: n("rejected") }; }

/**
 * @returns {{ status: "nothing"|"busy"|"failed"|"done"|"empty"|"denied", why?, errors?, revision?, results?, window, billing? }}
 */
async function runDistill(ctx, user, { reason = "manual" } = {}) {
  const turns = await ctx.readTurns();
  const due = distillDue(ctx.run, turns, reason);
  const win = { from: due.window.from, to: due.window.to, exchanges: due.window.exchanges };
  if (!due.due) return { status: "nothing", why: due.why, window: win };
  if (!(await ctx.acquire("distilling"))) return { status: "busy", why: "上一次整理还没结束", window: win };
  try {
    const w = due.window;
    const stage = ctx.doc.map.stages.find((s) => s.stage_id === w.stageId) || ctx.doc.map.stages.find((s) => s.stage_id === currentStageId(ctx.doc, ctx.run.progress)) || ctx.doc.map.stages[0];
    const cfg = aiConfig();
    if (!cfg && !demoAllowed()) return { status: "denied", why: "服务器还没配模型", window: win };
    let ops;
    let charged = null;
    if (cfg) {
      const prompt = distillPrompt({ doc: ctx.doc, stage, turns: w.turns });
      const meta = { courseId: ctx.id, userId: String(user._id), stage: stage.stage_id, reason };
      const askOnce = async (p, retry) => (await chat({ system: "你只输出一个 JSON 对象，不输出任何解释。", user: p, json: true, maxTokens: 3000, kind: "distill", meta: retry ? { ...meta, retry: true } : meta })).text;
      // $ tutor_distill：模型回了正文 = 受理；读不出重试一次（同一笔钱）
      const r = await billing.chargedCall({
        user, cost: priceOf("tutor_distill"), memo: `tutor_distill ${ctx.id} ${reason}`, refundTag: "tutor_refund",
        forward: async () => {
          let text;
          try { text = await askOnce(prompt, false); } catch (e) { return { accepted: false, error: e }; }
          try { return { accepted: true, ops: parseStrictJson(text).ops }; } catch (e) {
            console.warn(`[tutor] 蒸馏第一发读不出来（${e.message}），重试一次`);
            try { return { accepted: true, ops: parseStrictJson(await askOnce(prompt, true)).ops }; } catch (e2) { return { accepted: true, error: e2 }; }
          }
        },
      });
      if (!r.ok) return { status: "denied", why: r.body && r.body.message, billing: r.body, window: win };
      charged = { cost: r.cost, free: r.free, wallet: r.wallet };
      if (!r.accepted) return { status: "failed", errors: [`模型没有回包：${(r.result && r.result.error && r.result.error.message) || "?"}（这一次的 token 已退回）`], window: win, billing: charged };
      if (r.result.error) { ops = null; }
      else ops = r.result.ops;
      if (ops === null) {
        const now = new Date().toISOString();
        const rec = await appendRevision(ctx.revisionStore(), { kind: "distill", ops: [], summary: `这次没整理成：模型两次都没给出合法 JSON（已计费一次）`, by: "ai", review: "n/a", source: { turn_from: w.from, turn_to: w.to, reason, mode: "model", stage: stage.stage_id, rejected: [String(r.result.error.message)] } });
        ctx.run.distill = { ...(ctx.run.distill || { upTo: 0 }), failedFrom: w.from, lastAt: new Date(now) };
        await ctx.persistRun();
        return { status: "failed", errors: [String(r.result.error.message)], revision: rec, window: win, billing: charged };
      }
    } else ops = demoDistillOps({ doc: ctx.doc, turns: w.turns });
    let v = validateOpsBatch(ops, { source: "distill", runId: ctx.doc.id, turnFrom: w.from, turnTo: w.to, doc: ctx.doc });
    if (!v.ok && cfg) { // 白名单整批拒 → 重试一次（把被拒的原因带给模型，这一发不再计费）；再拒就标 failed 当面说
      console.warn(`[tutor] 蒸馏整批被拒（${v.errors.length} 条），重试一次`);
      const prompt = `${distillPrompt({ doc: ctx.doc, stage, turns: w.turns })}\n\n上一次的回答被程序整批拒绝，原因：\n${v.errors.map((e) => `- ${e}`).join("\n")}\n请只输出合规的 op。`;
      try { ops = parseStrictJson((await chat({ system: "你只输出一个 JSON 对象，不输出任何解释。", user: prompt, json: true, maxTokens: 3000, kind: "distill", meta: { courseId: ctx.id, userId: String(user._id), stage: stage.stage_id, reason, retry: true } })).text).ops; v = validateOpsBatch(ops, { source: "distill", runId: ctx.doc.id, turnFrom: w.from, turnTo: w.to, doc: ctx.doc }); } catch (e) { v = { ok: false, errors: [e.message], ops: [] }; }
    }
    const store = ctx.revisionStore();
    const now = new Date();
    if (!v.ok) {
      const rec = await appendRevision(store, { kind: "distill", ops: [], summary: `这次没整理成：${v.errors.length} 条不合白名单${cfg ? "（已计费一次）" : ""}`, by: "ai", review: "n/a", source: { turn_from: w.from, turn_to: w.to, reason, mode: cfg ? "model" : "demo", stage: stage.stage_id, rejected: v.errors } });
      ctx.run.distill = { ...(ctx.run.distill || { upTo: 0 }), failedFrom: w.from, lastAt: now };
      await ctx.persistRun();
      return { status: "failed", errors: v.errors, revision: rec, window: win, billing: charged };
    }
    const { doc: next, results } = await applyOps(ctx.doc, v.ops, { appliedIds: appliedOpIds(await readRevisions(store)) });
    const rec = await appendRevision(store, { kind: "distill", ops: results, summary: summarize(results), by: "ai", source: { turn_from: w.from, turn_to: w.to, reason, mode: cfg ? "model" : "demo", stage: stage.stage_id } });
    if (results.some((r) => r.status === "applied")) await ctx.persistDoc(next);
    ctx.run.distill = { upTo: w.to, lastAt: now, count: ((ctx.run.distill && ctx.run.distill.count) || 0) + 1 };
    ctx.run.usage = { ...(ctx.run.usage || {}), distills: ((ctx.run.usage && ctx.run.usage.distills) || 0) + 1 };
    await ctx.persistRun();
    return { status: results.length ? "done" : "empty", why: results.length ? undefined : rec.summary, revision: rec, results, window: win, billing: charged };
  } finally { await ctx.release("distilling"); }
}

/** 自动触发的那几拍：异步跑、失败只记日志（它是旁路，不是主链路） */
function autoDistill(ctx, user, reason) {
  runDistill(ctx, user, { reason })
    .then((r) => { if (r.status !== "nothing") console.log(`[tutor] 蒸馏（${reason}）${ctx.id}：${r.status}${r.revision ? ` · ${r.revision.summary}` : r.why ? ` · ${r.why}` : ""}`); })
    .catch((e) => console.error(`[tutor] 蒸馏（${reason}）${ctx.id} 失败:`, (e && e.message) || e));
}

module.exports = { runDistill, autoDistill, revisionView, learnedOf };
