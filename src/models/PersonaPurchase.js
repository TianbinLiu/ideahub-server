// src/models/PersonaPurchase.js
// 人格购买记录 —— 一条 = 某用户对某付费人格的【永久解锁】。
//
// 语义：
// - 购买后永久可用：作者后续调价/降价不影响已购用户（price/fee 是成交时的快照，供对账）。
// - 解锁的是【选用权】：绑进自己的情景、装备到插件。收藏（PersonaInstall）不需要购买。
// - 作者本人永远不需要购买记录（gate 处一律先判 owner）。
//
// 并发唯一性由 {user, persona} 唯一索引兜底（与 PersonaInstall 同款思路）：
// 购买流程用「先 claim 记录、失败补偿删除」的顺序，重复/并发购买最终只会有一条记录、只扣一次款。
const mongoose = require("mongoose");

const personaPurchaseSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    persona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", required: true },
    // 成交价与平台抽成快照（点数，整数）。creator 实收 = price - fee。
    price: { type: Number, required: true, min: 0 },
    fee: { type: Number, required: true, min: 0 },
    // 结算标记（评审实锤补的）：null = claim 已建但转账未完成（pending，【不算已购】）；
    // 非 null = 已结算，才是真正的永久解锁凭证。
    // ★所有「已购」判定（equip/绑定/play/payload 的 purchased）必须带 settledAt:{$ne:null}——
    //   否则「claim 已建、转账将失败」的窗口里，并发请求会把 pending 当已购返回假成功。
    settledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

personaPurchaseSchema.index({ user: 1, persona: 1 }, { unique: true });
personaPurchaseSchema.index({ persona: 1 });

module.exports = mongoose.model("PersonaPurchase", personaPurchaseSchema);
