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

// ★ require 放在模块顶层，不能挪回 beforeAll 里。
//   载入 redis 包是同步的（600+ 个模块），而 hook 的超时从 hook 开始就在计时；
//   同步代码执行期间任何定时器都插不进来，connectTimeout 更管不到这一段。
//   实测（2026-09-30，Windows 11 / Node 24）：这一步空闲时 ~0.35 s，CPU 8 倍超订
//   （32 个逻辑核跑 256 个满载线程）时 6–7 s —— 单它就超过 Jest 默认 5 s 的 hook
//   超时，三条用例一起报「Exceeded timeout of 5000 ms for a hook」，而连接本身
//   几毫秒就 ECONNREFUSED 了。模块求值阶段 Jest 不计超时，放这里慢也只是慢。
const { createClient } = require("redis");

// ★ 探测（connect + ping）的总预算，到点就按「不可用」跳过。
//   connectTimeout 只管 TCP 握手：TCP 连上之后的 HELLO / CLIENT SETINFO 握手
//   没有超时，ping 走 node-redis 6 默认的 5 s 命令超时，又恰好等于 Jest 的 hook
//   超时 —— 对端「收连接但不回话」时，没有这道预算 hook 一定超时（与负载无关）。
//   预算要宽：本机 Redis 几毫秒就回 PONG，给窄了会在高负载下把可用的 Redis
//   误判成不可用，悄悄丢掉覆盖。连接被拒（最常见的跳过原因）几毫秒就结束，不受它影响。
const PROBE_BUDGET_MS = 3_000;
// hook 自己的超时只是兜底，必须明显大于预算：要让预算来裁决，而不是 Jest。
const PROBE_HOOK_TIMEOUT_MS = 10_000;

let available = false;
let probeClient = null;

beforeAll(async () => {
  let client = null;
  let budgetTimer;
  try {
    client = createClient({
      url: TEST_URL,
      // ★ reconnectStrategy:false 必不可少 —— node-redis 默认会不断重连，
      //   connect() 因此迟迟不 reject，把这个 hook 拖到 Jest 超时（表现为
      //   「测试失败」而不是「优雅跳过」）。探测用的客户端要的就是快速失败。
      socket: { connectTimeout: 800, reconnectStrategy: false },
    });
    client.on("error", () => {});
    await Promise.race([
      client.connect().then(() => client.ping()),
      new Promise((_, reject) => {
        budgetTimer = setTimeout(
          () => reject(new Error(`探测 ${PROBE_BUDGET_MS} ms 内未完成`)),
          PROBE_BUDGET_MS
        );
      }),
    ]);
    probeClient = client;
    available = true;
  } catch (err) {
    available = false;
    // 用 destroy() 而不是 quit()/close()：后两者要等服务端回话，正是可能挂住的那一步。
    // destroy() 是同步的；连接早已失败时它抛 ClientClosedError，吞掉即可。
    try { client?.destroy(); } catch {}
    console.warn(
      `\n[跳过] Redis 限流集成测试：连不上 ${TEST_URL}（${err?.code || err?.message}）。` +
      `\n       这不是失败，但意味着 Redis 分支未被覆盖。` +
      `\n       需要覆盖时启动本地 Redis 或设 REDIS_TEST_URL。\n`
    );
  } finally {
    clearTimeout(budgetTimer);
  }
}, PROBE_HOOK_TIMEOUT_MS);

afterAll(() => {
  if (probeClient) {
    try { probeClient.destroy(); } catch {}
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
