/**
 * @file gameTicket.js - 「这一发用券结算」的标记解析（三个出片路由共用，铁律六）
 * @category Middleware
 *
 * ★ 为什么要有中间件而不是让每个路由自己读：
 *   ① 判据只该有一处（`gameTicket.payWithTicketOf`）；② 请求体里的 `payWithTicket` **必须被删掉**，
 *      否则它会跟着 req.body 交给方舟（`withServerTaskFields` 只动几个已知字段）或被 H3 的
 *      zod 严格白名单整句 400（schemas/minimaxV2 的 `unrecognized_keys`）。
 *   ③ 必须排在 resolveDraftFinal **之前**（那个中间件会把整个 body 清空重写）。
 *
 * ★ 不读 `req.body` 之外的任何东西（cookie / 版本号 / IP）：券是"付钱的币种"，必须由客户端**明说**。
 *   推断错一次的代价是「用户以为花了券、其实扣了 token」（或者反过来），两种都不可接受。
 */
const gameTicket = require("../services/gameTicket.service");

function payWithTicket(req, _res, next) {
  // 先判再删：删完就判不出「body 里写了」这件事了
  req.payWithTicket = gameTicket.payWithTicketOf(req);
  const body = req.body;
  if (body && typeof body === "object" && Object.hasOwn(body, "payWithTicket")) delete body.payWithTicket;
  next();
}

module.exports = { payWithTicket };
