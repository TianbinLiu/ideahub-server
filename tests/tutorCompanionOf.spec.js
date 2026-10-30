/**
 * App 上课页 bundle 的 `companion`（M4，tutor 仓 docs/06 §6.1「老师说话只对勾了『同时发布为启梦人格』的老师」）：
 * tutorPublish.companionOf 只转述 personaAccess.checkPersonaAccess 的答案（同一条规则），这里验的是「找对人格 + 三种结局的形状」。不碰 Mongo。
 */
const mongoose = require("mongoose");
jest.mock("../src/models/Persona", () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock("../src/models/PersonaPurchase", () => ({ exists: jest.fn(async () => null) }));
jest.mock("../src/services/tutorNotify.service", () => ({ notifyMany: jest.fn(async () => 0) }));
const Persona = require("../src/models/Persona");
const { companionOf } = require("../src/services/tutorPublish.service");

const chain = (v) => { const c = { populate: () => c, select: () => c, lean: async () => v }; return c; };
const oid = () => new mongoose.Types.ObjectId();
const author = oid();
const tutor = (extra = {}) => ({ _id: oid(), author: { _id: author, username: "a" }, name: "老包", shared: true, price: 0, kind: "tutor", ...extra });
const ctxOf = (course, user) => ({ course, user });

beforeEach(() => { jest.clearAllMocks(); Persona.findOne.mockReturnValue(chain(null)); Persona.findById.mockReturnValue(chain(null)); });

describe("companionOf", () => {
  it("作者自己的课：按 {kind:tutor, course} 找人格；勾了「同时发布为启梦人格」→ enabled:true", async () => {
    const p = tutor({ companion: { enabled: true, at: new Date() } });
    Persona.findOne.mockReturnValue(chain({ _id: p._id }));
    Persona.findById.mockReturnValue(chain(p));
    const courseId = oid();
    expect(await companionOf(ctxOf({ _id: courseId }, { _id: author }))).toEqual({ personaId: String(p._id), name: "老包", enabled: true });
    expect(Persona.findOne).toHaveBeenCalledWith({ kind: "tutor", course: courseId });
    expect(Persona.findById).toHaveBeenCalledWith(String(p._id)); // checkPersonaAccess 先 String() 再查
  });
  it("没勾 → enabled:false + reason:not_companion（作者自己也一样：这一格是表态不是可见性）；名字照带", async () => {
    const p = tutor();
    Persona.findOne.mockReturnValue(chain({ _id: p._id }));
    Persona.findById.mockReturnValue(chain(p));
    expect(await companionOf(ctxOf({ _id: oid() }, { _id: author }))).toEqual({ personaId: String(p._id), name: "老包", enabled: false, reason: "not_companion" });
  });
  it("从市场开的课：直接用 sourcePersona，不再按 course 找；取消分享的老师对学习者 → private", async () => {
    const p = tutor({ shared: false, companion: { enabled: true } });
    Persona.findById.mockReturnValue(chain(p));
    const r = await companionOf(ctxOf({ _id: oid(), sourcePersona: p._id }, { _id: oid() }));
    expect(r).toEqual({ personaId: String(p._id), name: "老包", enabled: false, reason: "private" });
    expect(Persona.findOne).not.toHaveBeenCalled();
  });
  it("没发布过 → null；sourcePersona 指向的人格已删 → null（App 两种都画成「不会说话」）", async () => {
    expect(await companionOf(ctxOf({ _id: oid() }, { _id: author }))).toBeNull();
    Persona.findById.mockReturnValue(chain(null));
    expect(await companionOf(ctxOf({ _id: oid(), sourcePersona: oid() }, { _id: author }))).toBeNull();
  });
});
