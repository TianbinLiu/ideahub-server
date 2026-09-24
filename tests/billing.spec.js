/**
 * 把四条不计费的链路接进钱包（方案 9.1 的 R1.5）：TTS / ASR / 陪聊 / 客服 / 试聊 / Runway。
 *
 * ★ 这些链路此前 `priceOf` / `charge` / `wallet` **零命中** —— 不是定价问题，是架构缺口：
 *   改免费额度对一个从来不扣款的余额毫无作用。
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

let fetchSpy;
beforeAll(() => {
  fetchSpy = jest.spyOn(global, 'fetch');
});

let mongod;
let app;
let User;
let TokenLedger;
let wallet;
let tokens;
let signToken;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.TTS_API_KEY = 'test-tts-key';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
  User = require('../src/models/User');
  TokenLedger = require('../src/models/TokenLedger');
  wallet = require('../src/services/tokenWallet.service');
  tokens = require('../src/config/tokens');
  ({ signToken } = require('../src/utils/jwt'));
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  fetchSpy.mockReset();
});

async function makeUser(role = 'user') {
  const rand = new mongoose.Types.ObjectId().toString().slice(-6);
  const u = await User.create({ username: `bl_${rand}`, email: `${rand}@test.local`, role, passwordHash: 'x' });
  return { user: u, token: signToken(u) };
}

async function balance(userId) {
  const u = await User.findById(userId).select('tokenWallet').lean();
  return u.tokenWallet.plan + u.tokenWallet.addon;
}

/** 豆包 TTS 的 SSE：一帧音频 + 结束帧 */
function ttsOk() {
  const audio = Buffer.from('fake-mp3').toString('base64');
  return { status: 200, text: async () => `data: ${JSON.stringify({ data: audio })}\n\ndata: ${JSON.stringify({ code: 20000000, message: 'OK' })}\n\n` };
}
function ttsFail(code = 45000030) {
  return { status: 200, text: async () => `data: ${JSON.stringify({ code, message: 'resource not activated' })}\n\n` };
}

describe('TTS 进钱包（33 token/字符）', () => {
  it('合成成功 → 按字符扣费，流水 memo 带 tts', async () => {
    const { user, token } = await makeUser();
    const before = await balance(user._id).catch(() => 0);
    fetchSpy.mockResolvedValueOnce(ttsOk());
    const text = '你好世界'; // 4 字符
    const res = await request(app).post('/api/tts').set('Authorization', `Bearer ${token}`).send({ text });
    expect(res.status).toBe(200);
    const row = await TokenLedger.findOne({ user: user._id, reason: 'ark_spend' }).lean();
    expect(row.delta).toBe(-4 * tokens.TTS_TOKENS_PER_CHAR);
    expect(row.memo).toMatch(/^tts /);
    void before;
  });

  it('上游一帧音频都没给（资源未开通）→ 全额退回', async () => {
    const { user, token } = await makeUser();
    fetchSpy.mockResolvedValueOnce(ttsFail());
    await request(app).post('/api/tts').set('Authorization', `Bearer ${token}`).send({ text: '你好' });
    const spend = await TokenLedger.findOne({ user: user._id, reason: 'ark_spend' }).lean();
    const refund = await TokenLedger.findOne({ user: user._id, reason: 'ark_refund' }).lean();
    expect(refund.delta).toBe(-spend.delta);
    // 一来一回，余额回到发放值
    expect(await balance(user._id)).toBe(tokens.planOf('free').monthlyTokens);
  });

  it('余额不足 → 402，且**不调上游**（白嫖不了）', async () => {
    const { user, token } = await makeUser();
    await wallet.ensureWallet(user._id);
    await User.updateOne({ _id: user._id }, { $set: { 'tokenWallet.plan': 1, 'tokenWallet.addon': 0 } });
    const res = await request(app).post('/api/tts').set('Authorization', `Bearer ${token}`).send({ text: '一句很长的台词'.repeat(5) });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_TOKENS');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('欠额冻结 → 403 WALLET_FROZEN，同样不调上游', async () => {
    const { user, token } = await makeUser();
    await wallet.revokeTokens({ userId: user._id, amount: 999_999_999 });
    const res = await request(app).post('/api/tts').set('Authorization', `Bearer ${token}`).send({ text: '你好' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WALLET_FROZEN');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('报价按**截断后**的文本：路由送去合成的是 300 字，就不能按 5,000 字收钱', async () => {
    const { user, token } = await makeUser();
    fetchSpy.mockResolvedValueOnce(ttsOk());
    const long = '啊'.repeat(5000); // 路由会截到 MAX_TEXT=300
    const res = await request(app).post('/api/tts').set('Authorization', `Bearer ${token}`).send({ text: long });
    expect(res.status).toBe(200);
    // 上游确实只收到 300 字
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sent.req_params.text).toHaveLength(300);
    const row = await TokenLedger.findOne({ user: user._id, reason: 'ark_spend' }).lean();
    expect(-row.delta).toBe(300 * tokens.TTS_TOKENS_PER_CHAR);
  });
});

describe('ASR 进钱包（5,000 token/分钟，预扣多退）', () => {
  function asrOk(durationMs, text = '你好') {
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'x-api-status-code' ? '20000000' : '') },
      text: async () => JSON.stringify({ result: { text }, audio_info: { duration: durationMs } }),
    };
  }

  it('按上游给的真实时长结算：预扣多的退回来', async () => {
    const { user, token } = await makeUser();
    // 48,000 B/s 的 wav：96,000 字节 = 估 2 秒
    const buf = Buffer.alloc(96000, 1);
    fetchSpy.mockResolvedValueOnce(asrOk(1000)); // 上游说只有 1 秒
    const res = await request(app).post('/api/asr').set('Authorization', `Bearer ${token}`).set('Content-Type', 'audio/wav').send(buf);
    expect(res.status).toBe(200);
    const spend = await TokenLedger.findOne({ user: user._id, reason: 'ark_spend' }).lean();
    const refund = await TokenLedger.findOne({ user: user._id, reason: 'ark_refund' }).lean();
    expect(-spend.delta).toBe(tokens.priceOf('asr', { seconds: 2 }));
    expect(refund.delta).toBe(tokens.priceOf('asr', { seconds: 2 }) - tokens.priceOf('asr', { seconds: 1 }));
  });

  it('★ 预扣只能多不能少：估的秒数必须是上界，否则就是白送', () => {
    // wav 每秒 48,000 字节是我们自己的录音参数；取更小的每秒字节数 ⇒ 秒数更大 ⇒ 预扣更多
    expect(tokens.ASR_BYTES_PER_SECOND.wav).toBeGreaterThanOrEqual(48000);
    expect(tokens.ASR_BYTES_PER_SECOND.mp3).toBeLessThanOrEqual(8000);
  });

  it('整段静音（上游受理了但没人说话）→ 退全款，不算失败', async () => {
    const { user, token } = await makeUser();
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: (k) => (k === 'x-api-status-code' ? '20000003' : '') }, text: async () => '{}' });
    const res = await request(app).post('/api/asr').set('Authorization', `Bearer ${token}`).set('Content-Type', 'audio/wav').send(Buffer.alloc(96000, 1));
    expect(res.status).toBe(200);
    expect(res.body.silent).toBe(true);
    expect(await balance(user._id)).toBe(tokens.planOf('free').monthlyTokens);
  });

  it('余额不足 → 402 且不调上游', async () => {
    const { user, token } = await makeUser();
    await wallet.ensureWallet(user._id);
    await User.updateOne({ _id: user._id }, { $set: { 'tokenWallet.plan': 1, 'tokenWallet.addon': 0 } });
    const res = await request(app).post('/api/asr').set('Authorization', `Bearer ${token}`).set('Content-Type', 'audio/wav').send(Buffer.alloc(96000, 1));
    expect(res.status).toBe(402);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Runway：没价目不许跑（绝不降级成免费）', () => {
  it('不在价目表里的档位 → 501 RUNWAY_NOT_PRICED，且不调上游', async () => {
    const { token } = await makeUser();
    process.env.RUNWAY_API_KEY = 'test-key';
    try {
      const res = await request(app)
        .post('/api/runway/video')
        .set('Authorization', `Bearer ${token}`)
        .send({ model: 'some_unpriced_model', promptImage: 'data:image/png;base64,QQ==', duration: 5 });
      expect(res.status).toBe(501);
      expect(res.body.code).toBe('RUNWAY_NOT_PRICED');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.RUNWAY_API_KEY;
    }
  });

  it('价目能回溯到 Runway 自己的价目页（credit 面值 $0.01）', () => {
    // gen4_turbo 5 cr/秒 = $0.05/秒；$1 = 447,563 token ⇒ 22,378 → 取整到百位 22,400
    expect(tokens.RUNWAY_TOKENS_PER_SECOND.gen4_turbo).toBe(22400);
    expect(tokens.RUNWAY_TOKENS_PER_SECOND.hailuo3).toBe(44800); // 10 cr/秒
    expect(tokens.RUNWAY_TOKENS_PER_SECOND.h3_max).toBe(35800); // 8 cr/秒
    expect(tokens.priceOf('runway', { model: 'gen4_turbo', duration: 5 })).toBe(5 * 22400);
    // hailuo3 另收每张参考图 2 cr（$0.02 → 9,000）
    expect(tokens.priceOf('runway', { model: 'hailuo3', duration: 6 })).toBe(6 * 44800 + 9000);
  });
});

describe('每日上限（§14.10）', () => {
  it('付费档撞到硬线 → 429 DAILY_LIMIT，文案是整句人话', async () => {
    const { user, token } = await makeUser();
    await wallet.buyPlan(user._id, 'pro');
    await wallet.credit(user._id, 10_000_000, 'recharge');
    // 伪造今天已经花掉 3M
    await TokenLedger.create({ user: user._id, delta: -tokens.DAILY_LIMITS.paidHardDaily, reason: 'ark_spend', balanceAfter: 0 });
    fetchSpy.mockResolvedValueOnce(ttsOk());
    const res = await request(app).post('/api/tts').set('Authorization', `Bearer ${token}`).send({ text: '你好' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('DAILY_LIMIT');
    expect(res.body.message).toMatch(/上限/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('退款要抵掉当天用量：扣了又退的失败调用不该吃掉额度', async () => {
    const { user } = await makeUser();
    await TokenLedger.create({ user: user._id, delta: -50000, reason: 'ark_spend', balanceAfter: 0 });
    await TokenLedger.create({ user: user._id, delta: 50000, reason: 'ark_refund', balanceAfter: 0 });
    expect(await wallet.spentToday(user._id)).toBe(0);
  });

  it('免费档的日上限不能低到「一段视频都出不来」（死配置自检）', () => {
    // 方案 §14.10 自己点名的形状：日上限 < 最短一段的价钱 ⇒ 那条闸门永远触发不到
    const cheapestVideo = 67200; // H3-Max 480P 最短一段（方案 §18.2）
    expect(tokens.DAILY_LIMITS.freeDaily).toBeGreaterThanOrEqual(cheapestVideo);
  });
});

describe('★ 不许再出现「调了付费上游却不扣费」的链路', () => {
  it('每一条调付费上游的路由都引到了钱（billing / chargedArkCall）', () => {
    const dir = path.join(__dirname, '..', 'src', 'routes');
    // 这张表就是「哪些路由会花钱」的登记册。新增一条调上游的路由时：
    // 要么接进 billing（推荐），要么在下面的 FREE_BY_DESIGN 里写明白为什么不用。
    const MUST_CHARGE = ['tts.routes.js', 'asr.routes.js', 'runway.routes.js', 'companion.routes.js', 'support.routes.js', 'minimax.routes.js', 'ark.routes.js'];
    // ⚠ 控制器里也有直接调模型的（人格试聊）—— 只扫 routes/ 会漏掉它，而这次真的漏过一次
    const MUST_CHARGE_CTRL = ['persona.controller.js'];
    const missing = [];
    for (const f of MUST_CHARGE) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!/billing\.|chargedArkCall/.test(src)) missing.push(f);
    }
    for (const f of MUST_CHARGE_CTRL) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', f), 'utf8');
      if (!/billing\./.test(src)) missing.push(f);
    }
    expect(missing).toEqual([]);
  });

  it('priceOf 认得四条链路的 kind（缺一个就是一条白跑的链路）', () => {
    expect(tokens.priceOf('tts', { text: 'ab' })).toBeGreaterThan(0);
    expect(tokens.priceOf('asr', { seconds: 1 })).toBeGreaterThan(0);
    expect(tokens.priceOf('chat', {})).toBeGreaterThan(0);
    expect(tokens.priceOf('image', { model: 'doubao-seedream-4-0-250828' })).toBeGreaterThan(0);
  });
});
