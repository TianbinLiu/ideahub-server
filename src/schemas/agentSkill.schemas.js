// src/schemas/agentSkill.schemas.js
// 「出片技能」的请求校验。客户端对应 app/src/data/agentSkills.ts（跨仓，两边一起动）。
//
// ⚠⚠ `z.object` 默认 strip 未声明字段。给技能加字段时**四处一起加**：
//   这份 schema、models/AgentSkill.js、controller 的 toSkillPayload、app 仓的 api/skills.ts。
//   漏任何一处的表现都是「客户端发了、服务端 201 了、读回来是空的」，全程零报错
//   （方案市场那套的同款教训，见 promptScheme.schemas.js 文件头）。
const { z } = require("../middleware/validate");

/** 技能正文上限。★ 与 app 的视频提示词硬顶（VIDEO_PROMPT_MAX=400）同数：技能本体
 *  就是要发进 agent 输入条的那句话，存得下却发不出的技能是假承诺 */
const SKILL_TEXT_MAX = 400;

/** 客户端 id（app 的 uid("ask") → `ask_xxx`）。字符集收窄同 schemeId：它会进 Mongo 查询 */
const skillId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/, "invalid skill id");

const upsertSkillBody = z.object({
  skillId,
  title: z.string().trim().min(1).max(20),
  intro: z.string().trim().max(120).optional().default(""),
  text: z.string().trim().min(1).max(SKILL_TEXT_MAX),
});

module.exports = { skillId, upsertSkillBody, SKILL_TEXT_MAX };
