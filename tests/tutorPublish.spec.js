/**
 * 发布五道门（docs/02 6.1；docs/06 §4.2「五道门各有 spec：每一道单独不过都整句拒且指明处；全过才 shared:true」）。
 * 只测纯函数 checkGates（服务端唯一的判定处），不碰 Mongo：文档由核心包演示模式从 fixture 生成。
 */
const { runGenerate } = require("../src/tutor/core/generate/index");
const { pagesToText } = require("../src/tutor/core/materials/blocks");
const { checkGates, TAGS_MAX } = require("../src/services/tutorPublish.service");

const pages = require("./fixtures/tutor/week1-delay.pages.json");
const mats = [{ sha: "a".repeat(64), name: "week1-delay.pdf", ext: ".pdf", pages, license: { source: "self" } }];
const course = { title: "计算机网络", subject: "计算机网络", code: "CSEN 146", policy: { ai: "limited", homework_mode: "principles_only", allowed_uses: [], text: "作业独立完成" }, key_dates: [] };
const texts = [{ name: "week1-delay.pdf", text: pagesToText(pages) }];
let doc;
beforeAll(async () => {
  delete process.env.AI_API_KEY; delete process.env.OPENAI_API_KEY;
  const out = await runGenerate({ course, materials: mats, questionnaire: { name: "老包", style: "socratic" }, env: {} });
  doc = out.doc;
});
const good = () => ({ doc, materials: mats, materialTexts: texts, adultDeclared: true, body: { aigcDeclared: true } });
const leaked = () => { const bad = JSON.parse(JSON.stringify(doc)); bad.card.who = texts[0].text.replace(/\s+/g, " ").slice(0, 300); return bad; }; // ① 里贴 300 字讲义原文（阈值 120 字）

describe("checkGates（五道门，顺序固定）", () => {
  it("全过 → ok；发布件是 market 口径：学生问答不带、状态列清空、checksum 有", () => {
    const r = checkGates(good());
    expect(r.ok).toBe(true);
    expect(r.built.doc.audience).toBe("market");
    for (const st of Object.values(r.built.doc.distill)) expect(st.student_qa).toEqual([]);
    for (const s of r.built.doc.map.stages) expect(s.status).toBe("未讲");
    expect(r.built.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.name).toBe("老包");
    expect(r.tags).toEqual([]);
  });
  it("① 授权：有一份「不确定」→ gate=license 并点名那份；没有教材也是 license", () => {
    const r = checkGates({ ...good(), materials: [{ ...mats[0], license: { source: "unsure" } }] });
    expect(r).toMatchObject({ ok: false, gate: "license" });
    expect(r.message).toMatch(/week1-delay\.pdf/);
    expect(checkGates({ ...good(), materials: [] })).toMatchObject({ ok: false, gate: "license" });
  });
  it("② 泄漏核查：人格卡里贴一段讲义原文 → gate=cleanCheck；没有教材文本 = 没查过，同样不许发", () => {
    const r = checkGates({ ...good(), doc: leaked() });
    expect(r).toMatchObject({ ok: false, gate: "cleanCheck" });
    expect(r.details && r.details.clean && r.details.clean.ok).toBe(false);
    expect(checkGates({ ...good(), materialTexts: [] })).toMatchObject({ ok: false, gate: "cleanCheck" });
  });
  it("③ 成人声明没做 → adult", () => {
    expect(checkGates({ ...good(), adultDeclared: false })).toMatchObject({ ok: false, gate: "adult" });
  });
  it("④ 没勾「主动声明含 AI 生成内容」→ aigc；字符串 'yes' 也不算（显式布尔，不是脚注）", () => {
    expect(checkGates({ ...good(), body: {} })).toMatchObject({ ok: false, gate: "aigc" });
    expect(checkGates({ ...good(), body: { aigcDeclared: "yes" } })).toMatchObject({ ok: false, gate: "aigc" });
  });
  it("⑤ 化名：像真实教授姓名 → name；标签超 " + TAGS_MAX + " 个 → tags；空名 → name", () => {
    expect(checkGates({ ...good(), body: { aigcDeclared: true, name: "张三教授" } })).toMatchObject({ ok: false, gate: "name" });
    expect(checkGates({ ...good(), body: { aigcDeclared: true, name: "Prof. Smith" } })).toMatchObject({ ok: false, gate: "name" });
    expect(checkGates({ ...good(), body: { aigcDeclared: true, tags: Array.from({ length: TAGS_MAX + 1 }, (_, i) => `t${i}`) } })).toMatchObject({ ok: false, gate: "tags" });
    expect(checkGates({ ...good(), body: { aigcDeclared: true, name: "  " } })).toMatchObject({ ok: false, gate: "name" });
    const ok = checkGates({ ...good(), body: { aigcDeclared: true, name: "老包", tags: [" 网络 ", "网络", "TCP"] } });
    expect(ok.ok).toBe(true);
    expect(ok.tags).toEqual(["网络", "tcp"]); // 去重、去空、小写
  });
  it("顺序：授权与泄漏同时坏只报授权（不白算一遍核查）；泄漏与成人同时坏只报泄漏", () => {
    expect(checkGates({ ...good(), doc: leaked(), materials: [{ ...mats[0], license: { source: "unsure" } }] }).gate).toBe("license");
    expect(checkGates({ ...good(), doc: leaked(), adultDeclared: false }).gate).toBe("cleanCheck");
  });
  it("没有老师 → persona", () => {
    expect(checkGates({ ...good(), doc: null })).toMatchObject({ ok: false, gate: "persona" });
  });
});
