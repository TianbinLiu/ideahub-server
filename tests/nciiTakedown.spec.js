/**
 * NCII 移除通道（TAKE IT DOWN Act §3）：免登录入口、48 小时时限、已知相同副本检索、到期提醒。
 * 法条出处见 routes/takedown.routes.js 与 models/TakedownRequest.js 的文件头。
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

const sentEmails = [];
jest.mock('../src/services/email.service', () => ({
  sendEmail: jest.fn(async (msg) => {
    sentEmails.push(msg);
    return { ok: true };
  }),
  sendEmailOtp: jest.fn(async () => ({ ok: true })),
}));

let mongod;
let app;
let TakedownRequest;
let Report;
let User;
let BranchVideo;
let BranchDeck;
let ncii;
let signToken;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
  TakedownRequest = require('../src/models/TakedownRequest');
  Report = require('../src/models/Report');
  User = require('../src/models/User');
  BranchVideo = require('../src/models/BranchVideo');
  BranchDeck = require('../src/models/BranchDeck');
  ncii = require('../src/services/nciiTakedown.service');
  ({ signToken } = require('../src/utils/jwt'));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  sentEmails.length = 0;
  process.env.TAKEDOWN_NOTIFY_EMAIL = 'abuse@ideahubs.org';
});

async function makeUser(role = 'user') {
  const rand = new mongoose.Types.ObjectId().toString().slice(-6);
  const u = await User.create({ username: `td_${rand}`, email: `${rand}@test.local`, role, passwordHash: 'x' });
  return { user: u, token: signToken(u) };
}

const validBody = {
  signature: '张三',
  contactEmail: 'victim@example.com',
  urls: ['https://res.cloudinary.com/demo/image/upload/v1/abc123.jpg'],
  statement: '这段影像是未经我同意被发布的。',
  affirmedNotConsensual: true,
};

describe('免登录的移除请求入口（§3(a)/(b)）', () => {
  it('不带 token 也能提交，并且当场给出 48 小时的到期时间', async () => {
    const res = await request(app).post('/api/takedown').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.slaHours).toBe(48);
    const doc = await TakedownRequest.findById(res.body.id).lean();
    expect(doc.status).toBe('pending');
    // dueAt 由 receivedAt 推导，不接受调用方传值
    expect(new Date(doc.dueAt) - new Date(doc.receivedAt)).toBe(48 * 3600 * 1000);
  });

  it('请求人塞 dueAt 也改不了时限（48 小时不是一个能自己往后挪的数字）', async () => {
    const far = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const res = await request(app).post('/api/takedown').send({ ...validBody, dueAt: far, status: 'removed' });
    expect(res.status).toBe(201);
    const doc = await TakedownRequest.findById(res.body.id).lean();
    expect(new Date(doc.dueAt).getTime()).toBeLessThan(far.getTime());
    expect(doc.status).toBe('pending');
  });

  it('直接写库也挪不动时限——不只是路由的 zod 在挡（将来后台补录一条也走同一条 pre hook）', async () => {
    const far = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const doc = await TakedownRequest.create({ ...validBody, dueAt: far, receivedAt: new Date() });
    expect(new Date(doc.dueAt) - new Date(doc.receivedAt)).toBe(48 * 3600 * 1000);
  });

  it('四个法定要件缺一不可：没签名 / 没联系方式 / 没位置 / 没勾「未经同意」都 400', async () => {
    const cases = [
      { ...validBody, signature: '' },
      { ...validBody, contactEmail: '' },
      { ...validBody, urls: [] },
      { ...validBody, affirmedNotConsensual: false },
    ];
    for (const body of cases) {
      const res = await request(app).post('/api/takedown').send(body);
      expect(res.status).toBe(400);
    }
    expect(await TakedownRequest.countDocuments()).toBe(0);
  });

  it('收到就发信给管理员：48 小时等不到有人正好打开后台', async () => {
    await request(app).post('/api/takedown').send(validBody);
    // 邮件是异步发的（不挡住请求），等一拍
    await new Promise((r) => setTimeout(r, 30));
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toEqual(['abuse@ideahubs.org']);
    expect(sentEmails[0].text).toContain('48 小时');
    expect(sentEmails[0].text).toContain(validBody.urls[0]);
  });

  it('提交本身不动任何内容——移除永远要人先看过', async () => {
    const { user } = await makeUser();
    const v = await BranchVideo.create({ author: user._id, title: '作品', cover: validBody.urls[0] });
    await request(app).post('/api/takedown').send(validBody);
    const after = await BranchVideo.findById(v._id).lean();
    expect(after).not.toBeNull();
    expect(after.cover).toBe(validBody.urls[0]);
  });
});

describe('已知相同副本检索（§3(b)(1)(B)）', () => {
  it('同一个资产地址被别人的卡组快照引用时也要找出来', async () => {
    const { user } = await makeUser();
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/victim.jpg';
    const v = await BranchVideo.create({ author: user._id, title: '原作', cover: url });
    const other = await makeUser();
    // 卡组快照按 URL 抄地址（installDeck 不重新上传）⇒ 删掉原作，这一份还在
    const deck = await BranchDeck.create({
      owner: other.user._id,
      name: '别人的卡组',
      published: true,
      cards: [{ cardId: 'c1', cover: url, views: [{ url, kind: 'face' }] }],
    });
    const { refs } = await ncii.findReferences([url]);
    const models = refs.map((r) => `${r.model}:${r.id}`);
    expect(models).toContain(`BranchVideo:${v._id}`);
    expect(models).toContain(`BranchDeck:${deck._id}`);
  });

  it('给的是作品页链接时，展开成这条作品的全部资产再找副本', async () => {
    const { user } = await makeUser();
    const frame = 'https://res.cloudinary.com/demo/image/upload/v1/frame9.jpg';
    const v = await BranchVideo.create({
      author: user._id,
      title: '原作',
      cover: 'https://res.cloudinary.com/demo/image/upload/v1/cover9.jpg',
      segments: [{ firstFrame: frame, videoUrl: 'https://res.cloudinary.com/demo/video/upload/v1/seg9.mp4' }],
    });
    const copy = await BranchVideo.create({ author: user._id, title: '回炉后的新版', cover: frame });
    const { refs, urls } = await ncii.findReferences([`https://ideahubs.org/video/${v._id}`]);
    expect(urls).toContain(frame);
    expect(refs.map((r) => r.id)).toContain(String(copy._id));
  });

  it('改过尺寸的 Cloudinary 地址算同一张图（只按整串比会漏）', async () => {
    const { user } = await makeUser();
    const original = 'https://res.cloudinary.com/demo/image/upload/v1699/abc123.jpg';
    const resized = 'https://res.cloudinary.com/demo/image/upload/w_400,c_fill/v1699/abc123.jpg';
    await User.updateOne({ _id: user._id }, { $set: { avatarUrl: resized } });
    const { refs } = await ncii.findReferences([original]);
    expect(refs.some((r) => r.model === 'User' && r.url === resized)).toBe(true);
  });

  it('页面链接的尾段（24 位 id）不会被当成文件名去误伤别的资产', async () => {
    const { user } = await makeUser();
    const id = new mongoose.Types.ObjectId();
    // 有一条别的作品，它的封面文件名恰好就是那个 id
    const unrelated = await BranchVideo.create({ author: user._id, title: '无关', cover: `https://res.cloudinary.com/demo/image/upload/v1/${id}.jpg` });
    const { refs } = await ncii.findReferences([`https://ideahubs.org/video/${id}`]);
    expect(refs.map((r) => r.id)).not.toContain(String(unrelated._id));
  });

  it('登记表漏一个模型 = 那份副本永远搜不到且零报错，所以这里逐字段核对', () => {
    const dir = path.join(__dirname, '..', 'src', 'models');
    const pattern = /^\s*([A-Za-z0-9_]*(?:[Uu]rl|[Uu]rls|cover|Cover|image|Image|avatar|Avatar|photo|Photo|video|Video|thumb|Thumb))\s*:\s*\{\s*type:\s*(\[?String\]?)/gm;
    const registered = new Map(ncii.MEDIA_SOURCES.map((s) => [s.model, s.fields.map((f) => f.split('.').pop())]));
    const missing = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const model = file.replace(/\.js$/, '');
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const known = new Set([...(registered.get(model) || []), ...(ncii.NOT_USER_MEDIA[model] || [])]);
      for (const m of src.matchAll(pattern)) {
        if (!known.has(m[1])) missing.push(`${model}.${m[1]}`);
      }
    }
    // 新增了带地址的字段 → 要么登记进 MEDIA_SOURCES（用户上传的影像），
    // 要么登记进 NOT_USER_MEDIA（外部链接 / 非影像）。两者都不是就会在这里变红。
    expect(missing).toEqual([]);
  });
});

describe('管理端：队列、检索、处置', () => {
  it('普通用户看不到队列，管理员看得到，且最急的排最前', async () => {
    const u = await makeUser();
    const admin = await makeUser('admin');
    await request(app).post('/api/takedown').send(validBody);
    await request(app).post('/api/takedown').send({ ...validBody, urls: ['https://example.com/b.jpg'] });
    // 把其中一条的到期时间往前挪，模拟先收到的那条
    const first = await TakedownRequest.findOne().sort({ createdAt: 1 });
    await TakedownRequest.updateOne({ _id: first._id }, { $set: { dueAt: new Date(Date.now() - 1000) } });

    expect((await request(app).get('/api/admin/takedown')).status).toBe(401);
    expect((await request(app).get('/api/admin/takedown').set('Authorization', `Bearer ${u.token}`)).status).toBe(403);

    const res = await request(app).get('/api/admin/takedown').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.pendingCount).toBe(2);
    expect(String(res.body.items[0]._id)).toBe(String(first._id));
    expect(res.body.items[0].overdue).toBe(true);
  });

  it('扫描留痕：跑过但 0 条，与根本没跑过，是两件事', async () => {
    const admin = await makeUser('admin');
    const created = await request(app).post('/api/takedown').send(validBody);
    const before = await TakedownRequest.findById(created.body.id).lean();
    expect(before.copySearch.ranAt).toBeNull();

    const res = await request(app).post(`/api/admin/takedown/${created.body.id}/scan`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    const after = await TakedownRequest.findById(created.body.id).lean();
    expect(after.copySearch.ranAt).not.toBeNull();
    expect(after.copySearch.foundCount).toBe(0);
  });

  it('处置记下是谁、什么时候、删了哪些（这就是 48 小时内处理过的证据）', async () => {
    const admin = await makeUser('admin');
    const created = await request(app).post('/api/takedown').send(validBody);
    const res = await request(app)
      .patch(`/api/admin/takedown/${created.body.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'removed', handleNote: '已删除原作与两处副本', removed: [{ model: 'BranchVideo', id: 'x', field: 'cover', url: validBody.urls[0], action: 'delete' }] });
    expect(res.status).toBe(200);
    const doc = await TakedownRequest.findById(created.body.id).lean();
    expect(doc.status).toBe('removed');
    expect(String(doc.handler)).toBe(String(admin.user._id));
    expect(doc.handledAt).not.toBeNull();
    expect(doc.removed).toHaveLength(1);
  });

  it('乱写的 id 是 404，不是 500', async () => {
    const admin = await makeUser('admin');
    expect((await request(app).post('/api/admin/takedown/not-an-id/scan').set('Authorization', `Bearer ${admin.token}`)).status).toBe(404);
    expect(
      (await request(app).patch('/api/admin/takedown/not-an-id').set('Authorization', `Bearer ${admin.token}`).send({ status: 'rejected' })).status
    ).toBe(404);
  });
});

describe('到期提醒', () => {
  it('剩不到 12 小时提醒一次、超时再提醒一次，同一档不重发', async () => {
    const created = await request(app).post('/api/takedown').send(validBody);
    await new Promise((r) => setTimeout(r, 30));
    sentEmails.length = 0;

    // 还早：不提醒
    await ncii.sweepDueReminders();
    expect(sentEmails).toHaveLength(0);

    // 剩 6 小时
    await TakedownRequest.updateOne({ _id: created.body.id }, { $set: { dueAt: new Date(Date.now() + 6 * 3600 * 1000) } });
    await ncii.sweepDueReminders();
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].subject).toContain('即将到期');
    await ncii.sweepDueReminders(); // 同一档不重发
    expect(sentEmails).toHaveLength(1);

    // 超时
    await TakedownRequest.updateOne({ _id: created.body.id }, { $set: { dueAt: new Date(Date.now() - 1000) } });
    await ncii.sweepDueReminders();
    expect(sentEmails).toHaveLength(2);
    expect(sentEmails[1].subject).toContain('逾期');

    // 处理完就不再提醒
    await TakedownRequest.updateOne({ _id: created.body.id }, { $set: { status: 'removed' } });
    await ncii.sweepDueReminders();
    expect(sentEmails).toHaveLength(2);
  });

  it('发信失败就不要记 stage，否则下一轮把提醒静默吞掉', async () => {
    const created = await request(app).post('/api/takedown').send(validBody);
    await TakedownRequest.updateOne({ _id: created.body.id }, { $set: { dueAt: new Date(Date.now() + 3600 * 1000) } });
    const { sendEmail } = require('../src/services/email.service');
    sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    await ncii.sweepDueReminders();
    expect((await TakedownRequest.findById(created.body.id).lean()).reminderStage).toBe('');
    await ncii.sweepDueReminders();
    expect((await TakedownRequest.findById(created.body.id).lean()).reminderStage).toBe('soon');
  });
});

describe('站内举报里的 ncii 理由', () => {
  it('是个独立理由、且和 csae 一样插队', () => {
    expect(Report.REASONS).toContain('ncii');
    expect(Report.URGENT_REASONS).toContain('ncii');
    expect(Report.REASON_LABELS.ncii).toBeTruthy();
  });

  it('提交后 priority=1，排在普通举报前面', async () => {
    const { user, token } = await makeUser();
    const other = await makeUser();
    const v = await BranchVideo.create({ author: other.user._id, title: '作品' });
    const res = await request(app)
      .post('/api/branch/reports')
      .set('Authorization', `Bearer ${token}`)
      .send({ targetType: 'video', targetId: String(v._id), reason: 'ncii' });
    expect(res.status).toBe(201);
    const doc = await Report.findOne({ reporter: user._id }).lean();
    expect(doc.priority).toBe(1);
  });
});
