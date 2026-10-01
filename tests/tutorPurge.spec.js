/**
 * 删号级联里老师人格那一线（tutor 仓 docs/04 S14、docs/06 §4.2）：两份清单覆盖全部 Tutor* 模型；跑一遍（模型全 mock）看句柄先落、每张表都删到、
 * 他给别人的评分删了要重算别人的均分、别人从他老师开的课只标 orphan 不删。不碰 Mongo。
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const chain = (v) => { const c = { select: () => c, lean: async () => v, sort: () => c, limit: () => c, then: (f, r) => Promise.resolve(v).then(f, r) }; return c; };
const del = () => jest.fn(async () => ({ deletedCount: 1 }));
const models = {};
for (const name of ["TutorCourse", "TutorMaterial", "TutorChunk", "TutorDoc", "TutorRun", "TutorTurn", "TutorRevision", "TutorExport", "TutorJob", "TutorUsage", "TutorRelease", "TutorRating", "TutorReferral", "Persona", "PersonaInstall", "ArenaComment", "Report", "PendingAssetPurge"]) {
  jest.doMock(`../src/models/${name}`, () => { const m = { deleteMany: del(), find: jest.fn(() => chain([])), updateMany: jest.fn(async () => ({ modifiedCount: 2 })), bulkWrite: jest.fn(async () => ({})), URGENT_REASONS: ["csae"] }; models[name] = m; return m; });
}
jest.doMock("../src/services/tutorRating.service", () => ({ recompute: jest.fn(async () => ({})) }));
const rating = require("../src/services/tutorRating.service");
const purge = require("../src/services/tutorPurge.service");

const uid = new mongoose.Types.ObjectId();
const oid = () => new mongoose.Types.ObjectId();

describe("两份清单", () => {
  it("src/models/Tutor*.js 每一张要么在 PURGE_DELETE 要么在 PURGE_KEEP（新表漏了这里就红）", () => {
    const all = fs.readdirSync(path.join(__dirname, "..", "src", "models")).filter((f) => /^Tutor[A-Za-z]+\.js$/.test(f)).map((f) => f.replace(/\.js$/, "")).sort();
    const covered = [...purge.PURGE_DELETE, ...Object.keys(purge.PURGE_KEEP)].sort();
    expect(all.every((m) => covered.includes(m))).toBe(true);
    expect(covered.filter((m) => !all.includes(m))).toEqual([]);
  });
  it("PendingAssetPurge 认 raw（教材原件在 raw 空间）", () => {
    const real = jest.requireActual("../src/models/PendingAssetPurge");
    expect(real.schema.path("resourceType").enumValues).toContain("raw");
  });
});

describe("purgeTutorForUser", () => {
  beforeEach(() => { jest.clearAllMocks(); for (const m of Object.values(models)) m.find.mockReturnValue(chain([])); }); // clearAllMocks 不清 mockReturnValue，上一条设的 find 会漏到这一条
  it("句柄先落（raw）→ 课程树逐表删 → 他的老师：发布版 / 收到的评分 / 安装 / 评论 / 举报（儿童安全留下）→ 别人的课标 orphan 不删 → 老师本体 → 课本体；他给别人的评分删了重算别人", async () => {
    const c1 = oid(); const m1 = oid(); const r1 = oid(); const p1 = oid(); const other = oid();
    models.TutorCourse.find.mockReturnValue(chain([{ _id: c1 }]));
    models.TutorMaterial.find.mockReturnValue(chain([{ _id: m1, publicId: "ideahub/tutor/abc" }, { _id: oid(), publicId: "" }]));
    models.TutorRun.find.mockReturnValue(chain([{ _id: r1 }]));
    models.Persona.find.mockReturnValue(chain([{ _id: p1 }]));
    models.TutorRating.find.mockReturnValue(chain([{ persona: other }, { persona: p1 }, { persona: other }]));
    const removed = await purge.purgeTutorForUser(String(uid));
    // ① 句柄
    const ops = models.PendingAssetPurge.bulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    expect(ops[0].updateOne.update.$setOnInsert).toMatchObject({ publicId: "ideahub/tutor/abc", resourceType: "raw", source: `tutor-material:${m1}` });
    expect(removed.tutorMaterialAssets).toBe(1);
    // ② 每张表都删到
    for (const name of purge.PURGE_DELETE) expect(models[name].deleteMany).toHaveBeenCalled();
    expect(models.TutorTurn.deleteMany).toHaveBeenCalledWith({ run: { $in: [r1] } });
    expect(models.TutorRun.deleteMany).toHaveBeenCalledWith({ _id: { $in: [r1] } });
    expect(models.TutorChunk.deleteMany).toHaveBeenCalledWith({ course: { $in: [c1] } });
    // ③ 老师人格那一串
    expect(models.TutorRelease.deleteMany.mock.calls[0][0]).toEqual({ $or: [{ persona: { $in: [p1] } }, { owner: uid }] });
    expect(models.TutorRating.deleteMany.mock.calls[0][0]).toEqual({ persona: { $in: [p1] } });
    expect(models.PersonaInstall.deleteMany).toHaveBeenCalledWith({ persona: { $in: [p1] } });
    expect(models.ArenaComment.deleteMany).toHaveBeenCalledWith({ targetType: "persona", target: { $in: [p1] } });
    expect(models.Report.deleteMany.mock.calls[0][0]).toMatchObject({ reason: { $nin: ["csae"] }, targetType: "persona" });
    expect(models.Persona.deleteMany).toHaveBeenCalledWith({ _id: { $in: [p1] } });
    // ④ 他给别人的评分：删 + 只重算别人的（自己的老师随人格一起没了）
    expect(models.TutorRating.deleteMany.mock.calls[1][0]).toEqual({ user: uid });
    expect(models.TutorReferral.deleteMany.mock.calls[0][0]).toEqual({ $or: [{ subject: `u:${String(uid)}` }, { user: uid }] }); // 引流度量里他的行（游客 ip: 行不动）
    expect(rating.recompute).toHaveBeenCalledTimes(1);
    expect(rating.recompute).toHaveBeenCalledWith(String(other));
    // ⑤ 别人的课只标 orphan
    expect(models.TutorCourse.updateMany).toHaveBeenCalledWith({ sourcePersona: { $in: [p1] }, owner: { $ne: uid } }, { $set: { sourceOrphanedAt: expect.any(Date) } });
    expect(removed.tutorLearnersOrphaned).toBe(2);
    // ⑥ 课本体最后
    const order = models.TutorCourse.deleteMany.mock.invocationCallOrder[0];
    expect(order).toBeGreaterThan(models.TutorMaterial.deleteMany.mock.invocationCallOrder[0]);
    expect(removed.tutorCourses).toBe(1);
  });
  it("一张表都没有的账号：不落句柄、不动 Persona / 安装 / 评论那几张（$in [] 也不发）", async () => {
    const removed = await purge.purgeTutorForUser(String(uid));
    expect(models.PendingAssetPurge.bulkWrite).not.toHaveBeenCalled();
    expect(models.PersonaInstall.deleteMany).not.toHaveBeenCalled();
    expect(models.Persona.deleteMany).not.toHaveBeenCalled();
    expect(models.TutorCourse.updateMany).not.toHaveBeenCalled();
    expect(removed).toMatchObject({ tutorMaterialAssets: 0, tutorPersonas: 0, tutorLearnersOrphaned: 0 });
  });
});
