/**
 * @file aiClient.js - 统一的 AI 出口（provider-agnostic 抽象层）
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节
 *
 * 职责:
 * - 收敛全站 AI 调用：所有 service 只经由本文件访问大模型，不再各自 new OpenAI(...)。
 * - 把 provider 配置抽出来由 env 驱动：换厂商只需改环境变量，不动代码。
 *
 * ── 为什么用 chat.completions 而不是 responses ──────────────────────────
 * 本项目原先调用的 `client.responses.create({ model, input })` + `resp.output_text`
 * 是 OpenAI 专有的 Responses API。国内厂商（DeepSeek / 通义千问 / 豆包 / 智谱）所谓的
 * 「OpenAI 兼容」接口，只实现了 /v1/chat/completions，并没有 /v1/responses —— 直接把
 * baseURL 指过去会 404。因此这里统一改用 chat.completions，这是各家兼容端点的最大公约数。
 *
 * 仍然复用 `openai` SDK：它本质上就是个带鉴权的 HTTP 客户端，把 baseURL 指向兼容端点即可，
 * 无需为每家厂商引入新依赖。
 *
 * ── 环境变量与 OPENAI_* 的向后兼容 ──────────────────────────────────────
 * @env {AI_BASE_URL} - 兼容端点地址。留空 = 用 SDK 默认（OpenAI 官方 https://api.openai.com/v1）。
 * @env {AI_API_KEY}  - 该 provider 的 API Key。
 * @env {AI_MODEL}    - 模型名；留空则用各调用点自带的 fallbackModel。
 *
 * 解析顺序一律为 AI_* → OPENAI_* → 默认值。即：新部署用 AI_*；老部署只配了 OPENAI_API_KEY /
 * OPENAI_MODEL 也能原样继续跑，无需改 .env（向后兼容）。两者都配时 AI_* 优先。
 *
 * ⚠️ 安全：API Key 绝不允许出现在日志、错误信息或返回值里。本文件只把 key 交给 SDK。
 *
 * 导出方法:
 * @exports hasAiKey - 是否已配置 key；供各 service 决定「抛 501」还是「回退启发式」。
 * @exports aiComplete - 发一个 prompt，拿回 { text, model }。
 * @exports resolveModel - 解析模型名（env 优先，否则用传入的 fallback）。
 *
 * 外部依赖:
 * @external {openai} - 仅作为兼容端点的 HTTP 客户端使用（chat.completions）。
 *
 * 被使用于:
 * @used_in {services/aiReview.service.js} - 创意点评 / 反馈校验 / 草稿生成
 * @used_in {services/arenaSuggest.service.js} - 卢本伟广场发言方案
 * @used_in {services/scenarioAi.service.js} - 情景模拟种子评论 / AI 对线
 * @used_in {services/workshopAi.service.js} - 工坊改版 / 全站改版草案
 * @used_in {services/speakingStyleAi.service.js} - 发言风格面板
 * @used_in {services/standpointAi.service.js} - 立场展开自动应答
 */

const OpenAI = require("openai");

function resolveKey() {
  return process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
}

// 空字符串 = 不传 baseURL，交给 SDK 用官方默认值
function resolveBaseUrl() {
  return process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "";
}

function resolveModel(fallback) {
  return process.env.AI_MODEL || process.env.OPENAI_MODEL || fallback;
}

function hasAiKey() {
  return !!resolveKey();
}

function getClient() {
  const baseURL = resolveBaseUrl();
  return new OpenAI({
    apiKey: resolveKey(),
    ...(baseURL ? { baseURL } : {}),
  });
}

/**
 * 发一个 prompt，取回文本。
 *
 * ⚠️ 这里【不吞异常】：网络错误 / 鉴权失败 / 限流都会原样抛给调用方。
 * 因为 6 个 service 的兜底语义并不相同 —— aiReview / arenaSuggest / scenarioAi /
 * workshopAi 需要把错误冒泡成 501，而 speakingStyleAi / standpointAi 必须回退本地启发式
 * 且绝不抛 501。若在此处 catch 掉，就把这个差异抹平了。
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.fallbackModel] - env 未指定 AI_MODEL/OPENAI_MODEL 时使用的模型名
 * @returns {Promise<{ text: string, model: string }>}
 */
async function aiComplete(prompt, opts = {}) {
  const model = resolveModel(opts.fallbackModel || "gpt-5.2");

  const resp = await getClient().chat.completions.create({
    model,
    messages: [{ role: "user", content: String(prompt || "") }],
  });

  const text =
    (resp &&
      resp.choices &&
      resp.choices[0] &&
      resp.choices[0].message &&
      resp.choices[0].message.content) ||
    "";

  return { text, model };
}

module.exports = { hasAiKey, aiComplete, resolveModel };
