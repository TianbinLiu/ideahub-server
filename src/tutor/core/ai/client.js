// 老师人格核心包的 AI 出口 —— **server `services/aiClient.js` 的适配层**（手写，port-core 不覆盖；tutor 仓那份自己发 HTTP）。
// 对上保持 tutor 仓 src/ai/client.js 的形状：chat() / chatStream() / aiConfig() / parseStrictJson / 三个错误类 / onUsage()，
// 这样 core/generate/pipeline.js、core/session/*.js 一行不改就能跑；对下只调 aiComplete / aiChatStream（同一个 AI 出口、同一份超时与退让逻辑）。
// ★ 模型选择（tutor 仓 docs/04 S10、docs/05 §6.4）：TUTOR_AI_MODEL_TEACH 给教学轮 / 试教 / 判卷，TUTOR_AI_MODEL_CHEAP 给蒸馏 / 阶段提议 / ① ⑥ / 扫描；
//   都没配就走全站 AI_MODEL（aiClient.resolveModel 的老规矩）。变量名只在这里出现一次。
// ★ 演示模式：没配 AI key 时 aiConfig() 回 null，上层走本地确定性规则（生成 / 老师 / 判卷 / 蒸馏都有一份）。生产是否允许由 tutorAi.service 的 demoAllowed() 决定，这里不管。
// ★ 用量记录（tutor 仓 docs/10）：每一发结束吐一条给 onUsage 订阅者（kind / 模型 / token / 耗时 / 首字 / 截断 / 成败；没有密钥、没有正文），
//   tutor.worker / tutorLedger 把它落进 TutorUsage，GET /api/tutor/usage-ledger 从那里读。
"use strict";
const ai = require("../../../services/aiClient");

const CHEAP_KINDS = new Set(["distill", "stages", "stage", "card", "scan"]);
const ENV = { key: "AI_API_KEY", teach: "TUTOR_AI_MODEL_TEACH", cheap: "TUTOR_AI_MODEL_CHEAP" };
const STREAM_USAGE_ENV = "TUTOR_AI_STREAM_USAGE"; // 兼容 tutor 仓的名字；server 的 aiChatStream 本来就带 stream_options 并会自动退让，这里只是留着给 measure 的说明对得上

class AiNotConfigured extends Error { constructor() { super("没有配置模型（AI_API_KEY）：老师人格的生成 / 教学 / 蒸馏都需要它"); this.name = "AiNotConfigured"; } }
class AiTruncated extends Error { constructor(max) { super(`模型输出被 max_tokens=${max} 截断，不解析半截 JSON（这一次已计费）`); this.name = "AiTruncated"; this.maxTokens = max; } }
class AiBadReply extends Error { constructor(msg) { super(msg); this.name = "AiBadReply"; } }

const usageSinks = new Set();
/** 订阅用量记录；返回退订函数。记录失败不影响调用本身。 */
function onUsage(fn) { usageSinks.add(fn); return () => usageSinks.delete(fn); }
function emitUsage(rec) { for (const fn of usageSinks) { try { fn(rec); } catch { /* 记录是旁路 */ } } }
const charsOf = (msgs) => msgs.reduce((n, m) => n + String((m && m.content) || "").length, 0);
const usageOf = (u) => ({ promptTokens: u ? u.promptTokens : null, completionTokens: u ? u.completionTokens : null, totalTokens: u ? u.promptTokens + u.completionTokens : null });

/** 模型配置：没 key 就是 null（演示模式）。model 是「教学那一档」的名字，给界面 / 使用记录显示用；按 kind 选模型见 modelFor。 */
function aiConfig(env = process.env) {
  if (!ai.hasAiKey()) return null;
  return { base: "(server aiClient)", key: "(server)", model: env[ENV.teach] || ai.resolveModel(env[ENV.cheap] || "gpt-5.2") };
}
function modelFor(kind, env = process.env) {
  const cheap = env[ENV.cheap];
  const teach = env[ENV.teach];
  const pick = CHEAP_KINDS.has(kind) ? cheap || teach : teach || cheap;
  return pick || undefined; // undefined = 让 aiClient 按全站 AI_MODEL 走
}
function messagesOf(req) {
  if (Array.isArray(req.messages) && req.messages.length) return req.messages;
  return [{ role: "system", content: req.system }, { role: "user", content: req.user }];
}

/**
 * 非流式一发（生成 / 蒸馏 / 判卷）。与 tutor 仓同形：{ text, finishReason, usage, model }；finish_reason=length 抛 AiTruncated。
 * @param {{ system?: string, user?: string, messages?: object[], json?: boolean, maxTokens?: number, temperature?: number, kind?: string, meta?: object }} req
 */
async function chat(req, { env = process.env } = {}) {
  if (!ai.hasAiKey()) throw new AiNotConfigured();
  const maxTokens = req.maxTokens ?? 4000;
  const messages = messagesOf(req);
  const kind = req.kind || "chat";
  const t0 = performance.now();
  const rec = { at: new Date().toISOString(), kind, meta: req.meta || {}, model: modelFor(kind, env) || ai.resolveModel("") || null, stream: false, maxTokens, promptChars: charsOf(messages), completionChars: 0, ...usageOf(null), latencyMs: null, ttfbMs: null, finishReason: null, ok: false, error: null };
  const finish = (patch) => { rec.latencyMs = Math.round(performance.now() - t0); Object.assign(rec, patch); emitUsage(rec); };
  let r;
  try {
    r = await ai.aiComplete("", { messages, maxTokens, temperature: req.temperature ?? 0.3, model: modelFor(kind, env), ...(req.json ? { responseFormat: { type: "json_object" } } : {}) });
  } catch (e) {
    const status = e && (e.status || (e.error && e.error.status));
    finish({ error: status ? `http_${status}` : /timeout|timed out|abort/i.test(String(e && e.message)) ? "timeout" : "network" });
    throw new Error(`模型没有回包（${status ? `HTTP ${status}` : (e && e.message) || "网络"}）—— 这一次有没有计费要看上游后台，这里说不准`, { cause: e });
  }
  const content = String(r.text || "");
  if (r.finishReason === "length") { finish({ error: "truncated", finishReason: "length", ...usageOf(r.usage), completionChars: content.length, model: r.model }); throw new AiTruncated(maxTokens); }
  finish({ ok: true, finishReason: r.finishReason, ...usageOf(r.usage), completionChars: content.length, model: r.model });
  return { text: content, finishReason: r.finishReason, usage: r.rawUsage || (r.usage ? { prompt_tokens: r.usage.promptTokens, completion_tokens: r.usage.completionTokens, total_tokens: r.usage.promptTokens + r.usage.completionTokens } : undefined), model: r.model };
}

/** 严格 JSON：整段必须是一个对象；剥掉模型爱加的 ```json 围栏；解析不了就当坏回包。（与 tutor 仓逐字同） */
function parseStrictJson(text) {
  const t = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const v = JSON.parse(t);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("顶层不是对象");
    return v;
  } catch (e) {
    throw new AiBadReply(`回答不是合法 JSON 对象（${e.message}）。前 120 字：${t.slice(0, 120)}`);
  }
}

/**
 * 流式一轮（教学会话）：逐段 yield { delta }，最后 yield { done: { finishReason, usage, model } }。
 * 超时 / 退让 / usage 都是 aiChatStream 的；这里只翻形状 + 记用量。
 */
async function* chatStream(req, { env = process.env, signal } = {}) {
  if (!ai.hasAiKey()) throw new AiNotConfigured();
  const maxTokens = req.maxTokens ?? 1024;
  const messages = messagesOf(req);
  const kind = req.kind || "stream";
  const t0 = performance.now();
  const rec = { at: new Date().toISOString(), kind, meta: req.meta || {}, model: modelFor(kind, env) || ai.resolveModel("") || null, stream: true, maxTokens, promptChars: charsOf(messages), completionChars: 0, ...usageOf(null), latencyMs: null, ttfbMs: null, finishReason: null, ok: false, error: null };
  const finish = (patch) => { rec.latencyMs = Math.round(performance.now() - t0); Object.assign(rec, patch); emitUsage(rec); };
  let usage = null;
  let finishReason = null;
  let modelSeen = null;
  let chars = 0;
  let ttfbMs = null;
  let failed = null;
  try {
    const gen = ai.aiChatStream(messages, { maxTokens, temperature: req.temperature ?? 0.5, model: modelFor(kind, env), signal, onUsage: (u) => { usage = u; }, onFinish: (fin, m) => { finishReason = fin; modelSeen = m; } });
    for await (const delta of gen) {
      if (ttfbMs === null) ttfbMs = Math.round(performance.now() - t0);
      chars += delta.length;
      yield { delta };
    }
  } catch (e) {
    failed = e && e.name === "AbortError" ? "aborted" : ttfbMs === null ? (e && e.status ? `http_${e.status}` : "network") : "stream";
    throw e;
  } finally {
    finish({ ok: !failed, error: failed || (finishReason === "length" ? "truncated" : null), finishReason, ttfbMs, completionChars: chars, ...usageOf(usage), model: modelSeen || rec.model });
  }
  yield { done: { finishReason, usage: usage ? { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens } : undefined, model: modelSeen || rec.model } };
}

module.exports = { AiNotConfigured, AiTruncated, AiBadReply, aiConfig, modelFor, chat, chatStream, parseStrictJson, onUsage, STREAM_USAGE_ENV, ENV };
