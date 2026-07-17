// src/config/points.js
// 虚拟点数系统的共享常量。
//
// ★这是【虚拟点数】，不是真钱：不接任何真实支付/提现/兑换，没有现金价值。
//
// 为什么单独一个文件：SIGNUP_GRANT_POINTS 同时被 User schema 的 default 和
// points.service 的 signup 分录金额引用。若两边各写一个字面量 1000，哪天改了其中一个，
// 「余额」和「账本」就会从注册第一天起对不上，而且不会报任何错。
// 放在这个叶子模块里（不 require 任何 model/service）也避免 User <-> points.service 的循环依赖。
const SIGNUP_GRANT_POINTS = 1000;

module.exports = { SIGNUP_GRANT_POINTS };
