/**
 * 老师人格与客服 / 陪聊人格的缺省隔离（tutor 仓 docs/04 §5 S3 / S4、docs/06 D2 / D4）—— 不碰 Mongo：
 * 过滤器本身、Persona 模型新字段的形状（判否定：没有 default）、zod 不收 kind、controller 里 kind 只在唯一实现那一处。
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { personaKindFilter, TUTOR_KIND } = require("../src/services/personaKind");
const { createBody, updateBody } = require("../src/schemas/persona.schemas");
require("../src/models/Persona");

describe("personaKindFilter（唯一实现）", () => {
  it("缺省 / 空 / 乱值 → 排除没勾「同时发布为启梦人格」的老师人格（M3）；存量没有 kind 字段的文档不被 $nor 那一支命中；单个 $nor 键，不与 controller 的 $or / $and 打架", () => {
    for (const v of [undefined, "", "companion", "TUTOR", "all", 0]) expect(personaKindFilter(v)).toEqual({ $nor: [{ kind: "tutor", "companion.enabled": { $ne: true } }] });
    expect(Object.keys(personaKindFilter())).toEqual(["$nor"]);
  });
  it("kind=tutor → 只要老师人格", () => {
    expect(personaKindFilter("tutor")).toEqual({ kind: TUTOR_KIND });
  });
});

describe("Persona 模型：老师那几格全部判否定", () => {
  const P = mongoose.model("Persona");
  const base = () => ({ author: new mongoose.Types.ObjectId(), name: "x" });
  it("kind 只认 tutor、没有 default（存量 = undefined = 客服人格）", () => {
    const p = P.schema.path("kind");
    expect(p.enumValues).toEqual(["tutor"]);
    expect(p.defaultValue).toBeUndefined();
    expect(new P(base()).kind).toBeUndefined();
    expect(new P({ ...base(), kind: "tutor" }).validateSync()).toBeUndefined();
    expect(new P({ ...base(), kind: "companion" }).validateSync()?.errors?.kind).toBeTruthy();
  });
  it("companion.enabled / companion.at（M3 反向勾选）没有 default：存量老师人格 = 没勾", () => {
    expect(P.schema.path("companion.enabled").defaultValue).toBeUndefined();
    expect(P.schema.path("companion.at").defaultValue).toBeUndefined();
    expect(new P({ ...base(), kind: "tutor" }).companion?.enabled).toBeUndefined();
  });
  it("course / currentDoc / remixOf 是可选的 ObjectId 引用", () => {
    for (const k of ["course", "currentDoc", "remixOf"]) {
      const p = P.schema.path(k);
      expect(p.instance).toBe("ObjectId");
      expect(p.isRequired).toBeFalsy();
    }
  });
  it("D4：zod 与 model 同一提交 —— 客户端 body 里的 kind / course / currentDoc / remixOf 一律被 strip（谁都不许把自己标成老师）", () => {
    const out = createBody.parse({ name: "x", kind: "tutor", course: "a", currentDoc: "b", remixOf: "c" });
    for (const k of ["kind", "course", "currentDoc", "remixOf"]) expect(out).not.toHaveProperty(k);
    const up = updateBody.parse({ kind: "tutor" });
    expect(up).not.toHaveProperty("kind");
  });
});

describe("docs/06 D2：persona.controller 里的 kind 判断只有唯一实现那一处", () => {
  it("personaKindFilter 只调一次；其它带 kind 的行只有 ai_disclosure 那条通知类型（与老师人格无关）", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/controllers/persona.controller.js"), "utf8");
    expect(src.match(/personaKindFilter\(/g)).toHaveLength(1);
    const kindLines = src.split("\n").filter((l) => /\bkind\b/.test(l)).map((l) => l.trim());
    expect(kindLines).toEqual(["Object.assign(filter, personaKindFilter(req.query.kind));", 'kind: "ai_disclosure",']);
  });
});
