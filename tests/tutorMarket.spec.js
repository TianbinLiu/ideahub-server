/**
 * 市场端点的纯函数部分（docs/02 7.1 / 7.2 / 7.4 / 7.5）：参数归一化、Mongo 过滤形状、卡片与预览形状。不碰 Mongo。
 */
const { parseQuery, marketFilter, toMarketCard, previewOf, LIMIT_MAX } = require("../src/services/tutorMarket.service");

describe("parseQuery", () => {
  it("未登录 scope 一律退 all；limit 封顶；乱 sort 退 new；page 最小 1", () => {
    expect(parseQuery({ scope: "mine", sort: "xx", limit: "99", page: "0" }, null)).toMatchObject({ scope: "all", sort: "new", limit: LIMIT_MAX, page: 1 });
    expect(parseQuery({ scope: "installed", sort: "rating" }, { _id: "u" })).toMatchObject({ scope: "installed", sort: "rating" });
    expect(parseQuery({ tag: " TCP ", subject: " 计算机网络 " }, null)).toMatchObject({ tag: "tcp", subject: "计算机网络" });
  });
});

describe("marketFilter", () => {
  const p = (q, user) => parseQuery(q, user);
  it("缺省：只回 kind:tutor && shared && !takenDown", () => {
    expect(marketFilter(p({}, null))).toEqual({ kind: "tutor", shared: true, takenDown: { $ne: true } });
  });
  it("mine：按作者、含私有（不带 shared）；installed：_id $in", () => {
    expect(marketFilter(p({ scope: "mine" }, { _id: "u1" }), { userId: "u1" })).toEqual({ kind: "tutor", author: "u1" });
    expect(marketFilter(p({ scope: "installed" }, { _id: "u1" }), { userId: "u1", installedIds: ["a", "b"] })).toMatchObject({ kind: "tutor", shared: true, _id: { $in: ["a", "b"] } });
  });
  it("tag 精确、subject 不分大小写整词、q 四列正则", () => {
    const f = marketFilter(p({ tag: "TCP", subject: "networks", q: "延迟" }, null));
    expect(f.tags).toBe("tcp");
    expect(f.subject).toBeInstanceOf(RegExp); expect(f.subject.test("Networks")).toBe(true); expect(f.subject.test("networks 101")).toBe(false);
    expect(f.$or.map((o) => Object.keys(o)[0])).toEqual(["name", "description", "tags", "subject"]);
  });
  it("拉黑：author $nin；author= 与拉黑同时在 → $eq + $nin；正则元字符要转义", () => {
    expect(marketFilter(p({}, { _id: "u" }), { userId: "u", blockedIds: new Set(["b1"]) }).author).toEqual({ $nin: ["b1"] });
    const a = "0123456789abcdef01234567";
    expect(marketFilter(p({ author: a }, { _id: "u" }), { userId: "u", blockedIds: ["b1"] }).author).toEqual({ $eq: a, $nin: ["b1"] });
    expect(marketFilter(p({ q: "a.b*" }, null)).$or[0].name.test("axb")).toBe(false);
  });
});

describe("toMarketCard / previewOf", () => {
  const persona = { _id: "p1", name: "老包", description: "d", tags: ["tcp"], subject: "计算机网络", author: { _id: "u1", username: "bao" }, price: 0, releaseVersion: 2, shared: true, stats: { downloadCount: 3, likeCount: 1 }, aigcDeclaredAt: new Date("2026-09-28T00:00:00Z"), createdAt: new Date("2026-09-01T00:00:00Z") };
  it("卡片：作者 / 统计 / 已下载态 / isOwner 都在，缺的统计补 0", () => {
    const c = toMarketCard(persona, { installedSet: new Set(["p1"]), userId: "u1" });
    expect(c).toMatchObject({ id: "p1", name: "老包", version: 2, author: { _id: "u1", username: "bao" }, stats: { downloadCount: 3, likeCount: 1, ratingAvg: 0, ratingCount: 0 }, installed: true, isOwner: true, coverEmoji: "🎓" });
    expect(toMarketCard({ ...persona, author: "u2" }, { userId: "u1" })).toMatchObject({ author: { _id: "u2", username: "" }, installed: false, isOwner: false });
  });
  it("预览：只带 ① 教学面 + ③ 每阶段几步几条 + ⑥，硬规则字符串 / 对象都认；不带 ② ④ 正文", () => {
    const doc = { subject: "s", card: { who: "w", teaching_style: "t", catchphrases: ["c"], hard_rules: ["r1", { text: "r2", locked: true }] }, map: { stages: [{ stage_id: "stage-01", title: "T", summary: "S" }] }, distill: { "stage-01": { walkthrough: [{}, {}], must_memorize: ["m"], self_checks: ["q", "q", "q"], student_qa: [{ q: "x" }] } }, guide: "g" };
    const v = previewOf(doc);
    expect(v.card.hard_rules).toEqual([{ text: "r1", locked: false }, { text: "r2", locked: true }]);
    expect(v.stages).toEqual([{ stage_id: "stage-01", title: "T", summary: "S", steps: 2, memo: 1, checks: 3 }]);
    expect(v.guide).toBe("g");
    expect(JSON.stringify(v)).not.toMatch(/student_qa|"x"/);
  });
});
