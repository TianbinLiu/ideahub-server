/**
 * 教授认领的人工核实队列（tutor 仓 docs/06 §4.2「instructorClaim 进人工队列」）：车道过滤 / 阶段派生 / 先来先处理、联系举报人（平台通知 + 留痕）、
 * 裁定（成立 → 与通用队列同一份处置正文：registry 下架 + 级联收尾 + 两头通知；不成立 → 驳回 + 只通知举报人）、已处理 409。不碰 Mongo。
 */
const mongoose = require("mongoose");
const chain = (v) => { const c = { select: () => c, populate: () => c, sort: () => c, skip: () => c, limit: () => c, lean: async () => v, then: (f, r) => Promise.resolve(v).then(f, r) }; return c; };
jest.mock("../src/models/Report", () => {
  const actual = jest.requireActual("../src/models/Report");
  return { ACTION_STATUS: actual.ACTION_STATUS, REASON_LABELS: actual.REASON_LABELS, STATUSES: actual.STATUSES, TARGET_TYPES: actual.TARGET_TYPES, REASONS: actual.REASONS, URGENT_REASONS: actual.URGENT_REASONS,
    find: jest.fn(), findOne: jest.fn(), findByIdAndUpdate: jest.fn(), updateMany: jest.fn(async () => ({ modifiedCount: 2 })), updateOne: jest.fn(async () => ({})), countDocuments: jest.fn(async () => 0) };
});
jest.mock("../src/models/Persona", () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock("../src/services/notification.service", () => ({ createNotification: jest.fn(async (a) => ({ _id: "n", ...a })) }));
jest.mock("../src/services/takedown.service", () => ({ takedownTarget: jest.fn(async (a) => ({ applied: "takedown", ...a })) }));
const Report = require("../src/models/Report");
const Persona = require("../src/models/Persona");
const { createNotification } = require("../src/services/notification.service");
const { takedownTarget } = require("../src/services/takedown.service");
const { resolveReportRecord } = require("../src/services/reportResolve.service");
const claims = require("../src/services/tutorClaims.service");

const oid = () => new mongoose.Types.ObjectId();
const admin = { _id: oid() };
const reporter = oid(); const author = oid(); const personaId = oid();
const claim = (extra = {}) => ({ _id: oid(), targetType: "persona", targetId: personaId, reason: "instructorClaim", detail: "这是我的课", status: "pending", reporter, createdAt: new Date(), ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  Report.find.mockReturnValue(chain([]));
  Report.findOne.mockReturnValue(chain(null));
  Report.findByIdAndUpdate.mockImplementation((id, upd) => chain({ ...claim({ _id: id }), ...(upd.$set && upd.$set.status ? { status: upd.$set.status, handler: admin._id, handledAt: new Date(), handleNote: upd.$set.handleNote } : {}), review: upd.$set && upd.$set["review.contactedAt"] ? { contactedAt: upd.$set["review.contactedAt"], contactCount: 1, log: [] } : {} }));
  Persona.find.mockReturnValue(chain([{ _id: personaId, name: "老包", subject: "计算机网络", author: { _id: author, username: "prof" }, shared: true, takenDown: false, releaseVersion: 2, stats: { downloadCount: 3, ratingCount: 1 } }]));
  Persona.findById.mockReturnValue(chain({ _id: personaId, name: "老包", author }));
});

describe("阶段与车道", () => {
  it("stageOf：status + review.contactedAt 派生，不新增 status 取值；stageFilter 只在 instructorClaim × persona 这条车道里切", () => {
    expect(claims.stageOf(claim())).toBe("new");
    expect(claims.stageOf(claim({ review: { contactedAt: new Date() } }))).toBe("awaiting");
    expect(claims.stageOf(claim({ status: "taken_down" }))).toBe("upheld");
    expect(claims.stageOf(claim({ status: "dismissed" }))).toBe("rejected");
    expect(claims.stageOf(claim({ status: "deleted" }))).toBe("closed");
    expect(claims.stageFilter("new")).toEqual({ status: "pending", "review.contactedAt": null });
    expect(claims.stageFilter("awaiting")).toEqual({ status: "pending", "review.contactedAt": { $ne: null } });
    expect(claims.CLAIM).toEqual({ targetType: "persona", reason: "instructorClaim" });
  });
  it("list：待核实按先来先处理排、老师那一格现查（名字 / 作者 / 版本 / 下架态）、四个阶段的计数一起回；乱 stage 退 new", async () => {
    const rows = [claim(), claim({ review: { contactedAt: new Date(), contactCount: 1, log: [{ at: new Date(), by: admin._id, action: "contact", note: "请补证" }] } })];
    Report.find.mockReturnValue(chain(rows));
    Report.countDocuments.mockResolvedValue(2);
    const r = await claims.list({ stage: "xx", page: "0", limit: "999" });
    expect(r).toMatchObject({ stage: "new", page: 1, limit: 50, total: 2, counts: { new: 2, awaiting: 2, upheld: 2, rejected: 2 } });
    expect(Report.find.mock.calls[0][0]).toEqual({ targetType: "persona", reason: "instructorClaim", status: "pending", "review.contactedAt": null });
    const sortArg = Report.find.mock.results[0].value; void sortArg;
    expect(r.items[0].persona).toMatchObject({ exists: true, name: "老包", author: { username: "prof" }, version: 2, downloadCount: 3, marketPath: `/tutor/market/${personaId}` });
    expect(r.items[1]).toMatchObject({ stage: "awaiting", review: { contactCount: 1 } });
    expect(r.items[1].review.log[0]).toMatchObject({ action: "contact", note: "请补证", by: String(admin._id) });
    expect(r.items[0].reporter.email).toBeUndefined();
  });
});

describe("contact（联系举报人）", () => {
  it("没有 → 404；已处理 → 409 HANDLED；空话 → 400；成功 → 举报人收一条 ADMIN_NOTICE（平台口径无 actorId）+ contactedAt / contactCount / log 留痕", async () => {
    expect((await claims.contact({ id: String(oid()), operator: admin, message: "x" })).status).toBe(404);
    Report.findOne.mockReturnValue(chain(claim({ status: "dismissed" })));
    expect(await claims.contact({ id: String(oid()), operator: admin, message: "x" })).toMatchObject({ status: 409, body: { code: "HANDLED", stage: "rejected" } });
    const c = claim(); Report.findOne.mockReturnValue(chain(c));
    expect((await claims.contact({ id: String(c._id), operator: admin, message: "   " })).status).toBe(400);
    const r = await claims.contact({ id: String(c._id), operator: admin, message: "请提供教务系统课程页截图" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ notified: true, claim: { stage: "awaiting", persona: { name: "老包" } } });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({ userId: reporter, type: "ADMIN_NOTICE", payload: { text: "请提供教务系统课程页截图", claimId: String(c._id), personaId: String(personaId) } });
    expect(createNotification.mock.calls[0][0].actorId).toBeUndefined();
    const upd = Report.findByIdAndUpdate.mock.calls[0][1];
    expect(upd.$set["review.contactedAt"]).toBeInstanceOf(Date);
    expect(upd.$inc).toEqual({ "review.contactCount": 1 });
    expect(upd.$push["review.log"]).toMatchObject({ action: "contact", note: "请提供教务系统课程页截图", by: admin._id });
  });
});

describe("verdict（裁定）", () => {
  it("成立：与通用队列同一份处置正文 —— registry 下架（reason 是给作者看的人话）→ taken_down → 同一位老师其余待处理一起收尾 → 举报人与作者各一条平台通知", async () => {
    const c = claim(); Report.findOne.mockReturnValue(chain(c));
    const r = await claims.verdict({ id: String(c._id), operator: admin, verdict: "upheld", note: "已核对教务系统" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ verdict: "upheld", applied: true, alsoResolved: 2, claim: { stage: "upheld", status: "taken_down" } });
    expect(takedownTarget).toHaveBeenCalledWith({ targetType: "persona", targetId: personaId, operatorId: admin._id, reason: "教授认领经人工核实成立：已核对教务系统", hard: false });
    expect(Report.findByIdAndUpdate.mock.calls[0][1].$set).toMatchObject({ status: "taken_down", handler: admin._id, handleNote: "已核对教务系统" });
    expect(Report.updateMany).toHaveBeenCalledWith({ targetType: "persona", targetId: personaId, status: "pending", _id: { $ne: c._id } }, expect.any(Object));
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification.mock.calls[0][0]).toMatchObject({ userId: reporter, type: "ADMIN_NOTICE", payload: { verdict: "upheld" } });
    expect(createNotification.mock.calls[0][0].payload.text).toMatch(/已核实成立.*已下架/);
    expect(createNotification.mock.calls[1][0]).toMatchObject({ userId: author, type: "ADMIN_NOTICE" });
    expect(createNotification.mock.calls[1][0].payload.text).toMatch(/老包.*已从市场下架/);
  });
  it("不成立：dismiss、不下架、不级联、只通知举报人；老师已不存在时成立裁定 409 TARGET_GONE；verdict 乱给 400；已处理 409", async () => {
    const c = claim(); Report.findOne.mockReturnValue(chain(c));
    const r = await claims.verdict({ id: String(c._id), operator: admin, verdict: "rejected", note: "查无此人" });
    expect(r.body).toMatchObject({ verdict: "rejected", applied: false, alsoResolved: 0, claim: { stage: "rejected" } });
    expect(takedownTarget).not.toHaveBeenCalled();
    expect(Report.updateMany).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0].payload.text).toMatch(/未能核实成立/);
    Persona.findById.mockReturnValue(chain(null));
    expect(await claims.verdict({ id: String(c._id), operator: admin, verdict: "upheld" })).toMatchObject({ status: 409, body: { code: "TARGET_GONE" } });
    expect((await claims.verdict({ id: String(c._id), operator: admin, verdict: "maybe" })).status).toBe(400);
    Report.findOne.mockReturnValue(chain(claim({ status: "taken_down" })));
    expect((await claims.verdict({ id: String(c._id), operator: admin, verdict: "upheld" })).status).toBe(409);
  });
});

describe("reportResolve.service（通用队列与这条车道共用的处置正文）", () => {
  it("动作 → 状态只查 ACTION_STATUS；dismiss 不碰下架也不级联；未知动作整句拒", async () => {
    const c = claim();
    const r = await resolveReportRecord({ report: c, action: "dismiss", note: "n", operatorId: admin._id });
    expect(r).toMatchObject({ applied: false, alsoResolved: 0, takedownResult: null });
    expect(Report.findByIdAndUpdate.mock.calls[0][1].$set.status).toBe("dismissed");
    expect(takedownTarget).not.toHaveBeenCalled();
    await expect(resolveReportRecord({ report: c, action: "nuke", operatorId: admin._id })).rejects.toThrow(/unknown report action/);
    const t = await resolveReportRecord({ report: c, action: "takedown", operatorId: admin._id });
    expect(t.applied).toBe(true);
    expect(takedownTarget.mock.calls[0][0].reason).toBe(Report.REASON_LABELS.instructorClaim);
  });
});
