// tests/gameRoomStream.spec.js
// 「工坊对局」的 SSE 推送（2026-11-23，把 App 的 2 秒轮询换成服务端推送）。
// 契约正本：docs/api-contract.md「工坊对局：推送（SSE）」。
//
// 覆盖：建连即 snapshot（与 GET /rooms/:code + GET rounds/current 同形）/ 写操作触发 update
// （join → ready → start → 开回合 → 交片 → 展映 → 点赞 → 投票 → 结算 → next 一条链）/
// 心跳帧格式（`event: ping\ndata: \n\n`）/ error 后关闭（ROOM_NOT_FOUND / NOT_IN_ROOM /
// GAME_ROOMS_OFF / 未登录 401）/ `?token=` 鉴权 / 每用户 2 条连接上限（429 TOO_MANY_STREAMS，
// 关一条之后又能连）/ 连接断开后 bus 订阅与名额都被清掉 / 连接寿命到期推 `end`。
//
// ★ 测试选型（任务允许二选一）：**supertest + 真实流读取**（`app.listen(0)` + 原生 fetch 的
//   ReadableStream，与 App 的用法一致），而不是直接调 handler —— 帧格式、响应头、429 状态码、
//   客户端断开后的清理都只有走真实 HTTP 才测得到。另加两段 bus 的单测（上限与退订）与一段
//   帧格式纯函数测试，补上流里不方便构造的分支。
//
// ★ 不联网、不花钱：只用 MongoMemoryServer + 本机 ephemeral 端口。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const { once } = require("events");

const gameRoomBus = require("../src/services/gameRoomBus");
const gameRoomStream = require("../src/services/gameRoomStream.service");
const config = require("../src/config/gameRoom");

// MongoMemoryServer 第一次起 + 建索引可能超过 jest 默认的 5 秒
jest.setTimeout(20000);

let mongod;
let app;
let GameRoom;
let GameQueue;
let server;
let base;

const ENV_KEYS = ["GAME_ROOMS", "GAME_STREAM_HEARTBEAT_SEC", "GAME_STREAM_MAX_SEC"];
let savedEnv;

let seq = 0;
async function registerUser(tag) {
  seq += 1;
  const name = `gs_${tag}_${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { id: res.body.user._id, username: name, token: res.body.token, auth: { Authorization: `Bearer ${res.body.token}` } };
}

const create = (u, body) => request(app).post("/api/game/rooms").set(u.auth).send(body);
const join = (u, code) => request(app).post("/api/game/rooms/join").set(u.auth).send({ code });
const ready = (u, code, value) => request(app).post(`/api/game/rooms/${code}/ready`).set(u.auth).send({ ready: value });
const start = (u, code) => request(app).post(`/api/game/rooms/${code}/start`).set(u.auth).send({});
const roundsStart = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/start`).set(u.auth).send({});
const entry = (u, code, prompt) =>
  request(app).post(`/api/game/rooms/${code}/rounds/entries`).set(u.auth).send({ prompt });
const phase = (u, code, value) => request(app).post(`/api/game/rooms/${code}/rounds/phase`).set(u.auth).send({ phase: value });
const like = (u, code, targetUserId) =>
  request(app).post(`/api/game/rooms/${code}/rounds/like`).set(u.auth).send({ targetUserId });
const vote = (u, code, targetUserId) =>
  request(app).post(`/api/game/rooms/${code}/rounds/vote`).set(u.auth).send({ targetUserId });
const settle = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/settle`).set(u.auth).send({});
const nextRound = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/next`).set(u.auth).send({});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 3000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** 解析一帧 SSE：`event: x\ndata: y\n\n`（data 空串 = ping） */
function parseFrame(raw) {
  const frame = { event: "message", data: null, dataRaw: undefined, raw: `${raw}\n\n` };
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) frame.event = line.slice(6).trim();
    else if (line.startsWith("data:")) frame.dataRaw = line.slice(5).replace(/^ /, "");
  }
  if (frame.dataRaw !== undefined) {
    if (frame.dataRaw === "") {
      frame.data = "";
    } else {
      try {
        frame.data = JSON.parse(frame.dataRaw);
      } catch {
        frame.data = frame.dataRaw;
      }
    }
  }
  return frame;
}

/** 把 fetch 的 ReadableStream 读成帧数组（缓冲不完整帧，按 `\n\n` 切） */
function startReader(body) {
  const reader = { frames: [], ended: false, error: null, cancel: null };
  const decoder = new TextDecoder();
  let buffer = "";
  const streamReader = body.getReader();
  reader.cancel = () => streamReader.cancel().catch(() => {});
  (async () => {
    try {
      for (;;) {
        const { value, done } = await streamReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          reader.frames.push(parseFrame(buffer.slice(0, index)));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      // abort 是测试自己关的，不算错误
      if (err?.name !== "AbortError") reader.error = err;
    } finally {
      reader.ended = true;
    }
  })();
  return reader;
}

/** 本文件打开过的流（afterEach 统一关掉，别让下一条用例被上一条的连接计数带偏） */
const opened = [];

async function openStream({ code, token, auth, controller }) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const res = await fetch(`${base}/api/game/rooms/${encodeURIComponent(code)}/stream${query}`, { headers, signal: controller.signal });
  if (res.status !== 200) {
    const body = await res.json().catch(() => null);
    return { res, status: res.status, body, reader: null };
  }
  const reader = startReader(res.body);
  opened.push({ controller, reader });
  return { res, status: res.status, body: null, reader };
}

function newController() {
  return new AbortController();
}

async function frameWhere(reader, predicate, label = "frame") {
  return waitFor(() => reader.frames.find(predicate), { label });
}

async function closeAllStreams() {
  for (const item of opened) {
    try {
      item.controller.abort();
    } catch {
      // 已经 aborted 了
    }
    try {
      item.reader.cancel();
    } catch {
      // 已经结束
    }
  }
  opened.length = 0;
  // 等 server 端的 res 'close' 清理跑完（退订 + 释放名额）
  await waitFor(() => gameRoomBus.activeRoomCount() === 0, { timeoutMs: 3000, label: "all stream subscriptions cleaned" }).catch(() => {});
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  GameRoom = require("../src/models/GameRoom");
  GameQueue = require("../src/models/GameQueue");
  await Promise.all([GameRoom.createIndexes(), GameQueue.createIndexes()]);

  // ★ 不用 supertest 的临时 server：SSE 是一条要读的长连接，需要一个能一直开着的端口
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await GameRoom.deleteMany({});
  await GameQueue.deleteMany({});
  gameRoomStream.resetForTests();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  await closeAllStreams();
  gameRoomStream.resetForTests();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ─────────────────────────────────────────────────────────────────────
describe("帧格式（纯函数）", () => {
  test("ping 的 data 是空串；其它事件是单行 JSON；都以空行结尾", () => {
    expect(gameRoomStream.frameOf("ping")).toBe("event: ping\ndata: \n\n");
    expect(gameRoomStream.frameOf("update", { room: { code: "ABC123" }, round: null })).toBe(
      'event: update\ndata: {"room":{"code":"ABC123"},"round":null}\n\n',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("进程内总线：广播、上限、退订", () => {
  test("publish 通知到订阅者并返回人数；退订（幂等）之后不再收到", () => {
    const seen = [];
    const unsubscribe = gameRoomBus.subscribe("ab12cd", (event) => seen.push(event));
    expect(unsubscribe).toBeInstanceOf(Function);
    expect(gameRoomBus.subscriberCount("AB12CD")).toBe(1);
    expect(gameRoomBus.publish("ab12cd")).toBe(1);
    expect(seen).toEqual(["changed"]);

    unsubscribe();
    unsubscribe(); // 幂等：连接关闭与错误两条路都会调它
    expect(gameRoomBus.subscriberCount("AB12CD")).toBe(0);
    expect(gameRoomBus.publish("AB12CD")).toBe(0);
    expect(seen).toEqual(["changed"]);
  });

  test(`同一房间最多 ${gameRoomBus.MAX_LISTENERS_PER_ROOM} 个 listener，超了返回 null（不静默丢 listener）`, () => {
    const unsubscribers = [];
    for (let i = 0; i < gameRoomBus.MAX_LISTENERS_PER_ROOM; i += 1) {
      const unsubscribe = gameRoomBus.subscribe("CAP123", () => {});
      expect(unsubscribe).toBeInstanceOf(Function);
      unsubscribers.push(unsubscribe);
    }
    expect(gameRoomBus.subscribe("CAP123", () => {})).toBeNull();
    expect(gameRoomBus.subscriberCount("CAP123")).toBe(gameRoomBus.MAX_LISTENERS_PER_ROOM);
    // 退掉一个，名额就回一个
    unsubscribers.pop()();
    const extra = gameRoomBus.subscribe("CAP123", () => {});
    expect(extra).toBeInstanceOf(Function);
    // 别把 listener 留给下一条用例（afterEach 的「订阅清零」等待会白白等满 3 秒）
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    extra();
    expect(gameRoomBus.subscriberCount("CAP123")).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("建连即 snapshot", () => {
  test("第一帧是 snapshot，room 与 GET /rooms/:code 同形（state / winners / hp），round 为 null", async () => {
    const host = await registerUser("snap");
    const created = await create(host, { mode: "custom", seats: 4 }).expect(201);
    const code = created.body.room.code;

    const controller = newController();
    const stream = await openStream({ code, auth: host.auth.Authorization, controller });
    expect(stream.status).toBe(200);
    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.res.headers.get("cache-control")).toContain("no-cache");

    const snapshot = await frameWhere(stream.reader, (frame) => frame.event === "snapshot");
    expect(snapshot.data.room).toMatchObject({
      code,
      state: "waiting",
      status: "waiting",
      winners: null,
      finishedAt: null,
      memberCount: 1,
    });
    expect(snapshot.data.room.members[0]).toMatchObject({
      userId: host.id,
      seat: 0,
      ready: true,
      hp: 100,
      isHost: true,
    });
    expect(snapshot.data.round).toBeNull();
  });

  test("?token= 走同一套校验：带 token 能连，不带 / 带错都 401（HTTP 层拒，不是 error 帧）", async () => {
    const host = await registerUser("token");
    const code = (await create(host, { mode: "custom", seats: 4 }).expect(201)).body.room.code;

    const ok = await openStream({ code, token: host.token, controller: newController() });
    expect(ok.status).toBe(200);
    expect((await frameWhere(ok.reader, (frame) => frame.event === "snapshot")).data.room.code).toBe(code);

    const anon = await fetch(`${base}/api/game/rooms/${code}/stream`);
    expect(anon.status).toBe(401);
    expect((await anon.json()).code).toBe("UNAUTHORIZED");

    const bad = await fetch(`${base}/api/game/rooms/${code}/stream?token=not-a-jwt`);
    expect(bad.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("房间 / 回合变化推 update", () => {
  test("join → ready → start → 开回合 → 交片 → 展映 → 点赞 → 投票 → 结算 → next 每一步都推一帧", async () => {
    const host = await registerUser("flow_host");
    const guest = await registerUser("flow_guest");
    const created = await create(host, { mode: "custom", seats: 2 }).expect(201);
    const code = created.body.room.code;

    const stream = await openStream({ code, auth: host.auth.Authorization, controller: newController() });
    const snapshot = await frameWhere(stream.reader, (frame) => frame.event === "snapshot");
    expect(snapshot.data.room.memberCount).toBe(1);

    // 进房
    await join(guest, code).expect(200);
    const joined = await frameWhere(stream.reader, (frame) => frame.event === "update" && frame.data.room.memberCount === 2, "join update");
    expect(joined.data.room.members).toHaveLength(2);
    expect(joined.data.room.hostId).toBe(host.id);

    // 准备
    await ready(guest, code, true).expect(200);
    await frameWhere(
      stream.reader,
      (frame) => frame.event === "update" && frame.data.room.members.some((m) => m.userId === guest.id && m.ready === true),
      "ready update",
    );

    // 开局
    await start(host, code).expect(200);
    await frameWhere(stream.reader, (frame) => frame.event === "update" && frame.data.room.state === "playing", "start update");

    // 开第 1 回合（room 快照照旧带着）；没有回合时 round 是 null，有了之后与 GET rounds/current 同形
    await roundsStart(host, code).expect(200);
    const round1 = await frameWhere(stream.reader, (frame) => frame.event === "update" && frame.data.round?.round === 1, "round start update");
    expect(round1.data.round).toMatchObject({ round: 1, phase: "creating", entries: [], allSubmitted: false, likesPending: 2 });

    // 交片（一人一条）
    await entry(host, code, "host prompt").expect(200);
    await entry(guest, code, "guest prompt").expect(200);
    const submitted = await frameWhere(stream.reader, (frame) => frame.event === "update" && frame.data.round?.entries?.length === 2, "entries update");
    expect(submitted.data.round.allSubmitted).toBe(true);

    // 展映 + 点赞（guest 赞 host）
    await phase(host, code, "screening").expect(200);
    await frameWhere(stream.reader, (frame) => frame.event === "update" && frame.data.round?.phase === "screening", "screening update");
    await like(guest, code, host.id).expect(200);
    const liked = await frameWhere(
      stream.reader,
      (frame) => frame.event === "update" && frame.data.round?.entries?.some((e) => e.userId === host.id && e.likes === 1),
      "like update",
    );
    expect(liked.data.round.likesPending).toBe(1);

    // 投票（两人互投）
    await phase(host, code, "voting").expect(200);
    await frameWhere(stream.reader, (frame) => frame.event === "update" && frame.data.round?.phase === "voting", "voting update");
    await vote(guest, code, host.id).expect(200);
    await vote(host, code, guest.id).expect(200);
    await frameWhere(stream.reader, (frame) => frame.event === "update" && frame.data.round?.votesPending === 0, "votes update");

    // 结算（全员已投，谁都能触发）
    await settle(host, code).expect(200);
    const settled = await frameWhere(stream.reader, (frame) => frame.event === "update" && frame.data.round?.phase === "settled", "settle update");
    // 2 人局各 1 票：胜者 -5、败者 -10（谁是胜者由 userId 定序，这里只查两个数）
    expect(settled.data.room.members.map((m) => m.hp).sort()).toEqual([90, 95]);

    // 下一回合
    await nextRound(host, code).expect(200);
    const round2 = await frameWhere(stream.reader, (frame) => frame.event === "update" && frame.data.round?.round === 2, "next update");
    expect(round2.data.round).toMatchObject({ round: 2, phase: "creating", entries: [] });
    expect(round2.data.room.state).toBe("playing");
  });

  test("失败的动作不推帧（NOT_HOST 的 403 什么都没改）", async () => {
    const host = await registerUser("no_bump_host");
    const guest = await registerUser("no_bump_guest");
    const created = await create(host, { mode: "custom", seats: 2 }).expect(201);
    const code = created.body.room.code;
    await join(guest, code).expect(200);

    const stream = await openStream({ code, auth: host.auth.Authorization, controller: newController() });
    await frameWhere(stream.reader, (frame) => frame.event === "snapshot");
    const before = stream.reader.frames.length;

    await start(guest, code).expect(403); // 客人不能开局
    await sleep(150);
    expect(stream.reader.frames.length).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("心跳 / 寿命", () => {
  test("每 GAME_STREAM_HEARTBEAT_SEC 推 `event: ping`，data 是空串（20 秒那个的缩短版）", async () => {
    process.env.GAME_STREAM_HEARTBEAT_SEC = "1";
    const host = await registerUser("ping");
    const code = (await create(host, { mode: "custom", seats: 4 }).expect(201)).body.room.code;

    const stream = await openStream({ code, auth: host.auth.Authorization, controller: newController() });
    await frameWhere(stream.reader, (frame) => frame.event === "snapshot");
    const ping = await frameWhere(stream.reader, (frame) => frame.event === "ping", "ping frame");
    expect(ping.data).toBe("");
    expect(ping.raw).toBe("event: ping\ndata: \n\n");
  });

  test("连接活满寿命 → 推 event: end（reason lifetime）并关闭，让客户端重连", async () => {
    process.env.GAME_STREAM_MAX_SEC = "1";
    const host = await registerUser("lifetime");
    const code = (await create(host, { mode: "custom", seats: 4 }).expect(201)).body.room.code;

    const stream = await openStream({ code, auth: host.auth.Authorization, controller: newController() });
    await frameWhere(stream.reader, (frame) => frame.event === "snapshot");
    const end = await frameWhere(stream.reader, (frame) => frame.event === "end", "end frame");
    expect(end.data).toEqual({ reason: "lifetime" });
    await waitFor(() => stream.reader.ended, { label: "stream closed after end" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("error 帧之后关闭连接", () => {
  test("房号不存在 → error: ROOM_NOT_FOUND，然后流结束", async () => {
    const host = await registerUser("err_404");
    const stream = await openStream({ code: "ZZZZZZ", auth: host.auth.Authorization, controller: newController() });
    expect(stream.status).toBe(200); // 流已经开了：错误走 error 帧，不是 HTTP 404
    const error = await frameWhere(stream.reader, (frame) => frame.event === "error");
    expect(error.data).toMatchObject({ ok: false, code: "ROOM_NOT_FOUND" });
    await waitFor(() => stream.reader.ended, { label: "stream closed after error" });
  });

  test("不是房间成员 → error: NOT_IN_ROOM（带 roomCode），然后流结束", async () => {
    const host = await registerUser("err_room");
    const outsider = await registerUser("err_outsider");
    const code = (await create(host, { mode: "custom", seats: 4 }).expect(201)).body.room.code;

    const stream = await openStream({ code, auth: outsider.auth.Authorization, controller: newController() });
    const error = await frameWhere(stream.reader, (frame) => frame.event === "error");
    expect(error.data).toMatchObject({ ok: false, code: "NOT_IN_ROOM", roomCode: code });
    await waitFor(() => stream.reader.ended, { label: "stream closed after error" });
  });

  test("GAME_ROOMS=off → error: GAME_ROOMS_OFF（不是 JSON 503），然后流结束", async () => {
    process.env.GAME_ROOMS = "off";
    const host = await registerUser("err_off");
    const stream = await openStream({ code: "AAAAAA", auth: host.auth.Authorization, controller: newController() });
    expect(stream.status).toBe(200);
    const error = await frameWhere(stream.reader, (frame) => frame.event === "error");
    expect(error.data).toMatchObject({ ok: false, code: "GAME_ROOMS_OFF" });
    await waitFor(() => stream.reader.ended, { label: "stream closed after error" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("限流：每用户同时最多 2 条", () => {
  test("第 3 条回 429 TOO_MANY_STREAMS；关掉一条之后又能连", async () => {
    const host = await registerUser("limit");
    const code = (await create(host, { mode: "custom", seats: 4 }).expect(201)).body.room.code;

    const c1 = newController();
    const c2 = newController();
    const s1 = await openStream({ code, auth: host.auth.Authorization, controller: c1 });
    const s2 = await openStream({ code, auth: host.auth.Authorization, controller: c2 });
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    await frameWhere(s1.reader, (frame) => frame.event === "snapshot");
    await frameWhere(s2.reader, (frame) => frame.event === "snapshot");
    expect(gameRoomStream.activeCountOf(host.id)).toBe(config.STREAM_MAX_PER_USER);

    const third = await openStream({ code, auth: host.auth.Authorization, controller: newController() });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ ok: false, code: "TOO_MANY_STREAMS", details: { max: 2, active: 2 } });

    // 客户端关掉一条 → 名额释放 → 第三条能连上
    c1.abort();
    await waitFor(() => gameRoomStream.activeCountOf(host.id) === 1, { label: "one slot released" });
    const retry = await openStream({ code, auth: host.auth.Authorization, controller: newController() });
    expect(retry.status).toBe(200);
    expect((await frameWhere(retry.reader, (frame) => frame.event === "snapshot")).data.room.code).toBe(code);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("清理：不泄漏 listener / 名额", () => {
  test("客户端断开 → bus 订阅清零、每用户名额归零", async () => {
    const host = await registerUser("cleanup");
    const code = (await create(host, { mode: "custom", seats: 4 }).expect(201)).body.room.code;

    const controller = newController();
    const stream = await openStream({ code, auth: host.auth.Authorization, controller });
    await frameWhere(stream.reader, (frame) => frame.event === "snapshot");
    expect(gameRoomBus.subscriberCount(code)).toBe(1);
    expect(gameRoomStream.activeCountOf(host.id)).toBe(1);

    controller.abort();
    await waitFor(() => gameRoomBus.subscriberCount(code) === 0, { label: "bus listener removed on close" });
    expect(gameRoomStream.activeCountOf(host.id)).toBe(0);
    expect(gameRoomBus.publish(code)).toBe(0);
  });

  test("订阅之后被服务端关流（房间删了）→ 订阅与名额都清掉，不是只有客户端断开那条路", async () => {
    const host = await registerUser("cleanup_deleted");
    const code = (await create(host, { mode: "custom", seats: 4 }).expect(201)).body.room.code;

    const stream = await openStream({ code, auth: host.auth.Authorization, controller: newController() });
    await frameWhere(stream.reader, (frame) => frame.event === "snapshot");
    expect(gameRoomBus.subscriberCount(code)).toBe(1);

    // 最后一个人退房 = 房间当场删掉；订阅者下一次重读 → ROOM_NOT_FOUND → error + 关闭
    await request(app).post(`/api/game/rooms/${code}/leave`).set(host.auth).send({}).expect(200);
    const error = await frameWhere(stream.reader, (frame) => frame.event === "error");
    expect(error.data).toMatchObject({ ok: false, code: "ROOM_NOT_FOUND" });
    await waitFor(() => stream.reader.ended, { label: "stream closed after room deleted" });
    expect(gameRoomBus.subscriberCount(code)).toBe(0);
    expect(gameRoomStream.activeCountOf(host.id)).toBe(0);
  });

  test("建立阶段的 error（不是成员）失败后同样不占名额、不留订阅", async () => {
    const host = await registerUser("cleanup_host");
    const outsider = await registerUser("cleanup_outsider");
    const code = (await create(host, { mode: "custom", seats: 4 }).expect(201)).body.room.code;

    const stream = await openStream({ code, auth: outsider.auth.Authorization, controller: newController() });
    expect(stream.status).toBe(200);
    expect((await frameWhere(stream.reader, (frame) => frame.event === "error")).data.code).toBe("NOT_IN_ROOM");
    await waitFor(() => stream.reader.ended, { label: "stream closed after error" });
    expect(gameRoomBus.subscriberCount(code)).toBe(0);
    expect(gameRoomStream.activeCountOf(outsider.id)).toBe(0);
  });
});
