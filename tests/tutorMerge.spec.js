/**
 * 合并新版（tutor 仓 docs/03 §6.3）：核心包 core/publish/merge 在本仓能装载、按演示模式生成的老师跑一次三方合并；
 * tutorMerge.service 的早退（没 sourcePersona → 409 NOT_FORKED）不碰库；TutorRun / TutorCourse / TutorRating 的新字段与索引在模型上。不连 Mongo。
 */
const { runGenerate } = require("../src/tutor/core/generate/index");
const { validateTutorDoc } = require("../src/tutor/core/format/index");
const { initProgress, nextReviewAt } = require("../src/tutor/core/session/index");
const { mergeRelease, describeMerge } = require("../src/tutor/core/publish/merge");
const { RATING_MIN_VOTES } = require("../src/tutor/core/publish/rating");
const market = require("../src/services/tutorMarket.service");
const mergeSvc = require("../src/services/tutorMerge.service");
const TutorRun = require("../src/models/TutorRun");
const TutorCourse = require("../src/models/TutorCourse");
const TutorRating = require("../src/models/TutorRating");

const pages = require("./fixtures/tutor/week1-delay.pages.json");
const mats = [{ sha: "a".repeat(64), name: "week1-delay.pdf", ext: ".pdf", pages, license: { source: "self" } }];
const course = { title: "计算机网络", subject: "计算机网络", code: "CSEN 146", policy: { ai: "limited", homework_mode: "principles_only", allowed_uses: [], text: "作业独立完成" }, key_dates: [] };
const clone = (x) => JSON.parse(JSON.stringify(x));

describe("core/publish/merge（CJS 生成物）", () => {
  it("三方合并：进度按 stage_id 保留、新段 pending、作者改的讲法照收、学习者的问答留着；文档合规范；一句话回执", async () => {
    delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY;
    const { doc } = await runGenerate({ course, materials: mats, questionnaire: { name: "老包", style: "socratic" }, env: {} });
    const s1 = doc.map.stages[0].stage_id;
    const mine = clone(doc); mine.distill[s1].student_qa.push({ q: "我问的", a: "答" });
    const progress = initProgress(mine); progress[s1] = { status: "passed", stepIdx: 0, nextReviewAt: "2026-10-01T00:00:00.000Z" };
    const release = clone(doc); release.version += 1; release.distill[s1].method = "新讲法";
    release.map.stages.push({ stage_id: "stage-99", week: 99, title: "新段", summary: "", status: "未讲", key_date: "" });
    release.distill["stage-99"] = { method: "m", must_memorize: [], self_checks: [], student_qa: [], pitfalls: [] };
    const r = mergeRelease({ mine, release, base: doc, progress });
    expect(validateTutorDoc(r.doc, { requireLabels: false }).ok).toBe(true);
    expect(r.progress[s1]).toEqual(progress[s1]);
    expect(r.progress["stage-99"].status).toBe("pending");
    expect(r.doc.distill[s1].method).toBe("新讲法");
    expect(r.doc.distill[s1].student_qa).toEqual([{ q: "我问的", a: "答" }]);
    expect(r.doc.stages).toBe(r.doc.map.stages.length);
    expect(r.report).toMatchObject({ added: ["stage-99"], removed: [], changed: [s1], baseKnown: true });
    expect(describeMerge(r.report, "老包")).toMatch(/^合并 老包 v\d+：新增 1 段、更新 1 段内容、保留你的 1 条问答$/);
    expect(nextReviewAt(r.progress)).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("tutorMerge.service / 模型形状", () => {
  it("不是从市场开的课 → 409 NOT_FORKED（不查库）；sourceState(null) 为 null", async () => {
    expect(await mergeSvc.merge({ course: {}, doc: {}, run: {} })).toMatchObject({ status: 409, body: { code: "NOT_FORKED" } });
    expect(await mergeSvc.sourceState(null)).toBeNull();
  });
  it("TutorRun 多 nextReviewAt（索引）/ reviewNotifiedAt / archived；TutorCourse 多 mergedAt；TutorRating {user, persona} 唯一；沉底票数与核心包同源", () => {
    expect(TutorRun.schema.path("nextReviewAt").instance).toBe("Date");
    expect(TutorRun.schema.path("nextReviewAt").options.index).toBe(true);
    expect(TutorRun.schema.path("reviewNotifiedAt").instance).toBe("Date");
    expect(TutorRun.schema.path("archived")).toBeTruthy();
    expect(TutorCourse.schema.path("mergedAt").instance).toBe("Date");
    expect(TutorRating.schema.indexes().some(([k, o]) => k.user === 1 && k.persona === 1 && o.unique)).toBe(true);
    expect(TutorRating.schema.path("stars").options).toMatchObject({ min: 1, max: 5 });
    expect(market.RATING_MIN_VOTES).toBe(RATING_MIN_VOTES);
  });
});
