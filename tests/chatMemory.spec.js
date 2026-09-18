/**
 * 数字人对话记忆：会话持久化 / 上下文用量 / 自动提纯 / 记忆卡 / 硬删除 / 过期清扫。
 * 上游 LLM 用 jest.mock 换成可控脚本 —— 测的是 chatMemory.service 与两个 /chat 路由的契约，不是模型。
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const mockAi = {
  chunks: [],
  usage: null,
  failAfterChunks: false,
  calls: [],
  prompts: [],
  completions: [],
};

jest.mock('../src/services/aiClient', () => {
  const actual = jest.requireActual('../src/services/aiClient');
  return {
    ...actual,
    hasAiKey: () => true,
    aiChatStream: async function* (messages, opts = {}) {
      mockAi.calls.push(messages);
      for (const c of mockAi.chunks) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield c;
      }
      if (mockAi.failAfterChunks) throw new Error('upstream boom');
      if (mockAi.usage && typeof opts.onUsage === 'function') opts.onUsage(mockAi.usage);
    },
    aiComplete: async (prompt) => {
      mockAi.prompts.push(prompt);
      const next = mockAi.completions.length ? mockAi.completions.shift() : '';
      if (next instanceof Error) throw next;
      return { text: next, model: 'mock', usage: { model: 'mock', promptTokens: 500, completionTokens: 80, cacheHitTokens: 0, cacheMissTokens: 500, reasoningTokens: 0 } };
    },
  };
});

let mongod;
let app;
let chatMemory;
let ChatThread;
let ChatMessage;
let ChatMemory;
let ChatUsageLog;
let DeletionLog;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
  chatMemory = require('../src/services/chatMemory.service');
  ChatThread = require('../src/models/ChatThread');
  ChatMessage = require('../src/models/ChatMessage');
  ChatMemory = require('../src/models/ChatMemory');
  ChatUsageLog = require('../src/models/ChatUsageLog');
  DeletionLog = require('../src/models/DeletionLog');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await Promise.all([ChatThread, ChatMessage, ChatMemory, ChatUsageLog, DeletionLog].map((m) => m.syncIndexes()));
  mockAi.chunks = ['[happy][face:happy][action:wave] 你好呀～ ', '[neutral][face:normal][action:explain]今天想聊点什么？'];
  mockAi.usage = { model: 'mock', promptTokens: 1200, completionTokens: 40, cacheHitTokens: 1000, cacheMissTokens: 200, reasoningTokens: 0 };
  mockAi.failAfterChunks = false;
  mockAi.calls = [];
  mockAi.prompts = [];
  mockAi.completions = [];
  delete process.env.COMPANION_CTX_BUDGET;
  delete process.env.SUPPORT_CTX_BUDGET;
  chatMemory._resetSweepClock();
});

async function createUser() {
  const User = require('../src/models/User');
  const { signToken } = require('../src/utils/jwt');
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `cm_${random}`, email: `${random}@test.local`, role: 'user', passwordHash: 'hashed' });
  return { user, token: signToken(user) };
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => ({ event: /event: (\w+)/.exec(block)[1], data: JSON.parse(/data: (.*)/.exec(block)[1]) }));
}

function chat(path, token, body) {
  return request(app).post(path).set('Authorization', `Bearer ${token}`).send(body).buffer(true).parse((res, cb) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (data += c));
    res.on('end', () => cb(null, data));
  });
}

async function waitFor(fn, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 直接往库里铺一段 n 轮的对话（不经过模型） */
async function seedThread(userId, scene, turns) {
  const thread = await chatMemory.openThread({ userId, scene });
  for (let i = 1; i <= turns; i++) {
    await chatMemory.appendMessage(thread, { role: 'user', displayText: `第${i}句用户话` });
    await chatMemory.appendMessage(thread, { role: 'assistant', displayText: `第${i}句回复`, modelText: `[neutral][face:normal][action:none] 第${i}句回复` });
  }
  return thread;
}

const GOOD_COMPACT = JSON.stringify({
  summary: '用户在做一个关于猫的分支视频，想要温柔的配音。',
  facts_add: [
    { text: '用户喜欢猫', category: 'preference' },
    { text: '用户手机号是13812345678', category: 'other' },
  ],
  facts_update: [],
  facts_remove: [],
});

describe('estimateTokens / mergeSameRole', () => {
  it('汉字按 0.6、其余按 0.3 估算', () => {
    expect(chatMemory.estimateTokens('你好')).toBe(2); // ceil(1.2)
    expect(chatMemory.estimateTokens('hello world')).toBe(4); // ceil(3.3)
    expect(chatMemory.estimateTokens('')).toBe(0);
  });

  it('连续同角色合成一条，完全相同的重发只留一条', () => {
    const out = chatMemory.mergeSameRole([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: 'c' },
    ]);
  });
});

describe('POST /api/companion/chat 按会话', () => {
  it('新会话：先发 thread 事件；done 带 threadId 与用量；两条消息落库，助手原文保留演出标签', async () => {
    const { user, token } = await createUser();
    const res = await chat('/api/companion/chat', token, { message: '你好' });
    expect(res.status).toBe(200);
    const events = parseSse(res.body);
    expect(events[0].event).toBe('thread');
    const threadId = events[0].data.threadId;
    expect(events[0].data.title).toBe('你好');
    const done = events.find((e) => e.event === 'done');
    expect(done.data.threadId).toBe(threadId);
    expect(done.data.context).toMatchObject({ used: 1240, budget: 32000, level: 'ok' });

    const msgs = await ChatMessage.find({ thread: threadId }).sort({ seq: 1 }).lean();
    expect(msgs.map((m) => [m.seq, m.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
    ]);
    expect(msgs[1].displayText).toBe('你好呀～ 今天想聊点什么？');
    expect(msgs[1].modelText).toContain('[happy][face:happy][action:wave]');
    expect(String(msgs[0].user)).toBe(String(user._id));

    const thread = await ChatThread.findById(threadId).lean();
    expect(thread.messageCount).toBe(2);
    expect(thread.stats.lastPromptTokens).toBe(1200);
    expect(await ChatUsageLog.countDocuments({ thread: threadId, kind: 'reply', cacheHitTokens: 1000 })).toBe(1);
  });

  it('第二轮带 threadId：模型拿到服务端存的历史（带标签的原文），不用客户端再传', async () => {
    const { token } = await createUser();
    const first = parseSse((await chat('/api/companion/chat', token, { message: '你好' })).body);
    const threadId = first[0].data.threadId;
    await chat('/api/companion/chat', token, { message: '我今天画了一只猫', threadId });
    const sent = mockAi.calls[1];
    expect(sent[0].role).toBe('system');
    const tail = sent.slice(-3);
    expect(tail[0]).toEqual({ role: 'user', content: '你好' });
    expect(tail[1].role).toBe('assistant');
    expect(tail[1].content).toContain('[happy]');
    expect(tail[2]).toEqual({ role: 'user', content: '我今天画了一只猫' });
    expect(await ChatMessage.countDocuments({ thread: threadId })).toBe(4);
  });

  it('别人的 threadId → 404 JSON（还没开始 SSE），对方会话不被追加', async () => {
    const a = await createUser();
    const b = await createUser();
    const threadId = parseSse((await chat('/api/companion/chat', a.token, { message: '你好' })).body)[0].data.threadId;
    const res = await request(app).post('/api/companion/chat').set('Authorization', `Bearer ${b.token}`).send({ message: '偷看', threadId });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CHAT_THREAD_NOT_FOUND');
    expect(await ChatMessage.countDocuments({ thread: threadId })).toBe(2);
  });

  it('陪聊的 threadId 拿去客服用 → 404（两个场景互不可见）', async () => {
    const { token } = await createUser();
    const threadId = parseSse((await chat('/api/companion/chat', token, { message: '你好' })).body)[0].data.threadId;
    const res = await request(app).post('/api/support/chat').set('Authorization', `Bearer ${token}`).send({ message: '怎么导出视频', threadId });
    expect(res.status).toBe(404);
  });

  it('旧写法 messages[] 照常可用，且不落库', async () => {
    const { token } = await createUser();
    const res = await chat('/api/companion/chat', token, { messages: [{ role: 'user', content: '你好' }] });
    const events = parseSse(res.body);
    expect(events.some((e) => e.event === 'thread')).toBe(false);
    expect(events.find((e) => e.event === 'done').data.threadId).toBeUndefined();
    expect(await ChatThread.countDocuments()).toBe(0);
  });

  it('message 与 messages[] 同时给 / 都不给 → 400', async () => {
    const { token } = await createUser();
    const both = await request(app)
      .post('/api/companion/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'a', messages: [{ role: 'user', content: 'a' }] });
    expect(both.status).toBe(400);
    const none = await request(app).post('/api/companion/chat').set('Authorization', `Bearer ${token}`).send({ lang: 'zh' });
    expect(none.status).toBe(400);
  });

  it('上游中途失败：error 事件带 threadId；用户那句留在历史里', async () => {
    const { token } = await createUser();
    mockAi.failAfterChunks = true;
    const events = parseSse((await chat('/api/companion/chat', token, { message: '你好' })).body);
    const err = events.find((e) => e.event === 'error');
    expect(err.data.threadId).toBe(events[0].data.threadId);
    const msgs = await ChatMessage.find({ thread: err.data.threadId }).sort({ seq: 1 }).lean();
    expect(msgs[0]).toMatchObject({ role: 'user', displayText: '你好' });
    // 已经说出口的整句存下来，标 partial
    expect(msgs[1]).toMatchObject({ role: 'assistant', partial: true });
  });

  it('用量过 75% → 回复发完后自动提纯：旧原文标 compacted、最近 6 轮保留、写摘要和记忆卡、插分隔提示', async () => {
    const { user, token } = await createUser();
    const thread = await seedThread(user._id, 'companion', 10); // 20 条
    mockAi.usage = { model: 'mock', promptTokens: 26000, completionTokens: 100, cacheHitTokens: 0, cacheMissTokens: 26000, reasoningTokens: 0 };
    mockAi.completions = [GOOD_COMPACT];
    const events = parseSse((await chat('/api/companion/chat', token, { message: '还记得我吗', threadId: String(thread._id) })).body);
    expect(events.find((e) => e.event === 'done').data.context.level).toBe('compact');

    const after = await waitFor(async () => {
      const t = await ChatThread.findById(thread._id).lean();
      return t.summary.version === 1 && !t.stats.compacting ? t : null;
    });
    expect(after.summary.text).toContain('猫');
    expect(after.stats.lastPromptTokens).toBeLessThan(26000);
    // 20 条种子 + 本轮 2 条 = 22 条，保留最后 12 条
    expect(await ChatMessage.countDocuments({ thread: thread._id, kind: 'msg', compacted: true })).toBe(10);
    expect(await ChatMessage.countDocuments({ thread: thread._id, kind: 'msg', compacted: false })).toBe(12);
    const divider = await ChatMessage.findOne({ thread: thread._id, kind: 'divider' }).lean();
    expect(divider.role).toBe('system');
    expect(divider.displayText).toContain('已整理前 5 轮');
    // 敏感信息（手机号）不进记忆卡
    const mems = await ChatMemory.find({ user: user._id }).lean();
    expect(mems.map((m) => m.text)).toEqual(['用户喜欢猫']);
    expect(mems[0].sourceThreads.map(String)).toEqual([String(thread._id)]);
    expect(await ChatUsageLog.countDocuments({ thread: thread._id, kind: 'compact' })).toBe(1);

    // 下一轮：记忆块接在 system 末尾、被提纯的原文不再发给模型
    await chat('/api/companion/chat', token, { message: '那我们继续', threadId: String(thread._id) });
    const sent = mockAi.calls[mockAi.calls.length - 1];
    expect(sent[0].content).toContain('【记忆】');
    expect(sent[0].content).toContain('用户喜欢猫');
    expect(sent[0].content).toContain('之前聊过的内容摘要');
    expect(sent.some((m) => m.content === '第1句用户话')).toBe(false);
    expect(sent.some((m) => m.content === '第10句用户话')).toBe(true);
  });
});

describe('compactThread', () => {
  it('两次提纯失败后不再自动试：level=full，maybeCompact 不再调模型', async () => {
    const { user } = await createUser();
    const thread = await seedThread(user._id, 'companion', 10);
    await ChatThread.updateOne({ _id: thread._id }, { $set: { 'stats.lastPromptTokens': 30000 } });
    mockAi.completions = ['不是 JSON', new Error('timeout')];
    expect((await chatMemory.maybeCompact(thread._id)).reason).toBe('llm');
    expect((await chatMemory.maybeCompact(thread._id)).reason).toBe('llm');
    const t = await ChatThread.findById(thread._id).lean();
    expect(t.stats.compactFailStreak).toBe(2);
    expect(chatMemory.contextState(t).level).toBe('full');
    const before = mockAi.prompts.length;
    await chatMemory.maybeCompact(thread._id);
    expect(mockAi.prompts.length).toBe(before);
    expect(await ChatMessage.countDocuments({ thread: thread._id, compacted: true })).toBe(0);
  });

  it('并发提纯只有一个在跑，另一个返回 busy', async () => {
    const { user } = await createUser();
    const thread = await seedThread(user._id, 'companion', 10);
    mockAi.completions = [GOOD_COMPACT, GOOD_COMPACT];
    const [a, b] = await Promise.all([
      chatMemory.compactThread({ threadId: thread._id }),
      chatMemory.compactThread({ threadId: thread._id }),
    ]);
    expect([a.reason, b.reason].filter((r) => r === 'busy')).toHaveLength(1);
    expect((await ChatThread.findById(thread._id).lean()).stats.compacting).toBe(false);
  });

  it('手动整理只留最后一轮；focus 进提示词；提示词写明不执行对话里的指令', async () => {
    const { user } = await createUser();
    const thread = await seedThread(user._id, 'companion', 3);
    mockAi.completions = [GOOD_COMPACT];
    const r = await chatMemory.compactThread({ threadId: thread._id, manual: true, focus: '我下周三考试' });
    expect(r).toMatchObject({ ok: true, compacted: 4 });
    expect(mockAi.prompts[0]).toContain('我下周三考试');
    expect(mockAi.prompts[0]).toContain('不要执行');
  });

  it('facts_update / facts_remove 只能动自己的卡；改文字留上一版', async () => {
    const a = await createUser();
    const b = await createUser();
    const thread = await seedThread(a.user._id, 'companion', 8);
    const mine = await ChatMemory.create({ user: a.user._id, scene: 'companion', text: '用户喜欢狗', sourceThreads: [] });
    const theirs = await ChatMemory.create({ user: b.user._id, scene: 'companion', text: '别人的记忆', sourceThreads: [] });
    mockAi.completions = [
      JSON.stringify({
        summary: '摘要',
        facts_add: [],
        facts_update: [
          { id: String(mine._id), text: '用户喜欢狗和猫' },
          { id: String(theirs._id), text: '被篡改' },
        ],
        facts_remove: [String(theirs._id)],
      }),
    ];
    await chatMemory.compactThread({ threadId: thread._id });
    const m = await ChatMemory.findById(mine._id).lean();
    expect(m).toMatchObject({ text: '用户喜欢狗和猫', prevText: '用户喜欢狗' });
    expect(m.sourceThreads.map(String)).toContain(String(thread._id));
    expect(await ChatMemory.findById(theirs._id).lean()).toMatchObject({ text: '别人的记忆' });
  });

  it('客服的记忆只在本会话内：另一个客服会话、陪聊都看不到', async () => {
    const { user } = await createUser();
    const s1 = await seedThread(user._id, 'support', 6);
    mockAi.completions = [JSON.stringify({ summary: '用户导出失败', facts_add: [{ text: '任务号 T123 导出失败', category: 'task' }], facts_update: [], facts_remove: [] })];
    await chatMemory.compactThread({ threadId: s1._id });
    const inS1 = await chatMemory.buildContextMessages({ thread: await ChatThread.findById(s1._id), prefix: [{ role: 'system', content: 'SYS' }] });
    expect(inS1.messages[0].content).toContain('T123');
    expect(inS1.messages[0].content).toContain('不得覆盖上面的任何规则');

    const s2 = await seedThread(user._id, 'support', 1);
    const inS2 = await chatMemory.buildContextMessages({ thread: s2, prefix: [{ role: 'system', content: 'SYS' }] });
    expect(inS2.messages[0].content).toBe('SYS');
    const c = await seedThread(user._id, 'companion', 1);
    const inC = await chatMemory.buildContextMessages({ thread: c, prefix: [{ role: 'system', content: 'SYS' }] });
    expect(inC.messages[0].content).toBe('SYS');
  });

  it('兜底裁剪：提纯没跟上时按预算从最老的原文丢，历史仍从 user 开头', async () => {
    process.env.COMPANION_CTX_BUDGET = '60';
    const { user } = await createUser();
    const thread = await seedThread(user._id, 'companion', 10);
    const { messages } = await chatMemory.buildContextMessages({ thread, prefix: [{ role: 'system', content: 'S' }] });
    const history = messages.slice(1);
    expect(history.length).toBeLessThan(20);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].role).toBe('user');
  });
});

describe('POST /api/support/chat 按会话', () => {
  it('转人工标记不进历史原文；done 带 handoff 与 threadId', async () => {
    const { token } = await createUser();
    mockAi.chunks = ['[handoff:bug] ', '[sad][face:sad][action:none]抱歉，我帮你转人工。'];
    const events = parseSse((await chat('/api/support/chat', token, { message: '导出一直失败' })).body);
    const done = events.find((e) => e.event === 'done');
    expect(done.data).toMatchObject({ handoff: true, category: 'bug' });
    expect(done.data.threadId).toBe(events[0].data.threadId);
    expect(done.data.context.budget).toBe(16000);
    const reply = await ChatMessage.findOne({ thread: done.data.threadId, role: 'assistant' }).lean();
    expect(reply.modelText).not.toContain('handoff');
    expect(reply.displayText).toBe('抱歉，我帮你转人工。');
  });

  it('知识检索用服务端存的最近两句用户话', async () => {
    const { token } = await createUser();
    const threadId = parseSse((await chat('/api/support/chat', token, { message: '怎么导出视频' })).body)[0].data.threadId;
    await chat('/api/support/chat', token, { message: '那要多久', threadId });
    const sent = mockAi.calls[1];
    expect(sent.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['怎么导出视频', '那要多久']);
  });
});

describe('/api/chat 会话与记忆', () => {
  it('列表 / 翻历史分页 / 只看得到自己的', async () => {
    const a = await createUser();
    const b = await createUser();
    const thread = await seedThread(a.user._id, 'companion', 5);
    const list = await request(app).get('/api/chat/threads?scene=companion').set('Authorization', `Bearer ${a.token}`);
    expect(list.body.threads).toHaveLength(1);
    expect(list.body.threads[0]).toMatchObject({ id: String(thread._id), messageCount: 10, title: '第1句用户话' });

    const page = await request(app).get(`/api/chat/threads/${thread._id}/messages?limit=4`).set('Authorization', `Bearer ${a.token}`);
    expect(page.body.messages.map((m) => m.seq)).toEqual([7, 8, 9, 10]);
    expect(page.body.hasMore).toBe(true);
    const older = await request(app).get(`/api/chat/threads/${thread._id}/messages?before=7&limit=10`).set('Authorization', `Bearer ${a.token}`);
    expect(older.body.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(older.body.hasMore).toBe(false);

    expect((await request(app).get(`/api/chat/threads/${thread._id}/messages`).set('Authorization', `Bearer ${b.token}`)).status).toBe(404);
    expect((await request(app).get('/api/chat/threads?scene=companion').set('Authorization', `Bearer ${b.token}`)).body.threads).toHaveLength(0);
    expect((await request(app).get('/api/chat/threads?scene=nope').set('Authorization', `Bearer ${a.token}`)).status).toBe(400);
    expect((await request(app).get('/api/chat/threads?scene=companion')).status).toBe(401);
  });

  it('删会话：消息、用量、从它提炼的记忆卡一并硬删，并记 DeletionLog；别人删不了', async () => {
    const a = await createUser();
    const b = await createUser();
    const thread = await seedThread(a.user._id, 'companion', 8);
    mockAi.completions = [GOOD_COMPACT];
    await chatMemory.compactThread({ threadId: thread._id });
    const other = await ChatMemory.create({ user: a.user._id, scene: 'companion', text: '另一段会话记下的事', sourceThreads: [new mongoose.Types.ObjectId()] });
    await ChatUsageLog.create({ thread: thread._id, user: a.user._id, scene: 'companion', kind: 'reply', promptTokens: 1 });

    expect((await request(app).delete(`/api/chat/threads/${thread._id}`).set('Authorization', `Bearer ${b.token}`)).status).toBe(404);
    const res = await request(app).delete(`/api/chat/threads/${thread._id}`).set('Authorization', `Bearer ${a.token}`);
    expect(res.body).toMatchObject({ ok: true, deletedMemories: 1 });
    expect(await ChatThread.countDocuments({ _id: thread._id })).toBe(0);
    expect(await ChatMessage.countDocuments({ thread: thread._id })).toBe(0);
    expect(await ChatUsageLog.countDocuments({ thread: thread._id })).toBe(0);
    expect(await ChatMemory.countDocuments({ user: a.user._id })).toBe(1);
    expect(await ChatMemory.findById(other._id)).not.toBeNull();
    expect(await DeletionLog.countDocuments({ targetType: 'chat_thread', targetId: thread._id })).toBe(1);
    expect(await DeletionLog.countDocuments({ targetType: 'chat_memory' })).toBe(1);
  });

  it('记忆卡：改（留上一版）/ 回退 / 置顶 / 删 / 清空；别人的 404', async () => {
    const a = await createUser();
    const b = await createUser();
    const m = await ChatMemory.create({ user: a.user._id, scene: 'companion', text: '用户叫小林' });
    await ChatMemory.create({ user: a.user._id, scene: 'companion', text: '用户喜欢猫' });
    await ChatMemory.create({ user: a.user._id, scene: 'support', text: '客服那边的' });
    const auth = (t) => ({ Authorization: `Bearer ${t}` });

    const list = await request(app).get('/api/chat/memories?scene=companion').set(auth(a.token));
    expect(list.body.memories).toHaveLength(2);

    const patched = await request(app).patch(`/api/chat/memories/${m._id}`).set(auth(a.token)).send({ text: '用户叫小林，是插画师', pinned: true });
    expect(patched.body.memory).toMatchObject({ text: '用户叫小林，是插画师', pinned: true, canRevert: true });
    const reverted = await request(app).post(`/api/chat/memories/${m._id}/revert`).set(auth(a.token));
    expect(reverted.body.memory.text).toBe('用户叫小林');

    expect((await request(app).patch(`/api/chat/memories/${m._id}`).set(auth(b.token)).send({ text: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/chat/memories/${m._id}`).set(auth(b.token))).status).toBe(404);
    expect((await request(app).patch(`/api/chat/memories/${m._id}`).set(auth(a.token)).send({})).status).toBe(400);

    expect((await request(app).delete(`/api/chat/memories/${m._id}`).set(auth(a.token))).body.ok).toBe(true);
    const cleared = await request(app).delete('/api/chat/memories?scene=companion').set(auth(a.token));
    expect(cleared.body.deleted).toBe(1);
    expect(await ChatMemory.countDocuments({ user: a.user._id, scene: 'support' })).toBe(1);
    expect(await DeletionLog.countDocuments({ targetType: 'chat_memory' })).toBe(2);
  });

  it('手动整理：正在整理 → 409；成功返回新的用量', async () => {
    const { user, token } = await createUser();
    const thread = await seedThread(user._id, 'companion', 4);
    await ChatThread.updateOne({ _id: thread._id }, { $set: { 'stats.compacting': true } });
    const busy = await request(app).post(`/api/chat/threads/${thread._id}/compact`).set('Authorization', `Bearer ${token}`).send({});
    expect(busy.status).toBe(409);
    await ChatThread.updateOne({ _id: thread._id }, { $set: { 'stats.compacting': false } });
    mockAi.completions = [GOOD_COMPACT];
    const ok = await request(app).post(`/api/chat/threads/${thread._id}/compact`).set('Authorization', `Bearer ${token}`).send({ focus: '记住我喜欢猫' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, compacted: 6 });
    expect(ok.body.context.level).toBe('ok');
  });
});

describe('finishTurn / 过期清扫', () => {
  it('客户端中途断开：半截回复存下来标 partial', async () => {
    const { user } = await createUser();
    const thread = await chatMemory.openThread({ userId: user._id, scene: 'companion' });
    await chatMemory.appendMessage(thread, { role: 'user', displayText: '讲个故事' });
    const r = await chatMemory.finishTurn({ thread, displayText: '从前有座山', modelText: '[neutral] 从前有座山', usage: null, estPrompt: 100, aborted: true });
    expect(r.threadId).toBe(String(thread._id));
    const reply = await ChatMessage.findOne({ thread: thread._id, role: 'assistant' }).lean();
    expect(reply).toMatchObject({ partial: true, displayText: '从前有座山' });
  });

  it('usage 校准估算系数（滑动平均）', async () => {
    const { user } = await createUser();
    const thread = await chatMemory.openThread({ userId: user._id, scene: 'companion' });
    await chatMemory.recordUsage({ thread, kind: 'reply', usage: { promptTokens: 2000, completionTokens: 10 }, estPrompt: 1000 });
    const t = await ChatThread.findById(thread._id).lean();
    expect(t.stats.calibK).toBeCloseTo(1.3, 3); // 1*0.7 + 2*0.3
  });

  it('陪聊 180 天 / 客服 30 天未活跃的会话连消息一起删；记忆卡保留', async () => {
    const { user } = await createUser();
    const day = 24 * 60 * 60 * 1000;
    const oldC = await seedThread(user._id, 'companion', 1);
    const freshC = await seedThread(user._id, 'companion', 1);
    const oldS = await seedThread(user._id, 'support', 1);
    await ChatThread.updateOne({ _id: oldC._id }, { $set: { lastActiveAt: new Date(Date.now() - 181 * day) } });
    await ChatThread.updateOne({ _id: freshC._id }, { $set: { lastActiveAt: new Date(Date.now() - 31 * day) } });
    await ChatThread.updateOne({ _id: oldS._id }, { $set: { lastActiveAt: new Date(Date.now() - 31 * day) } });
    await ChatMemory.create({ user: user._id, scene: 'companion', text: '用户喜欢猫', sourceThreads: [oldC._id] });

    const r = await chatMemory.sweepExpiredChats();
    expect(r.removed).toBe(2);
    expect(await ChatThread.countDocuments()).toBe(1);
    expect(await ChatThread.findById(freshC._id)).not.toBeNull();
    expect(await ChatMessage.countDocuments({ thread: { $in: [oldC._id, oldS._id] } })).toBe(0);
    expect(await ChatMemory.countDocuments({ user: user._id })).toBe(1);
    // 同一进程 10 分钟内不再扫
    expect((await chatMemory.sweepExpiredChats()).skipped).toBe(true);
  });

  it('删账号用的 purgeUserChatData 只删这个人的', async () => {
    const a = await createUser();
    const b = await createUser();
    await seedThread(a.user._id, 'companion', 2);
    await seedThread(b.user._id, 'companion', 2);
    await ChatMemory.create({ user: a.user._id, scene: 'companion', text: 'x' });
    const r = await chatMemory.purgeUserChatData(a.user._id);
    expect(r).toEqual({ threads: 1, memories: 1 });
    expect(await ChatMessage.countDocuments({ user: a.user._id })).toBe(0);
    expect(await ChatMessage.countDocuments({ user: b.user._id })).toBe(4);
  });
});
