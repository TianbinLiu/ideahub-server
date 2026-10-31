// 人设描述按预算取舍（personaAccess.styleDescriptorOf，2026-10-30，docs/decisions-2026-10-30.md §三 2）：
// 放得下 = 与老写法逐字节相同；放不下先整段丢优先级低的，「边界」与名字永远在，「风格」只在句子边界处截。
const { styleDescriptorOf } = require("../src/services/personaAccess.service");

const BUDGET = 900;
const sentence = (n, ch = "句") => Array.from({ length: n }, (_, i) => `第${i + 1}${ch}话说得很长很长很长。`).join("");

describe("personaAccess.styleDescriptorOf 按预算取舍", () => {
  it("放得下：与老写法逐字节相同（拼法与顺序不变）", () => {
    const style = { summary: "爱讲冷笑话", tone: "轻快", catchphrases: ["哈哈", "好嘛"], stanceHint: "偏乐观", addressUser: "老铁", boundaries: ["不聊政治", "不给医疗建议"] };
    expect(styleDescriptorOf("小梦", style)).toBe("小梦｜风格：爱讲冷笑话｜语气：轻快｜口头禅：哈哈、好嘛｜倾向：偏乐观｜称呼用户：老铁｜边界：不聊政治；不给医疗建议");
    expect(styleDescriptorOf("小梦", {})).toBe("小梦");
    expect(styleDescriptorOf("", { tone: "冷" })).toBe("｜语气：冷");
  });

  it("放不下：先整段丢倾向、口头禅、称呼、语气（按这个顺序），边界与名字一个字不动", () => {
    const style = {
      summary: "A".repeat(560) + "。", // 561 字，长度算得准
      tone: "x".repeat(280),
      catchphrases: Array.from({ length: 10 }, (_, i) => `口头禅${i}`),
      stanceHint: "y".repeat(100),
      addressUser: "小主",
      boundaries: ["不聊政治", "不给医疗建议", "不帮写作业"],
    };
    const out = styleDescriptorOf("阿尔法", style);
    expect(out.length).toBeLessThanOrEqual(BUDGET);
    expect(out.startsWith("阿尔法｜")).toBe(true);
    expect(out).toContain("边界：不聊政治；不给医疗建议；不帮写作业");
    expect(out).not.toContain("倾向：");
    expect(out).not.toContain("口头禅：");
    // 总长 1039（3 + 564 + 283 + 53 + 103 + 7 + 20 + 6 个分隔符）：丢倾向 → 935，再丢口头禅 → 881 就放得下了，称呼与语气要还在
    expect(out).toContain("称呼用户：小主");
    expect(out).toContain("语气：");
    // 风格那一段整段保留（没被切成半句）
    expect(out).toContain("A".repeat(560) + "。");
    expect(out.length).toBe(881);
  });

  it("只有风格超长：在句子边界处截短，不留半句、末尾不加省略号；边界照样在最后", () => {
    const style = { summary: sentence(80), boundaries: ["不聊政治"] }; // 约 1600 字
    const out = styleDescriptorOf("贝塔", style);
    expect(out.length).toBeLessThanOrEqual(BUDGET);
    expect(out.endsWith("｜边界：不聊政治")).toBe(true);
    const summaryPart = out.split("｜")[1];
    expect(summaryPart.startsWith("风格：")).toBe(true);
    expect(summaryPart.endsWith("。")).toBe(true); // 停在句末
    expect(summaryPart).not.toMatch(/…$/);
    // 老写法会把第 900 个字之后的「边界」整段切没 —— 这是这次改法要治的
    const legacy = ["贝塔", `风格：${style.summary}`, "边界：不聊政治"].join("｜").slice(0, BUDGET);
    expect(legacy).not.toContain("边界：");
  });

  it("没有句号的长风格：退回逗号，再没有才硬截；永远不超预算", () => {
    const noStop = Array.from({ length: 300 }, (_, i) => `词${i}，`).join("");
    const out1 = styleDescriptorOf("伽马", { summary: noStop });
    expect(out1.length).toBeLessThanOrEqual(BUDGET);
    expect(out1.endsWith("，")).toBe(true);
    const out2 = styleDescriptorOf("伽马", { summary: "字".repeat(1500) });
    expect(out2.length).toBe(BUDGET);
  });

  it("边界本身写满（12 条 × 120 字）：从后往前整条去掉，留下的都是完整的一条", () => {
    const boundaries = Array.from({ length: 12 }, (_, i) => `第${i + 1}条边界` + "细".repeat(110));
    const out = styleDescriptorOf("德尔塔", { summary: "简短风格。", boundaries });
    expect(out.length).toBeLessThanOrEqual(BUDGET);
    expect(out).toContain("边界：第1条边界");
    const kept = out.split("边界：")[1].split("；");
    for (const b of kept) expect(b.endsWith("细")).toBe(true); // 每一条都是整条
  });
});
