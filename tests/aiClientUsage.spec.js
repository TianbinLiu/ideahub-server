/**
 * aiClient 的 token 用量：各家 usage 字段收成一个形状；流式请求带 stream_options.include_usage，
 * 不认这个字段的端点（400）去掉它重发，与 max_tokens → max_completion_tokens 的换名可以叠加。
 * openai SDK 用 jest.mock 换掉 —— 测的是我们发了什么、怎么退让，不是网络。
 */
const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));

const { aiChatStream, aiComplete, normalizeUsage } = require('../src/services/aiClient');

function streamOf(chunks) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

async function drain(gen) {
  const out = [];
  for await (const d of gen) out.push(d);
  return out;
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.AI_API_KEY = 'test-key';
  delete process.env.AI_EXTRA_BODY;
});

describe('normalizeUsage', () => {
  it('DeepSeek：prompt_cache_hit_tokens / prompt_cache_miss_tokens', () => {
    expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }, 'deepseek-v4-flash')).toEqual({
      model: 'deepseek-v4-flash',
      promptTokens: 100,
      completionTokens: 20,
      cacheHitTokens: 60,
      cacheMissTokens: 40,
      reasoningTokens: 0,
    });
  });

  it('OpenAI 形状：cached_tokens / reasoning_tokens；未命中 = prompt − 命中', () => {
    expect(
      normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 } }, 'm'),
    ).toMatchObject({ cacheHitTokens: 30, cacheMissTokens: 70, reasoningTokens: 5 });
  });

  it('没有 usage → null（不是 0）', () => {
    expect(normalizeUsage(undefined, 'm')).toBeNull();
  });
});

describe('aiChatStream 用量', () => {
  it('请求带 stream_options.include_usage；末尾只带 usage 的块交给 onUsage，一次', async () => {
    mockCreate.mockResolvedValueOnce(
      streamOf([
        { choices: [{ delta: { content: '你好' } }] },
        { choices: [{ delta: { content: '呀' } }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 3 }, model: 'up-model' },
      ]),
    );
    const onUsage = jest.fn();
    const out = await drain(aiChatStream([{ role: 'user', content: 'hi' }], { onUsage, maxTokens: 100 }));
    expect(out).toEqual(['你好', '呀']);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 100 });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0]).toMatchObject({ model: 'up-model', promptTokens: 50, completionTokens: 3 });
  });

  it('端点不认 stream_options（400）→ 去掉它重发；拿不到用量就不回调', async () => {
    mockCreate.mockRejectedValueOnce(badRequest('Unrecognized request argument supplied: stream_options'));
    mockCreate.mockResolvedValueOnce(streamOf([{ choices: [{ delta: { content: 'ok' } }] }]));
    const onUsage = jest.fn();
    expect(await drain(aiChatStream([], { onUsage }))).toEqual(['ok']);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0].stream_options).toBeUndefined();
    expect(mockCreate.mock.calls[1][0].max_tokens).toBeDefined();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('两种退让可以叠加：先去 stream_options，再换 max_completion_tokens；最多发三次', async () => {
    mockCreate.mockRejectedValueOnce(badRequest('stream_options is not supported'));
    mockCreate.mockRejectedValueOnce(badRequest("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."));
    mockCreate.mockResolvedValueOnce(streamOf([{ choices: [{ delta: { content: 'ok' } }] }]));
    await drain(aiChatStream([], { maxTokens: 77 }));
    const third = mockCreate.mock.calls[2][0];
    expect(third.stream_options).toBeUndefined();
    expect(third.max_tokens).toBeUndefined();
    expect(third.max_completion_tokens).toBe(77);
  });

  it('别的 400 照原样抛出，不重试', async () => {
    mockCreate.mockRejectedValueOnce(badRequest('context length exceeded'));
    await expect(drain(aiChatStream([]))).rejects.toThrow('context length exceeded');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe('aiComplete 用量', () => {
  it('返回 { text, model, usage }；maxTokens 覆盖默认', async () => {
    mockCreate.mockResolvedValueOnce({ model: 'm2', choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 9, completion_tokens: 1 } });
    const r = await aiComplete('p', { maxTokens: 1500 });
    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(1500);
    expect(r.text).toBe('{}');
    expect(r.usage).toMatchObject({ model: 'm2', promptTokens: 9, completionTokens: 1 });
  });
});
