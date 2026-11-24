// tests/gameRoomBusRedis.spec.js
// 工坊对局推送总线（services/gameRoomBus）的**跨实例**回归测试（2026-11-24）。
//
// 钉四件事：
//   ① 有 Redis 时 A 实例 publish → B 实例的订阅者收到（两个独立的 bus，各自一条订阅连接）；
//   ② 不重复：A 自己的订阅者只收到一次（A 发布的回环靠 instanceId 丢掉，本地那条是发布时直接分发的）；
//   ③ 没有 Redis（清掉 env / 指向不可用端口）→ 退回进程内广播，发布仍投递本实例，
//      /api/ark/health 的 gameRoomStreamShared=false；
//   ④ 订阅者退订 / 归零之后不再收到；没人订阅时收到的消息直接丢（没有缓存给后来的订阅者）。
//
// ★ 为什么单独一个文件：跨实例分支需要**真的连一个 Redis**。其它 gameRoomStream 用例跑的是
//   无 Redis 的进程内路径（连不上 Redis 时本文件的 ③ 也照跑）；两条路径代码完全不同，
//   只测进程内等于 Redis 分支零覆盖。
//
// ★ 没有可用 Redis 时整个跨实例套件跳过（本地开发与 CI 不该因缺 Redis 而失败），但会打一条
//   提示，避免「以为测过了其实跳过了」。用 REDIS_TEST_URL 指定；未设则回退到本机默认地址。
//
// ★ 文件开头先清掉 REDIS_URL：默认单例（生产代码 require 的那一个）必须落在「没有 Redis」的
//   分支上，否则开发机 / CI 里导出的 REDIS_URL 会让 ③ 的能力位断言变成偶发红。跨实例用例
//   自己显式传 redisUrl 建独立实例。
const SAVED_ENV = { REDIS_URL: process.env.REDIS_URL, GAME_ROOMS: process.env.GAME_ROOMS };
delete process.env.REDIS_URL;
// 能力位那一断言要房间总开关是「开」的（GAME_ROOMS=off 时 gameRoomStream 本来就是 false）。
delete process.env.GAME_ROOMS;

const express = require("express");
const request = require("supertest");

const { createRoomBus } = require("../src/services/gameRoomBus");
// 只挂 ark 路由，为了真实地读一次 /api/ark/health 的 gameRoomStreamShared（不连业务库 —— 健康端点不读库）
const arkRoutes = require("../src/routes/ark.routes");

const TEST_URL = process.env.REDIS_TEST_URL || "redis://127.0.0.1:6379";

// 探测（connect + ping）的总预算，到点就按「不可用」跳过；理由同 tests/rateLimitRedis.spec.js
const PROBE_BUDGET_MS = 3_000;
const PROBE_HOOK_TIMEOUT_MS = 10_000;

// require 放模块顶层：载入 redis 包是同步的（几百个模块），放进 beforeAll 会吃掉 hook 超时
const { createClient } = require("redis");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 5_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** 安静的路由 / 总线日志：测试进程里不要被「没有 REDIS_URL」那一行淹没 */
function quietLogger(sink = []) {
  return {
    warn: (...args) => sink.push(args.join(" ")),
    log: () => {},
  };
}

let available = false;
let probeClient = null;

beforeAll(async () => {
  let client = null;
  let budgetTimer;
  try {
    client = createClient({
      url: TEST_URL,
      // reconnectStrategy:false 必不可少：node-redis 默认会不断重连，connect() 因此迟迟不 reject，
      // 把这个 hook 拖到 Jest 超时（表现为「测试失败」而不是「优雅跳过」）。
      socket: { connectTimeout: 800, reconnectStrategy: false },
    });
    client.on("error", () => {});
    await Promise.race([
      client.connect().then(() => client.ping()),
      new Promise((_, reject) => {
        budgetTimer = setTimeout(
          () => reject(new Error(`探测 ${PROBE_BUDGET_MS} ms 内未完成`)),
          PROBE_BUDGET_MS,
        );
      }),
    ]);
    probeClient = client;
    available = true;
  } catch (err) {
    available = false;
    try {
      client?.destroy();
    } catch {
      // 已经关了
    }
    console.warn(
      `\n[跳过] 工坊对局总线的 Redis 跨实例测试：连不上 ${TEST_URL}（${err?.code || err?.message}）。` +
        `\n       这不是失败，但意味着跨实例分支未被覆盖。` +
        `\n       需要覆盖时启动本地 Redis 或设 REDIS_TEST_URL。\n`,
    );
  } finally {
    clearTimeout(budgetTimer);
  }
}, PROBE_HOOK_TIMEOUT_MS);

afterAll(() => {
  // 还原（Jest --runInBand 下 process.env 跨测试文件共享；别把「没有 Redis」这个状态带给别人）
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    probeClient?.destroy();
  } catch {
    // 已经关了
  }
});

/** Redis 用例的守卫：连不上就跳过（打印原因，别静默通过） */
function itRedis(name, fn) {
  test(name, async () => {
    if (!available) {
      console.warn(`[跳过] ${name}：没有可用的 Redis（${TEST_URL}）`);
      return;
    }
    await fn();
  });
}

let pairSeq = 0;

/**
 * 建两个完全独立的 bus（各自一条订阅连接 + 一条发布连接），等到两边都真的订上。
 * ★ 必须各自一条连接：同一个 client 上再建一个 bus 测不出「A 的 Redis 连接 → B 的 Redis 连接」。
 */
async function makePair(tag) {
  pairSeq += 1;
  const a = createRoomBus({
    redisUrl: TEST_URL,
    instanceId: `A-${tag}-${pairSeq}`,
    logger: quietLogger(),
    connectTimeoutMs: 800,
    subscribeRetryMs: 100,
  });
  const b = createRoomBus({
    redisUrl: TEST_URL,
    instanceId: `B-${tag}-${pairSeq}`,
    logger: quietLogger(),
    connectTimeoutMs: 800,
    subscribeRetryMs: 100,
  });
  const [aOk, bOk] = await Promise.all([a.waitUntilShared(8_000), b.waitUntilShared(8_000)]);
  if (!aOk || !bOk) {
    await a.close();
    await b.close();
    throw new Error(`两个 bus 未能进入跨实例状态（A=${aOk}, B=${bOk}）`);
  }
  return [a, b];
}

// ─────────────────────────────────────────────────────────────────────
describe("降级：没有 Redis 时退回进程内（能力位 false）", () => {
  test("publish 仍投递本实例，isShared=false；/api/ark/health 的 gameRoomStreamShared=false", async () => {
    const warnings = [];
    const bus = createRoomBus({
      redisUrl: "",
      instanceId: "local-only",
      logger: quietLogger(warnings),
    });
    try {
      const seen = [];
      const unsubscribe = bus.subscribe("LOCAL1", (event) => seen.push(event));
      expect(unsubscribe).toBeInstanceOf(Function);
      expect(bus.isShared()).toBe(false);
      expect(bus.publish("local1")).toBe(1);
      expect(seen).toEqual(["changed"]);
      unsubscribe();
      expect(bus.subscriberCount("LOCAL1")).toBe(0);

      // 日志 warn 一次（没有 REDIS_URL 是缺省状态，不该按错误刷屏）
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("REDIS_URL");
      expect(warnings[0]).toContain("退回进程内广播");

      const mini = express();
      mini.use(express.json());
      mini.use("/api/ark", arkRoutes);
      const health = await request(mini).get("/api/ark/health").expect(200);
      expect(health.body.gameRoomStreamShared).toBe(false); // false = 只有本实例能收到
      expect(health.body.gameRoomStream).toBe(true); // 有这条流（两件事分开报）
    } finally {
      await bus.close();
    }
  });

  test("REDIS_URL 不是合法 URL：构造不抛、isShared=false、本地照旧投递（配置写错不该把进程带崩）", async () => {
    const warnings = [];
    const bus = createRoomBus({
      redisUrl: "not-a-url", // node-redis 的 createClient 对这个值是同步抛 TypeError 的
      instanceId: "bad-url",
      logger: quietLogger(warnings),
    });
    try {
      const seen = [];
      bus.subscribe("BADURL1", () => seen.push("changed"));
      expect(bus.isShared()).toBe(false);
      expect(bus.publish("BADURL1")).toBe(1);
      expect(seen).toEqual(["changed"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("创建失败");
    } finally {
      await bus.close();
    }
  });

  test("REDIS_URL 指向不可用端口：构造不抛、isShared=false、本地照旧投递、warn 只一次", async () => {
    const warnings = [];
    const bus = createRoomBus({
      redisUrl: "redis://127.0.0.1:1", // 1 号端口没有服务，ECONNREFUSED
      instanceId: "redis-down",
      logger: quietLogger(warnings),
      connectTimeoutMs: 200,
      subscribeRetryMs: 50,
    });
    try {
      const seen = [];
      bus.subscribe("DOWN1", () => seen.push("changed"));
      expect(bus.isShared()).toBe(false);
      expect(bus.publish("DOWN1")).toBe(1);
      expect(seen).toEqual(["changed"]);

      await waitFor(() => warnings.length >= 1, { timeoutMs: 5_000, label: "degrade warning" });
      await sleep(300); // 给重连再失败几次的机会：有 warned 闸，不应追加
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("退回进程内广播");
      expect(bus.isShared()).toBe(false);
    } finally {
      await bus.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("跨实例：两个独立 bus（需要 Redis）", () => {
  itRedis("A publish → B 的订阅者收到；A 自己的订阅者也收到且**恰好一次**（回环被丢掉）", async () => {
    const [a, b] = await makePair("cross");
    try {
      const seenA = [];
      const seenB = [];
      const seenOther = [];
      a.subscribe("CROSS1", () => seenA.push("changed"));
      b.subscribe("cross1", () => seenB.push("changed"));
      b.subscribe("OTHER1", () => seenOther.push("changed"));

      expect(a.publish("CROSS1")).toBe(1); // 返回值仍是本进程人数，语义没变
      await waitFor(() => seenB.length >= 1, { label: "B receives A's publish" });
      await sleep(250); // 留够「自己的回环」到达的时间：没丢的话 seenA 会变成 2

      expect(seenB).toEqual(["changed"]);
      expect(seenA).toEqual(["changed"]); // 本地立即分发一次；自己的 Redis 回环被 instanceId 丢掉
      expect(seenOther).toEqual([]); // 只投递给对应的房间频道

      // ★ 发布方本进程没人订阅（写动作在 A、看的人在 B —— 这正是 cluster 下的常态）：
      //   publish 的返回值是 0，但 Redis 那一条照发，B 必须收到。
      const seenB2 = [];
      b.subscribe("CROSS2", () => seenB2.push("changed"));
      expect(a.subscriberCount("CROSS2")).toBe(0);
      expect(a.publish("CROSS2")).toBe(0);
      await waitFor(() => seenB2.length === 1, { label: "B receives with no local subscriber" });
      expect(seenB2).toEqual(["changed"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  itRedis("订阅者退订 / 归零之后不再收到；重新订阅后同一条 Redis 连接仍能收到", async () => {
    const [a, b] = await makePair("unsub");
    try {
      const seen = [];
      const unsubscribe = b.subscribe("GONE1", () => seen.push("changed"));
      a.publish("GONE1");
      await waitFor(() => seen.length === 1, { label: "first delivery" });

      unsubscribe();
      unsubscribe(); // 幂等
      expect(b.subscriberCount("GONE1")).toBe(0);
      expect(b.activeRoomCount()).toBe(0);
      a.publish("GONE1");
      await sleep(250);
      expect(seen).toEqual(["changed"]); // 退订后不再收到

      // 频道没有退订（保持简单）：重新订阅不需要重连，也立刻能收到
      b.subscribe("GONE1", () => seen.push("again"));
      a.publish("GONE1");
      await waitFor(() => seen.includes("again"), { label: "delivery after resubscribe" });
      expect(seen).toEqual(["changed", "again"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  itRedis("没人订阅时收到的消息直接丢：后来的订阅者不会收到积压的那一条", async () => {
    const [a, b] = await makePair("buffer");
    try {
      a.publish("BUFFER1"); // 此刻 B 这间房没有订阅者
      await sleep(200);

      const seen = [];
      b.subscribe("BUFFER1", () => seen.push("changed"));
      await sleep(200);
      expect(seen).toEqual([]); // 不缓存、不补发

      a.publish("BUFFER1");
      await waitFor(() => seen.length === 1, { label: "delivery after subscribe" });
      expect(seen).toEqual(["changed"]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
