/**
 * M3 反向勾选的选用门（tutor 仓 docs/06 §5.1 / §5.2「作者不勾时 App 人格市场里没有这条；勾了才有且可装进看板娘」）：
 * personaAccess.checkPersonaAccess 对没勾 companion.enabled 的老师人格回 not_companion（作者自己也一样）；勾了放行；陪聊人格不受影响。不碰 Mongo。
 */
const mongoose = require("mongoose");
jest.mock("../src/models/Persona", () => ({ findById: jest.fn() }));
jest.mock("../src/models/PersonaPurchase", () => ({ exists: jest.fn(async () => null) }));
const Persona = require("../src/models/Persona");
const { checkPersonaAccess, loadUsablePersona } = require("../src/services/personaAccess.service");

const chain = (v) => { const c = { populate: () => c, select: () => c, lean: async () => v }; return c; };
const oid = () => String(new mongoose.Types.ObjectId());
const author = oid();
const tutor = (extra = {}) => ({ _id: new mongoose.Types.ObjectId(), author: { _id: author, username: "a" }, name: "老包", shared: true, price: 0, kind: "tutor", ...extra });

beforeEach(() => jest.clearAllMocks());

describe("checkPersonaAccess × kind:tutor", () => {
  it("没勾（没有 companion 这一格 = 存量老师）→ not_companion，作者自己也一样", async () => {
    Persona.findById.mockReturnValue(chain(tutor()));
    expect(await checkPersonaAccess(oid(), oid())).toEqual({ persona: null, reason: "not_companion" });
    expect(await checkPersonaAccess(oid(), author)).toEqual({ persona: null, reason: "not_companion" });
    expect(await loadUsablePersona(oid(), oid())).toBeNull();
  });
  it("companion.enabled:false（勾过又取消）→ not_companion；'true' 字符串也不算", async () => {
    Persona.findById.mockReturnValue(chain(tutor({ companion: { enabled: false, at: null } })));
    expect((await checkPersonaAccess(oid(), oid())).reason).toBe("not_companion");
    Persona.findById.mockReturnValue(chain(tutor({ companion: { enabled: "true" } })));
    expect((await checkPersonaAccess(oid(), oid())).reason).toBe("not_companion");
  });
  it("勾了 → 放行（与普通人格同一条后续规则：shared / 付费）", async () => {
    Persona.findById.mockReturnValue(chain(tutor({ companion: { enabled: true, at: new Date() } })));
    const r = await checkPersonaAccess(oid(), oid());
    expect(r.reason).toBe(""); expect(r.persona.name).toBe("老包");
  });
  it("下架 / 取消分享的老师先被 private 挡住（不因勾了就露出去）", async () => {
    Persona.findById.mockReturnValue(chain(tutor({ shared: false, companion: { enabled: true } })));
    expect((await checkPersonaAccess(oid(), oid())).reason).toBe("private");
  });
  it("陪聊人格（没有 kind）一个字不变", async () => {
    Persona.findById.mockReturnValue(chain({ ...tutor(), kind: undefined }));
    expect((await checkPersonaAccess(oid(), oid())).reason).toBe("");
  });
});
