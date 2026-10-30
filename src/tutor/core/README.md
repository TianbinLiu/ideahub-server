# `src/tutor/core/` —— 老师人格（tutor）的核心纯函数包（生成物，别手改）

这里的 `.js` 绝大多数是从 **ideahub-tutor 仓** `src/{format,ops,materials,generate,session,export,measure}` 与 `src/cleanCheck.js`
用 esbuild 转成 CommonJS 的（那边是 ESM）；`prompts/*.md` 原样照搬（冻结中文，不进 i18n）。清单与时间戳在 `PORT.json`。

- **改规则只改 tutor 仓**，再在那边跑 `npm run port:server -- <本仓路径>` 同步过来（一条规则一处实现，`AGENTS.md` 铁律六）。
  在这里手改的话下一次同步会被覆盖，而且两边从此分叉。
- **手写、不由同步生成的四份**（同路径、同导出名，port 脚本不覆盖它们）：
  | 文件 | 为什么手写 |
  |---|---|
  | `ai/client.js` | tutor 仓那份自己发 HTTP；这里是 **server `services/aiClient.js` 的适配层**（同一个 AI 出口、同一份超时与模型选择），只把回包翻成 `chat` / `chatStream` 的形状并吐用量记录 |
  | `ai/prompts.js` | `import.meta.url` 在 CJS 里没有，改用 `__dirname` 找 `prompts/` |
  | `ops/revision.js` | 修订记录从 `.tutor/revisions.jsonl` 换成 `TutorRevision` 表：第一个参数由文件路径换成 `store`（`{ read, append, write }`），三个 IO 函数变 async |
  | `materials/index.js` | 只导出纯函数（切块 / 块 hash / 找短引 / 锚点 / PPTX XML）；本地文件系统那一套（`extract` / `hash` / `manifest`）服务端没有 —— 教材在浏览器里抽文本（docs/05 §4.2） |
- 上层（`services/tutor*.service.js`、`routes/tutor.routes.js`、`workers/tutor.worker.js`）与 tutor 仓 `src/server/devServer.mjs` 的参考实现一一对应，
  数据从课程工作区（文件）换成 `Tutor*` 表；端点契约见 `docs/api-contract.md`「老师人格（tutor）」一节。
- 依赖：`zod`（本仓已有）、`js-yaml`、`jszip`（为此加进 package.json）。
