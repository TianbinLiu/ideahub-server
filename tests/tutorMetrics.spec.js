/**
 * M3 度量（tutor 仓 docs/06 §5.1「度量（每条都能防刷）」）：引流记一行（白名单 / 每天每主体每来源一条 / 游客按 IP 指纹不存明文）+ 三条比率的聚合。不碰 Mongo。
 */
const mongoose = require("mongoose");
jest.mock("../src/models/TutorReferral", () => ({ updateOne: jest.fn(), aggregate: jest.fn(async () => []) }));
jest.mock("../src/models/TutorRun", () => ({ distinct: jest.fn(async () => []), find: jest.fn() }));
jest.mock("../src/models/TutorCourse", () => ({ find: jest.fn() }));
jest.mock("../src/models/Persona", () => ({ distinct: jest.fn(async () => []) }));
jest.mock("../src/models/BranchVideo", () => ({ distinct: jest.fn(async () => []) }));
jest.mock("../src/models/CompanionSetting", () => ({ distinct: jest.fn(async () => []), countDocuments: jest.fn(async () => 0) }));
const TutorReferral = require("../src/models/TutorReferral");
const TutorRun = require("../src/models/TutorRun");
const TutorCourse = require("../src/models/TutorCourse");
const Persona = require("../src/models/Persona");
const BranchVideo = require("../src/models/BranchVideo");
const CompanionSetting = require("../src/models/CompanionSetting");
const core = require("../src/tutor/core/publish/referral");
const svc = require("../src/services/tutorMetrics.service");

const chain = (v) => { const c = { select: () => c, sort: () => c, lean: async () => v, then: (f, r) => Promise.resolve(v).then(f, r) }; return c; };
const oid = () => new mongoose.Types.ObjectId();

beforeEach(() => {
  // ★ clearAllMocks 只清调用记录、不清 mockResolvedValue 的实现，上一条用例设的返回值会漏到下一条（tutorPurge.spec 栽过）—— 每条开头把默认值全部重设一遍
  jest.clearAllMocks();
  TutorReferral.updateOne.mockResolvedValue({ upsertedCount: 1 });
  TutorReferral.aggregate.mockResolvedValue([]);
  TutorRun.distinct.mockResolvedValue([]);
  TutorRun.find.mockReturnValue(chain([]));
  TutorCourse.find.mockReturnValue(chain([]));
  Persona.distinct.mockResolvedValue([]);
  BranchVideo.distinct.mockResolvedValue([]);
  CompanionSetting.distinct.mockResolvedValue([]);
  CompanionSetting.countDocuments.mockResolvedValue(0);
});

describe("recordReferral", () => {
  it("白名单外的来源不记、不落库（200 recorded:false unknown_from）", async () => {
    const r = await svc.recordReferral({ user: null, ip: "1.2.3.4", from: "weibo", path: "/tutor" });
    expect(r).toEqual({ status: 200, body: { ok: true, recorded: false, reason: "unknown_from" } });
    expect(TutorReferral.updateOne).not.toHaveBeenCalled();
  });
  it("登录用户：主体 u:<id>、日粒度、只在唯一键上 upsert；插进去 = 201 recorded，撞到 = 200 duplicate", async () => {
    const user = { _id: oid() };
    const r1 = await svc.recordReferral({ user, ip: "1.2.3.4", from: " NAV ", path: "/tutor?x=1" });
    expect(r1).toEqual({ status: 201, body: { ok: true, recorded: true, from: "nav" } });
    const [filter, update, opts] = TutorReferral.updateOne.mock.calls[0];
    expect(filter).toEqual({ day: core.referralDay(), from: "nav", subject: `u:${user._id}` });
    expect(update.$setOnInsert).toMatchObject({ from: "nav", subject: `u:${user._id}`, user: user._id, path: "/tutor?x=1" });
    expect(opts).toEqual({ upsert: true });
    TutorReferral.updateOne.mockResolvedValue({ upsertedCount: 0, matchedCount: 1 });
    expect(await svc.recordReferral({ user, ip: "1.2.3.4", from: "nav" })).toEqual({ status: 200, body: { ok: true, recorded: false, from: "nav", reason: "duplicate" } });
  });
  it("游客：主体是 IP 指纹（sha256 前 32 位），落库的任何一格都不含明文 IP；并发撞唯一索引（E11000）当 duplicate", async () => {
    await svc.recordReferral({ user: null, ip: "203.0.113.9", from: "app-settings", path: "https://evil.example/x" });
    const [filter, update] = TutorReferral.updateOne.mock.calls[0];
    expect(filter.subject).toMatch(/^ip:[0-9a-f]{32}$/);
    expect(JSON.stringify([filter, update])).not.toContain("203.0.113.9");
    expect(update.$setOnInsert.path).toBe("/tutor"); // 站外地址不记，退回 /tutor
    expect(update.$setOnInsert.user).toBeNull();
    TutorReferral.updateOne.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));
    expect((await svc.recordReferral({ user: null, ip: "203.0.113.9", from: "app-settings" })).body).toMatchObject({ recorded: false, reason: "duplicate" });
  });
  it("别的错误照抛（不吞）", async () => {
    TutorReferral.updateOne.mockRejectedValue(new Error("db down"));
    await expect(svc.recordReferral({ user: null, ip: "1.1.1.1", from: "nav" })).rejects.toThrow("db down");
  });
});

describe("metrics", () => {
  it("三条比率：激活按 user._id 去重取并集；反哺只数勾了 companion.enabled 的老师；fork 7 天按课去重", async () => {
    const [a, b, c] = [oid(), oid(), oid()];
    TutorReferral.aggregate.mockResolvedValue([{ from: "nav", count: 3, users: 2 }, { from: "app-settings", count: 1, users: 1 }]);
    TutorRun.distinct.mockResolvedValue([a, b, c]);
    BranchVideo.distinct.mockResolvedValue([a]);
    CompanionSetting.distinct.mockResolvedValue([a, b]);
    const p1 = oid();
    Persona.distinct.mockResolvedValue([p1]);
    CompanionSetting.countDocuments.mockResolvedValue(4);
    const [c1, c2] = [oid(), oid()];
    const t0 = new Date("2026-09-01T00:00:00.000Z");
    TutorCourse.find.mockReturnValue(chain([{ _id: c1, createdAt: t0 }, { _id: c2, createdAt: t0 }]));
    TutorRun.find.mockReturnValue(chain([
      { course: c1, progress: { "stage-01": { status: "passed", passedAt: "2026-09-03T00:00:00.000Z" } } },
      { course: c2, progress: { "stage-01": { status: "passed", passedAt: "2026-09-20T00:00:00.000Z" } } },
    ]));
    const m = await svc.metrics({ now: new Date("2026-09-29T00:00:00.000Z") });
    expect(m.ok).toBe(true);
    expect(m.days).toBe(core.METRICS_WINDOW_DAYS);
    expect(m.referrals).toEqual([{ from: "nav", count: 3, users: 2 }, { from: "app-settings", count: 1, users: 1 }]);
    expect(m.activation).toEqual({ tutorUsers: 3, crossUsers: 2, ratio: 0.667 });
    expect(m.companion).toEqual({ personas: 1, accounts: 4 });
    expect(m.fork7d).toEqual({ days: core.FORK_ACTIVATION_DAYS, forks: 2, activated: 1, ratio: 0.5 });
    // 查询形状：激活那两条只在 tutor 用户里找（$in），反哺只数勾了的老师，聚合窗口是 since
    expect(BranchVideo.distinct).toHaveBeenCalledWith("author", { author: { $in: [a, b, c] } });
    expect(CompanionSetting.distinct).toHaveBeenCalledWith("user", { user: { $in: [a, b, c] } });
    expect(Persona.distinct).toHaveBeenCalledWith("_id", { kind: "tutor", "companion.enabled": true });
    expect(CompanionSetting.countDocuments).toHaveBeenCalledWith({ persona: { $in: [p1] } });
    expect(TutorReferral.aggregate.mock.calls[0][0][0]).toEqual({ $match: { createdAt: { $gte: new Date("2026-08-30T00:00:00.000Z") } } });
  });
  it("一个人都没有：分母 0 → ratio 0，不去查 $in 空数组", async () => {
    const m = await svc.metrics();
    expect(m.activation).toEqual({ tutorUsers: 0, crossUsers: 0, ratio: 0 });
    expect(m.companion).toEqual({ personas: 0, accounts: 0 });
    expect(m.fork7d).toMatchObject({ forks: 0, activated: 0, ratio: 0 });
    expect(BranchVideo.distinct).not.toHaveBeenCalled();
    expect(CompanionSetting.countDocuments).not.toHaveBeenCalled();
  });
});

describe("TutorReferral 模型", () => {
  it("唯一键 {day, from, subject}、TTL = core REFERRAL_TTL_DAYS（两处同一个数）", () => {
    const Real = jest.requireActual("../src/models/TutorReferral");
    const idx = Real.schema.indexes();
    expect(idx.some(([k, o]) => JSON.stringify(k) === JSON.stringify({ day: 1, from: 1, subject: 1 }) && o.unique)).toBe(true);
    const ttl = idx.find(([k]) => JSON.stringify(k) === JSON.stringify({ createdAt: 1 }));
    expect(ttl[1].expireAfterSeconds).toBe(core.REFERRAL_TTL_DAYS * 86400);
  });
});
