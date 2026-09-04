#!/usr/bin/env node
/**
 * AI 客服评测：拿 tests/fixtures/support-eval.json 的题库打真实的 /api/support/chat，量三件事——
 *   1) 准不准：期望关键词命中率 + 「禁止承诺」正则零命中 + 转人工判定对不对
 *   2) 快不快：首句（TTFB，第一条 sentence 事件）与整段耗时
 *   3) 像不像人：句数、每句长度、演出标签是否干净（正文里不能残留方括号）
 * 可选 EVAL_JUDGE=1：再让模型当裁判，对照知识库节选给 1～5 分（事实一致性）。
 *
 * 用法：
 *   node scripts/evalSupport.js                          # 打 http://127.0.0.1:4000，自动注册临时账号
 *   EVAL_BASE_URL=https://api.example.com EVAL_TOKEN=xxx node scripts/evalSupport.js
 *   EVAL_ONLY=retrieve-paid,ios node scripts/evalSupport.js   # 只跑几题
 * 输出：终端表格 + eval-out/support-eval-<时间>.md / .json
 *
 * ★ 为什么不放进 jest：它打真模型、要花钱、几分钟才跑完，且结果是"分数"不是"对错"。
 */
const fs = require("fs");
const path = require("path");

const BASE = (process.env.EVAL_BASE_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
const ONLY = String(process.env.EVAL_ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const JUDGE = process.env.EVAL_JUDGE === "1";
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../tests/fixtures/support-eval.json"), "utf8"));

async function getToken() {
  if (process.env.EVAL_TOKEN) return process.env.EVAL_TOKEN;
  const suffix = Date.now().toString(36);
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: `eval_${suffix}`, email: `eval_${suffix}@example.com`, password: "eval-pass-123" }),
  });
  const json = await res.json();
  if (!json.token) throw new Error(`register failed: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json.token;
}

function parseSse(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const ev = /event: (\w+)/.exec(block);
    const data = /data: (.*)/.exec(block);
    if (!ev || !data) continue;
    try {
      out.push({ event: ev[1], data: JSON.parse(data[1]) });
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function runCase(c, token) {
  const last = c.messages[c.messages.length - 1].content;
  const body = JSON.stringify({ messages: c.messages, lang: /[a-z]/i.test(last) && !/[一-鿿]/.test(last) ? "en" : "zh" });
  let res;
  let t0 = performance.now();
  // /chat 按账号限流 20/分钟；评测题库超过 20 题，撞 429 就按 Retry-After 等一等再来，别把限流算成客服不会答
  for (let attempt = 0; attempt < 4; attempt += 1) {
    t0 = performance.now();
    res = await fetch(`${BASE}/api/support/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body,
    });
    if (res.status !== 429) break;
    const wait = Math.max(1, Number(res.headers.get("retry-after") || 3));
    process.stdout.write(`(429, wait ${wait}s) `);
    await new Promise((r) => setTimeout(r, wait * 1000 + 200));
  }
  let ttfb = null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (ttfb === null && /event: sentence/.test(raw)) ttfb = performance.now() - t0;
  }
  const total = performance.now() - t0;
  const events = parseSse(raw);
  const sentences = events.filter((e) => e.event === "sentence").map((e) => e.data);
  const done = events.find((e) => e.event === "done");
  const error = events.find((e) => e.event === "error");
  const text = done ? done.data.text : sentences.map((s) => s.text).join(" ");
  const handoff = Boolean(done && done.data.handoff);
  return { ttfb, total, sentences, text, handoff, category: done ? done.data.category : "", error: error ? error.data.message : "" };
}

function grade(c, r) {
  const text = r.text || "";
  const groups = c.expect || [];
  const hits = groups.map((g) => g.some((k) => text.toLowerCase().includes(String(k).toLowerCase())));
  const expectScore = groups.length ? hits.filter(Boolean).length / groups.length : 1;
  // 禁止承诺按正则查，但要认得否定：「不支持提现」「没法帮你找回原密码」「不会立刻删除」是合规的说法，不是承诺
  // 否定词出现在命中前 10 字内（同一句里，没被句号隔开）就当否定：「没法帮你找回原密码」「不是硬约束的严丝合缝」
  const NEGATION = /(不能|不会|没法|无法|不可|不许|不是|并非|不该|不得|不支持|没有|不|没|无|非|别)/;
  const forbiddenHits = (c.forbidden || []).filter((re) => {
    const r = new RegExp(re, "ig");
    let m;
    while ((m = r.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 10), m.index).split(/[。！？!?；;]/).pop();
      if (!NEGATION.test(before)) return true;
    }
    return false;
  });
  const handoffOk = c.handoff === "either" ? true : Boolean(c.handoff) === r.handoff;
  const dirty = r.sentences.some((s) => /[\[\]]/.test(s.text));
  const tooLong = r.sentences.filter((s) => Array.from(s.text).length > 60).length;
  const okTags = r.sentences.every((s) => s.face && s.action && s.emotion);
  const pass = expectScore >= 0.99 && forbiddenHits.length === 0 && handoffOk && !dirty && !r.error;
  return { expectScore, forbiddenHits, handoffOk, dirty, tooLong, okTags, pass, missing: groups.filter((_, i) => !hits[i]).map((g) => g[0]) };
}

async function judge(c, r, knowledge) {
  // 只在 EVAL_JUDGE=1 且服务端配置可用时跑；用服务端同一套 aiClient（Ark/DeepSeek 都行）
  const { aiComplete } = require("../src/services/aiClient");
  const prompt = [
    "你是客服质检员。下面是知识库节选、用户问题和 AI 客服的回答。只根据知识库判断回答是否事实正确、是否承诺了做不到的事。",
    "输出一个 JSON：{\"score\": 1到5的整数, \"reason\": \"不超过40字\"}。5=完全正确且措辞得当；3=基本对但有遗漏/模糊；1=有事实错误或违规承诺。",
    "【知识库节选】\n" + knowledge.slice(0, 6000),
    "【用户问题】\n" + c.messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
    "【AI 回答】\n" + (r.text || "(空)"),
  ].join("\n\n");
  try {
    const { text } = await aiComplete(prompt);
    const m = /\{[\s\S]*\}/.exec(text);
    const j = JSON.parse(m ? m[0] : text);
    return { score: Number(j.score) || 0, reason: String(j.reason || "") };
  } catch (e) {
    return { score: 0, reason: `judge failed: ${(e && e.message) || e}` };
  }
}

function pct(arr, p) {
  const sorted = arr.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

(async () => {
  const token = await getToken();
  const cases = fixture.cases.filter((c) => !ONLY.length || ONLY.includes(c.id));
  const support = JUDGE ? require("../src/services/support.service") : null;
  const rows = [];
  for (const c of cases) {
    process.stdout.write(`▶ ${c.id} … `);
    try {
      const r = await runCase(c, token);
      const g = grade(c, r);
      const j = JUDGE ? await judge(c, r, support.selectKnowledge(c.messages.filter((m) => m.role === "user").map((m) => m.content).slice(-2).join("\n"))) : null;
      rows.push({ id: c.id, category: c.category, ...r, ...g, judge: j });
      console.log(`${g.pass ? "PASS" : "FAIL"} ttfb=${r.ttfb ? Math.round(r.ttfb) : "-"}ms total=${Math.round(r.total)}ms sent=${r.sentences.length} kw=${g.expectScore.toFixed(2)} forbid=${g.forbiddenHits.length} handoff=${r.handoff}${j ? ` judge=${j.score}` : ""}`);
    } catch (e) {
      rows.push({ id: c.id, category: c.category, error: String((e && e.message) || e), pass: false, sentences: [], forbiddenHits: [], expectScore: 0, handoffOk: false });
      console.log(`ERROR ${(e && e.message) || e}`);
    }
  }

  const passed = rows.filter((r) => r.pass).length;
  const summary = {
    baseUrl: BASE,
    at: new Date().toISOString(),
    cases: rows.length,
    passed,
    passRate: rows.length ? passed / rows.length : 0,
    keywordRecall: rows.length ? rows.reduce((a, r) => a + (r.expectScore || 0), 0) / rows.length : 0,
    forbiddenViolations: rows.reduce((a, r) => a + (r.forbiddenHits ? r.forbiddenHits.length : 0), 0),
    handoffAccuracy: rows.length ? rows.filter((r) => r.handoffOk).length / rows.length : 0,
    ttfbP50: pct(rows.map((r) => r.ttfb), 50),
    ttfbP95: pct(rows.map((r) => r.ttfb), 95),
    totalP50: pct(rows.map((r) => r.total), 50),
    totalP95: pct(rows.map((r) => r.total), 95),
    avgSentences: rows.length ? rows.reduce((a, r) => a + r.sentences.length, 0) / rows.length : 0,
    judgeAvg: JUDGE ? rows.reduce((a, r) => a + ((r.judge && r.judge.score) || 0), 0) / Math.max(1, rows.filter((r) => r.judge).length) : null,
  };

  const md = [
    `# AI 客服评测 ${summary.at}`,
    "",
    `- 服务端：${BASE}`,
    `- 题数 ${summary.cases}，通过 ${summary.passed}（${(summary.passRate * 100).toFixed(0)}%）；关键词召回 ${(summary.keywordRecall * 100).toFixed(0)}%；禁止承诺命中 ${summary.forbiddenViolations} 次；转人工判定正确率 ${(summary.handoffAccuracy * 100).toFixed(0)}%`,
    `- 首句延迟 P50 ${Math.round(summary.ttfbP50 || 0)} ms / P95 ${Math.round(summary.ttfbP95 || 0)} ms；整段 P50 ${Math.round(summary.totalP50 || 0)} ms / P95 ${Math.round(summary.totalP95 || 0)} ms；平均 ${summary.avgSentences.toFixed(1)} 句/答` + (JUDGE ? `；裁判均分 ${summary.judgeAvg.toFixed(2)}/5` : ""),
    "",
    "| 题目 | 结果 | 首句 ms | 整段 ms | 句数 | 关键词 | 违规 | 转人工 | 缺失关键词 |" + (JUDGE ? " 裁判 |" : ""),
    "|---|---|---|---|---|---|---|---|---|" + (JUDGE ? "---|" : ""),
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.pass ? "✅" : "❌"} | ${r.ttfb ? Math.round(r.ttfb) : "-"} | ${r.total ? Math.round(r.total) : "-"} | ${r.sentences.length} | ${((r.expectScore || 0) * 100).toFixed(0)}% | ${(r.forbiddenHits || []).join("; ") || "-"} | ${r.handoff ? "是" : "否"}${r.handoffOk ? "" : " ⚠"} | ${(r.missing || []).join("、") || "-"} |` +
        (JUDGE ? ` ${r.judge ? `${r.judge.score} ${r.judge.reason}` : "-"} |` : ""),
    ),
    "",
    "## 逐题回答",
    "",
    ...rows.map((r) => `### ${r.id}\n\n> ${fixture.cases.find((c) => c.id === r.id).messages.map((m) => `${m.role}: ${m.content}`).join("\n> ")}\n\n${r.error ? `错误：${r.error}` : r.sentences.map((s) => `- [${s.emotion}/${s.face}/${s.action}] ${s.text}`).join("\n")}\n`),
  ].join("\n");

  const outDir = path.join(__dirname, "../eval-out");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = summary.at.replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(outDir, `support-eval-${stamp}.md`), md);
  fs.writeFileSync(path.join(outDir, `support-eval-${stamp}.json`), JSON.stringify({ summary, rows }, null, 2));
  console.log("\n" + md.split("\n").slice(0, 6).join("\n"));
  console.log(`\nwritten to eval-out/support-eval-${stamp}.md`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
