# prompts/ —— 冻结中文的提示词

2026-09-26 起「生成人格」是三步三份提示词（分块多轮，docs/02 2.4 / docs/05 §4.5）：`stages.md` → `stage.md`（逐阶段）→ `generate.md`；没配模型时 `src/generate/demo.js` 给确定性产物（界面标 demo）。

进模型的文本**不进 i18n 目录**（App CLAUDE.md「界面文案走 Lingui」那条的冻结规则）：这些是被解析的输入，措辞一改，输出形状就变。

| 文件 | 用在哪 | 输出 |
|---|---|---|
| `scan.md` | `scan`：新教材文本 → 提议新阶段 | 严格 JSON `{ "ops": [ map.stage.propose … ] }` |
| `distill.md` | `distill`：一段一问一答 → typed ops | 严格 JSON `{ "ops": [ … ] }`，op 目录由 `src/ops/catalog.js` 生成插入 |
| `stages.md` | 生成 / 扫描的第一步：章节提纲 → 阶段提议（每份教材一笔 `tutor_extract`，`src/generate/pipeline.js`） | 严格 JSON `{ "stages": [ { week, title, summary, sections[] } ] }` |
| `stage.md` | 生成的第二步：一个阶段覆盖的章节文本 → ④（讲法 / 讲解步带逐字短引 / 必背 / 自检题 / 易错点；每阶段一笔） | 严格 JSON，锚点由代码按短引查找 |
| `generate.md` | 生成的第三步：问卷 + 提纲 → ① 人格卡 + ⑥ 复刻指南（硬规则由代码从政策派生，模型只补 `extra_rules`） | 严格 JSON `{ "card": {…}, "guide": {…} }`，字段名 = `docs/03` |
| `teach.md` | M1 教学会话的 system prompt 模板（① + ② + 当前阶段 ③④ + 最近 N 轮） | 自然语言 |

占位符 `{{name}}` 由 `src/ai/prompts.js` 插值；`{{op_catalog_distill}}` / `{{op_catalog_scan}}` 是代码生成的 op 目录。
改任何一份都要重跑 `npm test`（`tests/prompts.test.mjs` 钉着占位符齐全与「输出只许 JSON」这两句）。
