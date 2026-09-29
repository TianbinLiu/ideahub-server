"use strict";
/**
 * 老师人格（tutor）与客服 / 陪聊人格在 /api/personas 列表里的缺省隔离 —— 唯一实现（tutor 仓 docs/04 §5 S4、docs/06 D2）。
 *
 * ★ 为什么缺省要滤掉：老 App（≤ 2.48）的 SupportPersonasPage.applyPersona 会把列表里**任何一条** PUT /api/companion/settings
 *   装成客服人格，漏了零报错 —— 老师人格进了市场（M2）之后，不滤等于让老用户把一位「计算机网络老师」装成看板娘。
 * ★ 判否定：存量文档没有 kind 字段，`kind: { $ne: "tutor" }` 对它们恒真；别写成 `kind: "companion"`（那会把存量整批判成"不是"）。
 * ★ ?kind=tutor 只要老师人格（M2 市场页用）；其它任何值一律按缺省 —— 失败方向是"看不到老师"，不是"把老师装成客服"。
 * ★ 2026-09-29 M3 反向勾选（tutor 仓 docs/06 §5.1）：缺省列表放行**作者勾了「同时发布为启梦人格」**的老师（`companion.enabled === true`，判否定：
 *   没这一格 = 没勾）—— 那正是"可装进看板娘"的定义；没勾的照旧不列。选用那道门在 personaAccess.service（同一条规则的另一半：列表看得见 ⇔ 能装）。
 */
const TUTOR_KIND = "tutor";

function personaKindFilter(kindParam) {
  if (String(kindParam || "") === TUTOR_KIND) return { kind: TUTOR_KIND };
  // 缺省 = 不是老师，或者是勾了「同时发布为启梦人格」的老师。写成**单个 $nor 键**而不是 $or：persona.controller 把它 Object.assign 进 filter，
  // scope=installed 时 filter 已经有 $or、搜索分支又会重写 $and —— 再给一个 $or / $and 会把它们盖掉，零报错、结果是漏过滤或漏搜索
  return { $nor: [{ kind: TUTOR_KIND, "companion.enabled": { $ne: true } }] };
}

module.exports = { TUTOR_KIND, personaKindFilter };
