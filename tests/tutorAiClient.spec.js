/**
 * core/ai/client.js —— 老师人格核心包的 AI 适配层：把 services/aiClient 的回包翻成 tutor 仓 chat / chatStream 的形状，
 * 按 kind 选模型（TUTOR_AI_MODEL_TEACH / _CHEAP），截断抛 AiTruncated，每一发吐一条用量记录（不含正文）。
 * openai SDK 用 jest.mock 换掉：测的是我们发了什么、翻成了什么。
 */
const mockCreate = jest.fn();
jest.mock("openai", () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));

const client = require("../src/tutor/core/ai/client");

function streamOf(chunks) { return (async function* () { for (const c of chunks) yield c; })(); }

beforeEach(() => {
  mockCreate.mockReset();
  process.env.AI_API_KEY = "test-key";
  process.env.TUTOR_AI_MODEL_TEACH = "teach-model";
  process.env.TUTOR_AI_MODEL_CHEAP = "cheap-model";
  delete process.env.AI_MODEL; delete process.env.OPENAI_MODEL;
});
afterAll(() => { delete process.env.AI_API_KEY; delete process.env.TUTOR_AI_MODEL_TEACH; delete process.env.TUTOR_AI_MODEL_CHEAP; });

describe("aiConfig / modelFor", () => {
  it("没 key → null（演示模式）；有 key → 有模型名；教学类走 TEACH、蒸馏 / 生成类走 CHEAP", () => {
    delete process.env.AI_API_KEY;
    expect(client.aiConfig()).toBeNull();
    process.env.AI_API_KEY = "k";
    expect(client.aiConfig().model).toBe("teach-model");
    expect(client.modelFor("turn")).toBe("teach-model");
    expect(client.modelFor("quiz-grade")).toBe("teach-model");
    for (const k of ["distill", "stages", "stage", "card", "scan"]) expect(client.modelFor(k)).toBe("cheap-model");
    delete process.env.TUTOR_AI_MODEL_CHEAP;
    expect(client.modelFor("distill")).toBe("teach-model");
    delete process.env.TUTOR_AI_MODEL_TEACH;
    expect(client.modelFor("turn")).toBeUndefined();
  });
});

describe("chat", () => {
  it("system + user 两条 messages、json 时带 response_format、模型按 kind；回包翻成 { text, finishReason, usage, model }；吐一条用量记录", async () => {
    mockCreate.mockResolvedValueOnce({ model: "cheap-model-2", choices: [{ message: { content: "{\"a\":1}" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 } });
    const recs = []; const off = client.onUsage((r) => recs.push(r));
    const r = await client.chat({ system: "只输出 JSON", user: "教材……", json: true, maxTokens: 500, kind: "stage", meta: { what: "蒸馏" } });
    off();
    const [body] = mockCreate.mock.calls[0];
    expect(body.model).toBe("cheap-model");
    expect(body.messages).toEqual([{ role: "system", content: "只输出 JSON" }, { role: "user", content: "教材……" }]);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(500);
    expect(r.text).toBe("{\"a\":1}");
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 });
    expect(r.model).toBe("cheap-model-2");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: "stage", ok: true, model: "cheap-model-2", promptTokens: 100, completionTokens: 8, totalTokens: 108, finishReason: "stop", stream: false });
    expect(JSON.stringify(recs[0])).not.toMatch(/教材……|test-key/);
  });

  it("finish_reason=length → AiTruncated，记录 error=truncated 且 usage 留下；没 key → AiNotConfigured", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "半截" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 500, total_tokens: 505 } });
    const recs = []; const off = client.onUsage((r) => recs.push(r));
    await expect(client.chat({ system: "s", user: "u", maxTokens: 500 })).rejects.toBeInstanceOf(client.AiTruncated);
    off();
    expect(recs[0]).toMatchObject({ error: "truncated", finishReason: "length", totalTokens: 505, ok: false });
    delete process.env.AI_API_KEY;
    await expect(client.chat({ system: "s", user: "u" })).rejects.toBeInstanceOf(client.AiNotConfigured);
  });

  it("上游抛 → 「模型没有回包」并记 http_<状态> / network", async () => {
    const e = new Error("rate limited"); e.status = 429;
    mockCreate.mockRejectedValueOnce(e);
    const recs = []; const off = client.onUsage((r) => recs.push(r));
    await expect(client.chat({ system: "s", user: "u" })).rejects.toThrow(/没有回包/);
    off();
    expect(recs[0].error).toBe("http_429");
  });

  it("parseStrictJson：剥围栏、顶层必须是对象", () => {
    expect(client.parseStrictJson("```json\n{\"ops\":[]}\n```")).toEqual({ ops: [] });
    expect(() => client.parseStrictJson("[1]")).toThrow(client.AiBadReply);
  });
});

describe("chatStream", () => {
  it("逐段 yield { delta }，末尾 { done: { finishReason, usage, model } }；记录带首字延迟与字符数；模型走 TEACH", async () => {
    mockCreate.mockResolvedValueOnce(streamOf([
      { model: "teach-model", choices: [{ delta: { content: "先" } }] },
      { choices: [{ delta: { content: "算一道" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 300, completion_tokens: 40 } },
    ]));
    const recs = []; const off = client.onUsage((r) => recs.push(r));
    const got = [];
    for await (const ev of client.chatStream({ messages: [{ role: "system", content: "s" }, { role: "user", content: "讲" }], kind: "turn", maxTokens: 1024 })) got.push(ev);
    off();
    expect(mockCreate.mock.calls[0][0].model).toBe("teach-model");
    expect(mockCreate.mock.calls[0][0].stream).toBe(true);
    expect(got.filter((e) => e.delta).map((e) => e.delta).join("")).toBe("先算一道");
    expect(got.at(-1).done).toMatchObject({ finishReason: "stop", usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 } });
    expect(recs[0]).toMatchObject({ kind: "turn", stream: true, ok: true, completionChars: 4, promptTokens: 300, completionTokens: 40, totalTokens: 340, finishReason: "stop" });
    expect(recs[0].ttfbMs).toBeGreaterThanOrEqual(0);
  });

  it("第一个字之前上游抛 → 记 http_<状态>、ok=false；之后断流记 stream", async () => {
    const e = new Error("boom"); e.status = 502;
    mockCreate.mockRejectedValueOnce(e);
    const recs = []; const off = client.onUsage((r) => recs.push(r));
    await expect((async () => { for await (const _ of client.chatStream({ system: "s", user: "u" })) { void _; } })()).rejects.toThrow("boom");
    mockCreate.mockResolvedValueOnce((async function* () { yield { choices: [{ delta: { content: "先算" } }] }; throw new Error("reset"); })());
    await expect((async () => { for await (const _ of client.chatStream({ system: "s", user: "u", kind: "turn" })) { void _; } })()).rejects.toThrow("reset");
    off();
    expect(recs.map((r) => [r.ok, r.error, r.completionChars])).toEqual([[false, "http_502", 0], [false, "stream", 2]]);
  });
});
