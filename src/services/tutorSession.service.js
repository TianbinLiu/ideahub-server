// src/services/tutorSession.service.js
// 老师人格的学习会话（tutor 仓 docs/05 §5.1 / §5.6；参考实现 devServer.mjs 的 buildMessages / handleTurn / handleQuiz 逐段搬来，数据从课程工作区换成 CourseCtx）。
//   · 一轮 = SSE：token {t} / sentence {index,text} / done / error，与 companion 同形（openSse 同一份响应头）；
//   · 钱（docs/05 §6.2）：tutor_turn 在开流**之前** billing.preAuthorize 原子扣（余额 / 套餐 / 冻结的拒绝还能按 JSON 回 402 / 403），
//     第一个 delta 之前上游抛 ⇒ refundUnaccepted 按扣的那两桶退回；之后断流不退（W2 同口径）；管理员免单照 noteFreeCall 记账。试教同价；
//   · 状态只由 core/session/progress.js 的 advance() 翻（ctx.applyAdvance 是唯一调用口）；政策闸 policyGate 在拼提示词之前判；
//   · 「没懂」「加入必背」两条不过模型、不计费，直接成 typed op（source: reader）落修订记录。
// ★ 演示模式（没配 AI key）：老师是 core/session/demoTeacher 的确定性回复，不扣钱；生产是否允许由 tutorAi.demoAllowed() 决定。
const { chatStream, chat, aiConfig, parseStrictJson } = require("../tutor/core/ai/client");
const { loadPrompt } = require("../tutor/core/ai/prompts");
const { validateOpsBatch, applyOps, appendRevision, readRevisions, appliedOpIds } = require("../tutor/core/ops/index");
const { currentStageId, gradeQuiz, policyGate, selectionContext, demoReply, reviewQuestions, dueReviews, distillDue } = require("../tutor/core/session/index");
const billing = require("./billing.service");
const { priceOf } = require("../config/tokens");
const { setWalletHeaders } = require("./arkGateway.service");
const { openSse } = require("./companion.service");
const { demoAllowed } = require("./tutorAi.service");
const distill = require("./tutorDistill.service");

const SENT_END = /(?<=[。！？!?\n])/;
const textOf = (x) => (typeof x === "string" ? x : (x && x.text) || "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sendJson = (res, status, body) => res.status(status).json(body);
const fail = (res, status, message, extra = {}) => sendJson(res, status, { ok: false, message, ...extra });

function stageOf(ctx, body) {
  const doc = ctx.doc;
  const id = (body && body.stage) || currentStageId(doc, ctx.run.progress) || (doc.map.stages[0] && doc.map.stages[0].stage_id);
  return doc.map.stages.find((s) => s.stage_id === id) || null;
}

/** 提示词拼装（一处实现，docs/05 §5.2）：人格卡 + 学生画像里这一阶段的卡点 / 有效讲法 + 本阶段蒸馏 + 最近 12 轮 + 圈选原文 + 政策 */
function buildMessages(ctx, { stage, body, ctxText, gate, history }) {
  const doc = ctx.doc;
  const st = doc.distill[stage.stage_id] || {};
  const system = loadPrompt("teach", {
    system_prompt: (doc.guide && doc.guide.system_prompt) || "", card_who: (doc.card && doc.card.who) || "", teaching_style: (doc.card && doc.card.teaching_style) || "",
    catchphrases: ((doc.card && doc.card.catchphrases) || []).join(" / "), hard_rules: ((doc.card && doc.card.hard_rules) || []).map((r) => `${r.locked ? "🔒 " : ""}${r.text}`).join("\n") || "（无）",
    profile: [...doc.profile.stuck_points.filter((x) => !x.resolved_at && x.stage_id === stage.stage_id).map((x) => `- 卡点：${x.text}`), ...doc.profile.effective_methods.map((x) => `- 有效讲法 [${x.stage_id}] ${x.text}`)].join("\n") || "（还没有）",
    stage_id: stage.stage_id, stage_title: stage.title, method: st.method || "", must_memorize: (st.must_memorize || []).map(textOf).join("；") || "（无）",
    self_checks: (st.self_checks || []).map((c) => c.q).join("；") || "（无）", pitfalls: (st.pitfalls || []).map(textOf).join("；") || "（无）",
    key_dates: (doc.map.key_dates || []).map((d) => `${d.label} ${d.at}`).join("、") || "（无）",
  });
  const hist = history.filter((t) => t.role === "user" || t.role === "assistant").slice(-12).map((t) => ({ role: t.role, content: t.text || "" }));
  const notes = [];
  if (ctxText) notes.push(`【学生圈选的教材原文（第 ${body.selection.anchor.page} 页，只给你看、不要整段复述）】\n${ctxText}`);
  if (gate && gate.blocked) notes.push(`【课程政策】学生问到作业 / 考试相关的题：只讲原理与方法，不给可交付的答案 / 代码 / 完整推导；开头说明这是这门课的政策（原文：${gate.policyText}）。`);
  if (body.kind === "teach") notes.push("【任务】按「老师的讲法」讲这一阶段，讲完固定问一句「有问题吗，还是下一阶段？」");
  else if (body.direct && String(body.selfExplain || "").trim()) notes.push(`【学生已经用自己的话说了理解】${body.selfExplain}\n现在直接讲，讲完问「还有问题吗？」`);
  else notes.push("【教法】先反问、再分层提示（提示 1 / 提示 2），不直接给结论；引用教材某一页时写 [[p页码]]，例如 [[p12]]。回答完问一句「还有问题吗？」");
  const user = `${body.text || (body.kind === "teach" ? "请讲这一阶段。" : "")}\n\n${notes.join("\n\n")}`.trim();
  return [{ role: "system", content: system }, ...hist, { role: "user", content: user }];
}

/** 演示路吐字：token {t}、sentence {index,text}（与模型路同形） */
async function streamText(send, text) {
  let index = 0;
  for (const sentence of text.split(SENT_END).filter((s) => s.length)) {
    for (let i = 0; i < sentence.length; i += 3) { send("token", { t: sentence.slice(i, i + 3) }); await sleep(8); }
    if (sentence.trim()) send("sentence", { index: index++, text: sentence.trim() });
  }
}

/**
 * POST /runs/:id/turns 与 POST /personas/:id/preview（preview = 试教：不落 Turn、不翻状态、不计入 usage，但**同价**）。
 * 阅读面的「没懂」「加入必背」（kind select / memorize）不过模型、不开流，按 JSON 回。
 */
async function handleTurn(ctx, req, res, body, { preview = false } = {}) {
  const stage = stageOf(ctx, body);
  if (!stage) return fail(res, 400, "课程地图里没有阶段");
  const kind = body.kind || "ask";
  const anchor = body.selection && body.selection.anchor;
  if ((kind === "select" || kind === "memorize") && !anchor) return fail(res, 400, "「没懂」和「加入必背」都要带 selection.anchor");
  if (kind === "select" || kind === "memorize") {
    const seq = (ctx.run.turnSeq || 0) + 1;
    const op = kind === "select"
      ? { op: "profile.stuck_point.add", path: "/profile/stuck_points", value: { stage_id: stage.stage_id, text: `没懂：「${anchor.quote}」` }, evidence: [seq], anchor }
      : { op: "distill.must_memorize.add", path: `/distill/${stage.stage_id}/must_memorize`, value: anchor.quote, evidence: [seq], anchor };
    const v = validateOpsBatch([op], { source: "reader", runId: ctx.doc.id, turnFrom: seq, turnTo: seq, doc: ctx.doc });
    if (!v.ok) return fail(res, 400, `记不下来：${v.errors.join("；")}`);
    await ctx.nextSeq();
    await ctx.logTurn({ seq, role: "user", kind: kind === "select" ? "select" : "meta", text: body.text || "", stage_id: stage.stage_id, selection: body.selection, at: new Date().toISOString() });
    const store = ctx.revisionStore();
    const { doc: next, results } = await applyOps(ctx.doc, v.ops, { appliedIds: appliedOpIds(await readRevisions(store)) });
    await appendRevision(store, { kind: "manual", ops: results, summary: kind === "select" ? "学生标了「没懂」" : "学生想加入必背（等作者点头）", by: "user", source: { turn_from: seq, turn_to: seq, via: "reader" } });
    try { await ctx.persistDoc(next); } catch (e) { return fail(res, 500, e.message); }
    const r = results[0];
    return sendJson(res, 200, { ok: true, seq, status: r.status, ...(kind === "select" ? { stuck: next.profile.stuck_points.at(-1) } : { pending: r.status === "pending" }) });
  }
  if (!["ask", "teach", "quiz-from-selection"].includes(kind)) return fail(res, 400, `不认识的 kind「${kind}」`);
  const cfg = aiConfig();
  if (!cfg && !demoAllowed()) return sendJson(res, 501, { ok: false, code: "AI_NOT_CONFIGURED", message: "服务器还没配模型，老师暂时不能上课" });
  if (!(await ctx.acquire("busy"))) return fail(res, 409, "老师还在回上一句，等它说完再发", { code: "BUSY" });
  let send = null;
  try {
    const gate = policyGate(ctx.doc, body.text || "");
    const flags = { homeworkDetected: gate.homeworkDetected, policyBlocked: gate.blocked };
    // $ tutor_turn：开流之前原子扣（拒绝还能按 JSON 回）；第一个 delta 之前上游抛 ⇒ 退；之后不退。演示模式不扣。
    let pre = null;
    const cost = priceOf("tutor_turn");
    if (cfg) {
      pre = await billing.preAuthorize({ user: req.user, cost, memo: `tutor_turn ${ctx.id}${preview ? " preview" : ""}` });
      if (!pre.ok) { await ctx.release("busy"); setWalletHeaders(res, pre.wallet); return sendJson(res, pre.status, pre.body); }
      setWalletHeaders(res, pre.wallet);
    }
    let userSeq = null;
    if (kind !== "teach" && !preview) {
      userSeq = await ctx.nextSeq();
      await ctx.logTurn({ seq: userSeq, role: "user", kind: kind === "ask" ? "ask" : "quiz", text: body.text || "", stage_id: stage.stage_id, ...(body.selection ? { selection: body.selection } : {}), flags, at: new Date().toISOString() });
    }
    send = openSse(res);
    send("ping", { t: Date.now() }); // 先让代理看到字节
    const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15_000); // Cloudflare 125 秒读超时之下
    ping.unref?.();
    let text = "";
    let tokens = 0;
    let accepted = !cfg;
    try {
      if (cfg) {
        const mat = anchor ? await ctx.findMaterial(anchor.material) : null;
        const ctxText = anchor ? selectionContext((await ctx.pagesOf(mat)) || [], anchor) : "";
        const history = preview ? [] : await ctx.readTurns();
        let sentence = "";
        let index = 0;
        const abort = new AbortController();
        res.on("close", () => { if (!res.writableFinished) abort.abort(); });
        try {
          for await (const ev of chatStream({ messages: buildMessages(ctx, { stage, body, ctxText, gate, history }), maxTokens: kind === "teach" ? 1024 : 512, kind: preview ? "preview" : "turn", meta: { courseId: ctx.id, userId: String(req.user._id), stage: stage.stage_id, turnKind: kind } }, { signal: abort.signal })) {
            if (ev.delta) {
              if (!accepted) { accepted = true; await billing.noteFreeCall({ user: req.user, cost, memo: `tutor_turn ${ctx.id}`, snapshot: pre.before }); }
              text += ev.delta; sentence += ev.delta; send("token", { t: ev.delta });
              const parts = sentence.split(SENT_END);
              if (parts.length > 1) { for (const s of parts.slice(0, -1)) if (s.trim()) send("sentence", { index: index++, text: s.trim() }); sentence = parts.at(-1); }
            }
            if (ev.done) { tokens = (ev.done.usage && ev.done.usage.total_tokens) || 0; if (sentence.trim()) send("sentence", { index: index++, text: sentence.trim() }); }
          }
        } catch (e) {
          if (!accepted) { await billing.refundUnaccepted({ user: req.user, cost, memo: `tutor_turn ${ctx.id}`, refundTag: "tutor_refund", took: pre && pre.took }); throw new Error(`${e.message}（这一轮的 token 已退回）`); }
          throw e; // 第一个 token 之后断流：已扣、半截如实说
        }
      } else {
        text = demoReply({ doc: ctx.doc, stageId: stage.stage_id, kind, text: body.text, selection: body.selection, direct: !!body.direct, selfExplain: body.selfExplain });
        if (gate.blocked) text = `这门课的政策是：作业与考试只讲原理、不给可交付的答案（${gate.policyText.slice(0, 60)}…）。\n\n${text}`;
        await streamText(send, text);
      }
      let seq = null;
      let changed = [];
      if (!preview) {
        seq = await ctx.nextSeq();
        await ctx.logTurn({ seq, role: "assistant", kind: kind === "teach" ? "teach" : kind === "ask" ? "answer" : "quiz", text, stage_id: stage.stage_id, ...(userSeq ? { replyTo: userSeq } : {}), flags, tokens, demo: !cfg, at: new Date().toISOString() });
        ctx.run.usage = { ...(ctx.run.usage || {}), turns: ((ctx.run.usage && ctx.run.usage.turns) || 0) + 1, tokens: ((ctx.run.usage && ctx.run.usage.tokens) || 0) + tokens };
        if (kind === "teach") { const r = await ctx.applyAdvance({ type: "taught", stage: stage.stage_id }); changed = (r && r.changed) || []; }
        await ctx.persistRun();
      }
      // 蒸馏的自动触发（docs/02 4.1）：每 8 个一问一答；30 分钟无动作那条由 tutor.worker 扫 lastTurnAt。都在 done 之后异步跑，不拖住这一句。
      const distillQueued = !preview && kind !== "teach" && distillDue(ctx.run, await ctx.readTurns(), "turns").due;
      send("done", { seq, kind: kind === "teach" ? "teach" : kind === "ask" ? "answer" : "quiz", text, flags, demo: !cfg, preview, stage: stage.stage_id, progress: ctx.run.progress, status: ctx.run.status, changed, distillQueued });
      if (distillQueued) distill.autoDistill(ctx, req.user, "turns");
    } catch (e) {
      send("error", { message: e.message });
    } finally {
      clearInterval(ping);
      res.end();
    }
  } catch (e) {
    if (send) { send("error", { message: e.message }); res.end(); } else if (!res.headersSent) fail(res, 500, e.message);
  } finally {
    await ctx.release("busy");
  }
}

/** POST /runs/:id/quiz（自检 / 回访 review:true）：模型逐题判对错（严格 JSON；形状不对退回确定性判法）；阈值与翻状态只在 advance() */
async function handleQuiz(ctx, req, res, body) {
  const stage = stageOf(ctx, body);
  if (!stage) return fail(res, 400, "课程地图里没有阶段");
  const review = !!body.review;
  if (review && (!ctx.run.progress[stage.stage_id] || ctx.run.progress[stage.stage_id].status !== "passed")) return fail(res, 409, `${stage.stage_id} 还没通过，谈不上回访`, { code: "NOT_PASSED" });
  const turns = await ctx.readTurns();
  const checks = review ? reviewQuestions(ctx.doc, ctx.run, turns, stage.stage_id) : ((ctx.doc.distill[stage.stage_id] && ctx.doc.distill[stage.stage_id].self_checks) || []);
  if (!checks.length) return fail(res, 400, review ? "这一阶段凑不出回访题" : "这一阶段没有自检题：作者可以跳过它");
  const answers = Array.isArray(body.answers) ? body.answers : [];
  let graded = gradeQuiz(checks, answers);
  if (aiConfig()) { // ★ 模型判卷今天**不单独计费**（tutor 仓 docs/08 #4 待拍板：并进 tutor_turn 还是当门禁成本）；账本里单列 quiz-grade 一行
    try {
      const reply = await chat({ system: "你是判卷老师，只输出一个 JSON 对象，不输出任何解释。", json: true, maxTokens: 800, kind: "quiz-grade", meta: { courseId: ctx.id, userId: String(req.user._id), stage: stage.stage_id, review }, user: `逐题判断学生的回答是否正确（数值题结果对即可，单位错要在 why 里指出；概念题意思对即可）。输出 {"results":[{"correct":true|false,"why":"一句话"}]}，results 长度必须等于题数。\n\n${checks.map((c, i) => `第 ${i + 1} 题：${c.q}\n参考答案：${c.a}\n学生答：${answers[i] ?? "（空）"}`).join("\n\n")}` });
      const j = parseStrictJson(reply.text);
      if (Array.isArray(j.results) && j.results.length === checks.length && j.results.every((r) => typeof r.correct === "boolean")) {
        graded = { results: checks.map((c, i) => ({ q: c.q, kind: c.kind, expected: c.a, given: String(answers[i] ?? ""), correct: j.results[i].correct, why: String(j.results[i].why || "") })), correct: j.results.filter((r) => r.correct).length, asked: checks.length };
      }
    } catch (e) { console.warn(`[tutor] 模型判卷失败，用确定性判法：${e.message}`); }
  }
  const seq = await ctx.nextSeq();
  await ctx.logTurn({ seq, role: "user", kind: "quizResult", text: `${review ? "回访" : "自检"} ${graded.correct}/${graded.asked}`, stage_id: stage.stage_id, review, results: graded.results.map((g, i) => ({ ...g, ...(checks[i].anchor ? { anchor: checks[i].anchor } : {}), ...(checks[i].from ? { from: checks[i].from } : {}) })), at: new Date().toISOString() });
  const r = await ctx.applyAdvance({ type: "quiz", stage: stage.stage_id, correct: graded.correct, asked: graded.asked });
  if (r.error) return fail(res, 409, r.error);
  const passed = ctx.run.progress[stage.stage_id].status === "passed";
  const distillQueued = !review && passed && distillDue(ctx.run, await ctx.readTurns(), "stageDone").due; // 阶段完成 = 蒸馏的第三个触发；回访通过不算
  sendJson(res, 200, { ok: true, ...graded, passed, review, progress: ctx.run.progress, status: ctx.run.status, changed: r.changed, nextStage: currentStageId(ctx.doc, ctx.run.progress), nextReviewAt: ctx.run.progress[stage.stage_id].nextReviewAt ?? null, dueReviews: dueReviews(ctx.doc, ctx.run.progress), distillQueued });
  if (distillQueued) distill.autoDistill(ctx, req.user, "stageDone");
}

module.exports = { handleTurn, handleQuiz, buildMessages, stageOf };
