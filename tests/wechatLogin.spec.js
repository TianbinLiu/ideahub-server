// tests/wechatLogin.spec.js
// 覆盖：微信登录（移动应用 / 原生 SDK 链路）POST /api/auth/oauth/wechat/native。
// 与 qqLogin.spec 同一套威胁模型，另加微信特有的一条：**unionid 优先**。
//
// 钉死的不变量（全都是"松了就账号接管/静默错档，且零报错"的那类）：
//   ① 客户端送上来的 openid/unionid 一律不作数——身份只认微信告诉服务端的。
//   ② 微信的失败是 HTTP 200 + body 里的 errcode（QQ 是 error 字段，一家一个叫法）。
//   ③ 身份标识 unionid 优先、openid 兜底——两次登录若一次带 unionid 一次不带，
//      不该被认成两个人（本测试固定回 unionid，验证存的是它）。
//   ④ headimgurl 微信可能给 http://，存库前必须升 https（QQ 头像真机踩过的混合内容坑）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const APP_ID = "wx2b628676d9f7ac75";
const UNIONID = "UNIONID_REAL_AAAAAAAAAAAAAAAA";
const OPENID = "OPENID_REAL_BBBBBBBBBBBBBBBBBB";
const VICTIM = "UNIONID_VICTIM_CCCCCCCCCCCCCC";

let mongod;
let app;
let User;
let wxHandler;
let realFetch;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-sec";
  process.env.WECHAT_APP_ID = APP_ID;
  process.env.WECHAT_APP_SECRET = "test-wechat-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = mongoose.model("User");
  await User.syncIndexes();

  realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    const body = wxHandler(u);
    return { ok: true, status: 200, json: async () => body };
  };
});

afterAll(async () => {
  global.fetch = realFetch;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  wxHandler = (u) => {
    if (u.pathname === "/sns/oauth2/access_token") {
      return { access_token: "AT", expires_in: 7200, refresh_token: "RT", openid: OPENID, scope: "snsapi_userinfo", unionid: UNIONID };
    }
    if (u.pathname === "/sns/userinfo") {
      // ★ 微信文档明说 headimgurl 可能是 http:// —— 照实模拟
      return { openid: OPENID, nickname: "微信阿真", headimgurl: "http://thirdwx.qlogo.cn/x/132", unionid: UNIONID };
    }
    return { errcode: 40001, errmsg: "unexpected path" };
  };
});

function login(body) {
  return request(app).post("/api/auth/oauth/wechat/native").send(body);
}

// ① 客户端伪造身份不作数
test("客户端多送 openid/unionid：登进去的仍是微信认可的那个人", async () => {
  await User.create({
    username: "victim",
    email: `wechat_${VICTIM}@no-email.ideahub.local`,
    passwordHash: "",
    providers: { google: "", github: "", qq: "", wechat: VICTIM },
  });

  const res = await login({ code: "CODE", openid: VICTIM, unionid: VICTIM });
  expect(res.status).toBe(201);

  const me = await User.findById(res.body.user.id).lean();
  expect(me.providers.wechat).toBe(UNIONID);
  expect(me.username).not.toBe("victim");
  const victim = await User.findOne({ username: "victim" }).lean();
  expect(victim.providers.wechat).toBe(VICTIM);
});

// ② 200 + errcode = 失败
test("微信用 200 回 errcode：必须判失败，不能建号", async () => {
  wxHandler = () => ({ errcode: 40029, errmsg: "invalid code" });
  const res = await login({ code: "EXPIRED" });
  expect(res.status).toBe(400);
  expect(String(res.body.message || "")).toContain("40029");
  expect(await User.countDocuments()).toBe(0);
});

// ③ unionid 优先
test("身份标识存的是 unionid（不是 openid）", async () => {
  const res = await login({ code: "CODE" });
  expect(res.status).toBe(201);
  const me = await User.findById(res.body.user.id).lean();
  expect(me.providers.wechat).toBe(UNIONID);
  expect(me.email).toBe(`wechat_${UNIONID}@no-email.ideahub.local`);
});

test("回包不带 unionid 时退回 openid，不炸", async () => {
  wxHandler = (u) => {
    if (u.pathname === "/sns/oauth2/access_token") {
      return { access_token: "AT", openid: OPENID, scope: "snsapi_userinfo" };
    }
    return { openid: OPENID, nickname: "n", headimgurl: "" };
  };
  const res = await login({ code: "CODE" });
  expect(res.status).toBe(201);
  const me = await User.findById(res.body.user.id).lean();
  expect(me.providers.wechat).toBe(OPENID);
});

// ④ 头像升 https
test("headimgurl 的 http:// 存库前升成 https（混合内容会被静默丢弃）", async () => {
  const res = await login({ code: "CODE" });
  const me = await User.findById(res.body.user.id).lean();
  expect(me.avatarUrl).toBe("https://thirdwx.qlogo.cn/x/132");
  expect(me.displayName).toBe("微信阿真");
});

test("同一个人再登一次：复用原账号，不重复建号", async () => {
  const a = await login({ code: "C1" });
  const b = await login({ code: "C2" });
  expect(b.status).toBe(200);
  expect(b.body.created).toBe(false);
  expect(b.body.user.id).toBe(a.body.user.id);
  expect(await User.countDocuments()).toBe(1);
});

test("没配 WECHAT_APP_SECRET 时整条特性关闭（503）", async () => {
  const saved = process.env.WECHAT_APP_SECRET;
  delete process.env.WECHAT_APP_SECRET;
  try {
    const res = await login({ code: "CODE" });
    expect(res.status).toBe(503);
  } finally {
    process.env.WECHAT_APP_SECRET = saved;
  }
});
