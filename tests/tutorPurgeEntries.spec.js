/**
 * 三条删账号入口都要接老师人格那一线（tutor 仓 docs/04 S14 / S22；与 chatMemory.purgeUserChatData 头上「三条删账号入口都调它」同一条纪律）：
 * users.controller.deleteAccount（自助硬删）、admin.controller.adminDeleteUser（老管理后台）、branchAdmin.purgeUserCascade（⑩.7，tutorPurge.spec 另验）。
 * 2026-09-29 之前前两条都没接：用户自己删号，课 / 教材句柄 / 发布的老师原样留在库里。这里验「调了、而且在删 User 之前」（中途挂了还能重来）。不碰 Mongo。
 */
const mongoose = require("mongoose");
const chain = (v) => { const c = { select: () => c, lean: async () => v, sort: () => c, limit: () => c, then: (f, r) => Promise.resolve(v).then(f, r) }; return c; };
const del = () => jest.fn(async () => ({ deletedCount: 0 }));
const uid = new mongoose.Types.ObjectId();

jest.mock("../src/services/tutorPurge.service", () => ({ purgeTutorForUser: jest.fn(async () => ({})) }));
jest.mock("../src/services/chatMemory.service", () => ({ purgeUserChatData: jest.fn(async () => ({})) }));
jest.mock("../src/models/User", () => ({ findByIdAndDelete: jest.fn(async () => ({ _id: "x" })), findById: jest.fn(), countDocuments: jest.fn(async () => 2), deleteOne: jest.fn(async () => ({ deletedCount: 1 })) }));
for (const m of ["Idea", "Like", "Bookmark", "Comment", "Interest", "Notification", "AiJob", "IdeaView"]) {
  jest.doMock(`../src/models/${m}`, () => ({ find: jest.fn(() => chain([])), deleteMany: del() }));
}
const { purgeTutorForUser } = require("../src/services/tutorPurge.service");
const { purgeUserChatData } = require("../src/services/chatMemory.service");
const User = require("../src/models/User");

const res = () => ({ json: jest.fn(), status: jest.fn(function () { return this; }) });
const firstCall = (fn) => fn.mock.invocationCallOrder[0];

beforeEach(() => jest.clearAllMocks());

describe("三条删账号入口 × 老师人格那一线", () => {
  it("自助硬删 DELETE /api/users/:id：purgeTutorForUser 调了、在 chat 之后、在 findByIdAndDelete 之前；别人的号 403 时一个都不调", async () => {
    const { deleteAccount } = require("../src/controllers/users.controller");
    const r = res(); const next = jest.fn();
    await deleteAccount({ params: { id: String(uid) }, user: { _id: uid } }, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(purgeTutorForUser).toHaveBeenCalledWith(String(uid));
    expect(firstCall(purgeUserChatData)).toBeLessThan(firstCall(purgeTutorForUser));
    expect(firstCall(purgeTutorForUser)).toBeLessThan(firstCall(User.findByIdAndDelete));
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));

    jest.clearAllMocks();
    await deleteAccount({ params: { id: String(new mongoose.Types.ObjectId()) }, user: { _id: uid } }, res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/another user/) }));
    expect(purgeTutorForUser).not.toHaveBeenCalled();
    expect(User.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it("老管理后台 DELETE /api/admin/users/:id：purgeTutorForUser 调了、在 deleteOne 之前", async () => {
    User.findById.mockResolvedValue({ _id: uid, role: "user" });
    const { adminDeleteUser } = require("../src/controllers/admin.controller");
    const r = res(); const next = jest.fn();
    await adminDeleteUser({ params: { id: String(uid) } }, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(purgeTutorForUser).toHaveBeenCalledWith(uid);
    expect(firstCall(purgeTutorForUser)).toBeLessThan(firstCall(User.deleteOne));
    expect(r.json).toHaveBeenCalledWith({ ok: true });
  });

  it("三条入口在源码里都懒 require 同一个函数（开关关着 tutor 树零加载 —— tutorFlagOff.spec 那条依赖它是懒的）", () => {
    const fs = require("fs"); const path = require("path");
    for (const f of ["controllers/users.controller.js", "controllers/admin.controller.js", "controllers/branchAdmin.controller.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
      expect(src).toMatch(/require\("\.\.\/services\/tutorPurge\.service"\)\.purgeTutorForUser\(/);
      expect(src).not.toMatch(/^const .*require\("\.\.\/services\/tutorPurge\.service"\)/m); // 顶层 require = 开关关着也装
    }
  });
});
