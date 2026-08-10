/**
 * 「大 JSON body 只对持有效签名 token 的请求开放」的闸门。
 *
 * 两条路由需要它，规则必须只有一份（改了阈值/判据要两边同时生效）：
 *   /api/branch —— 发布体里带 dataURL 首尾帧（MB 级）
 *   /api/ark    —— Seedance 任务创建请求带 base64 首尾帧（压到 720p 后仍有 2-3MB）
 *
 * ★ 为什么要闸门：body 解析发生在路由鉴权【之前】。直接给全局放宽，等于
 *   "任何匿名者 POST 过来都能让服务端缓冲并解析 50MB" —— 几个并发就把进程内存打爆。
 *   这里先做一次纯签名校验（jwt.verify，不查库，微秒级）：验不过的走 1mb 常规上限，
 *   验得过的才放宽。真正的鉴权仍由路由的 requireAuth 负责（它还要查 tokenVersion /
 *   deactivatedAt），此处只管"值不值得为你分配内存"。
 */
const express = require("express");
const jwt = require("jsonwebtoken");

const bigJson = express.json({ limit: process.env.BRANCH_JSON_LIMIT || "50mb" });
const smallJson = express.json({ limit: "1mb" });

/** 挂在需要大 body 的前缀上，必须排在全局 express.json() 之前
 *  （body-parser 解析过一次就不会重复解析，排在后面等于没挂）。 */
function jsonGate(req, res, next) {
  const [type, token] = String(req.headers.authorization || "").split(" ");
  if (type === "Bearer" && token) {
    try {
      jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
      return bigJson(req, res, next);
    } catch {
      /* 签名无效：按匿名处理，走小上限 */
    }
  }
  return smallJson(req, res, next);
}

module.exports = { jsonGate };
