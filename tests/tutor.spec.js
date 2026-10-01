/**
 * 老师人格（/api/tutor）端到端：建课 → 教材直传票 / 验收（Cloudinary Admin API 用 spy 换掉）→ 生成（演示模式，worker 的一步直接调）→
 * 学习页 bundle → 漫游进度 → 一轮 SSE → 自检先错后对（阶段通过、回访时间落下）→ 手动蒸馏 → 修订点头 → 导出发布件 → 导入回读 → 使用记录 → 账本 → 改授权来源。
 * 与 tutor 仓 tests/server.test.mjs 同一条链（那边打的是文件版参考实现，这边打的是 Mongo 版）。
 * ★ TUTOR_ENABLED 与 CLOUDINARY_* 都是 require 时读的，必须在 require("../src/app") 之前设好。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const pages = require("./fixtures/tutor/week1-delay.pages.json");

let mongod;
let app;
let cloudinary;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  process.env.TUTOR_ENABLED = "true";
  process.env.CLOUDINARY_CLOUD_NAME = "demo-cloud";
  process.env.CLOUDINARY_API_KEY = "123456";
  process.env.CLOUDINARY_API_SECRET = "shh-test";
  delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY; // 演示模式（NODE_ENV=test 允许）
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  ({ cloudinary } = require("../src/config/cloudinary")); // ★ 要解构：spy 必须装在服务用的同一个 v2 对象上
});
afterAll(async () => { await mongoose.disconnect(); if (mongod) await mongod.stop(); });

async function createUser(prefix = "tu") {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `${prefix}_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  return { user, token: signToken(user) };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const SHA = "b".repeat(64);
const COURSE = { title: "计算机网络", subject: "计算机网络", code: "CSEN 146", policy: { ai: "limited", homework_mode: "principles_only", text: "作业独立完成" }, key_dates: [{ label: "作业 1", at: "2026-10-01", kind: "homework" }] };

describe("老师人格：建课 → 教材 → 生成 → 上课 → 蒸馏 → 导出", () => {
  jest.setTimeout(60_000);

  it("整条链", async () => {
    const { token } = await createUser();
    const other = await createUser("ot");

    // health 不鉴权；config 要登录；成人声明幂等
    expect((await request(app).get("/api/tutor/health")).body).toMatchObject({ ok: true, tutor: true, demo: true });
    expect((await request(app).get("/api/tutor/config")).status).toBe(401);
    const cfg = await request(app).get("/api/tutor/config").set(auth(token));
    expect(cfg.body.prices).toEqual({ tutor_turn: 400, tutor_distill: 600, tutor_extract: 400 });
    expect(cfg.body.adultDeclared).toBe(false);
    expect((await request(app).post("/api/tutor/declare-adult").set(auth(token)).send({})).body.adultDeclaredAt).toBeTruthy();
    expect((await request(app).get("/api/tutor/config").set(auth(token))).body.adultDeclared).toBe(true);

    // 建课：缺必填 400 并指名字段；成功 201
    expect((await request(app).post("/api/tutor/courses").set(auth(token)).send({ title: "x", subject: "y", policy: { ai: "limited" } })).status).toBe(400);
    const created = await request(app).post("/api/tutor/courses").set(auth(token)).send(COURSE);
    expect(created.status).toBe(201);
    const cid = created.body.course.id;
    expect(created.body.course).toMatchObject({ title: "计算机网络", materials: 0, persona: null, publishable: false });
    expect((await request(app).get(`/api/tutor/courses/${cid}`).set(auth(other.token))).status).toBe(404); // 别人的课 404
    expect((await request(app).get(`/api/tutor/courses/${cid}/rules`).set(auth(token))).body.rules.some((r) => r.locked)).toBe(true);

    // 没教材不能生成
    expect((await request(app).post("/api/tutor/personas/generate").set(auth(token)).send({ courseId: cid, questionnaire: { name: "老包" } })).body.code).toBe("NO_MATERIALS");

    // 直传票：格式白名单、public_id 归本账号；验收：Admin API 用 spy 换掉
    expect((await request(app).post("/api/tutor/materials/sign").set(auth(token)).send({ courseId: cid, format: "exe", bytes: 10, name: "x.exe" })).body.code).toBe("FORMAT");
    const sign = (await request(app).post("/api/tutor/materials/sign").set(auth(token)).send({ courseId: cid, format: "pdf", bytes: 1000, name: "week1-delay.pdf" })).body;
    expect(sign.ok).toBe(true);
    expect(sign.putUrl).toMatch(/api\.cloudinary\.com.*\/raw\/upload/);
    expect(sign.params.public_id).toBe(sign.ticket);
    expect(sign.params.allowed_formats).toBe("pdf,pptx,docx,md,txt");
    expect(sign.params.overwrite).toBe(false);
    const resourceSpy = jest.spyOn(cloudinary.api, "resource").mockResolvedValue({ bytes: 1000, public_id: sign.ticket });
    const destroySpy = jest.spyOn(cloudinary.uploader, "destroy").mockResolvedValue({ result: "ok" });
    const confirmBody = { ticket: sign.ticket, courseId: cid, sha256: SHA, name: "week1-delay.pdf", bytes: 1000, license: { source: "unsure" }, pages, warnings: [] };
    expect((await request(app).post("/api/tutor/materials/confirm").set(auth(token)).send({ ...confirmBody, ticket: "ideahub/tutor-materials/000000000000000000000000-1-abcdef.pdf" })).status).toBe(400); // 不是本账号的 public_id
    const conf = await request(app).post("/api/tutor/materials/confirm").set(auth(token)).send(confirmBody);
    expect(conf.status).toBe(201);
    expect(conf.body.material).toMatchObject({ sha: SHA, units: 16, parsed: { status: "ok" }, license: { source: "unsure" }, inDoc: false });
    expect(resourceSpy).toHaveBeenCalledWith(sign.ticket, { resource_type: "raw" });
    // 同 sha 再传：duplicate，这一发的副本回收
    const sign2 = (await request(app).post("/api/tutor/materials/sign").set(auth(token)).send({ courseId: cid, format: "pdf", bytes: 1000, name: "again.pdf" })).body;
    const dup = await request(app).post("/api/tutor/materials/confirm").set(auth(token)).send({ ...confirmBody, ticket: sign2.ticket, name: "again.pdf" });
    expect(dup.body.duplicate).toBe(true);
    expect(destroySpy).toHaveBeenCalledWith(sign2.ticket, { resource_type: "raw" });
    expect((await request(app).get(`/api/tutor/courses/${cid}/materials?sha256=${SHA}`).set(auth(token))).body.exists).toBe(true);
    expect((await request(app).head(`/api/tutor/courses/${cid}/materials?sha256=${"c".repeat(64)}`).set(auth(token))).status).toBe(404);
    // 块级文本原样回来（浏览器抽的 = 服务端存的，逐块 hash 相同）
    const text = (await request(app).get(`/api/tutor/materials/${SHA.slice(0, 12)}/text`).set(auth(token))).body;
    expect(text.pages.map((p) => p.blocks.map((b) => b.hash))).toEqual(pages.map((p) => p.blocks.map((b) => b.hash)));
    expect((await request(app).get(`/api/tutor/materials/${SHA}/text`).set(auth(other.token))).status).toBe(404);
    // 原件：2026-09-28 起不 302、由服务端签 5 分钟下载地址流式转回（理由在 tutorFile.service 头部，Range / 上游失败的细节在 tutorFile.spec）。
    //   这里只验接线：本人 200、字节原样、inline，去的是 Cloudinary 的签名下载；上游用 fetch 的 spy 顶替（supertest 不走 fetch，不受影响）。
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => new Response("%PDF-1.7 fake", { status: 200, headers: { "content-type": "application/octet-stream", "content-length": "13" } }));
    const binary = (res, cb) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); };
    const file = await request(app).get(`/api/tutor/materials/${SHA}/file`).set(auth(token)).redirects(0).buffer(true).parse(binary);
    expect(file.status).toBe(200);
    expect(file.body.toString()).toBe("%PDF-1.7 fake");
    expect(file.headers["content-disposition"]).toMatch(/^inline;/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/^https:\/\/api\.cloudinary\.com\/v1_1\/demo-cloud\/raw\/download\?/);
    expect((await request(app).get(`/api/tutor/materials/${SHA}/file`).set(auth(other.token))).status).toBe(404); // 别人的课 404，不去上游
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();

    // 报价（演示免费）→ 生成受理 202 → worker 的一步 → succeeded
    const quote = (await request(app).get(`/api/tutor/courses/${cid}/quote`).set(auth(token))).body;
    expect(quote).toMatchObject({ materials: 1, demo: true });
    expect(quote.quote.total).toBe(0);
    const gen = await request(app).post("/api/tutor/personas/generate").set(auth(token)).send({ courseId: cid, questionnaire: { name: "老包", style: "socratic", strictness: "firm" } });
    expect(gen.status).toBe(202);
    expect((await request(app).post("/api/tutor/personas/generate").set(auth(token)).send({ courseId: cid, questionnaire: { name: "老包" } })).body.code).toBe("BUSY");
    const { runNextJob } = require("../src/services/tutorAi.service");
    const job = await runNextJob();
    expect(job.status).toBe("succeeded");
    expect(job.result.stages).toBeGreaterThan(0);
    expect(job.result.anchors.hit).toBe(job.result.anchors.quotes);
    const jobView = (await request(app).get(`/api/tutor/jobs/${gen.body.jobId}`).set(auth(token))).body.job;
    expect(jobView.status).toBe("succeeded");
    expect((await request(app).get(`/api/tutor/jobs/${gen.body.jobId}`).set(auth(other.token))).status).toBe(404);
    const course = (await request(app).get(`/api/tutor/courses/${cid}`).set(auth(token))).body;
    expect(course.course.persona).toMatchObject({ name: "老包", version: 1 });
    expect(course.course.publishable).toBe(false); // 教材还是「不确定」
    expect(course.materials[0].inDoc).toBe(true);

    // 学习页 bundle
    const bundle = (await request(app).get(`/api/tutor/runs/${cid}`).set(auth(token))).body;
    expect(bundle.run).toMatchObject({ id: cid, status: "active", demo: true });
    const s1 = bundle.doc.map.stages[0].stage_id;
    expect(bundle.run.currentStage).toBe(s1);
    expect(bundle.run.progress[s1]).toMatchObject({ status: "pending", stepIdx: 0 });
    // 没讲完不能自检
    expect((await request(app).post(`/api/tutor/runs/${cid}/quiz`).set(auth(token)).send({ stage: s1, answers: [] })).status).toBe(409);
    // 漫游走到最后一步 → 已讲
    const steps = bundle.doc.distill[s1].walkthrough.length;
    const prog = await request(app).patch(`/api/tutor/runs/${cid}/progress`).set(auth(token)).send({ stage: s1, stepIdx: steps - 1 });
    expect(prog.body.progress[s1].status).toBe("taught");
    // 一轮 SSE（演示老师）：token / sentence / done 都在，落两条 Turn
    const turn = await request(app).post(`/api/tutor/runs/${cid}/turns`).set(auth(token)).send({ kind: "ask", stage: s1, text: "传播时延这句怎么理解？", selection: { anchor: bundle.doc.distill[s1].walkthrough.find((w) => w.anchor)?.anchor || { material: SHA.slice(0, 12), page: 1, quote: "x" } } });
    expect(turn.status).toBe(200);
    expect(turn.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(turn.text).toMatch(/event: token/);
    expect(turn.text).toMatch(/event: sentence/);
    const done = JSON.parse([...turn.text.matchAll(/event: done\ndata: (.*)\n/g)].at(-1)[1]);
    expect(done).toMatchObject({ kind: "answer", demo: true, stage: s1 });
    // ★ seq 是 3 不是 2：上面「没讲完不能自检」那一发虽然回 409，handleQuiz 是先判卷、落 quizResult（seq 1）、再 advance 才拒的。
    //   参考实现 devServer.handleQuiz 同序，这里照实钉住；要不要改成「拒了不落」是产品决定，两边得一起改（2026-09-30 本机首跑发现）。
    expect(done.seq).toBe(3);
    const turns = (await request(app).get(`/api/tutor/runs/${cid}/turns?after=0`).set(auth(token))).body.turns;
    expect(turns.map((t) => [t.seq, t.role, t.kind])).toEqual([[1, "user", "quizResult"], [2, "user", "ask"], [3, "assistant", "answer"]]);
    // 「没懂」不过模型：自动落卡点
    const mark = await request(app).post(`/api/tutor/runs/${cid}/turns`).set(auth(token)).send({ kind: "select", stage: s1, selection: { anchor: { material: SHA.slice(0, 12), page: 3, quote: "存储转发" } } });
    expect(mark.body).toMatchObject({ ok: true, status: "applied" });
    expect(mark.body.stuck.text).toMatch(/没懂/);
    // 自检：全答「不知道」不过 → 用参考答案过 → passed + 下次回访时间
    const checks = bundle.doc.distill[s1].self_checks;
    const bad = await request(app).post(`/api/tutor/runs/${cid}/quiz`).set(auth(token)).send({ stage: s1, answers: checks.map(() => "不知道") });
    expect(bad.body.passed).toBe(false);
    const good = await request(app).post(`/api/tutor/runs/${cid}/quiz`).set(auth(token)).send({ stage: s1, answers: checks.map((c) => c.a) });
    expect(good.body.passed).toBe(true);
    expect(good.body.nextReviewAt).toBeTruthy();
    expect(good.body.nextStage).not.toBe(s1);
    // 回访只认已通过的阶段：下一阶段还没过 → 409 NOT_PASSED。
    //   ★ 原先这里断言「s1 刚过、凑不出题 → 400」，与规则不符：reviewQuestions 不看到期，s1 有自检题就总能出题，
    //   那一发空答卷会被判成回访没过、把 s1 退回已讲，后面的到期断言跟着全错（参考实现 server.test.mjs 测的也是 409 这条）
    const notPassed = await request(app).post(`/api/tutor/runs/${cid}/quiz`).set(auth(token)).send({ stage: good.body.nextStage, answers: [], review: true });
    expect(notPassed.status).toBe(409);
    expect(notPassed.body.code).toBe("NOT_PASSED");
    // 回访到期：直接把时间往前拨（time-travel 端点不移植）
    const TutorRun = require("../src/models/TutorRun");
    const runDoc = await TutorRun.findOne({ course: cid });
    runDoc.progress[s1].nextReviewAt = new Date(Date.now() - 86400_000).toISOString(); runDoc.markModified("progress"); await runDoc.save();
    const due = (await request(app).get(`/api/tutor/runs/${cid}/review-due`).set(auth(token))).body;
    expect(due.due[0].stage_id).toBe(s1);
    const rq = (await request(app).get(`/api/tutor/runs/${cid}/review-quiz?stage=${s1}`).set(auth(token))).body;
    expect(rq.questions.length).toBeGreaterThan(0);
    expect(rq.questions[0].from).toBe("selection"); // 先出圈过的那一处
    // 复习卡
    expect((await request(app).get(`/api/tutor/runs/${cid}/review-card`).set(auth(token))).body.card.stuck.length).toBeGreaterThan(0);

    // 蒸馏：阶段完成那一拍的自动蒸馏在后台跑，等它落地；手动那一发要么 nothing 要么 done
    await new Promise((r) => setTimeout(r, 800));
    const dist = await request(app).post(`/api/tutor/runs/${cid}/distill`).set(auth(token)).send({});
    expect(dist.status).toBe(200);
    expect(["nothing", "done", "empty"]).toContain(dist.body.status);
    const revs = (await request(app).get(`/api/tutor/runs/${cid}/revisions`).set(auth(token))).body;
    expect(revs.revisions.length).toBeGreaterThan(0);
    const pending = revs.revisions.flatMap((r) => r.ops.filter((o) => o.status === "pending").map((o) => ({ rid: r.id, opId: o.opId })));
    expect(pending.length).toBeGreaterThan(0); // 自检答错 → 易错点等点头
    const rv = await request(app).post(`/api/tutor/runs/${cid}/revisions/${pending[0].rid}/review`).set(auth(token)).send({ accept: [pending[0].opId] });
    expect(rv.status).toBe(200);
    expect(rv.body.version).toBe(2);
    const un = await request(app).post(`/api/tutor/runs/${cid}/revisions/${pending[0].rid}/revert`).set(auth(token)).send({ opIds: [pending[0].opId] });
    expect(un.status).toBe(200);
    expect(un.body.revert.kind).toBe("revert");
    expect((await request(app).post(`/api/tutor/runs/${cid}/revisions/deadbeefdeadbeef/review`).set(auth(token)).send({ accept: [pending[0].opId] })).status).toBe(404);

    // 发布件：教材「不确定」→ 整句拒；改成「自己写的」→ 放行（文档头跟着重算）；泄漏核查跑过
    expect((await request(app).get(`/api/tutor/personas/${cid}/export?format=md&audience=market`).set(auth(token))).status).toBe(400);
    const lic = await request(app).patch(`/api/tutor/materials/${SHA}`).set(auth(token)).send({ courseId: cid, license: { source: "self" } });
    expect(lic.body).toMatchObject({ ok: true, docLicense: "self" });
    expect(lic.body.course.publishable).toBe(true);
    const exp = await request(app).get(`/api/tutor/personas/${cid}/export?format=md&audience=market`).set(auth(token));
    expect(exp.status).toBe(200);
    expect(exp.headers["x-tutor-clean-check"]).toBe("passed");
    expect(exp.headers["content-disposition"]).toMatch(/tutor-persona-.*\.md/);
    expect(exp.text).toMatch(/^---/);
    const exports = (await request(app).get(`/api/tutor/personas/${cid}/exports`).set(auth(token))).body;
    expect(exports.exports).toHaveLength(1);
    expect(exports.exports[0]).toMatchObject({ format: "md", audience: "market", cleanCheck: "passed" });
    // 导入回读：同一位老师 → same；别人的课 → 新开一门
    const imp = await request(app).post("/api/tutor/personas/import").set(auth(token)).send({ courseId: cid, text: exp.text, filename: "p.md" });
    expect(imp.body).toMatchObject({ ok: true, same: true, created: false, checksum: exp.headers["x-tutor-checksum"] });
    const imp2 = await request(app).post("/api/tutor/personas/import").set(auth(other.token)).send({ text: exp.text });
    expect(imp2.body).toMatchObject({ ok: true, created: true });
    expect((await request(app).get(`/api/tutor/courses/${imp2.body.courseId}`).set(auth(other.token))).body.course.persona.name).toBe("老包");
    expect((await request(app).post("/api/tutor/personas/import").set(auth(token)).send({ text: exp.text.replace("ideahub-tutor", "ideahub-tutox") })).status).toBe(400); // 改过正文整句拒
    // 使用记录（csv 带 BOM）与账本（演示模式没有一发真调用）
    const csv = await request(app).get(`/api/tutor/runs/${cid}/usage-export?format=csv`).set(auth(token));
    expect(csv.status).toBe(200);
    expect(Number(csv.headers["x-tutor-usage-rows"])).toBeGreaterThan(0);
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    const ledger = (await request(app).get("/api/tutor/usage-ledger").set(auth(token))).body;
    expect(ledger).toMatchObject({ ok: true, count: 0 });
    expect(ledger.summary.total.calls).toBe(0);
    // 课程列表：本人 1 门，别人 1 门（导入开的）
    expect((await request(app).get("/api/tutor/courses").set(auth(token))).body.courses).toHaveLength(1);
    expect((await request(app).get("/api/tutor/courses").set(auth(other.token))).body.courses).toHaveLength(1);
    resourceSpy.mockRestore(); destroySpy.mockRestore();
  });
});
