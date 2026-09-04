/**
 * 首页看板娘数字人：/api/companion 的契约测试。
 * 上游 LLM 用 jest.mock 换成固定脚本 —— 测的是"标签解析 + 切句 + SSE 事件形状"，不是模型。
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

jest.mock('../src/services/aiClient', () => {
  const actual = jest.requireActual('../src/services/aiClient');
  return {
    ...actual,
    hasAiKey: () => true,
    // 故意把一句话切得七零八落，模拟真实流式：标签跨 chunk、句号后面跟着下一句的标签。
    // ★ chunk 之间必须真的异步等一下：曾经的 bug 是路由监听了 req 的 'close'（Node 里请求体读完就触发），
    //   同步 yield 的假流测不出来——事件全在 close 之前写完了；线上模型每个 token 都要等，一上线就全丢。
    aiChatStream: async function* () {
      const chunks = ['[happy][fa', 'ce:happy][action:wave] 欢迎来到启梦～ ', '[neutral][face:normal][action:explain] 想找灵感可以先逛逛热门创意。', '[shy][face:shy][action:shy]谢谢夸奖…'];
      for (const c of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        yield c;
      }
    },
  };
});

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
});

async function createUser() {
  const User = require('../src/models/User');
  const { signToken } = require('../src/utils/jwt');
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `cmp_${random}`, email: `${random}@test.local`, role: 'user', passwordHash: 'hashed' });
  return { user, token: signToken(user) };
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = /event: (\w+)/.exec(block)[1];
      const data = JSON.parse(/data: (.*)/.exec(block)[1]);
      return { event, data };
    });
}

describe('GET /api/companion/config', () => {
  it('游客可读到是否启用与名字', async () => {
    const res = await request(app).get('/api/companion/config');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(typeof res.body.name).toBe('string');
    expect(res.body.loginRequired).toBe(true);
  });
});

describe('POST /api/companion/chat', () => {
  it('未登录 401', async () => {
    const res = await request(app).post('/api/companion/chat').send({ messages: [{ role: 'user', content: '你好' }] });
    expect(res.status).toBe(401);
  });

  it('消息形状不对 400', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post('/api/companion/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ messages: [{ role: 'assistant', content: '我先说' }] });
    expect(res.status).toBe(400);
  });

  it('按句吐 SSE：标签被解析并剥掉，未知值回退默认', async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post('/api/companion/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ messages: [{ role: 'user', content: '你好' }] });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['x-accel-buffering']).toBe('no');

    const events = parseSse(res.text);
    const sentences = events.filter((e) => e.event === 'sentence').map((e) => e.data);
    expect(sentences.map((s) => s.text)).toEqual(['欢迎来到启梦～', '想找灵感可以先逛逛热门创意。', '谢谢夸奖…']);
    expect(sentences[0]).toMatchObject({ index: 0, emotion: 'happy', face: 'happy', action: 'wave', tts: { emotion: 'happy' } });
    expect(sentences[1]).toMatchObject({ emotion: 'neutral', face: 'normal', action: 'explain' });
    expect(sentences[2]).toMatchObject({ emotion: 'shy', face: 'shy', action: 'shy', tts: { emotion: 'happy' } });
    // 正文里绝不能残留方括号
    sentences.forEach((s) => expect(s.text).not.toMatch(/[\[\]]/));

    const done = events.find((e) => e.event === 'done');
    expect(done.data.text).toBe('欢迎来到启梦～ 想找灵感可以先逛逛热门创意。 谢谢夸奖…');
  });
});

describe('companion.service 纯函数', () => {
  const svc = require('../src/services/companion.service');

  it('parseTags 容忍任意顺序与缺省，未知值回退', () => {
    expect(svc.parseTags('[action:wave][face:tease][excited] 嘿！')).toEqual({ emotion: 'excited', face: 'tease', action: 'wave', text: '嘿！' });
    expect(svc.parseTags('[face:banana][action:fly][zzz] 正文')).toEqual({ emotion: 'neutral', face: 'normal', action: 'none', text: '正文' });
    expect(svc.parseTags('[happy]')).toMatchObject({ text: '' });
  });

  it('createSentenceSplitter 的长度阈值不把句首标签算进去（40 字正常句不该在逗号处被腰斩）', () => {
    const out = [];
    const sp = svc.createSentenceSplitter((s) => out.push(s));
    sp.push('[neutral][face:normal][action:explain] 这里是一个把灵感变成作品的地方，你可以发想法、聊场景，也能看看大家的标签排行。');
    sp.flush();
    expect(out).toHaveLength(1);
  });

  it('createSentenceSplitter 超长无标点时在逗号处切', () => {
    const out = [];
    const sp = svc.createSentenceSplitter((s) => out.push(s), { maxLen: 20 });
    sp.push('[neutral][face:normal][action:none] 一二三四五六七八九十，十一十二十三十四十五十六十七十八十九二十，二十一');
    sp.flush();
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.join('')).toContain('二十一');
  });
});
