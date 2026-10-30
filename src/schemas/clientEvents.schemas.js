// src/schemas/clientEvents.schemas.js
// App 自报的客户端事件（POST /api/client-events）的请求校验。形状与 app 仓那一侧逐字一致（契约 docs/api-contract.md「客户端事件」）。
// ★ 四个字段全是**给日志看的字符串**，所以每个都有上限、能限字符集的都限了（where / name 只许路径与标识符那几种字符）：
//   这个端点免登录、谁都能打，放进来的每个字节都会原样进 pm2 日志。version 的形状由 App 定（`2.63+75` / `2.63-debug+75`），
//   这里只限长，日志那一侧再把控制字符剥掉（routes/clientEvents.routes.js 的 logSafe）—— 别让一个 `\n` 伪造出第二行日志。
// ★ 多余的键按 zod 缺省剥掉、不报错：App 哪天多带一个字段，老服务端照收，别让它 400。
const { z } = require("../middleware/validate");

/** 事件种类：白屏（渲染抛错）/ 没接住的 Promise / 应用内更新失败 / IndexedDB 丢数据 / 开机被本机库拦住 */
const CLIENT_EVENT_KINDS = ["render-error", "unhandled-rejection", "update-failed", "idb-dataloss", "boot-blocked"];

const clientEventBody = z.object({
  kind: z.enum(CLIENT_EVENT_KINDS),
  version: z.string().min(1).max(40),
  where: z.string().min(1).max(64).regex(/^[A-Za-z0-9/_.:-]+$/).optional(),
  name: z.string().min(1).max(40).regex(/^[A-Za-z0-9_.-]+$/).optional(),
});

module.exports = { clientEventBody, CLIENT_EVENT_KINDS };
