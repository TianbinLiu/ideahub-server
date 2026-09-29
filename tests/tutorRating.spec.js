/**
 * 评分（tutor 仓 docs/06 §4.2「没开过 Run 的账号按钮灰并说明；一人一票可改、均分回写正确」）：规则在核心包 core/publish/rating，
 * 存取在 tutorRating.service —— 这里 mock 掉四张表与拉黑 / 通知，验的是「从库里凑齐判据 → 403 / 400 / 201 / 200」与「均分从 aggregate 重算回写」。
 */
const mongoose = require("mongoose");
jest.mock("../src/models/Persona", () => ({ findOne: jest.fn(), updateOne: jest.fn(async () => ({ matchedCount: 1 })) }));
jest.mock("../src/models/TutorRating", () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(async () => 0), aggregate: jest.fn(async () => []), create: jest.fn(), deleteOne: jest.fn(async () => ({ deletedCount: 1 })) }));
jest.mock("../src/models/TutorCourse", () => ({ findOne: jest.fn() }));
jest.mock("../src/models/TutorRun", () => ({ findOne: jest.fn() }));
jest.mock("../src/utils/blocking", () => ({ hasAnyBlockBetween: jest.fn(async () => false) }));
jest.mock("../src/services/tutorNotify.service", () => ({ notifyTutor: jest.fn(async () => null) }));
const Persona = require("../src/models/Persona");
const TutorRating = require("../src/models/TutorRating");
const TutorCourse = require("../src/models/TutorCourse");
const TutorRun = require("../src/models/TutorRun");
const { hasAnyBlockBetween } = require("../src/utils/blocking");
const { notifyTutor } = require("../src/services/tutorNotify.service");
const core = require("../src/tutor/core/publish/rating");
const svc = require("../src/services/tutorRating.service");

/** mongoose 查询链的替身：select / populate / sort / skip / limit 都回自己，lean() 与 await 都给值 */
const chain = (v) => { const c = { select: () => c, populate: () => c, sort: () => c, skip: () => c, limit: () => c, lean: async () => v, then: (f, r) => Promise.resolve(v).then(f, r) }; return c; };
const oid = () => String(new mongoose.Types.ObjectId());
const author = oid(); const me = { _id: oid() };
const persona = () => ({ _id: new mongoose.Types.ObjectId(), author, name: "老包", shared: true, takenDown: false });

beforeEach(() => {
  jest.clearAllMocks();
  Persona.findOne.mockReturnValue(chain(persona()));
  TutorCourse.findOne.mockReturnValue(chain(null));
  TutorRun.findOne.mockReturnValue(chain(null));
  TutorRating.findOne.mockReturnValue(chain(null));
  TutorRating.aggregate.mockResolvedValue([]);
  hasAnyBlockBetween.mockResolvedValue(false);
});

describe("核心规则（ported core/publish/rating）", () => {
  it("canRate 四种不能评 + 两种能评；normalizeRating 越界整句拒；summaryFromDist 两位小数", () => {
    expect(core.canRate({ isOwner: true }).reason).toBe("owner");
    expect(core.canRate({ blocked: true }).reason).toBe("blocked");
    expect(core.canRate({}).reason).toBe("notStarted");
    expect(core.canRate({ progress: { s: { status: "taught" } } }).reason).toBe("noneDone");
    expect(core.canRate({ progress: { s: { status: "passed" } } })).toEqual({ ok: true });
    expect(core.canRate({ progress: {}, runStatus: "done" })).toEqual({ ok: true });
    expect(core.normalizeRating({ stars: 6 }).error).toMatch(/1~5/);
    expect(core.summaryFromDist({ 5: 1, 4: 2 })).toEqual({ avg: 4.33, count: 3, dist: { 1: 0, 2: 0, 3: 0, 4: 2, 5: 1 } });
  });
});

describe("rate：判据从库里凑齐", () => {
  const pid = () => String(persona()._id);
  it("作者评自己 403 owner；没从这位老师开过课 403 notStarted；开了课一段没通过 403 noneDone —— 一次都不写表", async () => {
    expect(await svc.rate({ user: { _id: author }, personaId: pid(), body: { stars: 5 } })).toMatchObject({ status: 403, body: { code: "NOT_ELIGIBLE", reason: "owner" } });
    expect(await svc.rate({ user: me, personaId: pid(), body: { stars: 5 } })).toMatchObject({ status: 403, body: { reason: "notStarted" } });
    TutorCourse.findOne.mockReturnValue(chain({ _id: oid(), sourceVersion: 1 }));
    TutorRun.findOne.mockReturnValue(chain({ progress: { "stage-01": { status: "taught" } }, status: "active" }));
    expect(await svc.rate({ user: me, personaId: pid(), body: { stars: 5 } })).toMatchObject({ status: 403, body: { reason: "noneDone" } });
    hasAnyBlockBetween.mockResolvedValueOnce(true);
    expect(await svc.rate({ user: me, personaId: pid(), body: { stars: 5 } })).toMatchObject({ status: 403, body: { reason: "blocked" } });
    expect(TutorRating.create).not.toHaveBeenCalled();
    expect(Persona.updateOne).not.toHaveBeenCalled();
  });
  it("通过过一段 → 201 建票、均分从 aggregate 重算回写（不 $inc）、作者收一条 TUTOR_RATING；形状错 400", async () => {
    TutorCourse.findOne.mockReturnValue(chain({ _id: oid(), sourceVersion: 2 }));
    TutorRun.findOne.mockReturnValue(chain({ progress: { "stage-01": { status: "passed" } }, status: "active" }));
    expect(await svc.rate({ user: me, personaId: pid(), body: { stars: 0 } })).toMatchObject({ status: 400 });
    const created = { _id: new mongoose.Types.ObjectId() };
    TutorRating.create.mockResolvedValue(created);
    TutorRating.aggregate.mockResolvedValue([{ _id: 5, n: 2 }, { _id: 4, n: 1 }]);
    TutorRating.findById.mockReturnValue(chain({ _id: created._id, user: { _id: me._id, username: "me" }, stars: 5, text: "好", atVersion: 2 }));
    const r = await svc.rate({ user: me, personaId: pid(), body: { stars: 5, text: " 好 " } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: true, summary: { avg: 4.67, count: 3 }, mine: { stars: 5, text: "好", atVersion: 2, user: { username: "me" } } });
    expect(TutorRating.create).toHaveBeenCalledWith(expect.objectContaining({ stars: 5, text: "好", atVersion: 2 }));
    const set = Persona.updateOne.mock.calls[0][1].$set;
    expect(set).toEqual({ "stats.ratingAvg": 4.67, "stats.ratingCount": 3 });
    expect(notifyTutor).toHaveBeenCalledTimes(1);
    expect(notifyTutor.mock.calls[0][0]).toBe("TUTOR_RATING");
    expect(notifyTutor.mock.calls[0][1]).toMatchObject({ userId: author, actorId: me._id, payload: { personaName: "老包", stars: 5 }, dedupe: expect.any(Object) });
  });
  it("改票：200、覆盖星与评语、重算、不再通知", async () => {
    TutorCourse.findOne.mockReturnValue(chain({ _id: oid(), sourceVersion: 1 }));
    TutorRun.findOne.mockReturnValue(chain({ progress: {}, status: "done" }));
    const existing = { _id: new mongoose.Types.ObjectId(), stars: 5, text: "好", atVersion: 1, save: jest.fn(async () => {}) };
    TutorRating.findOne.mockReturnValue(chain(existing));
    TutorRating.aggregate.mockResolvedValue([{ _id: 4, n: 1 }]);
    TutorRating.findById.mockReturnValue(chain({ ...existing, user: { _id: me._id, username: "me" }, stars: 4 }));
    const r = await svc.rate({ user: me, personaId: pid(), body: { stars: 4, text: "还行" } });
    expect(r.status).toBe(200);
    expect(existing).toMatchObject({ stars: 4, text: "还行" });
    expect(existing.save).toHaveBeenCalled();
    expect(r.body.summary).toEqual({ avg: 4, count: 1, dist: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 } });
    expect(notifyTutor).not.toHaveBeenCalled();
  });
  it("未发布 / 已下架的老师 404（不泄露）；unrate 没评过 404，删了就重算", async () => {
    Persona.findOne.mockReturnValue(chain({ ...persona(), shared: false }));
    expect((await svc.rate({ user: me, personaId: pid(), body: { stars: 5 } })).status).toBe(404);
    expect(await svc.list({ user: me, personaId: pid() })).toBeNull();
    Persona.findOne.mockReturnValue(chain(persona()));
    TutorRating.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    expect((await svc.unrate({ user: me, personaId: pid() })).status).toBe(404);
    expect((await svc.unrate({ user: me, personaId: pid() })).status).toBe(200);
    expect(Persona.updateOne).toHaveBeenCalledTimes(1);
  });
  it("list：作者能看自己没公开的；回 summary / items / mine / canRate；游客 canRate 是 login", async () => {
    Persona.findOne.mockReturnValue(chain({ ...persona(), shared: false }));
    TutorRating.find.mockReturnValue(chain([{ _id: oid(), user: { _id: me._id, username: "me" }, stars: 5, text: "", atVersion: 1 }]));
    TutorRating.countDocuments.mockResolvedValue(1);
    TutorRating.aggregate.mockResolvedValue([{ _id: 5, n: 1 }]);
    const r = await svc.list({ user: { _id: author }, personaId: pid() });
    expect(r).toMatchObject({ summary: { avg: 5, count: 1 }, total: 1, totalPages: 1, mine: null, canRate: { ok: false, reason: "owner" } });
    expect(r.items[0]).toMatchObject({ stars: 5, user: { username: "me" } });
    Persona.findOne.mockReturnValue(chain(persona()));
    expect((await svc.list({ user: null, personaId: pid() })).canRate).toMatchObject({ ok: false, reason: "login" });
  });
});
