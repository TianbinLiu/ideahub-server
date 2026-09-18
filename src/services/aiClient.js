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
 * @exports aiComplete - 发一个 prompt，拿回 { text, model, usage }。
 * @exports aiChatStream - 流式对话（async generator），供 SSE 端点逐句转发；opts.onUsage 拿本次 token 用量。
 * @exports normalizeUsage - 把各家 usage 字段收成一个形状（供 chatMemory 计量上下文）。
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
 * @used_in {routes/companion.routes.js} - 首页看板娘数字人的流式对话
 * @used_in {services/chatMemory.service.js} - 对话记忆的自动提纯（aiComplete）
 */

const OpenAI = require("openai");

function resolveKey() {
  return process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
}

// 空字符串 = 不传 baseURL，交给 SDK 用官方默认值
function resolveBaseUrl() {
  return process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "";
}

/**
 * 额外请求字段（JSON），原样并进每次 chat.completions 请求。
 * 用途：按供应商开关特性，例如方舟豆包 2.0 关思维链 `{"thinking":{"type":"disabled"}}`（客服要首句快），
 * 或 DeepSeek 的 `{"response_format":...}`。配错 JSON 直接启动即报，不静默忽略。
 */
function extraBody() {
  const raw = process.env.AI_EXTRA_BODY;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    throw new Error(`AI_EXTRA_BODY is not valid JSON: ${e.message}`);
  }
}

function resolveModel(fallback) {
  return process.env.AI_MODEL || process.env.OPENAI_MODEL || fallback;
}

function hasAiKey() {
  return !!resolveKey();
}

/**
 * 把接口返回的 usage 收成一个形状。各家字段名不一样：
 *   · DeepSeek：prompt_cache_hit_tokens / prompt_cache_miss_tokens（缓存命中按约 1/10 计费）；
 *   · OpenAI 及多数兼容端点：prompt_tokens_details.cached_tokens、completion_tokens_details.reasoning_tokens。
 * 没有 usage（有的兼容端点流式不给）→ null，调用方按「没拿到」处理，不当成 0。
 * @returns {{model: string, promptTokens: number, completionTokens: number, cacheHitTokens: number, cacheMissTokens: number, reasoningTokens: number} | null}
 */
function normalizeUsage(usage, model) {
  if (!usage || typeof usage !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const promptTokens = num(usage.prompt_tokens);
  const details = usage.prompt_tokens_details || {};
  const cacheHitTokens = num(usage.prompt_cache_hit_tokens) || num(details.cached_tokens);
  const cacheMissTokens = num(usage.prompt_cache_miss_tokens) || Math.max(0, promptTokens - cacheHitTokens);
  return {
    model: String(model || ""),
    promptTokens,
    completionTokens: num(usage.completion_tokens),
    cacheHitTokens,
    cacheMissTokens,
    reasoningTokens: num(usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens),
  };
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
 * @param {number} [opts.maxTokens] - 覆盖 AI_MAX_TOKENS
 * @returns {Promise<{ text: string, model: string, usage: object|null }>}
 */
async function aiComplete(prompt, opts = {}) {
  const model = resolveModel(opts.fallbackModel || "gpt-5.2");

  // ★ timeout / max_tokens 是必须的，不是可选优化：
  //   - 没有 timeout：上游挂起时这条请求会一直占着 Node 的连接与内存，
  //     几十个并发就能把服务拖垮（我们这边先崩，上游还没回）。
  //   - 没有 max_tokens：单次响应长度无上限，成本不可预测，
  //     且超长输出会连带把下游的解析/存储撑爆。
  const resp = await getClient().chat.completions.create(
    {
      model,
      messages: [{ role: "user", content: String(prompt || "") }],
      max_tokens: Number(opts.maxTokens || process.env.AI_MAX_TOKENS || 2048),
      ...extraBody(),
    },
    { timeout: Number(process.env.AI_TIMEOUT_MS || 60_000) },
  );

  const text =
    (resp &&
      resp.choices &&
      resp.choices[0] &&
      resp.choices[0].message &&
      resp.choices[0].message.content) ||
    "";

  return { text, model, usage: normalizeUsage(resp && resp.usage, (resp && resp.model) || model) };
}

/**
 * 流式对话：以 async generator 逐段吐出增量文本（chat.completions 的 delta.content）。
 *
 * ★ 与 aiComplete 一样【不吞异常】，且同样只经由本文件拿 provider 配置（铁律六：一条规则一处实现）。
 * ★ 为什么要处理 max_tokens/max_completion_tokens 两个名字：OpenAI 的 gpt-5 系列已经拒收
 *   `max_tokens`（400 "Unsupported parameter"），而国内兼容端点（DeepSeek 等）只认 `max_tokens`。
 *   先按兼容端点的写法发，撞到那条 400 再换名重发一次，两边都能跑，不用按 provider 写分支。
 * ★ signal：调用方（SSE 路由）在客户端断开时 abort，否则上游会把整段话生成完、token 照扣。
 * ★ usage：流式默认不给用量，要带 stream_options.include_usage —— 最后多来一个 choices 为空、只带 usage 的块
 *   （OpenAI 与 DeepSeek 都是这个约定）。有的兼容端点不认这个字段、回 400，就去掉它再发一次（和上面换名同一个套路），
 *   这时拿不到用量，onUsage 不会被调用。中途被 abort 时最后那块也收不到 —— 调用方要能处理「没拿到用量」。
 *
 * @param {Array<{role: string, content: string}>} messages - 含 system 的完整消息列表
 * @param {object} [opts]
 * @param {string} [opts.fallbackModel]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {(usage: object) => void} [opts.onUsage] - 拿到本次用量时回调一次（形状见 normalizeUsage）
 * @returns {AsyncGenerator<string>}
 */
async function* aiChatStream(messages, opts = {}) {
  const model = resolveModel(opts.fallbackModel || "gpt-5.2");
  const maxTokens = Number(opts.maxTokens || process.env.AI_MAX_TOKENS || 1024);
  const timeout = Number(process.env.AI_TIMEOUT_MS || 60_000);
  const base = {
    model,
    messages,
    stream: true,
    ...extraBody(),
    ...(typeof opts.temperature === "number" ? { temperature: opts.temperature } : {}),
  };
  const reqOpts = { timeout, ...(opts.signal ? { signal: opts.signal } : {}) };
  const client = getClient();

  // 两个可退让的字段：不认 stream_options 的端点去掉它，不认 max_tokens 的端点换成 max_completion_tokens。
  // 每个字段最多退让一次，最多发三次。
  let body = { ...base, stream_options: { include_usage: true }, max_tokens: maxTokens };
  let stream;
  for (let attempt = 0; ; attempt++) {
    try {
      stream = await client.chat.completions.create(body, reqOpts);
      break;
    } catch (e) {
      const msg = String((e && e.message) || "");
      if (attempt < 2 && e && e.status === 400 && body.stream_options && /stream_options|include_usage/.test(msg)) {
        const { stream_options: _drop, ...rest } = body;
        body = rest;
      } else if (attempt < 2 && e && e.status === 400 && "max_tokens" in body && /max_completion_tokens/.test(msg)) {
        const { max_tokens: _drop, ...rest } = body;
        body = { ...rest, max_completion_tokens: maxTokens };
      } else {
        throw e;
      }
    }
  }

  let usageSent = false;
  for await (const chunk of stream) {
    const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
    if (delta) yield delta;
    if (!usageSent && chunk && chunk.usage && typeof opts.onUsage === "function") {
      const usage = normalizeUsage(chunk.usage, chunk.model || model);
      if (usage) {
        usageSent = true;
        opts.onUsage(usage);
      }
    }
  }
}

module.exports = { hasAiKey, aiComplete, aiChatStream, resolveModel, normalizeUsage };
