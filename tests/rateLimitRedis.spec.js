/**
 * Redis 后端限流的集成测试。
 *
 * 为什么单独一个文件：这些用例需要真的连上 Redis，而 security.spec.js 里的
 * 限流用例跑的是【无 Redis 的回退路径】—— 两条路径的代码完全不同，
 * 只测回退路径等于 Redis 分支零覆盖。
 *
 * 没有可用 Redis 时整个套件跳过（本地开发与 CI 不该因缺 Redis 而失败），
 * 但会打一条提示，避免"以为测过了其实跳过了"。
 * 用 REDIS_TEST_URL 指定；未设则回退到本机默认地址。
 */
const TEST_URL = process.env.REDIS_TEST_URL || "redis://127.0.0.1:6379";

let available = false;
let probeClient = null;

beforeAll(async () => {
  try {
    const { createClient } = require("redis");
    probeClient = createClient({
      url: TEST_URL,
      // ★ reconnectStrategy:false 必不可少 —— node-redis 默认会不断重连，
      //   connect() 因此迟迟不 reject，把这个 hook 拖到 Jest 超时（表现为
      //   「测试失败」而不是「优雅跳过」）。探测用的客户端要的就是快速失败。
      socket: { connectTimeout: 800, reconnectStrategy: false },
    });
    probeClient.on("error", () => {});
    await probeClient.connect();
    await probeClient.ping();
    available = true;
  } catch {
    available = false;
    if (probeClient) {
      try { await probeClient.disconnect(); } catch {}
      probeClient = null;
    }
    console.warn(
      `\n[跳过] Redis 限流集成测试：连不上 ${TEST_URL}。` +
      `\n       这不是失败，但意味着 Redis 分支未被覆盖。` +
      `\n       需要覆盖时启动本地 Redis 或设 REDIS_TEST_URL。\n`
    );
  }
});

afterAll(async () => {
  if (probeClient) {
    try { await probeClient.disconnect(); } catch {}
  }
});

/** 载入一个「已配置 Redis」的限流器实例 */
function loadWithRedis() {
  jest.resetModules();
  process.env.REDIS_URL = TEST_URL;
  process.env.NODE_ENV = "development"; // test 环境限流整体关闭，这里要打开
  return require("../src/middleware/rateLimit");
}

function mkRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

/** 等 Redis 连上（模块是异步连接的） */
async function waitReady(redisMod, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (redisMod.isReady()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("Redis 后端限流", () => {
  test("计数跨【独立模块实例】共享 —— 这是 cluster 下配额准确的前提", async () => {
    if (!available) return;

    // 模拟两个 pm2 cluster 实例：两次独立 require，各自持有自己的进程内 Map。
    // 若限流仍走进程内计数，两个实例各算各的，配额会翻倍。
    const modA = loadWithRedis();
    const redisA = require("../src/config/redis");
    expect(await waitReady(redisA)).toBe(true);

    const scope = `xproc-${Date.now()}`;
    const mwA = modA.rateLimit({ windowMs: 60_000, max: 2, scope });

    jest.resetModules();
    const modB = loadWithRedis();
    const redisB = require("../src/config/redis");
    expect(await waitReady(redisB)).toBe(true);
    const mwB = modB.rateLimit({ windowMs: 60_000, max: 2, scope });

    const req = { headers: { "x-real-ip": "203.0.113.200" }, ip: "203.0.113.200", body: {} };
    let passed = 0;
    const next = () => { passed += 1; };

    await mwA(req, mkRes(), next);        // 实例 A 第 1 次
    await mwB(req, mkRes(), next);        // 实例 B 第 2 次（共享计数 → 已达 max=2）
    const r3 = mkRes();
    await mwA(req, r3, next);             // 第 3 次应被拒

    expect(passed).toBe(2);
    expect(r3.statusCode).toBe(429);      // 若走进程内计数，这里会放行（各自才第 2 次）
    expect(r3.headers["Retry-After"]).toBeDefined();

    await redisA.quit();
    await redisB.quit();
  });

  test("不同 key 互不影响", async () => {
    if (!available) return;

    const mod = loadWithRedis();
    const r = require("../src/config/redis");
    expect(await waitReady(r)).toBe(true);

    const scope = `isolate-${Date.now()}`;
    const mw = mod.rateLimit({ windowMs: 60_000, max: 1, scope });

    let passed = 0;
    const next = () => { passed += 1; };
    const mk = (ip) => ({ headers: { "x-real-ip": ip }, ip, body: {} });

    await mw(mk("198.51.100.1"), mkRes(), next);
    await mw(mk("198.51.100.2"), mkRes(), next);
    expect(passed).toBe(2);               // 不同 IP 各有各的桶

    const again = mkRes();
    await mw(mk("198.51.100.1"), again, next);
    expect(again.statusCode).toBe(429);   // 同 IP 第 2 次被拒

    await r.quit();
  });

  test("键设置了 TTL —— 没有 TTL 的话用户会被永久限流", async () => {
    if (!available) return;

    const mod = loadWithRedis();
    const r = require("../src/config/redis");
    expect(await waitReady(r)).toBe(true);

    const scope = `ttl-${Date.now()}`;
    const mw = mod.rateLimit({ windowMs: 5_000, max: 5, scope });
    const ip = "198.51.100.77";
    await mw({ headers: { "x-real-ip": ip }, ip, body: {} }, mkRes(), () => {});

    const ttl = await probeClient.pTTL(`rl:${scope}:${ip}`);
    expect(ttl).toBeGreaterThan(0);       // -1 表示无 TTL = 永久限流
    expect(ttl).toBeLessThanOrEqual(5_000);

    await r.quit();
  });
});
