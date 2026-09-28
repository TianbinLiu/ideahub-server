"use strict";
/**
 * 老师人格（tutor）与客服 / 陪聊人格在 /api/personas 列表里的缺省隔离 —— 唯一实现（tutor 仓 docs/04 §5 S4、docs/06 D2）。
 *
 * ★ 为什么缺省要滤掉：老 App（≤ 2.48）的 SupportPersonasPage.applyPersona 会把列表里**任何一条** PUT /api/companion/settings
 *   装成客服人格，漏了零报错 —— 老师人格进了市场（M2）之后，不滤等于让老用户把一位「计算机网络老师」装成看板娘。
 * ★ 判否定：存量文档没有 kind 字段，`kind: { $ne: "tutor" }` 对它们恒真；别写成 `kind: "companion"`（那会把存量整批判成"不是"）。
 * ★ ?kind=tutor 只要老师人格（M2 市场页用）；其它任何值一律按缺省 —— 失败方向是"看不到老师"，不是"把老师装成客服"。
 */
const TUTOR_KIND = "tutor";

function personaKindFilter(kindParam) {
  return String(kindParam || "") === TUTOR_KIND ? { kind: TUTOR_KIND } : { kind: { $ne: TUTOR_KIND } };
}

module.exports = { TUTOR_KIND, personaKindFilter };
