/**
 * 自伤危机协议：检测口径、求助资源、匿名计数，以及两条聊天链路上的输入拦截、输出拦截、AI 告知与同意闸门。
 * 用例出自方案文档 §8.5；法条依据见 services/chatSafety.service.js 文件头。
 * 上游 LLM 用 jest.mock 换成可控脚本 —— 测的是协议本身，不是模型。
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const mockAi = { chunks: [], usage: null, calls: [], completions: [], prompts: [] };

jest.mock('../src/services/aiClient', () => {
  const actual = jest.requireActual('../src/services/aiClient');
  return {
    ...actual,
    hasAiKey: () => true,
    aiChatStream: async function* (messages, opts = {}) {
      mockAi.calls.push(messages);
      for (const c of mockAi.chunks) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (opts.signal && opts.signal.aborted) throw new Error('aborted');
        yield c;
      }
      if (mockAi.usage && typeof opts.onUsage === 'function') opts.onUsage(mockAi.usage);
    },
    aiComplete: async (prompt) => {
      mockAi.prompts.push(prompt);
      return { text: mockAi.completions.length ? mockAi.completions.shift() : '', model: 'mock', usage: null };
    },
  };
});

let mongod;
let app;
let safety;
let chatMemory;
let ChatMessage;
let ChatThread;
let ChatMemory;
let SafetyReferralStat;
let CompanionSetting;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
  safety = require('../src/services/chatSafety.service');
  chatMemory = require('../src/services/chatMemory.service');
  ChatMessage = require('../src/models/ChatMessage');
  ChatThread = require('../src/models/ChatThread');
  ChatMemory = require('../src/models/ChatMemory');
  SafetyReferralStat = require('../src/models/SafetyReferralStat');
  CompanionSetting = require('../src/models/CompanionSetting');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await SafetyReferralStat.syncIndexes();
  mockAi.chunks = ['[happy][face:happy][action:wave] 你好呀～ ', '[neutral][face:normal][action:explain]今天想聊点什么？'];
  mockAi.usage = { model: 'mock', promptTokens: 100, completionTokens: 20, cacheHitTokens: 0, cacheMissTokens: 100, reasoningTokens: 0 };
  mockAi.calls = [];
  mockAi.completions = [];
  mockAi.prompts = [];
  delete process.env.COMPANION_REQUIRE_CONSENT;
});

async function createUser() {
  const User = require('../src/models/User');
  const { signToken } = require('../src/utils/jwt');
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `sf_${random}`, email: `${random}@test.local`, role: 'user', passwordHash: 'hashed' });
  return { user, token: signToken(user) };
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => ({ event: /event: (\w+)/.exec(b)[1], data: JSON.parse(/data: (.*)/.exec(b)[1]) }));
}

function chat(token, body, headers = {}) {
  const req = request(app).post('/api/companion/chat').set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req
    .send(body)
    .buffer(true)
    .parse((res, cb) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => cb(null, data));
    });
}

describe('检测口径（方案 §8.5）', () => {
  it('这些输入必须命中', () => {
    for (const t of [
      '我想死',
      '不想活了',
      '活着好累',
      '割腕',
      '想 自 杀',
      '我想死。',
      '自殺',
      '一觉不醒就好了',
      'I want to kill myself',
      'kms',
      'I don’t want to be alive',
      'thinking about overdosing',
    ]) {
      expect([t, safety.detectSelfHarm(t).hit]).toEqual([t, true]);
    }
  });

  it('这些输入不能命中（日常说法、骂人、片名式表达）', () => {
    for (const t of ['我想死你了', '笑死我了', '累死了', '手机死机了', '你去死吧', 'this game is killing me', "I'm dying to see it"]) {
      expect([t, safety.detectSelfHarm(t).hit]).toEqual([t, false]);
    }
  });

  it('输出侧要拦的：鼓动、教方法、骂人去死', () => {
    for (const t of ['你应该去死', '去死吧', 'how to kill yourself', 'lethal dose', '吃一整瓶安眠药']) {
      expect([t, safety.detectHarmfulOutput(t).hit]).toEqual([t, true]);
    }
    expect(safety.detectHarmfulOutput('[sad][face:sad][action:comfort] 听起来你今天很累。').hit).toBe(false);
  });

  it('热线按地区给：美国 988、大陆 12356+120、其它 findahelpline+988', () => {
    expect(safety.crisisResources({ country: 'US' }).resources.map((r) => r.tel || r.url)).toEqual(['988', 'https://chat.988lifeline.org/', '911']);
    expect(safety.crisisResources({ country: 'CN' }).resources.map((r) => r.tel)).toEqual(['12356', '120']);
    const de = safety.crisisResources({ country: 'DE' }).resources.map((r) => r.tel || r.url);
    expect(de[0]).toBe('https://findahelpline.com/');
    expect(de).toContain('988');
  });
});

describe('输入命中：不调模型、发求助卡、匿名计数', () => {
  it('0 token、卡片进历史、计数 +1，而且计数里没有任何用户标识', async () => {
    const { token } = await createUser();
    const res = await chat(token, { message: '我不想活了', caps: ['safety', 'notice'] }, { 'CF-IPCountry': 'US' });
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(['thread', 'notice', 'safety', 'done']);
    expect(mockAi.calls).toHaveLength(0); // 没调模型

    const card = events.find((e) => e.event === 'safety').data;
    expect(card).toMatchObject({ kind: 'crisis', trigger: 'input', region: 'US', policyUrl: '/safety/ai-chat' });
    expect(card.resources.some((r) => r.tel === '988')).toBe(true);

    const done = events.find((e) => e.event === 'done').data;
    expect(done).toMatchObject({ text: '', safety: true });
    const msgs = await ChatMessage.find({ thread: done.threadId }).sort({ seq: 1 }).lean();
    expect(msgs.map((m) => m.kind)).toEqual(['msg', 'safety']);
    expect(msgs[1].displayText).toContain('988');

    const stats = await SafetyReferralStat.find().lean();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ scene: 'companion', trigger: 'input', region: 'US', count: 1 });
    // §22603：报告里不得含用户标识 —— 这张表永远不能出现这些字段
    for (const k of ['user', 'thread', 'ip', 'text', 'userId', 'message']) expect(stats[0][k]).toBeUndefined();
  });

  it('危机那句不会变成会话标题', async () => {
    const { token } = await createUser();
    const events = parseSse((await chat(token, { message: '我不想活了', caps: ['safety'] })).body);
    const threadId = events[0].data.threadId;
    expect(events[0].data.title).toBe(''); // 发给前端的 thread 事件也不能带着这句标题
    expect((await ChatThread.findById(threadId).lean()).title).toBe('');
    // 下一句正常消息重新命名
    await chat(token, { message: '聊点别的', threadId, caps: ['safety'] });
    expect((await ChatThread.findById(threadId).lean()).title).toBe('聊点别的');
  });

  it('老客户端（没声明 caps）收到的是一句 sentence，照样看得到热线', async () => {
    const { token } = await createUser();
    const events = parseSse((await chat(token, { message: '我想自杀' }, { 'CF-IPCountry': 'CN' })).body);
    expect(events.some((e) => e.event === 'safety')).toBe(false);
    const sentence = events.find((e) => e.event === 'sentence');
    expect(sentence.data.text).toContain('12356');
    expect(mockAi.calls).toHaveLength(0);
  });

  it('命中之后照样能继续聊（不锁死会话）', async () => {
    const { token } = await createUser();
    const first = parseSse((await chat(token, { message: '我想死', caps: ['safety'] })).body);
    const threadId = first[0].data.threadId;
    const second = parseSse((await chat(token, { message: '我们聊点别的吧', threadId, caps: ['safety'] })).body);
    expect(second.some((e) => e.event === 'sentence')).toBe(true);
    expect(mockAi.calls).toHaveLength(1);
  });
});

describe('闸门不能只装在一条链路上（自审补的）', () => {
  // 条文管的是「我们这套服务」，不是「客户端挑了哪种请求体」。旧写法与人格试聊此前一道闸都没有。
  it('旧写法 {messages[]}：输入命中就不调模型，照样给求助卡并计一次数', async () => {
    const { token } = await createUser();
    const res = await chat(token, { messages: [{ role: 'user', content: '我想自杀' }], caps: ['safety'] });
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(['safety', 'done']);
    expect(mockAi.calls).toHaveLength(0);
    expect(events[0].data.trigger).toBe('input');
    const stats = await SafetyReferralStat.find().lean();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ scene: 'companion', trigger: 'input', count: 1 });
  });

  it('旧写法 {messages[]}：模型说了该拦的话，照样拦下并 abort', async () => {
    const { token } = await createUser();
    mockAi.chunks = ['[neutral][face:normal][action:none] 你还好吗？ ', '[sad][face:sad][action:none] 你不如去死吧。', '[neutral][face:normal][action:none] 再见。'];
    const events = parseSse((await chat(token, { messages: [{ role: 'user', content: '今天好累' }], caps: ['safety'] })).body);
    const kinds = events.map((e) => e.event);
    // 旧写法这条链路服务端不存历史、没有 lastDisclosureAt 可依据 ⇒ 每轮都先告知一次
    expect(kinds).toEqual(['notice', 'sentence', 'safety', 'done']);
    expect(events.find((e) => e.event === 'sentence').data.text).toBe('你还好吗？');
    expect(JSON.stringify(events)).not.toContain('去死');
    expect((await SafetyReferralStat.find().lean())[0]).toMatchObject({ trigger: 'output', scene: 'companion' });
  });

  it('人格试聊：输入命中不调模型；模型输出违规也拦得下来', async () => {
    const { token } = await createUser();
    const draft = { name: '小测', description: '测试用', style: { summary: '温柔' } };
    const preview = (body) =>
      request(app)
        .post('/api/personas/preview-chat')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .buffer(true)
        .parse((res, cb) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => cb(null, data));
        });

    const hit = parseSse((await preview({ draft, messages: [{ role: 'user', content: '我不想活了' }], caps: ['safety'] })).body);
    expect(hit.map((e) => e.event)).toEqual(['safety', 'done']);
    expect(mockAi.calls).toHaveLength(0);

    mockAi.chunks = ['[sad][face:sad][action:none] 割腕会很疼的。'];
    const blocked = parseSse((await preview({ draft, messages: [{ role: 'user', content: '在吗' }], caps: ['safety'] })).body);
    expect(blocked.map((e) => e.event)).toEqual(['notice', 'safety', 'done']);
    expect(JSON.stringify(blocked)).not.toContain('割腕');
    const scenes = (await SafetyReferralStat.find().lean()).map((s) => `${s.scene}:${s.trigger}`).sort();
    expect(scenes).toEqual(['persona_preview:input', 'persona_preview:output']);
  });

  it('退化成 sentence 时要和普通台词同形（带 tts 参数，老客户端才念得出情绪）', async () => {
    const { token } = await createUser();
    const events = parseSse((await chat(token, { message: '我想死' })).body); // 不声明 caps = 老客户端
    const sentence = events.find((e) => e.event === 'sentence');
    expect(sentence.data.tts).not.toBeNull();
    expect(sentence.data.tts.emotion).toBe('sad');
    const legacy = parseSse((await chat(token, { messages: [{ role: 'user', content: '我想死' }] })).body);
    expect(legacy.find((e) => e.event === 'sentence').data.tts.emotion).toBe('sad');
  });

  it('OTHER 地区给的 988 必须标明仅限美国（境外拨不通）', () => {
    const { resources } = safety.crisisResources({ country: 'DE', lang: 'zh' });
    const line = resources.find((r) => r.tel === '988');
    expect(line.label).toContain('仅限美国');
    expect(safety.crisisResources({ country: 'DE', lang: 'en' }).resources.find((r) => r.tel === '988').label).toContain('United States only');
  });
});

describe('评审补的几条（2026-09-25）', () => {
  function support(token, body) {
    return request(app)
      .post('/api/support/chat')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => cb(null, data));
      });
  }

  it('★ 客服链路也有闸：输入命中不调模型、直接回求助卡', async () => {
    const { token } = await createUser();
    const events = parseSse((await support(token, { message: '我不想活了', caps: ['safety'] })).body);
    expect(events.map((e) => e.event)).toEqual(['thread', 'safety', 'done']);
    expect(mockAi.calls).toHaveLength(0);
    expect((await SafetyReferralStat.find().lean())[0]).toMatchObject({ scene: 'support', trigger: 'input' });
  });

  it('★ 客服的输出也拦：模型说了该拦的话，那句不发、改发求助卡', async () => {
    const { token } = await createUser();
    mockAi.chunks = ['[neutral][face:normal][action:none] 你好呀。 ', '[sad][face:sad][action:none] 你不如去死吧。'];
    const events = parseSse((await support(token, { message: '你好', caps: ['safety'] })).body);
    expect(events.map((e) => e.event)).toEqual(['thread', 'sentence', 'safety', 'done']);
    expect(JSON.stringify(events)).not.toContain('去死');
    expect((await SafetyReferralStat.find({ trigger: 'output' }).lean())[0]).toMatchObject({ scene: 'support' });
  });

  it('★ 切句把一句话劈成两半时，整段复查要接住（先切后查会漏）', async () => {
    const { token } = await createUser();
    // ENDERS 含换行：逐句查时两半都不命中，拼起来才命中
    mockAi.chunks = ['[neutral][face:normal][action:none] 你可以割\n', '腕。'];
    const events = parseSse((await chat(token, { message: '难受', caps: ['safety'] })).body);
    expect(events.some((e) => e.event === 'safety')).toBe(true);
    expect(events[events.length - 1].data.text).toBe(''); // 被拦下的整段不进历史
    const rows = await ChatMessage.find({ role: 'assistant' }).lean();
    for (const r of rows) expect(r.displayText).not.toMatch(/割/);
  });

  it('★ 日常说法不该被方法词表误伤（误判的代价是这一轮一个字都不回）', async () => {
    for (const t of ['晚上一起打农药吗', '医生给我开了安眠药', '我最近一直吃安眠药也睡不好', '想去玩跳楼机', '周末去烧炭烤肉', '跳楼价', '一氧化碳中毒的原理是什么']) {
      expect({ t, hit: safety.detectSelfHarm(t).hit }).toEqual({ t, hit: false });
    }
    for (const t of ['吞了一整瓶安眠药', '从楼上跳楼', '烧炭自杀', '自杀的方法', '割腕']) {
      expect({ t, hit: safety.detectSelfHarm(t).hit }).toEqual({ t, hit: true });
    }
  });

  it('★ 插字归一化要按白名单：emoji / 软连字符 / 字母数字都不能当掩护', () => {
    for (const t of ['我想自💀杀', '我想自­杀', '我想自2杀', '我 想 自 杀']) {
      expect({ t, hit: safety.detectSelfHarm(t).hit }).toEqual({ t, hit: true });
    }
  });

  it('★ 旧写法的历史里那句危机原话不会被回灌给模型', async () => {
    const { token } = await createUser();
    await chat(token, {
      messages: [
        { role: 'user', content: '我想自杀' },
        { role: 'assistant', content: '（求助卡）' },
        { role: 'user', content: '聊点别的吧' },
      ],
      caps: ['safety'],
    });
    expect(mockAi.calls).toHaveLength(1);
    const sent = JSON.stringify(mockAi.calls[0]);
    expect(sent).not.toContain('我想自杀');
    expect(sent).toContain('已按安全协议移除');
  });

  it('★ 提纯出来的摘要命中敏感判据时整段丢弃，且不抹掉原来那段摘要', async () => {
    const { user } = await createUser();
    const thread = await chatMemory.openThread({ userId: user._id, scene: 'companion' });
    await ChatThread.updateOne({ _id: thread._id }, { $set: { 'summary.text': '之前的正常摘要' } });
    for (let i = 0; i < 8; i += 1) {
      await chatMemory.appendMessage(thread, { role: 'user', kind: 'msg', displayText: `第 ${i} 句`, modelText: `第 ${i} 句` });
      await chatMemory.appendMessage(thread, { role: 'assistant', kind: 'msg', displayText: '好', modelText: '好' });
    }
    mockAi.completions = [JSON.stringify({ summary: '用户说他想自杀，情绪低落', facts_add: [], facts_update: [], facts_remove: [] })];
    const r = await chatMemory.compactThread({ threadId: thread._id, manual: true });
    expect(r.ok).toBe(true); // 真的跑了提纯（不然下面那条断言是空跑）
    const after = await ChatThread.findById(thread._id).lean();
    expect(after.summary.text).toBe('之前的正常摘要'); // 没被危机摘要覆盖，也没被写空
    expect(after.summary.coversUntilSeq).toBeGreaterThan(0); // 覆盖点照常前移
  });
});

describe('输出命中：拦下那句、abort 上游、改发求助卡', () => {
  it('第二句违规：事件是 thread→sentence#0→safety→done，历史里没有违规句', async () => {
    const { token } = await createUser();
    mockAi.chunks = [
      '[neutral][face:normal][action:none] 今天过得怎么样？ ',
      '[sad][face:sad][action:none] 你不如去死吧。 ',
      '[happy][face:happy][action:none] 还有第三句。',
    ];
    const res = await chat(token, { message: '你好', caps: ['safety', 'notice'] }, { 'CF-IPCountry': 'US' });
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(['thread', 'notice', 'sentence', 'safety', 'done']);
    expect(events.find((e) => e.event === 'sentence').data.text).toBe('今天过得怎么样？');
    expect(events.find((e) => e.event === 'safety').data.trigger).toBe('output');
    expect(events.some((e) => e.event === 'token')).toBe(false); // 开守卫时不发未经检查的增量

    const threadId = events[0].data.threadId;
    const stored = await ChatMessage.find({ thread: threadId }).sort({ seq: 1 }).lean();
    expect(stored.map((m) => m.kind)).toEqual(['msg', 'safety', 'msg']);
    const assistant = stored.find((m) => m.role === 'assistant');
    expect(assistant.displayText).toBe('今天过得怎么样？');
    expect(assistant.displayText).not.toContain('去死');
    expect(await SafetyReferralStat.countDocuments({ trigger: 'output' })).toBe(1);
  });

  it('安全底线写进提示词，且在 few-shot 之后再发一次', async () => {
    const { token } = await createUser();
    await chat(token, { message: '你好', caps: ['safety'] });
    const sent = mockAi.calls[0];
    expect(sent[0].content).toContain('必须直接承认');
    expect(sent[0].content).not.toContain('16 岁');
    const last = sent.filter((m) => m.role === 'system').pop();
    expect(last.content).toContain('安全底线');
  });
});

describe('AI 身份告知（纽约 GBL §1702）', () => {
  it('新会话发、刚聊过不发、满 3 小时发、空闲 31 分钟回来发', async () => {
    const { token } = await createUser();
    const first = parseSse((await chat(token, { message: '你好', caps: ['notice'] })).body);
    expect(first.some((e) => e.event === 'notice')).toBe(true);
    const threadId = first[0].data.threadId;

    const second = parseSse((await chat(token, { message: '再聊会儿', threadId, caps: ['notice'] })).body);
    expect(second.some((e) => e.event === 'notice')).toBe(false);

    const t = await ChatThread.findById(threadId).lean();
    // 距上次告知 2 小时 59 分、且 5 分钟前刚说过话 → 不发（两条规则都不满足）
    const t2h59 = Date.now() + 2 * 60 * 60 * 1000 + 59 * 60 * 1000;
    expect(chatMemory.isDisclosureDue({ ...t, lastActiveAt: new Date(t2h59 - 5 * 60 * 1000) }, t2h59)).toBe(false);
    // 距上次告知 3 小时 01 分（同样 5 分钟前刚说过话）→ 发
    const t3h01 = Date.now() + 3 * 60 * 60 * 1000 + 60 * 1000;
    expect(chatMemory.isDisclosureDue({ ...t, lastActiveAt: new Date(t3h01 - 5 * 60 * 1000) }, t3h01)).toBe(true);

    await ChatThread.updateOne({ _id: threadId }, { $set: { lastActiveAt: new Date(Date.now() - 31 * 60 * 1000) } });
    const back = parseSse((await chat(token, { message: '我回来了', threadId, caps: ['notice'] })).body);
    expect(back.some((e) => e.event === 'notice')).toBe(true);
  });
});

describe('首次同意（加州 SB 243 §22602(a)/§22604）', () => {
  it('开了开关没同意 → 428 且不调模型；PUT /consent 之后 config 显示已同意', async () => {
    process.env.COMPANION_REQUIRE_CONSENT = '1';
    const { token } = await createUser();
    const blocked = await request(app).post('/api/companion/chat').set('Authorization', `Bearer ${token}`).send({ message: '你好' });
    expect(blocked.status).toBe(428);
    expect(blocked.body.code).toBe('CONSENT_REQUIRED');
    expect(mockAi.calls).toHaveLength(0);

    const ok = await request(app).put('/api/companion/consent').set('Authorization', `Bearer ${token}`).send({});
    expect(ok.body.consented).toBe(true);
    const cfg = await request(app).get('/api/companion/config').set('Authorization', `Bearer ${token}`);
    expect(cfg.body.safety).toMatchObject({ consented: true, policyUrl: '/safety/ai-chat', consentRequired: true });
    expect(cfg.body.safety.version).toBe(safety.PROTOCOL_VERSION);

    const after = parseSse((await chat(token, { message: '你好', caps: ['safety'] })).body);
    expect(after.some((e) => e.event === 'sentence')).toBe(true);
  });

  it('游客也能从 config 看到求助资源与安全说明地址', async () => {
    const res = await request(app).get('/api/companion/config').set('CF-IPCountry', 'CN');
    expect(res.body.safety).toMatchObject({ policyUrl: '/safety/ai-chat', consented: false, region: 'CN' });
    expect(res.body.safety.resources.some((r) => r.tel === '12356')).toBe(true);
  });
});

describe('危机内容不进模型上下文、不进记忆', () => {
  it('下一轮把那句原话换成占位句；提纯不会把它变成记忆卡', async () => {
    const { user, token } = await createUser();
    const first = parseSse((await chat(token, { message: '我想自杀', caps: ['safety'] })).body);
    const threadId = first[0].data.threadId;
    await chat(token, { message: '说点开心的', threadId, caps: ['safety'] });
    const sent = mockAi.calls[0];
    // 两句用户消息之间没有助手回复（输入命中时不调模型），所以它们会被合并成一条
    const userTurns = sent.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
    expect(userTurns).toContain(safety.SELF_HARM_PLACEHOLDER);
    expect(userTurns).not.toContain('我想自杀');

    // 提纯：即使模型硬要记，这条也会被 looksSensitive 挡下
    mockAi.completions = [
      JSON.stringify({ summary: '用户最近心情不好', facts_add: [{ text: '用户说过想自杀', category: 'other' }], facts_update: [], facts_remove: [] }),
    ];
    await chatMemory.compactThread({ threadId, manual: true });
    const mems = await ChatMemory.find({ user: user._id }).lean();
    expect(mems.map((m) => m.text)).not.toContain('用户说过想自杀');
    expect(mockAi.prompts[0]).toContain('不要记录任何与自杀');
  });
});
