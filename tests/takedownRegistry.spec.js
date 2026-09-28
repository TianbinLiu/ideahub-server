/**
 * takedown registry（治理 P5，docs/02 6.6）：Report.TARGET_TYPES 每一种都有处理器；persona 只有下架没有硬删（写 takenDown / shared:false / 原因 / 处置人）；
 * 评论 / 弹幕反过来只有删除；未知类型 / 非法 id 整句 400。模型与作品线的清理函数全 mock，不碰 Mongo。
 */
jest.mock("../src/models/BranchVideo", () => ({ exists: jest.fn() }));
jest.mock("../src/models/BranchComment", () => ({ findById: jest.fn() }));
jest.mock("../src/models/BranchDanmaku", () => ({ deleteOne: jest.fn() }));
jest.mock("../src/models/Persona", () => ({ updateOne: jest.fn() }));
jest.mock("../src/controllers/branchVideo.controller", () => ({ applyTakedown: jest.fn(), purgeVideo: jest.fn(), purgeComments: jest.fn() }));

const Persona = require("../src/models/Persona");
const BranchVideo = require("../src/models/BranchVideo");
const { applyTakedown, purgeVideo } = require("../src/controllers/branchVideo.controller");
const { takedownTarget, TAKEDOWN_TARGETS } = require("../src/services/takedown.service");
const Report = require("../src/models/Report");

const id = "0123456789abcdef01234567";
const op = "fedcba987654321076543210";
beforeEach(() => { jest.clearAllMocks(); });

it("Report.TARGET_TYPES 与 registry 逐字相等（加一种对象两处一起，服务端先上）；理由多了 instructorClaim 且有人话标签", () => {
  expect([...Report.TARGET_TYPES].sort()).toEqual([...TAKEDOWN_TARGETS].sort());
  expect(Report.TARGET_TYPES).toContain("persona");
  expect(Report.REASONS).toContain("instructorClaim");
  expect(Report.REASON_LABELS.instructorClaim).toMatch(/人工/);
});

it("persona 下架：takenDown / shared:false / 原因 / 处置人 / 时间；找不到 404", async () => {
  Persona.updateOne.mockResolvedValueOnce({ matchedCount: 1 });
  const r = await takedownTarget({ targetType: "persona", targetId: id, operatorId: op, reason: "侵权 / 冒用他人作品" });
  expect(r).toEqual({ applied: "takedown", targetType: "persona", targetId: id, removed: 0 });
  const [filter, update] = Persona.updateOne.mock.calls[0];
  expect(filter).toEqual({ _id: id });
  expect(update.$set).toMatchObject({ takenDown: true, shared: false, takenDownReason: "侵权 / 冒用他人作品", takenDownBy: op });
  expect(update.$set.takenDownAt).toBeInstanceOf(Date);
  Persona.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
  await expect(takedownTarget({ targetType: "persona", targetId: id, operatorId: op })).rejects.toMatchObject({ status: 404 });
});

it("persona 没有硬删除 → 400 整句（不替管理员把下架办成删除，也不反过来）", async () => {
  await expect(takedownTarget({ targetType: "persona", targetId: id, operatorId: op, hard: true })).rejects.toMatchObject({ status: 400 });
  expect(Persona.updateOne).not.toHaveBeenCalled();
});

it("评论 / 弹幕没有可撤销的下架 → 400，原话不变", async () => {
  await expect(takedownTarget({ targetType: "comment", targetId: id, operatorId: op })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/评论没有可撤销的下架/) });
  await expect(takedownTarget({ targetType: "danmaku", targetId: id, operatorId: op })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/弹幕没有可撤销的下架/) });
});

it("video 下架 / 删除仍转调作品线的那两个函数", async () => {
  applyTakedown.mockResolvedValueOnce({ _id: id });
  expect(await takedownTarget({ targetType: "video", targetId: id, operatorId: op, reason: "x" })).toMatchObject({ applied: "takedown" });
  expect(applyTakedown).toHaveBeenCalledWith(id, { by: op, reason: "x", on: true });
  BranchVideo.exists.mockResolvedValueOnce(true); purgeVideo.mockResolvedValueOnce({ removed: 6 });
  expect(await takedownTarget({ targetType: "video", targetId: id, operatorId: op, hard: true })).toMatchObject({ applied: "delete", removed: 6 });
});

it("未知类型 / 非法 id → 400", async () => {
  await expect(takedownTarget({ targetType: "scenario", targetId: id, operatorId: op })).rejects.toMatchObject({ status: 400 });
  await expect(takedownTarget({ targetType: "persona", targetId: "nope", operatorId: op })).rejects.toMatchObject({ status: 400 });
});
