// tests/oauthFailBack.spec.js
// 第三方登录**失败**也回到 App（2026-10-19，2.63 发版后验证 oauth-4b；routes/oauth.routes.js 的 failBack / oauthCallback）。
//
// ★ 为什么单开一份、而且用**真 passport**：失败分几种，各走 passport-oauth2 的不同分支 ——
//   取消授权（error=access_denied）→ this.fail；provider 报了别的错（server_error …）→ this.error(AuthorizationError)；
//   换 token / 取资料失败 → this.error；带 code 但我们的 state 过期 → passport 那边照常成功（策略没配 state store，用的是
//   不验 state 的 NullStore），到我们的处理函数里 decodeState 才失败。oauthAppState.spec 把 passport 整个 mock 掉，
//   这些分支一条都走不到；原来的毛病（失败落在官网、非 access_denied 回 JSON 5xx）恰恰就藏在这些分支里。
//   所以这里只把「去 provider 换 token」与「取资料」两件对外请求换成桩，其余都是 config/passport 真注册的策略。
//
// 钉死的事：
//   A  App 发起 + 取消授权 → ideahub://oauth?error=…&state=<App 的原串>（原来落在官网、不回带）；
//   B  App 发起 + 我们的 state 过期（取消，或 provider 那边成功了）→ 同上，带 state，而且**不登录**；
//   C  签名不对 / 根本不是我们的 state → 一个字都不回带、照改之前的样子落网页；
//   D  网页发起的失败与改之前逐字节一样；
//   E  next 被改成外域 / 深链的近似写法 → 不跟着走（回程目标只经 safeNextPath + isAppTarget）；
//   F  access_denied 以外的 provider 错误、换 token / 取资料失败 → 不再 5xx，provider 的原话不进 URL；
//   G  成功与起跳不变（真 passport 对照）；
//   H  safeNextPath 的控制字符闸（字面 NUL / DEL 字节改成 \u 转义之后）语义不变；
//   I  换 token 回了 2xx 却没有 access_token（GitHub 对坏 code 的回法，passport-oauth2 交出一个裸 Error）→ 只记一行 warn、
//      不落堆栈，回程不变；别的裸 Error 照旧整份落 console.error（2026-10-20，生产验证 #119 时打出来的）；
//   J  签进 state 的 provider 与回调那一家对不上 → 当不是我们的：失败落网页不回带、成功不登录不绑定；同一家与没写 provider 的照旧
//      （2026-10-20，纵深防御）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const passport = require("passport");

/** App 真发的那种形状（hex 32 位） */
const APP_STATE = "0123456789abcdef0123456789abcdef";
const WEB = "https://ideahubs.test";
const APP_TARGET = "ideahub://oauth";
const webFail = (provider) => `/api/auth/oauth/fail?provider=${provider}`;

let mongod;
let app;
let User;
let jwtUtil;
let warn;

/** 两件对外请求的桩：缺省都成功；个别用例换成失败 */
let tokenStub;
let profileStub;
const okToken = (cb) => cb(null, "access-token", "refresh-token", {});
const profileOf = (provider) =>
  provider === "google"
    ? { provider: "google", id: "g-1", displayName: "Alice", emails: [{ value: "alice@example.com" }], photos: [] }
    : { provider: "github", id: "h-1", username: "bob", emails: [{ value: "bob@example.com" }], photos: [] };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-sec";
  process.env.CLIENT_BASE_URL = WEB;
  process.env.SERVER_BASE_URL = "https://api.ideahubs.test";
  process.env.APP_OAUTH_SCHEME = "ideahub";
  // 两家都「配了」：config/passport 会注册真的 GoogleStrategy / GitHubStrategy
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

  // 每个请求用的是 Object.create(注册的策略)：在注册的那个实例上换掉两件对外请求，请求里就都是桩
  for (const name of ["google", "github"]) {
    const s = passport._strategy(name);
    expect(s).toBeTruthy();
    s._oauth2.getOAuthAccessToken = (_code, _params, cb) => tokenStub(cb);
    s.userProfile = (_accessToken, done) => profileStub(name, done);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  tokenStub = okToken;
  profileStub = (name, done) => done(null, profileOf(name));
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

/** 走一遍真的起跳，取出我们签好、交给 provider 的 state */
async function startState(provider, next, appState) {
  const qs = new URLSearchParams({ next });
  if (appState !== undefined) qs.set("state", appState);
  const res = await request(app).get(`/api/auth/oauth/${provider}?${qs}`).expect(302);
  const u = new URL(res.headers.location);
  expect(u.host).toBe(provider === "google" ? "accounts.google.com" : "github.com");
  return u.searchParams.get("state");
}

/** 签一张 11 分钟前签发、1 分钟前过期的 state（与 signOauthState 同一个函数，只是 iat 往前挪） */
function expiredState(payload) {
  return jwtUtil.signOauthState({ ...payload, iat: Math.floor(Date.now() / 1000) - 11 * 60 });
}

function cb(provider, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  return request(app).get(`/api/auth/oauth/${provider}/callback?${qs}`);
}
const denied = (provider, state, extra = {}) => cb(provider, { error: "access_denied", ...extra, state });
const withCode = (provider, state) => cb(provider, { code: "c0de-from-provider", state });

/** 断言落到 App 深链：失败、带 App 的原串、不带 token / next */
function expectAppFail(res, message, state = APP_STATE) {
  expect(res.status).toBe(302);
  expect(res.headers.location).toMatch(/^ideahub:\/\/oauth\?/);
  const u = new URL(res.headers.location);
  expect(u.searchParams.get("error")).toBe("oauth_failed");
  expect(u.searchParams.get("message")).toBe(message);
  if (state === null) expect(u.searchParams.has("state")).toBe(false);
  else expect(u.searchParams.get("state")).toBe(state);
  expect(u.searchParams.has("token")).toBe(false);
  expect(u.searchParams.has("next")).toBe(false);
}

describe("A · App 发起、用户在 provider 那边取消授权 → 回 App 并回带 state", () => {
  test("google：error=access_denied → ideahub://oauth?error=oauth_failed&message=…&state=<原串>", async () => {
    const st = await startState("google", APP_TARGET, APP_STATE);
    expectAppFail(await denied("google", st), "google login failed");
  });

  test("github（照它真实的错误回调形状带 error_description / error_uri）→ 同上，provider 的原话不进 URL", async () => {
    const st = await startState("github", APP_TARGET, APP_STATE);
    const res = await denied("github", st, {
      error_description: "The user has denied your application access.",
      error_uri: "https://docs.github.com/apps/troubleshooting",
    });
    expectAppFail(res, "github login failed");
    expect(res.headers.location).not.toMatch(/denied|docs\.github/);
  });

  test("老 App（起跳没带 state）→ 也回 App，但不带 state=（与成功那条一样：没有就不回带）", async () => {
    const st = await startState("google", APP_TARGET);
    expectAppFail(await denied("google", st), "google login failed", null);
  });
});

describe("B · App 发起、我们签的 state 过期了（在 provider 那边耽搁超过 10 分钟）→ 回 App 并回带 state，不登录", () => {
  const payload = { next: APP_TARGET, provider: "google", app: APP_STATE };

  test("过期 state + 取消授权", async () => {
    const st = expiredState(payload);
    expect(() => jwtUtil.verifyOauthState(st)).toThrow(/expired/);
    expectAppFail(await denied("google", st), "google login failed");
  });

  test("过期 state + provider 那边成功了（带真 code）→ 不登录、不建号，回 App 说 state 过期", async () => {
    const res = await withCode("google", expiredState(payload));
    expectAppFail(res, "Invalid or expired OAuth state");
    expect(await User.countDocuments({})).toBe(0);
  });

  test("github 同一条", async () => {
    const st = expiredState({ ...payload, provider: "github" });
    expectAppFail(await denied("github", st), "github login failed");
    expectAppFail(await withCode("github", st), "Invalid or expired OAuth state");
    expect(await User.countDocuments({})).toBe(0);
  });

  test("签进去的 app 不合形状（只可能是签发那一侧出了岔子）→ 回 App 但不回带它", async () => {
    const st = expiredState({ ...payload, app: "bad<state>1" });
    expectAppFail(await denied("google", st), "google login failed", null);
  });
});

describe("C · 签名不对 / 根本不是我们的 state → 不回带、照原样落网页", () => {
  const secret = () => process.env.JWT_SECRET;
  const appPayload = { next: APP_TARGET, provider: "google", app: APP_STATE };
  const past = () => Math.floor(Date.now() / 1000) - 11 * 60;
  const cases = [
    ["签名改了一位", () => {
      const [h, p, s] = jwtUtil.signOauthState(appPayload).split(".");
      const i = 10;
      return `${h}.${p}.${s.slice(0, i)}${s[i] === "A" ? "B" : "A"}${s.slice(i + 1)}`;
    }],
    ["payload 换过、签名照旧", () => {
      const [h, , s] = jwtUtil.signOauthState({ next: "/", provider: "google" }).split(".");
      const p = Buffer.from(JSON.stringify({ ...appPayload, purpose: "oauth-state" })).toString("base64url");
      return `${h}.${p}.${s}`;
    }],
    ["别的密钥签的", () => jwt.sign({ ...appPayload, purpose: "oauth-state" }, "another-secret-another-secret-xx", { expiresIn: "10m" })],
    ["别的密钥签的、又过期了（过期也得先验过签名）", () =>
      jwt.sign({ ...appPayload, purpose: "oauth-state", iat: past() }, "another-secret-another-secret-xx", { expiresIn: "10m" })],
    ["alg=none", () => jwt.sign({ ...appPayload, purpose: "oauth-state" }, "", { algorithm: "none" })],
    ["同一把密钥签的登录 token（purpose 不对）", () => jwt.sign({ sub: "u1", role: "user", ...appPayload }, secret(), { expiresIn: "10m" })],
    ["同一把密钥签的登录 token、过期了（只在过期那一支补的 purpose 判断）", () =>
      jwt.sign({ sub: "u1", role: "user", ...appPayload, iat: past() }, secret(), { expiresIn: "10m" })],
    ["不是 JWT", () => "not-a-jwt-hello"],
    ["App 自己的原串", () => APP_STATE],
    ["空串", () => ""],
  ];

  test.each(cases)("%s + 取消授权 → 照旧 302 /api/auth/oauth/fail，不回带", async (_label, make) => {
    const res = await denied("google", make()).expect(302);
    expect(res.headers.location).toBe(webFail("google"));
  });

  test.each(cases)("%s + 带 code → 照旧落官网 next=/、不登录、不回带", async (_label, make) => {
    const res = await withCode("google", make()).expect(302);
    expect(res.headers.location).toBe(`${WEB}/oauth/callback?next=%2F&error=oauth_failed&message=Invalid+or+expired+OAuth+state`);
    expect(await User.countDocuments({})).toBe(0);
  });

  test("根本没带 state + 取消授权 → 照旧经 /oauth/fail", async () => {
    const res = await cb("google", { error: "access_denied" }).expect(302);
    expect(res.headers.location).toBe(webFail("google"));
  });

  test("/oauth/fail 后面拼的 state= 没签过名，照样不回带", async () => {
    const res = await request(app).get(`/api/auth/oauth/fail?provider=google&state=${APP_STATE}`).expect(302);
    expect(res.headers.location).toBe(`${WEB}/oauth/callback?next=%2F&error=oauth_failed&message=google+login+failed`);
  });
});

describe("D · 网页发起的失败与改之前一样", () => {
  test("取消授权 → /api/auth/oauth/fail?provider=… → 官网 /oauth/callback?next=/&error=…（两跳，都不带 state）", async () => {
    const st = await startState("google", "/me", APP_STATE);
    const first = await denied("google", st).expect(302);
    expect(first.headers.location).toBe(webFail("google"));
    const second = await request(app).get(first.headers.location).expect(302);
    expect(second.headers.location).toBe(`${WEB}/oauth/callback?next=%2F&error=oauth_failed&message=google+login+failed`);
  });

  test("过期 state + 带 code → 官网 next=/，说 state 过期（与改之前同一串）", async () => {
    const res = await withCode("github", expiredState({ next: "/me", provider: "github", app: APP_STATE })).expect(302);
    expect(res.headers.location).toBe(`${WEB}/oauth/callback?next=%2F&error=oauth_failed&message=Invalid+or+expired+OAuth+state`);
    expect(await User.countDocuments({})).toBe(0);
  });

  test("绑定流的票（mode=link，next=/me）被拒 → 照旧经 /oauth/fail", async () => {
    const ticket = jwtUtil.signOauthState({ mode: "link", provider: "google", next: "/me", linkUserId: "507f1f77bcf86cd799439011" });
    const res = await denied("google", ticket).expect(302);
    expect(res.headers.location).toBe(webFail("google"));
  });
});

describe("E · next 被改成外域 / 深链的近似写法 → 不跟着走", () => {
  test("起跳就带外域 next：签进去的已经是 \"/\"，失败落网页、不回带", async () => {
    const st = await startState("google", "https://evil.example/x", APP_STATE);
    expect(jwtUtil.verifyOauthState(st).next).toBe("/");
    const res = await denied("google", st).expect(302);
    expect(res.headers.location).toBe(webFail("google"));
  });

  // 签名是我们的、里面却写着别的 next：只可能是签发那一侧出了岔子；回程目标照样再过一遍 safeNextPath + isAppTarget
  test.each([
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "ideahub://oauth@evil.example/",
    "ideahub://oauth.evil.example",
    "IDEAHUB://oauth",
    "ideahub://oauth/",
    "evilscheme://oauth",
  ])("签进去的 next = %s → 落网页 /api/auth/oauth/fail，Location 里没有它", async (next) => {
    const st = jwtUtil.signOauthState({ next, provider: "google", app: APP_STATE });
    const res = await denied("google", st).expect(302);
    expect(res.headers.location).toBe(webFail("google"));
  });

  test("回调查询串里另拼的 next= 不认（只认签进去的那一个）", async () => {
    const st = await startState("google", APP_TARGET, APP_STATE);
    const res = await cb("google", { error: "access_denied", state: st, next: "https://evil.example/" });
    expectAppFail(res, "google login failed");
    expect(res.headers.location).not.toMatch(/evil/);
  });

  test("服务端没配 APP_OAUTH_SCHEME（深链特性整个关着）→ App 的 state 也落网页", async () => {
    const st = jwtUtil.signOauthState({ next: APP_TARGET, provider: "google", app: APP_STATE });
    const saved = process.env.APP_OAUTH_SCHEME;
    delete process.env.APP_OAUTH_SCHEME;
    try {
      const res = await denied("google", st).expect(302);
      expect(res.headers.location).toBe(webFail("google"));
    } finally {
      process.env.APP_OAUTH_SCHEME = saved;
    }
  });
});

describe("F · access_denied 以外的 provider 错误、换 token / 取资料失败 → 不再 5xx", () => {
  const injected = "<script>alert(1)</script> call +1-555 now";

  test.each([["server_error"], ["temporarily_unavailable"], ["admin_policy_enforced"], ["invalid_scope"], ["interaction_required"]])(
    "%s：App 发起 → 回 App 带 state；provider 的 error_description 不进 URL；记一行日志",
    async (error) => {
      const st = await startState("google", APP_TARGET, APP_STATE);
      const res = await cb("google", { error, error_description: injected, state: st });
      expectAppFail(res, "google login failed");
      expect(res.headers.location).not.toMatch(/script|555/);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^\\[oauth\\] google .* AuthorizationError ${error} `)));
    },
  );

  test("server_error：网页发起 / 没带 state → 照网页失败走 /api/auth/oauth/fail（原来是 JSON 的 502）", async () => {
    const st = await startState("github", "/me", APP_STATE);
    const a = await cb("github", { error: "server_error", state: st });
    expect(a.status).toBe(302);
    expect(a.headers.location).toBe(webFail("github"));
    const b = await cb("github", { error: "server_error" });
    expect(b.status).toBe(302);
    expect(b.headers.location).toBe(webFail("github"));
  });

  test("换 token 失败（code 过期 / 用过，provider 回 invalid_grant）→ 回 App 带 state", async () => {
    tokenStub = (done) => done({ statusCode: 400, data: JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" }) });
    const st = await startState("google", APP_TARGET, APP_STATE);
    expectAppFail(await withCode("google", st), "google login failed");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[oauth\] google .* TokenError invalid_grant /));
    expect(await User.countDocuments({})).toBe(0);
  });

  test("换 token 时 provider 不回话（InternalOAuthError）→ 回 App 带 state", async () => {
    tokenStub = (done) => done({ statusCode: 503, data: "upstream down" });
    const st = await startState("github", APP_TARGET, APP_STATE);
    expectAppFail(await withCode("github", st), "github login failed");
  });

  test("取资料失败 → 回 App 带 state；不是 provider 那三种错的，整份（带堆栈）落 console.error", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      profileStub = (_name, done) => done(new Error("profile fetch failed"));
      const st = await startState("google", APP_TARGET, APP_STATE);
      expectAppFail(await withCode("google", st), "google login failed");
      const call = errSpy.mock.calls.find((c) => String(c[0]).startsWith("[oauth] google"));
      expect(call).toBeTruthy();
      expect(call[1]).toBeInstanceOf(Error);
      expect(call[1].stack).toBeTruthy();
    } finally {
      errSpy.mockRestore();
    }
  });

  test("error 码是查询串里谁都能填的：带换行也只记一行、限长（日志注入）", async () => {
    const st = await startState("google", APP_TARGET, APP_STATE);
    const forged = "server_error\n2026-10-19T00:00:00: [client-event] kind=fake" + "x".repeat(200);
    expectAppFail(await cb("google", { error: forged, state: st }), "google login failed");
    const lines = warn.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith("[oauth] google"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    expect(lines[0].length).toBeLessThan(200);
  });

  test("日志里不记 code、不记 state、不记 provider 的原话", async () => {
    const st = await startState("google", APP_TARGET, APP_STATE);
    await cb("google", { error: "server_error", error_description: injected, state: st }).expect(302);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(st);
    expect(logged).not.toContain(APP_STATE);
    expect(logged).not.toContain("script");
  });
});

describe("G · 成功与起跳不变（真 passport 对照）", () => {
  test("App 发起 + 成功 → ideahub://oauth?token=…&state=<原串>，建了号", async () => {
    const st = await startState("google", APP_TARGET, APP_STATE);
    const res = await withCode("google", st).expect(302);
    expect(res.headers.location).toMatch(/^ideahub:\/\/oauth\?/);
    const u = new URL(res.headers.location);
    expect(u.searchParams.get("token")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe(APP_STATE);
    expect(u.searchParams.has("error")).toBe(false);
    expect(await User.findOne({ "providers.google": "g-1" }).lean()).toBeTruthy();
  });

  test("网页发起 + 成功 → 官网 /oauth/callback?next=/me&token=…&state=…", async () => {
    const st = await startState("github", "/me", APP_STATE);
    const res = await withCode("github", st).expect(302);
    const u = new URL(res.headers.location);
    expect(`${u.origin}${u.pathname}`).toBe(`${WEB}/oauth/callback`);
    expect(u.searchParams.get("next")).toBe("/me");
    expect(u.searchParams.get("token")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe(APP_STATE);
  });

  test("回调既没 code 也没 error → passport 当起跳、302 去 provider（与原来一样，不经 failBack）", async () => {
    const res = await cb("google", { state: "whatever" }).expect(302);
    expect(new URL(res.headers.location).host).toBe("accounts.google.com");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("H · safeNextPath 的控制字符闸（字面 NUL / DEL 字节改成 \\u 转义）语义不变", () => {
  test.each([["/me%00x"], ["/me%0aevil"], ["/me%09x"], ["/me%1fx"], ["/me%7fx"]])("next=%s → 签进去的是 \"/\"", async (raw) => {
    const res = await request(app).get(`/api/auth/oauth/google?next=${raw}`).expect(302);
    const st = new URL(res.headers.location).searchParams.get("state");
    expect(jwtUtil.verifyOauthState(st).next).toBe("/");
  });

  test("对照：next=/me 原样签进去；~ 与 0x20 以上的可见字符不受影响", async () => {
    for (const [raw, want] of [["/me", "/me"], ["/u/~bob", "/u/~bob"], ["/a%20b", "/a b"]]) {
      const res = await request(app).get(`/api/auth/oauth/google?next=${raw}`).expect(302);
      const st = new URL(res.headers.location).searchParams.get("state");
      expect(jwtUtil.verifyOauthState(st).next).toBe(want);
    }
  });
});

describe("I · 换 token 回了 2xx 却没有 access_token（GitHub 对坏 / 用过的 code 就这么回）→ 只记一行、不落堆栈", () => {
  // GitHub 真实的回法：HTTP 200，body 里是 error 而没有 access_token。node-oauth 照 2xx 当成功、交出 accessToken = undefined，
  // passport-oauth2 1.8.0（lib/strategy.js 第 178 行）于是交出一个裸的 new Error('Failed to obtain access token')。
  const badCode = (done) =>
    done(null, undefined, undefined, {
      error: "bad_verification_code",
      error_description: "The code passed is incorrect or expired.",
      error_uri: "https://docs.github.com/apps/troubleshooting-oauth-app-access-token-request-errors",
    });
  let errSpy;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  /** 恰好一次 console.warn、只有一个参数（一行字，后面没跟 Error 对象）、没有换行 / 堆栈；console.error 一次都没调 */
  function expectOneLine(provider) {
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    const line = warn.mock.calls[0][0];
    expect(typeof line).toBe("string");
    expect(line).toMatch(new RegExp(`^\\[oauth\\] ${provider} .*: Error no_access_token -$`));
    expect(line).not.toMatch(/[\r\n]|\bat |strategy\.js/);
    expect(errSpy).not.toHaveBeenCalled();
  }

  test("github · App 发起 → 回 App 带 state（与改之前一样）、不建号；日志里没有 provider 的原话、code、state", async () => {
    tokenStub = badCode;
    const st = await startState("github", APP_TARGET, APP_STATE);
    expectAppFail(await withCode("github", st), "github login failed");
    expectOneLine("github");
    expect(await User.countDocuments({})).toBe(0);
    const logged = JSON.stringify(warn.mock.calls);
    for (const s of ["bad_verification_code", "incorrect", "c0de-from-provider", st, APP_STATE]) expect(logged).not.toContain(s);
  });

  test("github · 网页发起 → 照旧 302 /api/auth/oauth/fail?provider=github", async () => {
    tokenStub = badCode;
    const st = await startState("github", "/me", APP_STATE);
    const res = await withCode("github", st).expect(302);
    expect(res.headers.location).toBe(webFail("github"));
    expectOneLine("github");
  });

  test("google 碰上同一种回法也一样（认的是 passport-oauth2 的这一句，不认是哪一家）", async () => {
    tokenStub = badCode;
    const st = await startState("google", APP_TARGET, APP_STATE);
    expectAppFail(await withCode("google", st), "google login failed");
    expectOneLine("google");
  });

  test.each([
    ["别的话的裸 Error", () => new Error("profile fetch failed")],
    ["同一句话多一个空格", () => new Error("Failed to obtain access token ")],
    ["同一句话、但是 TypeError", () => new TypeError("Failed to obtain access token")],
    ["同一句话、Error 的子类（name 也是 \"Error\"）", () => new (class extends Error {})("Failed to obtain access token")],
  ])("只认那一个：%s → 照旧整份（带堆栈）落 console.error、不记 warn，回程不变", async (_label, make) => {
    profileStub = (_name, done) => done(make());
    const st = await startState("github", APP_TARGET, APP_STATE);
    expectAppFail(await withCode("github", st), "github login failed");
    const call = errSpy.mock.calls.find((c) => String(c[0]).startsWith("[oauth] github"));
    expect(call).toBeTruthy();
    expect(call[1]).toBeInstanceOf(Error);
    expect(call[1].stack).toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("J · 签进 state 的 provider 与回调那一家对不上 → 当不是我们的（纵深防御）", () => {
  const other = { google: "github", github: "google" };
  const stateFail = `${WEB}/oauth/callback?next=%2F&error=oauth_failed&message=Invalid+or+expired+OAuth+state`;

  test.each([["google"], ["github"]])("%s 起跳签的 App state 拿到另一家的回调上 + 取消授权 → 落网页、不回带", async (signedFor) => {
    const st = await startState(signedFor, APP_TARGET, APP_STATE);
    const to = other[signedFor];
    const res = await denied(to, st).expect(302);
    expect(res.headers.location).toBe(webFail(to));
  });

  test("provider 报别的错（server_error）、换 token 失败 → 也落网页、不回带", async () => {
    const st = await startState("google", APP_TARGET, APP_STATE);
    const a = await cb("github", { error: "server_error", state: st }).expect(302);
    expect(a.headers.location).toBe(webFail("github"));
    tokenStub = (done) => done({ statusCode: 400, data: JSON.stringify({ error: "invalid_grant" }) });
    const b = await withCode("github", st).expect(302);
    expect(b.headers.location).toBe(webFail("github"));
  });

  test("过期的、签给 Google 的 App state 拿到 GitHub 回调（取消 / 带 code）→ 落网页、不回带、不建号", async () => {
    const st = expiredState({ next: APP_TARGET, provider: "google", app: APP_STATE });
    expect((await denied("github", st).expect(302)).headers.location).toBe(webFail("github"));
    expect((await withCode("github", st).expect(302)).headers.location).toBe(stateFail);
    expect(await User.countDocuments({})).toBe(0);
  });

  test.each([["google"], ["github"]])("%s 签的 App state + 带 code 打另一家的回调 → 不登录、不建号，落官网 next=/、不回带", async (signedFor) => {
    const st = await startState(signedFor, APP_TARGET, APP_STATE);
    const res = await withCode(other[signedFor], st).expect(302);
    expect(res.headers.location).toBe(stateFail);
    expect(await User.countDocuments({})).toBe(0);
  });

  test("签给 Google 的绑定票拿到 GitHub 回调 + code → 不绑 GitHub", async () => {
    const user = await User.create({ username: "carol", email: "carol@example.com", role: "user", passwordHash: "hashed" });
    const ticket = jwtUtil.signOauthState({ mode: "link", provider: "google", next: "/me", linkUserId: String(user._id) });
    const res = await withCode("github", ticket).expect(302);
    expect(res.headers.location).toBe(stateFail);
    expect((await User.findById(user._id).lean()).providers?.github || "").toBe("");
    expect(await User.countDocuments({})).toBe(1);
  });

  test.each([["google"], ["github"]])("对照 · 同一家签的照旧：%s 取消授权回 App 带 state，带 code 登录回 App 带 token + state", async (p) => {
    const st = await startState(p, APP_TARGET, APP_STATE);
    expectAppFail(await denied(p, st), `${p} login failed`);
    const ok = await withCode(p, st).expect(302);
    expect(ok.headers.location).toMatch(/^ideahub:\/\/oauth\?/);
    const u = new URL(ok.headers.location);
    expect(u.searchParams.get("token")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe(APP_STATE);
  });

  test.each([["google"], ["github"]])("对照 · 没写 provider 的 state 照旧认（缺省 = 认）：%s", async (p) => {
    const st = jwtUtil.signOauthState({ next: APP_TARGET, app: APP_STATE });
    expect(jwtUtil.verifyOauthState(st).provider).toBeUndefined();
    expectAppFail(await denied(p, st), `${p} login failed`);
    expectAppFail(await denied(p, expiredState({ next: APP_TARGET, app: APP_STATE })), `${p} login failed`);
    const ok = await withCode(p, st).expect(302);
    expect(ok.headers.location).toMatch(/^ideahub:\/\/oauth\?/);
    const u = new URL(ok.headers.location);
    expect(u.searchParams.get("token")).toBeTruthy();
    expect(u.searchParams.get("state")).toBe(APP_STATE);
  });
});
