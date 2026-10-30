// tests/oauthAppState.spec.js
// OAuth 深链回程回带 App 的一次性 state（2026-10-15；routes/oauth.routes.js 文件头与 appStateOf 的 ★）。
//
// ★ 这份盯的是一条「松了就登错号、且零报错」的不变量：回 App 的深链 ideahub://oauth?token=… 手机上任何一个 App 都发得出，
//   App 只认带着自己那份 state 回来的。所以要钉死：
//     ① 发起那一跳把合形状的 state 签进我们的 OAuth state（app 字段），不合的当没带 —— 2.62 及更早的 App 一个都不带（2.63 起才带），不能 400；
//     ② 成功 / 失败两种回跳都把它原样回带（state=），网页落点与 App 深链落点都要；
//     ③ 签名对不上的 state 一个字都不回带（我们没法替它作保）；没带的也不多出一个空的 state=；
//     ④ 绑定流（/oauth/link/start → /oauth/*/link → callback）不受影响；
//     ⑤ provider 拒了（passport 的 fail 那一支）：App 发起的回 App 并回带（2026-10-19 起，routes 的 failBack；原来走写死的
//       failureRedirect 落在官网、App 什么都收不到），网页发起的照旧经 /api/auth/oauth/fail 落到官网。
//       各种失败（过期 state、伪造签名、provider 报别的错、换 token 失败）用真 passport 逐条钉在 oauthFailBack.spec.js。
//
// passport 整个 mock 掉：真 passport 要去 provider 换 token，这里只需要它做的两件事 ——
//   发起那一跳带着 options.state 302 去 provider；回调那一跳（routes 的 oauthCallback 用 passport 的自定义回调写法）
//   把 provider 交回来的人交给回调（或交 false = provider 拒了）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

jest.mock("passport", () => {
  const mock = {
    use: jest.fn(),
    initialize: () => (_req, _res, next) => next(),
    /** 每次 passport.authenticate(strategy, options) 记一笔；发起那一跳签好的 state 从这里读 */
    calls: [],
    /** 回调那一跳 provider 交回来的人（config/passport 的形状：{ provider, profile }）；null = provider 拒了 → 回调收到 false */
    user: null,
    authenticate(strategy, options = {}, callback) {
      return (req, res, next) => {
        mock.calls.push({ strategy, options });
        if (!callback) {
          // 发起（/oauth/:provider 与 /oauth/:provider/link 都不带回调）：真 passport 会 302 去 provider 的授权页，state 在它的查询串里
          return res.redirect(`https://provider.test/authorize?state=${encodeURIComponent(options.state || "")}`);
        }
        // 回调：与真 passport 的自定义回调同形 —— 成功 (null, user, info)，fail (null, false, challenge)
        return mock.user ? callback(null, mock.user, {}) : callback(null, false, { message: "denied" });
      };
    },
  };
  return mock;
});

const passport = require("passport");

/** App 真发的那种形状：16 位 URL 安全字符 */
const APP_STATE = "k9_Zx-2026abcDEF";
const WEB = "https://ideahubs.test";

let mongod;
let app;
let User;
let jwtUtil;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-sec";
  process.env.CLIENT_BASE_URL = WEB;
  process.env.SERVER_BASE_URL = "https://api.ideahubs.test";
  process.env.APP_OAUTH_SCHEME = "ideahub";
  // 两个 provider 都「配了」：/oauth/link/start 只给 availableProviders 里的发票；passport.use 是 mock，不会真的连谁
  process.env.GOOGLE_CLIENT_ID = "google-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.GITHUB_CLIENT_ID = "github-id";
  process.env.GITHUB_CLIENT_SECRET = "github-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = mongoose.model("User");
  await User.syncIndexes();
  jwtUtil = require("../src/utils/jwt");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  passport.calls.length = 0;
  passport.user = null;
});

/** 发起那一跳交给 passport 的 state，解开 */
function startedState() {
  return jwtUtil.verifyOauthState(passport.calls.at(-1).options.state);
}
const location = (res) => new URL(res.headers.location);
const google = (id = "google-1", email = "alice@example.com") => ({
  provider: "google",
  profile: { id, displayName: "Alice", emails: [{ value: email }], photos: [] },
});
const github = (id = "github-1", email = "bob@example.com") => ({
  provider: "github",
  profile: { id, username: "bob", emails: email ? [{ value: email }] : [], photos: [] },
});
const callback = (provider, state) => request(app).get(`/api/auth/oauth/${provider}/callback?code=c0de&state=${encodeURIComponent(state)}`);

describe("① 发起那一跳：合形状的 state 签进去，不合的当没带", () => {
  test.each([["google"], ["github"]])("%s：?state= 合形状 → 签进 OAuth state 的 app 字段，next 照旧", async (provider) => {
    const res = await request(app).get(`/api/auth/oauth/${provider}?state=${APP_STATE}&next=%2Fme`).expect(302);
    expect(res.headers.location).toMatch(/^https:\/\/provider\.test\/authorize\?state=/);
    expect(startedState()).toMatchObject({ provider, next: "/me", app: APP_STATE });
  });

  test.each([
    ["太短（7 位）", "state=abcdefg"],
    ["带空格 / 斜杠", "state=abc%20def%2F1234"],
    ["太长（129 位）", `state=${"a".repeat(129)}`],
    ["空串", "state="],
    ["没带（老 App / 网页）", ""],
    ["给了两个（数组）", "state=a1234567&state=b1234567"],
  ])("%s → 照常发起（302，不是 400），签进去的 state 里没有 app", async (_label, qs) => {
    await request(app).get(`/api/auth/oauth/google?${qs}`).expect(302);
    const st = startedState();
    expect(st.provider).toBe("google");
    expect(st.app).toBeUndefined();
  });
});

describe("② 回调那一跳：成功 / 失败都回带，网页与 App 两种落点", () => {
  test("网页落点 · 成功：/oauth/callback?next=…&token=…&state=…", async () => {
    passport.user = google();
    const res = await callback("google", jwtUtil.signOauthState({ next: "/me", provider: "google", app: APP_STATE })).expect(302);
    const u = location(res);
    expect(`${u.origin}${u.pathname}`).toBe(`${WEB}/oauth/callback`);
    expect(u.searchParams.get("next")).toBe("/me");
    expect(u.searchParams.get("token")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe(APP_STATE);
    expect(await User.findOne({ "providers.google": "google-1" }).lean()).toBeTruthy(); // 登录本身照常：新用户建了
  });

  test("App 落点 · 成功：ideahub://oauth?token=…&state=…（不带 next，与改之前一样）", async () => {
    passport.user = github();
    const res = await callback("github", jwtUtil.signOauthState({ next: "ideahub://oauth", provider: "github", app: APP_STATE })).expect(302);
    expect(res.headers.location).toMatch(/^ideahub:\/\/oauth\?/);
    const u = location(res);
    expect(u.searchParams.get("token")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe(APP_STATE);
    expect(u.searchParams.has("next")).toBe(false);
  });

  test("App 落点 · 失败（provider 回来的人没有 profile）：ideahub://oauth?error=…&state=…", async () => {
    passport.user = { provider: "google", profile: null };
    const res = await callback("google", jwtUtil.signOauthState({ next: "ideahub://oauth", provider: "google", app: APP_STATE })).expect(302);
    expect(res.headers.location).toMatch(/^ideahub:\/\/oauth\?/);
    const u = location(res);
    expect(u.searchParams.get("error")).toBe("oauth_failed");
    expect(u.searchParams.get("message")).toBe("Missing google profile");
    expect(u.searchParams.get("state")).toBe(APP_STATE);
    expect(u.searchParams.has("token")).toBe(false);
  });

  test("网页落点 · 失败（github 邮箱已被别的登录方式占用 → oauth_conflict）也回带", async () => {
    await User.create({ username: "bob_pw", email: "bob@example.com", role: "user", passwordHash: "hashed" });
    passport.user = github("github-9", "bob@example.com");
    const res = await callback("github", jwtUtil.signOauthState({ next: "/", provider: "github", app: APP_STATE })).expect(302);
    const u = location(res);
    expect(`${u.origin}${u.pathname}`).toBe(`${WEB}/oauth/callback`);
    expect(u.searchParams.get("error")).toBe("oauth_conflict");
    expect(u.searchParams.get("state")).toBe(APP_STATE);
  });

  test("③ 签名对不上的 state：打回，且一个字都不回带（我们没法替它作保）", async () => {
    passport.user = google();
    const forged = Buffer.from(JSON.stringify({ next: "ideahub://oauth", provider: "google", app: APP_STATE })).toString("base64url");
    const res = await callback("google", forged).expect(302);
    const u = location(res);
    expect(u.searchParams.get("error")).toBe("oauth_failed");
    expect(u.searchParams.get("message")).toBe("Invalid or expired OAuth state");
    expect(u.searchParams.has("state")).toBe(false);
  });

  test("③ 老 App / 网页：state 里没有 app → 回跳里不多出一个空的 state=", async () => {
    passport.user = google();
    const res = await callback("google", jwtUtil.signOauthState({ next: "/", provider: "google" })).expect(302);
    const u = location(res);
    expect(u.searchParams.get("token")).toBeTruthy();
    expect(u.searchParams.has("state")).toBe(false);
  });
});

describe("④ 绑定流不受影响", () => {
  test("link/start 的票里没有 app（body 里塞 state 也不认）；绑定成功回 linked=，不带 state=", async () => {
    const user = await User.create({ username: "carol", email: "carol@example.com", role: "user", passwordHash: "hashed" });
    const token = jwtUtil.signToken(user);
    const start = await request(app)
      .post("/api/auth/oauth/link/start")
      .set("Authorization", `Bearer ${token}`)
      .send({ provider: "google", next: "/me", state: APP_STATE })
      .expect(200);
    const raw = new URL(start.body.redirectUrl).searchParams.get("state");
    const ticket = jwtUtil.verifyOauthState(raw);
    expect(ticket).toMatchObject({ mode: "link", provider: "google", next: "/me", linkUserId: String(user._id) });
    expect(ticket.app).toBeUndefined();

    // /oauth/google/link 原样把这张票交给 passport
    await request(app).get(`/api/auth/oauth/google/link?state=${encodeURIComponent(raw)}`).expect(302);
    expect(passport.calls.at(-1).options.state).toBe(raw);

    passport.user = google("google-7", "carol@example.com");
    const res = await callback("google", raw).expect(302);
    const u = location(res);
    expect(u.searchParams.get("linked")).toBe("google");
    expect(u.searchParams.get("next")).toBe("/me");
    expect(u.searchParams.has("state")).toBe(false);
    expect(u.searchParams.has("token")).toBe(false);
    expect((await User.findById(user._id).lean()).providers.google).toBe("google-7");
  });
});

describe("⑤ provider 拒了：App 发起的回 App 并回带，网页发起的照旧经 /api/auth/oauth/fail", () => {
  test("App 发起 → ideahub://oauth?error=…&state=…（2026-10-19 起；原来落在官网、不回带）", async () => {
    passport.user = null;
    const res = await callback("google", jwtUtil.signOauthState({ next: "ideahub://oauth", provider: "google", app: APP_STATE })).expect(302);
    expect(res.headers.location).toMatch(/^ideahub:\/\/oauth\?/);
    const u = location(res);
    expect(u.searchParams.get("error")).toBe("oauth_failed");
    expect(u.searchParams.get("message")).toBe("google login failed");
    expect(u.searchParams.get("state")).toBe(APP_STATE);
    expect(u.searchParams.has("token")).toBe(false);
  });

  test("网页发起 → /api/auth/oauth/fail → 回跳只有 error=，没有 state=（与改之前一样）", async () => {
    passport.user = null;
    const first = await callback("google", jwtUtil.signOauthState({ next: "/me", provider: "google", app: APP_STATE })).expect(302);
    expect(first.headers.location).toBe("/api/auth/oauth/fail?provider=google");
    // 就算有人往 fail 后面拼一个 state=，它没签过名，照样不回带
    const res = await request(app).get(`/api/auth/oauth/fail?provider=google&state=${APP_STATE}`).expect(302);
    const u = location(res);
    expect(u.searchParams.get("error")).toBe("oauth_failed");
    expect(u.searchParams.has("state")).toBe(false);
  });
});
