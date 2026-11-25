// tests/gameSpectate.spec.js
// 「工坊对局」的**公开房列表 + 观战**（2026-11-24）。
// 契约正本：docs/api-contract.md「工坊对局：公开房列表与观战」。
//
// 覆盖：
//   · 公开房列表：只列 public（private 永不出现）/ createdAt 倒序 / 分页与 total / 满员不列 /
//     过期不列 / 参数校验（BAD_VISIBILITY / BAD_STATE / BAD_MODE / BAD_PAGE / BAD_LIMIT）；
//   · 建房：visibility 缺省 private、显式 public、非法值 400；
//   · 观战：不占座（members 不变、memberCount 不变、spectators.count +1）/ 幂等 / 上限 20 的 429 /
//     玩家不能观战自己的房 / 进房时从观众席拉出 / 观众 leave 与玩家 leave 分开 / 过期级联 /
//     观众读不续命；
//   · 权限矩阵：观众**读**四项通（快照 / rounds/current / rounds/history / SSE），
//     **写**九项统一 403 `SPECTATOR_NOT_ALLOWED`；非成员非观众仍是原来的 NOT_IN_ROOM；
//   · 观众不阻止开局、不参与「全员已交片」；
//   · 能力位 `gamePublicRooms` / `gameSpectators` 与 `GAME_PUBLIC_ROOMS=off` / `GAME_SPECTATORS=off` 急停。
//
// ★ 这些判据错了**零症状**（房间照样建、观战照样进），所以每条都有反例：
//   · 列表不筛 visibility → 私人房被摆到大厅上（房号本来是唯一凭据）；
//   · 观众算进 members → 4 人局挤进第 5 个人 / 开局人数骗过校验；
//   · 观众 leave 走成玩家 leave → 一按「退出观战」把别人的座位退了；
//   · 观众写操作漏判 → 观众的一票真的算进结算，名次悄悄变。
//
// ★ 不联网、不花钱：只用 MongoMemoryServer + supertest（SSE 那条要一个真端口，见下）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const { once } = require("events");

const gameRoomStream = require("../src/services/gameRoomStream.service");
const config = require("../src/config/gameRoom");

// MongoMemoryServer 第一次起 + 建索引 + 二十来个账号的 bcrypt，可能超过默认 5 秒
jest.setTimeout(30000);

let mongod;
let app;
let GameRoom;
let server;
let base;

const MIN = 60 * 1000;
const ENV_KEYS = [
  "GAME_ROOMS",
  "GAME_PUBLIC_ROOMS",
  "GAME_SPECTATORS",
  "GAME_ROUNDS",
  "GAME_HISTORY",
  "GAME_STREAM_MAX_SEC",
];
let savedEnv;

let seq = 0;
async function registerUser(tag) {
  seq += 1;
  const name = `gm_${tag}_${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { id: res.body.user._id, username: name, auth: { Authorization: `Bearer ${res.body.token}` } };
}

const create = (u, body) => request(app).post("/api/game/rooms").set(u.auth).send(body);
const join = (u, code) => request(app).post("/api/game/rooms/join").set(u.auth).send({ code });
const snapshot = (u, code) => request(app).get(`/api/game/rooms/${encodeURIComponent(code)}`).set(u.auth);
const leave = (u, code) => request(app).post(`/api/game/rooms/${code}/leave`).set(u.auth).send({});
const ready = (u, code, value) => request(app).post(`/api/game/rooms/${code}/ready`).set(u.auth).send({ ready: value });
const start = (u, code) => request(app).post(`/api/game/rooms/${code}/start`).set(u.auth).send({});
const kick = (u, code, userId) => request(app).post(`/api/game/rooms/${code}/kick`).set(u.auth).send({ userId });

const list = (u, q = "") => request(app).get(`/api/game/rooms${q ? `?${q}` : ""}`).set(u.auth);

const spectate = (u, code) => request(app).post(`/api/game/rooms/${code}/spectate`).set(u.auth).send({});
const spectateLeave = (u, code) => request(app).post(`/api/game/rooms/${code}/spectate/leave`).set(u.auth).send({});

const roundsStart = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/start`).set(u.auth).send({});
const submit = (u, code, body) => request(app).post(`/api/game/rooms/${code}/rounds/entries`).set(u.auth).send(body);
const current = (u, code) => request(app).get(`/api/game/rooms/${code}/rounds/current`).set(u.auth);
const history = (u, code) => request(app).get(`/api/game/rooms/${code}/rounds/history`).set(u.auth);
const phase = (u, code, value) => request(app).post(`/api/game/rooms/${code}/rounds/phase`).set(u.auth).send({ phase: value });
const like = (u, code, targetUserId) =>
  request(app).post(`/api/game/rooms/${code}/rounds/like`).set(u.auth).send({ targetUserId });
const vote = (u, code, targetUserId) =>
  request(app).post(`/api/game/rooms/${code}/rounds/vote`).set(u.auth).send({ targetUserId });
const settle = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/settle`).set(u.auth).send({});
const next = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/next`).set(u.auth).send({});
const eventChoice = (u, code, optionId) =>
  request(app).post(`/api/game/rooms/${code}/rounds/events/choice`).set(u.auth).send({ optionId });

/** 直接把库里的时间往前挪（不经过路由，也不动 updatedAt） */
async function ageRoom(code, patch) {
  await GameRoom.updateOne({ code }, { $set: patch }, { timestamps: false });
}

/** 造一间 n 人的 custom 房（第一个人是房主，其余人 join + ready），可选开局。返回 { code, users, host } */
async function roomWith(n, { seats = n, play = false } = {}) {
  const users = [];
  for (let i = 0; i < n; i += 1) users.push(await registerUser(`p${n}${play ? "x" : ""}${i}`));
  const created = await create(users[0], { mode: "custom", seats }).expect(201);
  const code = created.body.room.code;
  for (let i = 1; i < n; i += 1) {
    await join(users[i], code).expect(200);
    await ready(users[i], code, true).expect(200);
  }
  if (play) await start(users[0], code).expect(200);
  return { code, users, host: users[0] };
}

/** 本文件打开过的 SSE 流（afterEach 统一关掉） */
const opened = [];
function startReader(body) {
  const reader = { frames: [], ended: false };
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
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\n\n");
          const frame = { event: "message", dataRaw: undefined };
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) frame.event = line.slice(6).trim();
            else if (line.startsWith("data:")) frame.dataRaw = line.slice(5).replace(/^ /, "");
          }
          if (frame.dataRaw !== undefined) {
            frame.data = frame.dataRaw === "" ? "" : JSON.parse(frame.dataRaw);
          }
          reader.frames.push(frame);
        }
      }
    } catch {
      // abort 是测试自己关的
    } finally {
      reader.ended = true;
    }
  })();
  return reader;
}

async function openStream({ code, auth, controller }) {
  const res = await fetch(`${base}/api/game/rooms/${encodeURIComponent(code)}/stream`, {
    headers: auth ? { Authorization: auth } : {},
    signal: controller.signal,
  });
  if (res.status !== 200) return { res, status: res.status, body: await res.json().catch(() => null), reader: null };
  const reader = startReader(res.body);
  opened.push({ controller, reader });
  return { res, status: 200, body: null, reader };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  GameRoom = require("../src/models/GameRoom");
  await GameRoom.createIndexes();

  // SSE 那条要一条能一直开着的长连接（supertest 不适合读流）
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
  gameRoomStream.resetForTests();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const item of opened) {
    try {
      item.controller.abort();
    } catch {
      // 已经 aborted
    }
    try {
      item.reader.cancel();
    } catch {
      // 已经结束
    }
  }
  opened.length = 0;
  gameRoomStream.resetForTests();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ─────────────────────────────────────────────────────────────────────
describe("建房：visibility 缺省 private", () => {
  test("不带 visibility → room.visibility 是 private，库里也是 private（老客户端的形状不变）", async () => {
    const u = await registerUser("default");
    const res = await create(u, { mode: "custom", seats: 4 }).expect(201);
    expect(res.body.room.visibility).toBe("private");
    const doc = await GameRoom.findByCode(res.body.room.code);
    expect(doc.visibility).toBe("private");
  });

  test("显式 public 落库；非法值 → 400 BAD_VISIBILITY（不静默当 private）", async () => {
    const u = await registerUser("vis");
    const pub = await create(u, { mode: "custom", seats: 4, visibility: "public" }).expect(201);
    expect(pub.body.room.visibility).toBe("public");
    expect((await GameRoom.findByCode(pub.body.room.code)).visibility).toBe("public");

    const bad = await create(u, { mode: "custom", seats: 4, visibility: "friends" }).expect(400);
    expect(bad.body).toMatchObject({ ok: false, code: "BAD_VISIBILITY" });
  });

  test("老房间没有 visibility 这一格 → 快照按 private 读（不写迁移，见 visibilityOf）", async () => {
    const u = await registerUser("old");
    const created = await create(u, { mode: "custom", seats: 4, visibility: "public" }).expect(201);
    await GameRoom.updateOne({ code: created.body.room.code }, { $unset: { visibility: 1 } }, { timestamps: false });
    const snap = await snapshot(u, created.body.room.code).expect(200);
    expect(snap.body.room.visibility).toBe("private");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("公开房列表：只列 public、倒序、分页", () => {
  test("只列 public；private 房（含撮合出来的）永远不出现；行形状齐全", async () => {
    const host = await registerUser("list");
    const otherHost = await registerUser("list-priv");
    const pub = await create(host, { mode: "custom", seats: 6, visibility: "public" }).expect(201);
    // ★ 一人只能在一间房里：第二间房的房主必须是另一个人（否则建房就 409）
    const priv = await create(otherHost, { mode: "custom", seats: 6 }).expect(201);
    // 撮合出来的房（origin match）即使库里有，也一律 private（见 createRoom 的缺省）
    await GameRoom.updateOne({ code: priv.body.room.code }, { $set: { origin: "match" } });

    const guest = await registerUser("list-guest");
    await join(guest, pub.body.room.code).expect(200);

    const res = await list(host).expect(200);
    expect(res.body).toMatchObject({ ok: true, visibility: "public", state: "waiting", page: 1, limit: 20 });
    expect(res.body.total).toBe(1);
    const codes = res.body.rooms.map((room) => room.code);
    expect(codes).toEqual([pub.body.room.code]);
    expect(codes).not.toContain(priv.body.room.code);

    expect(res.body.rooms[0]).toMatchObject({
      code: pub.body.room.code,
      mode: "custom",
      seats: 6,
      members: 2,
      hostName: host.username,
      state: "waiting",
      joinable: true,
    });
    expect(new Date(res.body.rooms[0].createdAt).getTime()).toBeGreaterThan(0);
    // 大厅卡片只要人数：不把成员名单摆出去
    expect(res.body.rooms[0].members).not.toBeInstanceOf(Array);
  });

  test("createdAt 倒序 + 分页：total 是总数（不是本页条数）、hasMore 正确、翻页不重复", async () => {
    const codes = [];
    for (let i = 0; i < 3; i += 1) {
      // ★ 一人只能在一间房里：三间房三个房主
      const host = await registerUser(`page${i}`);
      const res = await create(host, { mode: "custom", seats: 4, visibility: "public" }).expect(201);
      codes.push(res.body.room.code);
    }
    // 显式排开创建时间（同一毫秒建三间房时 createdAt 会一样，排序就测不出来了）
    const baseAt = Date.now() - 10 * MIN;
    for (let i = 0; i < 3; i += 1) {
      await ageRoom(codes[i], { createdAt: new Date(baseAt + i * MIN) });
    }

    const viewer = await registerUser("page-viewer");
    const page1 = await list(viewer, "page=1&limit=2").expect(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.rooms.map((room) => room.code)).toEqual([codes[2], codes[1]]);

    const page2 = await list(viewer, "page=2&limit=2").expect(200);
    expect(page2.body.total).toBe(3);
    expect(page2.body.hasMore).toBe(false);
    expect(page2.body.rooms.map((room) => room.code)).toEqual([codes[0]]);

    const empty = await list(viewer, "page=9&limit=2").expect(200);
    expect(empty.body).toMatchObject({ total: 3, rooms: [], hasMore: false });
  });

  test("满员的不列（缺省 state=waiting）；显式 state=playing 能列出来，但 joinable:false", async () => {
    const host = await registerUser("full");
    const created = await create(host, { mode: "custom", seats: 2, visibility: "public" }).expect(201);
    const code = created.body.room.code;
    const guest = await registerUser("full-guest");
    await join(guest, code).expect(200);
    await ready(guest, code, true).expect(200);

    const full = await list(host).expect(200);
    expect(full.body.total).toBe(0);
    expect(full.body.rooms).toEqual([]);

    await start(host, code).expect(200);
    const playing = await list(host, "state=playing").expect(200);
    expect(playing.body.total).toBe(1);
    expect(playing.body.rooms[0]).toMatchObject({ code, state: "playing", joinable: false });

    // 显式查 waiting 时它已经不在了（已开局不列）
    const waiting = await list(host, "state=waiting").expect(200);
    expect(waiting.body.rooms.map((room) => room.code)).not.toContain(code);
  });

  test("过期的公开房不列（按 lastSeenAt + 寿命，与懒清理同一口径）", async () => {
    const host = await registerUser("stale");
    const otherHost = await registerUser("stale2");
    const fresh = await create(host, { mode: "custom", seats: 4, visibility: "public" }).expect(201);
    const stale = await create(otherHost, { mode: "custom", seats: 4, visibility: "public" }).expect(201);
    await ageRoom(stale.body.room.code, { lastSeenAt: new Date(Date.now() - (config.ROOM_TTL_MS + MIN)) });

    const res = await list(host).expect(200);
    expect(res.body.rooms.map((room) => room.code)).toEqual([fresh.body.room.code]);
    expect(res.body.total).toBe(1);
  });

  test("mode 过滤；参数校验各回各的码", async () => {
    const host = await registerUser("filter");
    const otherHost = await registerUser("filter2");
    await create(host, { mode: "match4", visibility: "public" }).expect(201);
    await create(otherHost, { mode: "custom", seats: 3, visibility: "public" }).expect(201);

    const match4 = await list(host, "mode=match4").expect(200);
    expect(match4.body).toMatchObject({ mode: "match4", total: 1 });
    expect(match4.body.rooms[0].mode).toBe("match4");

    expect((await list(host, "visibility=private")).status).toBe(400);
    expect((await list(host, "visibility=private")).body.code).toBe("BAD_VISIBILITY");
    expect((await list(host, "state=bogus")).body.code).toBe("BAD_STATE");
    expect((await list(host, "mode=bogus")).body.code).toBe("BAD_MODE");
    expect((await list(host, "page=0")).body.code).toBe("BAD_PAGE");
    expect((await list(host, `limit=${config.PUBLIC_ROOM_PAGE_SIZE_MAX + 1}`)).body.code).toBe("BAD_LIMIT");
    expect((await list(host, "limit=0")).body.code).toBe("BAD_LIMIT");
  });

  test("未登录 → 401（与其它房间端点同一条）", async () => {
    await request(app).get("/api/game/rooms").expect(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("观战：不占座、幂等、上限", () => {
  test("spectate 不写 members：memberCount 不变、spectators.count +1、回包带快照", async () => {
    const { code, host } = await roomWith(2);
    const fan = await registerUser("fan");
    const res = await spectate(fan, code).expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      spectating: true,
      already: false,
      code,
      spectators: { count: 1 },
    });
    expect(res.body.joinedAt).toBeTruthy();
    expect(res.body.room.members).toHaveLength(2);
    expect(res.body.room.memberCount).toBe(2);
    expect(res.body.room.spectators).toEqual({ count: 1 });

    const snap = await snapshot(host, code).expect(200);
    expect(snap.body.room.memberCount).toBe(2);
    expect(snap.body.room.spectators).toEqual({ count: 1 });
    // 观众不在成员名单里（座位没有被占）
    expect(snap.body.room.members.map((member) => member.userId)).not.toContain(fan.id);
    expect((await GameRoom.findByCode(code)).members).toHaveLength(2);
  });

  test("重复观战是幂等的：already:true，计数不涨、不重复写库", async () => {
    const { code } = await roomWith(2);
    const fan = await registerUser("fan2");
    await spectate(fan, code).expect(200);
    const again = await spectate(fan, code).expect(200);
    expect(again.body).toMatchObject({ spectating: true, already: true, spectators: { count: 1 } });
    expect((await GameRoom.findByCode(code)).spectators).toHaveLength(1);
  });

  test(`上限 ${config.MAX_SPECTATORS}：满席再进 → 429 TOO_MANY_SPECTATORS（带 max / count），有人走了又能进`, async () => {
    const { code } = await roomWith(2);
    // 先塞满 19 个（假 id 只用于占位，不是账号；不进 User 表也不影响观众计数）
    const fake = Array.from({ length: config.MAX_SPECTATORS - 1 }, () => ({
      userId: new mongoose.Types.ObjectId(),
      joinedAt: new Date(),
    }));
    await GameRoom.updateOne({ code }, { $set: { spectators: fake } });

    const last = await registerUser("seat20");
    const okRes = await spectate(last, code).expect(200);
    expect(okRes.body.spectators.count).toBe(config.MAX_SPECTATORS);

    const extra = await registerUser("seat21");
    const denied = await spectate(extra, code).expect(429);
    expect(denied.body).toMatchObject({ ok: false, code: "TOO_MANY_SPECTATORS", max: config.MAX_SPECTATORS });
    expect(denied.body.count).toBe(config.MAX_SPECTATORS);

    // 有人离席 → 名额回一个
    await spectateLeave(last, code).expect(200);
    const retry = await spectate(extra, code).expect(200);
    expect(retry.body.spectators.count).toBe(config.MAX_SPECTATORS);
  });

  test("已经在房里的玩家不能观战自己的房 → 409 ALREADY_IN_ROOM", async () => {
    const { code, host } = await roomWith(2);
    const res = await spectate(host, code).expect(409);
    expect(res.body).toMatchObject({ ok: false, code: "ALREADY_IN_ROOM" });
    expect((await GameRoom.findByCode(code)).spectators).toHaveLength(0);
  });

  test("先观战再进房：join 会把他从观众席拉出来（两张名单互斥）", async () => {
    const { code } = await roomWith(1, { seats: 4 });
    const fan = await registerUser("fanjoin");
    await spectate(fan, code).expect(200);
    expect((await GameRoom.findByCode(code)).spectators).toHaveLength(1);

    await join(fan, code).expect(200);
    const doc = await GameRoom.findByCode(code);
    expect(doc.members.map((member) => String(member.userId))).toContain(String(fan.id));
    expect(doc.spectators).toHaveLength(0);
  });

  test("★ 观众 leave 与玩家 leave 分开：观众离开不退座位，玩家调观众离开也不动成员", async () => {
    const { code, host } = await roomWith(2);
    const fan = await registerUser("fanleave");
    await spectate(fan, code).expect(200);

    // 玩家按「退出观战」：什么都不会发生（他本来就不在观众席）
    const playerLeave = await spectateLeave(host, code).expect(200);
    expect(playerLeave.body).toMatchObject({ left: false, spectators: { count: 1 } });
    expect((await GameRoom.findByCode(code)).members).toHaveLength(2);

    // 观众按「退房」：不是成员 → 409，座位不动
    const wrongLeave = await leave(fan, code).expect(409);
    expect(wrongLeave.body.code).toBe("NOT_IN_ROOM");
    expect((await GameRoom.findByCode(code)).members).toHaveLength(2);

    // 观众按「退出观战」：只拉掉观众行
    const fanLeave = await spectateLeave(fan, code).expect(200);
    expect(fanLeave.body).toMatchObject({ left: true, spectating: false, spectators: { count: 0 } });
    const doc = await GameRoom.findByCode(code);
    expect(doc.members).toHaveLength(2);
    expect(doc.spectators).toHaveLength(0);

    // 幂等：再走一次 left:false
    const again = await spectateLeave(fan, code).expect(200);
    expect(again.body.left).toBe(false);
  });

  test("房间过期 → 观众一并级联清掉（删的是整份文档）", async () => {
    const { code } = await roomWith(2);
    const fan = await registerUser("fanexpire");
    await spectate(fan, code).expect(200);
    await ageRoom(code, { lastSeenAt: new Date(Date.now() - (config.ROOM_TTL_MS + MIN)) });

    await snapshot(fan, code).expect(404);
    expect(await GameRoom.findByCode(code)).toBeNull();
  });

  test("观众读不续命（房间照常过期；与成员轮询相反）", async () => {
    const { code, host } = await roomWith(2, { play: true });
    const fan = await registerUser("fannever");
    await spectate(fan, code).expect(200);
    await roundsStart(host, code).expect(200);
    const staleAt = new Date(Date.now() - 29 * MIN);
    await ageRoom(code, { lastSeenAt: staleAt });

    await snapshot(fan, code).expect(200);
    await current(fan, code).expect(200);

    const doc = await GameRoom.findByCode(code);
    expect(new Date(doc.lastSeenAt).getTime()).toBe(staleAt.getTime());
    // 对照：成员读一次就续命（这条是既有行为，观众那条判据不能把它顺手改掉）
    await snapshot(host, code).expect(200);
    const touched = await GameRoom.findByCode(code);
    expect(new Date(touched.lastSeenAt).getTime()).toBeGreaterThan(staleAt.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("权限矩阵：观众读四项、写九项统一 403", () => {
  test("读：快照 / rounds/current / rounds/history / SSE 全部可读（非观众非成员仍然 NOT_IN_ROOM）", async () => {
    const { code, host, users } = await roomWith(2, { play: true });
    await roundsStart(host, code).expect(200);
    await submit(users[0], code, { prompt: "甲的作品" }).expect(200);
    await submit(users[1], code, { prompt: "乙的作品" }).expect(200);

    const fan = await registerUser("reader");
    await spectate(fan, code).expect(200);
    await snapshot(fan, code).expect(200);
    const cur = await current(fan, code).expect(200);
    expect(cur.body.ok).toBe(true);
    expect(cur.body.entries).toHaveLength(2);
    const hist = await history(fan, code).expect(200);
    expect(hist.body.ok).toBe(true);
    expect(hist.body.rounds).toHaveLength(1);

    // SSE：观众连上去第一帧就是 snapshot
    const controller = new AbortController();
    const stream = await openStream({ code, auth: fan.auth.Authorization, controller });
    expect(stream.status).toBe(200);
    const frame = await waitFor(() => stream.reader.frames.find((item) => item.event === "snapshot"));
    expect(frame.data.room.code).toBe(code);
    expect(frame.data.round.round).toBe(1);
    controller.abort();

    // 路人（不是成员也不是观众）：读还是原来的 NOT_IN_ROOM
    const stranger = await registerUser("stranger");
    expect((await current(stranger, code)).body.code).toBe("NOT_IN_ROOM");
    expect((await history(stranger, code)).body.code).toBe("NOT_IN_ROOM");
    const badController = new AbortController();
    const badStream = await openStream({ code, auth: stranger.auth.Authorization, controller: badController });
    expect(badStream.status).toBe(200); // SSE 的错误走 error 帧
    const errFrame = await waitFor(() => badStream.reader.frames.find((item) => item.event === "error"));
    expect(errFrame.data.code).toBe("NOT_IN_ROOM");
    badController.abort();
  });

  test("写：交片 / 点赞 / 投票 / 推进阶段 / 开局 / 踢人 / 准备 / 结算 / next / 选事件 全部 403 SPECTATOR_NOT_ALLOWED", async () => {
    const { code, host, users } = await roomWith(2, { play: true });
    await roundsStart(host, code).expect(200);
    const fan = await registerUser("writer");
    await spectate(fan, code).expect(200);

    const writes = [
      ["交片", await submit(fan, code, { prompt: "我也想交一条" })],
      ["点赞", await like(fan, code, users[0].id)],
      ["投票", await vote(fan, code, users[0].id)],
      ["推进阶段", await phase(fan, code, "screening")],
      ["开局", await start(fan, code)],
      ["踢人", await kick(fan, code, users[1].id)],
      ["准备", await ready(fan, code, true)],
      ["结算", await settle(fan, code)],
      ["下一回合", await next(fan, code)],
      ["选事件", await eventChoice(fan, code, "skip")],
    ];
    for (const [label, res] of writes) {
      expect([label, res.status, res.body.code]).toEqual([label, 403, "SPECTATOR_NOT_ALLOWED"]);
      expect(res.body.roomCode).toBe(code);
    }

    // 一条都没落库：回合还是 creating、没有新投稿 / 点赞 / 票、房间还是 playing
    const doc = await GameRoom.findByCode(code);
    expect(doc.status).toBe("playing");
    expect(doc.rounds[0].phase).toBe("creating");
    expect(doc.rounds[0].entries).toHaveLength(0);
    expect(doc.rounds[0].likes).toHaveLength(0);
    expect(doc.rounds[0].votes).toHaveLength(0);
  });

  test("观众不阻止开局、也不参与「全员已交片」", async () => {
    const { code, users } = await roomWith(2, { seats: 4 });
    const fan = await registerUser("watcher");
    await spectate(fan, code).expect(200);
    // 两个人全都 ready → 观众不在 members 里，开局人数照样够
    await start(users[0], code).expect(200);
    expect((await GameRoom.findByCode(code)).status).toBe("playing");

    await roundsStart(users[0], code).expect(200);
    await submit(users[0], code, { prompt: "甲的作品" }).expect(200);
    const one = await current(users[1], code).expect(200);
    expect(one.body.allSubmitted).toBe(false);
    await submit(users[1], code, { prompt: "乙的作品" }).expect(200);
    const two = await current(users[1], code).expect(200);
    expect(two.body.allSubmitted).toBe(true); // 只有 2 个玩家要交，观众不算
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("能力位与急停", () => {
  test("/api/ark/health 亮出 gamePublicRooms / gameSpectators", async () => {
    const health = await request(app).get("/api/ark/health").expect(200);
    expect(health.body).toMatchObject({ gameRooms: true, gamePublicRooms: true, gameSpectators: true });
  });

  test("GAME_PUBLIC_ROOMS=off：列表 503 GAME_PUBLIC_ROOMS_OFF、能力位 false；建房照旧认 public", async () => {
    process.env.GAME_PUBLIC_ROOMS = "off";
    const health = await request(app).get("/api/ark/health").expect(200);
    expect(health.body).toMatchObject({ gamePublicRooms: false, gameSpectators: true, gameRooms: true });

    const host = await registerUser("off");
    const denied = await list(host).expect(503);
    expect(denied.body.code).toBe("GAME_PUBLIC_ROOMS_OFF");
    // 关掉的只是列表读路径：建房仍可用（开关一开就又能看到）
    const created = await create(host, { mode: "custom", seats: 4, visibility: "public" }).expect(201);
    expect(created.body.room.visibility).toBe("public");
  });

  test("GAME_SPECTATORS=off：进 / 出观众席 503 GAME_SPECTATORS_OFF、能力位 false；已在席上的人照旧可读", async () => {
    const { code, host } = await roomWith(2, { play: true });
    await roundsStart(host, code).expect(200);
    const fan = await registerUser("offfan");
    await spectate(fan, code).expect(200);

    process.env.GAME_SPECTATORS = "off";
    const health = await request(app).get("/api/ark/health").expect(200);
    expect(health.body).toMatchObject({ gameSpectators: false, gamePublicRooms: true, gameRooms: true });

    const nextFan = await registerUser("offfan2");
    expect((await spectate(nextFan, code)).body.code).toBe("GAME_SPECTATORS_OFF");
    expect((await spectate(fan, code)).body.code).toBe("GAME_SPECTATORS_OFF");
    expect((await spectateLeave(fan, code)).body.code).toBe("GAME_SPECTATORS_OFF");

    // 已经在席上的人：读照旧（急停停的是「新的人涌进来」）
    await snapshot(fan, code).expect(200);
    await current(fan, code).expect(200);
  });

  test("GAME_ROOMS=off 时公开房列表与观战都先回 GAME_ROOMS_OFF（总闸在前）", async () => {
    const { code, host } = await roomWith(2);
    process.env.GAME_ROOMS = "off";
    expect((await list(host)).body.code).toBe("GAME_ROOMS_OFF");
    expect((await spectate(host, code)).body.code).toBe("GAME_ROOMS_OFF");
    expect((await spectateLeave(host, code)).body.code).toBe("GAME_ROOMS_OFF");
  });
});
