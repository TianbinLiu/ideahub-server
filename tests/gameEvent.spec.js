// tests/gameEvent.spec.js
// 「工坊对局」的**回合间事件**（2026-11-23，第 2/4/6 回合结算之后的三选一，由服务端出题）。
// 设计正本在 app 仓 docs/workshop-game-design.md §2.3b / §5-7、src/studio/game/rules.ts 的
// GAME_EVENTS / EVENT_AFTER_ROUNDS / drawEventAfterRound；服务端实现：
// src/config/gameEvent.js（事件表 + 确定性抽选 + 开关）、
// src/services/gameRound.service.js（getRoundEvent / chooseRoundEvent）。
//
// 覆盖：同一房间同一回合**确定性**（所有人同一个事件、三个事件回合是一副不重样的牌）/
// 只在 settled 之后、下一回合之前可读（creating / screening / voting 都拒；第 1 回合结算后 NO_EVENT；
// next 之后又不可读）/ 选择**幂等**（第一选作数、重复 / 并发只写一条）/ hp 效果**只在服务端落一次**
// （回包里的 effects.server.hp 不要在 App 再应用一遍）/ GAME_OVER 后事件不可读写 / GAME_EVENTS_API=off。
//
// ★ 这些判据错了都**零症状**（每个人各自看到"一个事件"、血加两次也只是一个更大的数），所以每条都要有反例。
// ★ 不联网、不花钱：只用 MongoMemoryServer + supertest。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let GameRoom;
let eventConfig;

const ENV_KEYS = ["GAME_EVENTS_API", "GAME_ROUNDS", "GAME_ROOMS"];
let savedEnv;

/** 建一个账号（走真的注册路由：快照里的 hp / 事件里的 userId 都是真账号） */
let seq = 0;
async function registerUser(tag) {
  seq += 1;
  const name = `ev_${tag}_${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { id: res.body.user._id, username: name, auth: { Authorization: `Bearer ${res.body.token}` } };
}

const create = (u, body) => request(app).post("/api/game/rooms").set(u.auth).send(body);
const join = (u, code) => request(app).post("/api/game/rooms/join").set(u.auth).send({ code });
const ready = (u, code, value) => request(app).post(`/api/game/rooms/${code}/ready`).set(u.auth).send({ ready: value });
const startRoom = (u, code) => request(app).post(`/api/game/rooms/${code}/start`).set(u.auth).send({});
const snapshot = (u, code) => request(app).get(`/api/game/rooms/${code}`).set(u.auth);

const roundsStart = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/start`).set(u.auth).send({});
const submit = (u, code, body) => request(app).post(`/api/game/rooms/${code}/rounds/entries`).set(u.auth).send(body);
const phase = (u, code, value) => request(app).post(`/api/game/rooms/${code}/rounds/phase`).set(u.auth).send({ phase: value });
const settle = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/settle`).set(u.auth).send({});
const next = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/next`).set(u.auth).send({});
const events = (u, code) => request(app).get(`/api/game/rooms/${code}/rounds/events`).set(u.auth);
const choose = (u, code, optionId) =>
  request(app).post(`/api/game/rooms/${code}/rounds/events/choice`).set(u.auth).send({ optionId });

/** 造一间 n 人的 custom 房并开局（第一个人是房主，其余人 join + ready） */
async function playingRoom(n, seats = n) {
  const users = [];
  for (let i = 0; i < n; i += 1) users.push(await registerUser(`p${n}-${i}`));
  const created = await create(users[0], { mode: "custom", seats }).expect(201);
  const code = created.body.room.code;
  const roomId = created.body.room.roomId;
  for (let i = 1; i < n; i += 1) {
    await join(users[i], code).expect(200);
    await ready(users[i], code, true).expect(200);
  }
  await startRoom(users[0], code).expect(200);
  return { code, roomId, users, host: users[0] };
}

async function submitAll(room) {
  for (let i = 0; i < room.users.length; i += 1) {
    await submit(room.users[i], room.code, { prompt: `第 ${i + 1} 个人的片子`, cardNames: [] }).expect(200);
  }
}

/** 打完一回合（1 = 开第 1 回合；n>1 = 先 next 再打），停在 settled */
async function settleRound(room, n) {
  if (n === 1) await roundsStart(room.host, room.code).expect(200);
  else await next(room.host, room.code).expect(200);
  await submitAll(room);
  await phase(room.host, room.code, "screening").expect(200);
  await phase(room.host, room.code, "voting").expect(200);
  await settle(room.host, room.code).expect(200);
}

/** 打到第 2 回合结算完：第 2 回合是**第一个事件回合**（第 1 回合结算后没有事件） */
async function atSecondSettled(n = 4) {
  const room = await playingRoom(n);
  await settleRound(room, 1);
  await settleRound(room, 2);
  return room;
}

/** 直接改某人的血量（模拟已经打了几回合） */
async function setHp(code, userId, hp) {
  await GameRoom.updateOne({ code, "members.userId": userId }, { $set: { "members.$.hp": hp } });
}

/**
 * 找一个房号，让它在第 `round` 回合抽到指定事件（抽选是纯函数，所以能反查）。
 * ★ 测试不能假设随机房号会抽到哪个事件 —— 想测「回血」就得先把事件钉住。
 */
function codeWithEvent(round, eventId) {
  for (let i = 0; i < 5000; i += 1) {
    const code = `EV${String(i).padStart(4, "0")}`;
    const event = eventConfig.eventFor(code, round);
    if (event && event.id === eventId) return code;
  }
  throw new Error(`no room code maps to ${eventId} at round ${round}`);
}

/** 把房间改成一个已知房号（抽选只认房号，改完 eventFor 就能算出来） */
async function forceCode(room, code) {
  await GameRoom.updateOne({ _id: room.roomId }, { $set: { code } });
  room.code = code;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  GameRoom = require("../src/models/GameRoom");
  eventConfig = require("../src/config/gameEvent");
  await GameRoom.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await GameRoom.deleteMany({});
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ─────────────────────────────────────────────────────────────────────
describe("确定性抽选：同一房间同一回合，所有人看到同一个事件", () => {
  test("★ 两个人读到同一个 eventId / title / 选项，且与纯函数 eventFor 一致", async () => {
    const room = await atSecondSettled(4);
    const a = await events(room.users[0], room.code).expect(200);
    const b = await events(room.users[2], room.code).expect(200);
    expect(a.body).toMatchObject({ round: 2, myChoice: null, allChosen: false });
    expect(b.body.eventId).toBe(a.body.eventId);
    expect(b.body.title).toBe(a.body.title);
    expect(b.body.options.map((option) => option.id)).toEqual(a.body.options.map((option) => option.id));
    expect(eventConfig.eventFor(room.code, 2).id).toBe(a.body.eventId);
    // 再读一次也不变（纯函数，不消费任何随机序列）
    expect((await events(room.users[1], room.code).expect(200)).body.eventId).toBe(a.body.eventId);
  });

  test("★ 3 个事件回合是一副不重样的牌（与 App「一局里不重样」同口径）；非事件回合没有事件", () => {
    const code = "AB3K7Q";
    const ids = [2, 4, 6].map((round) => eventConfig.eventFor(code, round).id);
    expect(new Set(ids).size).toBe(3);
    expect(new Set(ids)).toEqual(new Set(eventConfig.EVENTS.map((event) => event.id)));
    for (const round of [1, 3, 5, 7, 8]) expect(eventConfig.eventFor(code, round)).toBeNull();
    // 同一房间同一回合逐位相同（两个 cluster 实例算出来必须一样）
    expect(eventConfig.eventFor(code, 4)).toEqual(eventConfig.eventFor(code, 4));
    // 房号大小写不敏感（进房接口对大小写不敏感，抽事件必须同一口径）
    expect(eventConfig.eventFor("ab3k7q", 4).id).toBe(eventConfig.eventFor(code, 4).id);
  });

  test("回包的选项带 id / cost / label，effects 拆成 server（只可能 hp）与 client", async () => {
    const room = await atSecondSettled(4);
    const res = await events(room.users[0], room.code).expect(200);
    expect(res.body.options.length).toBeGreaterThanOrEqual(3);
    for (const option of res.body.options) {
      expect(typeof option.id).toBe("string");
      expect(typeof option.cost).toBe("number");
      expect(typeof option.label).toBe("string");
      expect(option.effects.server).toEqual(expect.any(Object));
      expect(Array.isArray(option.effects.client)).toBe(true);
      // ★ hp 只允许在 server 那一半出现：在 client 里再写一遍，App 就会回两次血
      for (const effect of option.effects.client) expect(effect.kind).not.toBe("hp");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("可读窗口：只在 settled 之后、下一回合 creating 之前", () => {
  test("★ creating / screening / voting 都拒（ROUND_NOT_SETTLED）；第 1 回合结算后 NO_EVENT；next 之后又不可读", async () => {
    const room = await playingRoom(4);
    const outsider = await registerUser("ev-outsider");
    await roundsStart(room.host, room.code).expect(200);
    expect((await events(room.users[0], room.code)).body).toMatchObject({
      code: "ROUND_NOT_SETTLED",
      phase: "creating",
      round: 1,
    });
    expect((await events(outsider, room.code)).body).toMatchObject({ code: "NOT_IN_ROOM" });

    await submitAll(room);
    await phase(room.host, room.code, "screening").expect(200);
    expect((await events(room.users[0], room.code)).body).toMatchObject({ code: "ROUND_NOT_SETTLED", phase: "screening" });
    await phase(room.host, room.code, "voting").expect(200);
    expect((await events(room.users[0], room.code)).body).toMatchObject({ code: "ROUND_NOT_SETTLED", phase: "voting" });
    // 投票阶段也不能选
    expect((await choose(room.users[0], room.code, "skip")).body).toMatchObject({ code: "ROUND_NOT_SETTLED" });

    await settle(room.host, room.code).expect(200);
    // 第 1 回合不是事件回合：读得到「没有事件」，但不是一个坏掉的端点
    expect((await events(room.users[0], room.code)).body).toMatchObject({
      code: "NO_EVENT",
      round: 1,
      eventRounds: [2, 4, 6],
    });

    await next(room.host, room.code).expect(200);
    expect((await events(room.users[0], room.code)).body).toMatchObject({ code: "ROUND_NOT_SETTLED", phase: "creating" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("选择：幂等、第一选作数、allChosen", () => {
  test("★ 重复选（不同选项）只有第一选作数；库里只有一行；全员选完 allChosen=true", async () => {
    const room = await atSecondSettled(4);
    const seen = await events(room.users[0], room.code).expect(200);
    const first = seen.body.options[0].id;
    const second = seen.body.options[1].id;

    // 不认识的选项 → 400，不写库
    expect((await choose(room.users[0], room.code, "no-such-option")).body).toMatchObject({ code: "BAD_OPTION" });
    expect((await events(room.users[0], room.code)).body.myChoice).toBeNull();

    const one = await choose(room.users[0], room.code, first).expect(200);
    expect(one.body).toMatchObject({ myChoice: first, allChosen: false });
    const again = await choose(room.users[0], room.code, second).expect(200);
    expect(again.body).toMatchObject({ myChoice: first, allChosen: false });
    expect((await events(room.users[0], room.code)).body.myChoice).toBe(first);

    await choose(room.users[1], room.code, second).expect(200);
    await choose(room.users[2], room.code, eventConfig.SKIP_PICK).expect(200);
    const last = await choose(room.users[3], room.code, first).expect(200);
    expect(last.body).toMatchObject({ myChoice: first, allChosen: true });
    // 别人的视角也看到全员选完
    expect((await events(room.users[1], room.code)).body).toMatchObject({ myChoice: second, allChosen: true });

    const doc = await GameRoom.findOne({ code: room.code }).lean();
    expect(doc.rounds[1].eventPicks).toHaveLength(4);
    expect(doc.rounds[1].eventPicks.filter((pick) => String(pick.userId) === room.users[2].id)).toEqual([
      expect.objectContaining({ optionId: "skip" }),
    ]);
  });

  test("★ 并发双击同一选项：两发都 200、只落 one 行、hp 只加一次", async () => {
    const room = await atSecondSettled(4);
    await forceCode(room, codeWithEvent(2, "supply-drop"));
    await setHp(room.code, room.users[0].id, 50);
    const [a, b] = await Promise.all([
      choose(room.users[0], room.code, "heal"),
      choose(room.users[0], room.code, "heal"),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.myChoice).toBe("heal");
    expect(b.body.myChoice).toBe("heal");

    const snap = await snapshot(room.users[0], room.code).expect(200);
    const me = snap.body.room.members.find((member) => member.userId === room.users[0].id);
    expect(me.hp).toBe(65); // 50 + 15，只加一次
    const third = await choose(room.users[0], room.code, "heal").expect(200);
    expect(third.body.myChoice).toBe("heal");
    const after = await snapshot(room.users[0], room.code).expect(200);
    expect(after.body.room.members.find((member) => member.userId === room.users[0].id).hp).toBe(65);
    const doc = await GameRoom.findOne({ code: room.code }).lean();
    expect(doc.rounds[1].eventPicks).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("hp 效果由服务端落：effects.server.hp / effects.client 的分工", () => {
  test("★ 补给站·医疗补给：server.hp=15、client 为空；选完血 +15（封顶 100）", async () => {
    const room = await atSecondSettled(4);
    await forceCode(room, codeWithEvent(2, "supply-drop"));
    await setHp(room.code, room.users[0].id, 95); // 回 15 会顶到 100，验证封顶与 App 同一条
    const res = await events(room.users[0], room.code).expect(200);
    expect(res.body).toMatchObject({ eventId: "supply-drop", title: "补给站" });
    const heal = res.body.options.find((option) => option.id === "heal");
    expect(heal).toMatchObject({ cost: 3, label: "医疗补给", effects: { server: { hp: 15 }, client: [] } });
    await choose(room.users[0], room.code, "heal").expect(200);
    const snap = await snapshot(room.users[0], room.code).expect(200);
    expect(snap.body.room.members.find((member) => member.userId === room.users[0].id).hp).toBe(100);
  });

  test("★ 非 hp 效果不进 server：金币 / 档位 / 道具上限 / 免费刷新原样交给 App", () => {
    const arms = eventConfig.EVENTS.find((event) => event.id === "model-arms-race");
    const freeGold = arms.options.find((option) => option.id === "free-gold");
    expect(freeGold.effects).toEqual({ server: {}, client: [{ kind: "gold", delta: 4 }] });
    const upgrade = arms.options.find((option) => option.id === "upgrade-draft");
    expect(upgrade.effects).toEqual({ server: {}, client: [{ kind: "model-level", to: 2 }] });
    const inspiration = eventConfig.EVENTS.find((event) => event.id === "inspiration-burst");
    expect(inspiration.options.find((option) => option.id === "long-prompt").effects.client).toEqual([
      { kind: "prompt-limit-pct", pct: 50 },
    ]);
    const supply = eventConfig.EVENTS.find((event) => event.id === "supply-drop");
    expect(supply.options.find((option) => option.id === "bag-expand").effects.client).toEqual([
      { kind: "item-limit", delta: 1 },
    ]);
    expect(supply.options.find((option) => option.id === "free-refresh").effects.client).toEqual([
      { kind: "free-refresh", count: 2 },
    ]);
    // 花费不在 effects 里（金币由 App 本地扣），HP 也不许被写成 client 效果
    expect(freeGold.cost).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("GAME_OVER 与开关", () => {
  test("★ 这局已经结束：事件不可读、不可选（409 GAME_OVER，带 winners）", async () => {
    const room = await playingRoom(4);
    await settleRound(room, 1);
    await next(room.host, room.code).expect(200);
    await setHp(room.code, room.users[2].id, 5);
    await setHp(room.code, room.users[3].id, 5);
    await submitAll(room);
    await phase(room.host, room.code, "screening").expect(200);
    await phase(room.host, room.code, "voting").expect(200);
    await settle(room.host, room.code).expect(200);
    const res = await events(room.users[0], room.code);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "GAME_OVER" });
    expect(res.body.winners.sort()).toEqual([room.users[0].id, room.users[1].id].sort());
    expect((await choose(room.users[0], room.code, "skip")).body).toMatchObject({ code: "GAME_OVER" });
  });

  test("GAME_EVENTS_API=off → 503 GAME_EVENTS_OFF；health gameEvents=false（gameRounds 仍 true）；房间/回合照常", async () => {
    const on = await request(app).get("/api/ark/health").expect(200);
    expect(on.body).toMatchObject({ gameRooms: true, gameRounds: true, gameEvents: true });

    process.env.GAME_EVENTS_API = "off";
    const off = await request(app).get("/api/ark/health").expect(200);
    expect(off.body).toMatchObject({ gameRooms: true, gameRounds: true, gameEvents: false });

    const room = await atSecondSettled(2);
    const read = await events(room.users[0], room.code);
    expect(read.status).toBe(503);
    expect(read.body).toMatchObject({ code: "GAME_EVENTS_OFF" });
    const written = await choose(room.users[0], room.code, "skip");
    expect(written.status).toBe(503);
    expect(written.body).toMatchObject({ code: "GAME_EVENTS_OFF" });
    // ★ 关事件不该把房间 / 回合端点也关掉
    expect((await snapshot(room.users[0], room.code).expect(200)).body.room.code).toBe(room.code);
    expect((await next(room.host, room.code).expect(200)).body.round).toBe(3);
  });
});
