// tests/qqLogin.spec.js
// 覆盖：QQ 登录（移动应用 / 原生 SDK 链路）POST /api/auth/oauth/qq/native。
//
// ★ 这份测试盯的**不是**"能不能登进去"，而是三条一旦松掉就等于账号接管、
//   而且全都【不报错】的不变量：
//     ① 客户端送上来的 openid 一律不作数 —— 身份只认 QQ 告诉服务端的那个。
//        写错了的表现是"登进去了"，测试要证明登进去的是**谁**。
//     ② /oauth2.0/me 返回的 client_id 必须等于我们的 AppID。
//        不核对的话，拿"给别的应用签发的 access_token"也能进来（confused deputy）。
//     ③ QQ 的错误是 HTTP 200 + body 里的 error 字段（还常裹一层 JSONP）。
//        只看状态码的实现会把失败当成功，然后拿着空 openid 往下走。
//
// 出网被整体 stub 掉：不打真的 graph.qq.com（既慢又要真 AppKey，还会把测试变成网络探针）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const APP_ID = "1905467096";
/** QQ 真正认可的那个人 */
const REAL_OPENID = "OPENID_REAL_AAAAAAAAAAAAAAAAAAAA";
/** 客户端谎称的那个人（受害者）*/
const VICTIM_OPENID = "OPENID_VICTIM_BBBBBBBBBBBBBBBBBB";

let mongod;
let app;
let User;
/** 每个用例自己决定 graph.qq.com 怎么回话 */
let graphHandler;
let realFetch;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-sec";
  process.env.QQ_APP_ID = APP_ID;
  process.env.QQ_APP_KEY = "test-app-key";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = mongoose.model("User");
  await User.syncIndexes();

  realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    const body = graphHandler(u);
    return { ok: true, status: 200, text: async () => body };
  };
});

afterAll(async () => {
  global.fetch = realFetch;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  // 默认：一切正常，token 端点直接带回 openid
  graphHandler = (u) => {
    if (u.pathname === "/oauth2.0/token") {
      return JSON.stringify({ access_token: "AT", expires_in: 7776000, openid: REAL_OPENID });
    }
    if (u.pathname === "/oauth2.0/me") {
      return JSON.stringify({ client_id: APP_ID, openid: REAL_OPENID });
    }
    if (u.pathname === "/user/get_user_info") {
      return JSON.stringify({ ret: 0, nickname: "阿真", figureurl_qq_2: "https://q.qq.com/a.png" });
    }
    return JSON.stringify({ error: 404, error_description: "unexpected path" });
  };
});

function login(body) {
  return request(app).post("/api/auth/oauth/qq/native").send(body);
}

// ① 客户端送的 openid 不作数 —— 这是整条链路存在的理由
test("客户端多送一个 openid：登进去的仍是 QQ 认可的那个人", async () => {
  // 先让受害者存在，攻击者才有得冒充
  await User.create({
    username: "victim",
    email: `qq_${VICTIM_OPENID}@no-email.ideahub.local`,
    passwordHash: "",
    providers: { google: "", github: "", qq: VICTIM_OPENID },
  });

  const res = await login({ code: "CODE", openid: VICTIM_OPENID, access_token: "forged" });
  expect(res.status).toBe(201); // 建的是新号（REAL_OPENID），不是登进受害者那个

  const me = await User.findById(res.body.user.id).lean();
  expect(me.providers.qq).toBe(REAL_OPENID);
  expect(me.username).not.toBe("victim");

  // 受害者那条纹丝不动
  const victim = await User.findOne({ username: "victim" }).lean();
  expect(victim.providers.qq).toBe(VICTIM_OPENID);
});

// ② confused deputy：token 是真的，但它是别的应用的
test("me 返回的 client_id 不是我们的 AppID：拒绝", async () => {
  graphHandler = (u) => {
    if (u.pathname === "/oauth2.0/token") return JSON.stringify({ access_token: "AT" }); // 不带 openid，逼它走 /me
    if (u.pathname === "/oauth2.0/me") return JSON.stringify({ client_id: "999999999", openid: VICTIM_OPENID });
    return "{}";
  };

  const res = await login({ code: "CODE" });
  expect(res.status).toBe(400);
  expect(await User.countDocuments()).toBe(0);
});

// ③ QQ 的失败是 200 + JSONP 包着的 error
test("QQ 用 200 回一个 JSONP 错误：必须判失败，不能建号", async () => {
  graphHandler = () => 'callback( {"error":100016,"error_description":"access token check failed"} );';

  const res = await login({ code: "EXPIRED" });
  expect(res.status).toBe(400);
  expect(String(res.body.message || "")).toContain("100016");
  expect(await User.countDocuments()).toBe(0);
});

// token 端点不带 openid 时要能退到 /me（这条走通了 ② 才有意义）
test("token 端点没给 openid：退到 /oauth2.0/me 拿", async () => {
  graphHandler = (u) => {
    if (u.pathname === "/oauth2.0/token") return "access_token=AT&expires_in=7776000"; // 老式 querystring 回包
    if (u.pathname === "/oauth2.0/me") return JSON.stringify({ client_id: APP_ID, openid: REAL_OPENID });
    return JSON.stringify({ ret: -1 });
  };

  const res = await login({ code: "CODE" });
  expect(res.status).toBe(201);
  const me = await User.findById(res.body.user.id).lean();
  expect(me.providers.qq).toBe(REAL_OPENID);
});

test("同一个 openid 再登一次：复用原账号，不重复建号", async () => {
  const first = await login({ code: "CODE1" });
  expect(first.status).toBe(201);

  const second = await login({ code: "CODE2" });
  expect(second.status).toBe(200);
  expect(second.body.created).toBe(false);
  expect(second.body.user.id).toBe(first.body.user.id);
  expect(await User.countDocuments()).toBe(1);
});

test("新建的 QQ 用户：昵称进 displayName，用户名是随机的、邮箱是合成的", async () => {
  const res = await login({ code: "CODE" });
  const me = await User.findById(res.body.user.id).lean();

  expect(me.displayName).toBe("阿真");
  // ★ 用户名不从昵称派生：它是公开的 @ 句柄，而且中文昵称洗完是空串，
  //   所有 QQ 用户会去抢同一个名字
  expect(me.username).toMatch(/^user_[0-9a-f]{8}$/);
  expect(me.email).toBe(`qq_${REAL_OPENID}@no-email.ideahub.local`);
  expect(me.passwordHash).toBe("");
});

test("没配 QQ_APP_KEY 时整条特性关闭（503），而不是拿空密钥去打 QQ", async () => {
  const saved = process.env.QQ_APP_KEY;
  delete process.env.QQ_APP_KEY;
  try {
    const res = await login({ code: "CODE" });
    expect(res.status).toBe(503);
  } finally {
    process.env.QQ_APP_KEY = saved;
  }
});
