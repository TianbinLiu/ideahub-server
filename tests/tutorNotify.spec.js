/**
 * 老师人格四类通知的唯一入口 tutorNotify（tutor 仓 docs/02 9.6 / 4.9 / 5.9）：类型白名单、自己不发、拉黑不发、24 小时同人同事去重、扇出上限；评论钩子只管 kind:tutor。
 * 不碰 Mongo：Notification.exists / createNotification / hasAnyBlockBetween 都 mock。
 */
jest.mock("../src/models/Notification", () => ({ exists: jest.fn(async () => null) }));
jest.mock("../src/services/notification.service", () => ({ createNotification: jest.fn(async (a) => ({ _id: "n1", ...a })) }));
jest.mock("../src/utils/blocking", () => ({ hasAnyBlockBetween: jest.fn(async () => false) }));
const Notification = require("../src/models/Notification");
const { createNotification } = require("../src/services/notification.service");
const { hasAnyBlockBetween } = require("../src/utils/blocking");
const notify = require("../src/services/tutorNotify.service");

beforeEach(() => { jest.clearAllMocks(); Notification.exists.mockResolvedValue(null); hasAnyBlockBetween.mockResolvedValue(false); });

describe("notifyTutor", () => {
  it("四类之外整句拒；自己给自己 / 拉黑 / 窗口内重复都回 null 且不写；正常的一条带 payload 落下去", async () => {
    await expect(notify.notifyTutor("BRANCH_LIKE", { userId: "u1" })).rejects.toThrow(/不是老师人格的通知类型/);
    expect(await notify.notifyTutor("TUTOR_RATING", { userId: "u1", actorId: "u1" })).toBeNull();
    hasAnyBlockBetween.mockResolvedValueOnce(true);
    expect(await notify.notifyTutor("TUTOR_RATING", { userId: "u1", actorId: "u2" })).toBeNull();
    Notification.exists.mockResolvedValueOnce({ _id: "old" });
    expect(await notify.notifyTutor("TUTOR_RATING", { userId: "u1", actorId: "u2", dedupe: { personaId: "p1" } })).toBeNull();
    expect(createNotification).not.toHaveBeenCalled();
    const n = await notify.notifyTutor("TUTOR_RATING", { userId: "u1", actorId: "u2", payload: { personaId: "p1", stars: 5 }, dedupe: { personaId: "p1" } });
    expect(n).toMatchObject({ type: "TUTOR_RATING", userId: "u1", actorId: "u2", payload: { personaId: "p1", stars: 5 } });
    const q = Notification.exists.mock.calls[0][0];
    expect(q).toMatchObject({ userId: "u1", actorId: "u2", type: "TUTOR_RATING", "payload.personaId": "p1" });
    expect(q.createdAt.$gte.getTime()).toBeGreaterThan(Date.now() - notify.DEDUP_WINDOW_MS - 5000);
  });
  it("没有 dedupe 的（回访到期）不查重、不带 actorId；createNotification 抛了只记日志回 null（通知不影响主流程）", async () => {
    const n = await notify.notifyTutor("TUTOR_REVIEW_DUE", { userId: "u1", payload: { courseId: "c1", count: 2 } });
    expect(n).toMatchObject({ type: "TUTOR_REVIEW_DUE", actorId: undefined });
    expect(Notification.exists).not.toHaveBeenCalled();
    createNotification.mockRejectedValueOnce(new Error("db down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await notify.notifyTutor("TUTOR_DOC_UPDATED", { userId: "u1", actorId: "u2" })).toBeNull();
    spy.mockRestore();
  });
});

describe("notifyMany（TUTOR_DOC_UPDATED 扇出）", () => {
  it("超过上限只发前 500 并 warn；每条各自去重；回实际发出数", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const recipients = Array.from({ length: notify.FANOUT_MAX + 1 }, (_, i) => ({ userId: `u${i}`, payload: { personaId: "p1", version: 2, courseId: `c${i}` } }));
    Notification.exists.mockImplementation(async (q) => (q.userId === "u3" ? { _id: "dup" } : null));
    const sent = await notify.notifyMany("TUTOR_DOC_UPDATED", recipients, { actorId: "author", dedupeOf: (pl) => ({ personaId: pl.personaId, version: pl.version }) });
    expect(sent).toBe(notify.FANOUT_MAX - 1);
    expect(createNotification).toHaveBeenCalledTimes(notify.FANOUT_MAX - 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("超过上限"));
    expect(Notification.exists.mock.calls[0][0]).toMatchObject({ "payload.personaId": "p1", "payload.version": 2 });
    warn.mockRestore();
  });
});

describe("onPersonaComment（persona.routes 的 onCreated 钩子）", () => {
  it("陪聊人格（没有 kind）原样跳过；老师人格 → 作者收 TUTOR_COMMENT，payload 带人格 / 评论 / 预览", async () => {
    expect(await notify.onPersonaComment({ target: { _id: "p1", author: "a" }, comment: { _id: "c1", author: { _id: "u2" } } })).toBeNull();
    expect(createNotification).not.toHaveBeenCalled();
    const n = await notify.onPersonaComment({ target: { _id: "p1", author: "a", kind: "tutor", name: "老包" }, comment: { _id: "c1", author: { _id: "u2", username: "x" }, content: "讲得清楚".repeat(50), parentId: null } });
    expect(n).toMatchObject({ type: "TUTOR_COMMENT", userId: "a", actorId: "u2", payload: { personaId: "p1", personaName: "老包", commentId: "c1", parentId: null } });
    expect(n.payload.preview).toHaveLength(120);
  });
});

describe("Notification 模型（真模型，不连库）", () => {
  it("type 枚举含这四类；写入只在 tutorNotify 一处", () => {
    const real = jest.requireActual("../src/models/Notification");
    const enums = real.schema.path("type").enumValues;
    for (const t of notify.TUTOR_NOTIFICATION_TYPES) expect(enums).toContain(t);
    const fs = require("fs"); const path = require("path");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const writers = walk(path.join(__dirname, "..", "src")).filter((f) => f.endsWith(".js") && /TUTOR_(RATING|COMMENT|REVIEW_DUE|DOC_UPDATED)/.test(fs.readFileSync(f, "utf8")) && /createNotification\(|Notification\.create\(/.test(fs.readFileSync(f, "utf8"))); // 调用形（带括号）：模型文件的注释里提到 createNotification 不算
    expect(writers.map((f) => path.relative(path.join(__dirname, "..", "src"), f).replace(/\\/g, "/"))).toEqual(["services/tutorNotify.service.js"]);
  });
});
