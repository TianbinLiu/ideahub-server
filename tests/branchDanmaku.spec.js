// tests/branchDanmaku.spec.js
// 覆盖：分支视频弹幕（GET/POST /api/branch/videos/:id/danmaku）。
//
// ★ 这套用例盯的是四类【做错了不报错】的问题：
//   D1 别人发的弹幕我要看得见 —— 这条端点存在的全部理由。做成"只回自己发的"
//      一样是 200，只有跨账号测才发现得了。
//   D2 返回必须按 at 升序 —— 播放端是按游标扫时间轴放的，乱序会整段漏放，
//      而且漏的是"中间那几条"，肉眼极难判定是漏了还是本来就没有。
//   D3 私密作品的弹幕端点必须 404 —— 否则它就是个探测私密作品是否存在的旁路
//      （与 branchVideoVisibility 的 V1 同源，那边挡了点赞/评论，这里补弹幕）。
//   D4 mine 标记只认当前用户，且**不透出作者身份** —— 弹幕挂了 username 就等于
//      公开"谁在什么时间看了这个视频"。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `dm${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

async function publish(token, extra = {}) {
  const res = await request(app)
    .post("/api/branch/videos")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: extra.title || "弹幕测试作品",
      category: "剧情",
      segments: [{ title: "第一段", firstFrame: "https://cdn.example.com/a.jpg", durationSec: 10 }],
      ...extra,
    })
    .expect(201);
  return String(res.body.video._id);
}

function send(token, id, body) {
  return request(app).post(`/api/branch/videos/${id}/danmaku`).set("Authorization", `Bearer ${token}`).send(body);
}

describe("弹幕", () => {
  test("D1 别人发的弹幕，我（以及没登录的人）都看得见", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const id = await publish(author.token);

    await send(author.token, id, { at: 1.5, text: "作者发的" }).expect(201);
    await send(viewer.token, id, { at: 2.5, text: "观众发的" }).expect(201);

    // 换个人看
    const asOther = await request(app)
      .get(`/api/branch/videos/${id}/danmaku`)
      .set("Authorization", `Bearer ${viewer.token}`)
      .expect(200);
    expect(asOther.body.items.map((d) => d.text)).toEqual(["作者发的", "观众发的"]);

    // 完全不登录也看得见（首页允许游客浏览）
    const anon = await request(app).get(`/api/branch/videos/${id}/danmaku`).expect(200);
    expect(anon.body.items).toHaveLength(2);
    expect(anon.body.items.every((d) => d.mine === false)).toBe(true);
  });

  test("D2 返回按 at 升序，与发送顺序无关", async () => {
    const user = await registerUser();
    const id = await publish(user.token);
    // 故意乱序发
    for (const at of [7.5, 0.5, 3, 9.25, 1]) {
      await send(user.token, id, { at, text: `t${at}` }).expect(201);
    }
    const res = await request(app).get(`/api/branch/videos/${id}/danmaku`).expect(200);
    expect(res.body.items.map((d) => d.at)).toEqual([0.5, 1, 3, 7.5, 9.25]);
  });

  test("D3 私密作品：别人读不到也发不了，且回的是 404 不是 403", async () => {
    const author = await registerUser();
    const stranger = await registerUser();
    const id = await publish(author.token, { visibility: "private", title: "私密的" });

    await send(author.token, id, { at: 1, text: "自己能发" }).expect(201);

    await request(app)
      .get(`/api/branch/videos/${id}/danmaku`)
      .set("Authorization", `Bearer ${stranger.token}`)
      .expect(404);
    await send(stranger.token, id, { at: 1, text: "别人不能发" }).expect(404);
    await request(app).get(`/api/branch/videos/${id}/danmaku`).expect(404); // 游客

    // 作者本人仍然读得到
    const mine = await request(app)
      .get(`/api/branch/videos/${id}/danmaku`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(mine.body.items).toHaveLength(1);
  });

  test("D4 mine 只对自己为真，且返回里没有任何作者身份字段", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const id = await publish(a.token);
    await send(a.token, id, { at: 1, text: "A 的" }).expect(201);
    await send(b.token, id, { at: 2, text: "B 的" }).expect(201);

    const asA = await request(app)
      .get(`/api/branch/videos/${id}/danmaku`)
      .set("Authorization", `Bearer ${a.token}`)
      .expect(200);
    expect(asA.body.items.map((d) => d.mine)).toEqual([true, false]);

    const asB = await request(app)
      .get(`/api/branch/videos/${id}/danmaku`)
      .set("Authorization", `Bearer ${b.token}`)
      .expect(200);
    expect(asB.body.items.map((d) => d.mine)).toEqual([false, true]);

    // 弹幕是匿名的：一个字段都不许带出作者
    for (const d of asA.body.items) {
      expect(Object.keys(d).sort()).toEqual(["_id", "at", "color", "createdAt", "mine", "text"]);
    }
  });

  test("D5 未登录不能发；正文/时间/颜色的边界一律 400", async () => {
    const user = await registerUser();
    const id = await publish(user.token);

    await request(app).post(`/api/branch/videos/${id}/danmaku`).send({ at: 1, text: "游客" }).expect(401);

    await send(user.token, id, { at: 1, text: "" }).expect(400); // 空
    await send(user.token, id, { at: 1, text: " ".repeat(5) }).expect(400); // 全空格，trim 后为空
    await send(user.token, id, { at: 1, text: "字".repeat(41) }).expect(400); // 超 40 字
    await send(user.token, id, { at: -1, text: "负数秒" }).expect(400);
    await send(user.token, id, { at: 999999, text: "离谱的秒" }).expect(400);
    // ★ 颜色最后会原样进客户端的 style.color，收任意字符串等于把用户可控文本喂进 CSS
    await send(user.token, id, { at: 1, text: "坏色", color: "red; background:url(x)" }).expect(400);
    await send(user.token, id, { at: 1, text: "好色", color: "#ff6b81" }).expect(201);
  });

  test("D6 limit 截断时要如实说，而且留下的是最新的那些", async () => {
    const user = await registerUser();
    const id = await publish(user.token);
    for (let i = 0; i < 5; i += 1) {
      await send(user.token, id, { at: i, text: `第${i}条` }).expect(201);
    }
    const res = await request(app).get(`/api/branch/videos/${id}/danmaku?limit=3`).expect(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.truncated).toBe(true);
    // 采样口径是"最新的 N 条"，不是"at 最小的 N 条" —— 一条爆火作品的开头
    // 被老弹幕占满、后发的永远看不见，那这个功能就废了
    expect(res.body.items.map((d) => d.text)).toEqual(["第2条", "第3条", "第4条"]);

    const full = await request(app).get(`/api/branch/videos/${id}/danmaku`).expect(200);
    expect(full.body.truncated).toBe(false);
  });

  test("D7 视频 id 不合法 / 不存在，分别是 400 与 404", async () => {
    const user = await registerUser();
    await request(app).get("/api/branch/videos/not-an-id/danmaku").expect(400);
    const ghost = new mongoose.Types.ObjectId().toString();
    await request(app).get(`/api/branch/videos/${ghost}/danmaku`).expect(404);
    await send(user.token, ghost, { at: 1, text: "x" }).expect(404);
  });
});
