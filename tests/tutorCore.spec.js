/**
 * 老师人格核心包（src/tutor/core，从 tutor 仓同步的 CJS 生成物）在本仓能装载、能在演示模式下走完
 * 生成 → 往返 → 修订记录（store 版）→ 导出 / 导入 → 状态机；以及价目与 tutor 仓那份报价同源。不碰数据库。
 */
const { runGenerate, planGenerate, PRICES } = require("../src/tutor/core/generate/index");
const { validateOpsBatch, applyOps } = require("../src/tutor/core/ops/index");
const rev = require("../src/tutor/core/ops/revision");
const { parseTutorDoc, validateTutorDoc } = require("../src/tutor/core/format/index");
const { buildExport, parseImport } = require("../src/tutor/core/export/index");
const { initProgress, advance, distillDue, demoDistillOps } = require("../src/tutor/core/session/index");
const { summarizeLedger, derivePrices } = require("../src/tutor/core/measure/index");
const { loadPrompt } = require("../src/tutor/core/ai/prompts");
const { priceOf, TUTOR_PRICES, CHAT_TURN_TOKENS } = require("../src/config/tokens");

const pages = require("./fixtures/tutor/week1-delay.pages.json");
const mats = [{ sha: "a".repeat(64), name: "week1-delay.pdf", ext: ".pdf", pages, license: { source: "self" } }];
const course = { title: "计算机网络", subject: "计算机网络", code: "CSEN 146", policy: { ai: "limited", homework_mode: "principles_only", allowed_uses: [], text: "作业独立完成" }, key_dates: [] };

describe("tutor core（CJS 生成物）", () => {
  it("提示词从 core/prompts 读得到，占位符全填", () => {
    expect(loadPrompt("teach", { system_prompt: "s", card_who: "w", teaching_style: "t", catchphrases: "", hard_rules: "", profile: "", stage_id: "stage-01", stage_title: "x", method: "", must_memorize: "", self_checks: "", pitfalls: "", key_dates: "" })).toMatch(/stage-01/);
    expect(() => loadPrompt("teach", {})).toThrow(/占位符/);
  });

  it("演示模式生成 → 往返无损 → 修订（store 版）点头 / 撤销 → 导出 / 导入 → 状态机", async () => {
    delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY;
    expect(planGenerate(mats).quote.total).toBe(0);
    const out = await runGenerate({ course, materials: mats, questionnaire: { name: "老包", style: "socratic" }, env: {} });
    expect(out.mode).toBe("demo");
    expect(out.doc.map.stages.length).toBeGreaterThan(0);
    expect(out.anchors.hit).toBe(out.anchors.quotes);
    const back = parseTutorDoc(out.text).doc;
    expect(validateTutorDoc(back, { requireLabels: false }).ok).toBe(true);
    expect(back.map.stages.length).toBe(out.doc.map.stages.length);

    const store = rev.memoryRevisionStore();
    const stage = out.doc.map.stages[0].stage_id;
    const ops = [{ op: "profile.stuck_point.add", path: "/profile/stuck_points", value: { stage_id: stage, text: "没懂 x" }, evidence: [1] }, { op: "distill.pitfall.add", path: `/distill/${stage}/pitfalls`, value: "易错点 y", evidence: [1] }];
    const v = validateOpsBatch(ops, { source: "distill", runId: out.doc.id, turnFrom: 1, turnTo: 1, doc: out.doc });
    expect(v.ok).toBe(true);
    const { doc: d2, results } = await applyOps(out.doc, v.ops, { appliedIds: rev.appliedOpIds(await rev.readRevisions(store)) });
    expect(results.map((r) => r.status)).toEqual(["applied", "pending"]);
    const rec = await rev.appendRevision(store, { kind: "distill", ops: results, summary: rev.summarize(results), by: "ai" });
    expect(rec.review).toBe("pending");
    const rv = await rev.reviewRevision(store, d2, rec.id, { accept: [results[1].opId] });
    expect(rv.doc.distill[stage].pitfalls).toContain("易错点 y");
    expect((await rev.readRevisions(store))[0].review).toBe("accepted");
    const un = await rev.revertOps(store, rv.doc, rec.id, [results[1].opId]);
    expect(un.doc.distill[stage].pitfalls).not.toContain("易错点 y");
    expect((await rev.readRevisions(store)).map((r) => r.kind)).toEqual(["distill", "revert"]);

    const exp = buildExport(out.doc, { audience: "market", materials: [{ name: "w", text: pages.map((p) => p.blocks.map((b) => b.text).join("\n")).join("\n") }] });
    expect(exp.ok).toBe(true);
    expect(exp.cleanSkipped).toBe(false);
    expect(parseImport({ text: exp.text }).ok).toBe(true);
    const unsure = buildExport({ ...out.doc, license: { ...out.doc.license, source: "unsure" } }, { audience: "market" });
    expect(unsure.ok).toBe(false);
    expect(unsure.code).toBe("INVALID");

    const run = { progress: initProgress(out.doc), status: "active", distill: { upTo: 0 } };
    expect(advance(out.doc, run, { type: "taught", stage }).changed[0]).toMatch(/已讲/);
    expect(distillDue(run, [], "manual").due).toBe(false);
    expect(demoDistillOps({ doc: out.doc, turns: [] })).toEqual([]);
  });

  it("价目：三个 tutor 单价在 priceOf 里有价且与 core 报价同源；tutor_turn 钉在 CHAT_TURN_TOKENS", () => {
    for (const k of ["tutor_turn", "tutor_distill", "tutor_extract"]) { expect(priceOf(k)).toBeGreaterThan(0); expect(priceOf(k)).toBe(PRICES[k]); expect(TUTOR_PRICES[k]).toBe(PRICES[k]); }
    expect(priceOf("tutor_turn")).toBe(CHAT_TURN_TOKENS);
  });

  it("量具：账本汇总与推价（与 tutor 仓 docs/10 同一份）", () => {
    const rec = (kind, total) => ({ at: "2026-09-27T01:00:00.000Z", kind, model: "m", ok: true, promptTokens: total - 10, completionTokens: 10, totalTokens: total, latencyMs: 100 });
    const recs = [rec("turn", 1000), rec("turn", 1200), rec("distill", 2400), rec("stage", 3600)];
    expect(summarizeLedger(recs).total.calls).toBe(4);
    const p = derivePrices(recs);
    const by = Object.fromEntries(p.rows.map((r) => [r.price, r]));
    expect(by.tutor_turn.recommended).toBe(400);
    expect(by.tutor_distill.recommended).toBe(800);
    expect(by.tutor_extract.recommended).toBe(1200);
  });
});
