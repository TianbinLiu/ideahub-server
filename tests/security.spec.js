/**
 * 安全回归测试。
 *
 * 这里每个用例都对应一个【真实存在过】的漏洞，不是假想威胁。
 * 加回归测试的理由：这类问题的共同点是"改回去也不会有任何报错"——
 * 删掉一行鉴权、把正则的反斜杠写多一个，功能测试全绿，只有攻击者会发现。
 */
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const { escapeRegex, searchRegex } = require("../src/utils/regex");
const { assertPublicUrl } = require("../src/utils/ssrfGuard");

describe("正则转义（ReDoS / 正则注入）", () => {
  // 曾经的写法 /[.*+?^${}()|[\\]\\]/g 多了一个反斜杠，字符类在 `]` 处提前闭合，
  // 整个 replace 成为 no-op —— 用户输入原样变成正则。
  // 实测 ?q=(a+)+$ 构造出的正则单次 test 耗时 41.7 秒，且该正则会交给 mongod 执行。
  test("元字符被真正转义（不是 no-op）", () => {
    expect(escapeRegex("(a+)+$")).toBe("\\(a\\+\\)\\+\\$");
    expect(escapeRegex(".*")).toBe("\\.\\*");
    expect(escapeRegex("a[b]c")).toBe("a\\[b\\]c");
  });

  test("灾难性回溯的输入转义后不再爆炸", () => {
    const re = searchRegex("(a+)+$", { anchored: true });
    const subject = "a".repeat(40) + "X";
    const t0 = Date.now();
    expect(re.test(subject)).toBe(false); // 只匹配字面量，匹配不上
    expect(Date.now() - t0).toBeLessThan(1000); // 未转义时这里要 40 秒以上
  });

  test("转义后的正则只匹配字面量，不再是通配", () => {
    expect(searchRegex(".*").test("anything")).toBe(false);
    expect(searchRegex(".*").test("a.*b")).toBe(true);
  });

  test("超长输入被截断", () => {
    expect(searchRegex("a".repeat(500)).source.length).toBeLessThanOrEqual(64);
  });
});

describe("SSRF 出网防护", () => {
  const blocked = [
    ["云元数据服务", "http://169.254.169.254/latest/meta-data/"],
    ["回环地址", "http://127.0.0.1:27017/"],
    ["localhost", "http://localhost:4000/api/admin"],
    ["私网 10/8", "http://10.0.0.5/"],
    ["私网 192.168/16", "http://192.168.1.1/"],
    ["私网 172.16/12", "http://172.16.0.1/"],
    ["IPv6 回环", "http://[::1]/"],
    ["IPv4 映射（点分）", "http://[::ffff:127.0.0.1]/"],
    ["IPv4 映射（十六进制）", "http://[::ffff:7f00:1]/"],
    ["NAT64", "http://[64:ff9b::127.0.0.1]/"],
    ["十进制 IP", "http://2130706433/"],
    ["非 HTTP 协议", "file:///etc/passwd"],
    ["gopher（可打 redis）", "gopher://127.0.0.1:6379/_INFO"],
    ["凭证混淆主机名", "http://user:pass@evil.com@127.0.0.1/"],
  ];

  test.each(blocked)("拦截 %s", async (_label, url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow();
  });

  test("公网地址正常放行", async () => {
    await expect(assertPublicUrl("https://example.com/")).resolves.toBeTruthy();
  });
});

describe("OAuth state 签名", () => {
  const { signOauthState, verifyOauthState } = require("../src/utils/jwt");

  test("自造的未签名 base64 state 无法通过校验", () => {
    // 这是账号接管链路的起点：decodeState 曾经在验签失败时回退到
    // JSON.parse(base64url(s))，于是任何人都能自造 { mode:"link", linkUserId:<受害者> }。
    const forged = Buffer.from(
      JSON.stringify({ mode: "link", provider: "google", linkUserId: "507f1f77bcf86cd799439011" })
    ).toString("base64url");
    expect(() => verifyOauthState(forged)).toThrow();
  });

  test("本服务签发的 state 可以通过", () => {
    const good = signOauthState({ mode: "link", linkUserId: "507f1f77bcf86cd799439011" });
    expect(verifyOauthState(good).linkUserId).toBe("507f1f77bcf86cd799439011");
  });

  test("用途不符的 token 不能当 state 用", () => {
    // 登录 token 与 state 用同一个密钥签，若不校验 purpose，
    // 登录 token 就能直接当 state 使
    const loginish = jwt.sign({ sub: "u1", role: "user" }, process.env.JWT_SECRET, { expiresIn: "10m" });
    expect(() => verifyOauthState(loginish)).toThrow();
  });

  test("algorithm=none 的 token 被拒绝", () => {
    const none = jwt.sign({ purpose: "oauth-state", linkUserId: "x" }, "", { algorithm: "none" });
    expect(() => verifyOauthState(none)).toThrow();
  });
});

describe("Live2D 上传的文件类型白名单", () => {
  // zip 解压产物落在 uploads/ 下，由 express.static 按扩展名推导 Content-Type，
  // 且该目录带 ACAO:*。放行 .html/.js/.svg 等于把存储型 XSS 送到同源上。
  const path = require("path");
  const ALLOWED = new Set([
    ".json", ".moc", ".moc3", ".mtn", ".motion3", ".exp", ".exp3",
    ".png", ".jpg", ".jpeg", ".webp",
    ".physics3", ".cdi3", ".pose3", ".userdata3", ".txt",
  ]);
  const isAllowed = (name) => {
    const base = path.basename(name).toLowerCase();
    if (base.startsWith(".")) return false;
    return ALLOWED.has(path.extname(base));
  };

  test.each([
    "evil.html", "payload.js", "icon.svg", "shell.php", ".htaccess",
    "model.png.html", "x.xml", "a.swf",
  ])("拒绝 %s", (name) => {
    expect(isAllowed(name)).toBe(false);
  });

  test.each(["model.moc3", "texture_00.png", "hiyori.model3.json", "idle.motion3.json"])(
    "放行 %s",
    (name) => {
      expect(isAllowed(name)).toBe(true);
    }
  );
});

describe("限流器", () => {
  // rateLimit 在 NODE_ENV=test 下整体关闭（否则会污染所有业务测试），
  // 所以这里直接测内部行为需要绕过那个开关 —— 用独立的模块实例。
  test("超过阈值后返回 429 且带 Retry-After", () => {
    jest.resetModules();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const { rateLimit } = require("../src/middleware/rateLimit");

    const mw = rateLimit({ windowMs: 60_000, max: 2, scope: "unit-test" });
    const req = { ip: "1.2.3.4", body: {} };
    const headers = {};
    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };

    let passed = 0;
    const next = () => { passed += 1; };

    mw(req, res, next);
    mw(req, res, next);
    expect(passed).toBe(2);

    mw(req, res, next);
    expect(passed).toBe(2);              // 第三次没有放行
    expect(res.statusCode).toBe(429);
    expect(headers["Retry-After"]).toBeDefined();

    process.env.NODE_ENV = prev;
    jest.resetModules();
  });
});
