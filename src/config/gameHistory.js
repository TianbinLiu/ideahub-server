// src/config/gameHistory.js
// 「工坊对局」的**历史回合 / 战绩**读取开关（2026-11-24，GET /api/game/rooms/:code/rounds/history）。
//
// 这个端点只读：把一局里每个回合的交片 / 两个计数 / 结算榜，外加一份按人累加的战绩（summary）
// 一次给全 —— App 的「战绩 + 每回合影片回放」不用再拼房间快照。数据本身早就落在房间文档的
// `rounds[]` 里（models/GameRoom 文件头有完整取舍），这里不新增任何存储。
//
// ★★ 为什么单独一个开关，而不是并进 GAME_ROUNDS：
//   · 历史读取是**只读**的，出事时的处置与「回合引擎」不同：回合写入出问题需要关引擎，
//     而那时候恰恰最需要让已经打完的局还能回看；反过来历史端点自己（查询变慢 / 回包过大）要能
//     单独关掉，不必把开回合 / 交片 / 结算一起停掉。
//   · `/api/ark/health` 的 `gameHistory` 也因此是独立一位：读不到 = 老服务端，App 不摆「战绩 / 回放」。
//
// ★ 与 GAME_ROUNDS 的关系（注册顺序见 routes/gameRoom.routes.js）：
//   `/rounds*` 那一层闸在前 —— `GAME_ROUNDS=off` 时历史端点跟着回 503 `GAME_ROUNDS_OFF`
//   （回合引擎整个关掉时，App 也不该再进「对局」里的任何一个屏）；`GAME_ROUNDS` 开着、
//   只有这里 off 时回 503 `GAME_HISTORY_OFF`，其余回合端点照常。
//
// ★ 每次现读环境变量（不在模块加载时定死）：测试要在同一个进程里开关它。
function enabled() {
  return String(process.env.GAME_HISTORY ?? "").trim().toLowerCase() !== "off";
}

module.exports = { enabled };
