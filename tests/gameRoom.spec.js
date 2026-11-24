// tests/gameRoom.spec.js
// 「工坊对局」的房间与匹配（2026-11-23，G5 联机的第一块，HTTP 轮询版）。
// 设计正本在 app 仓 docs/workshop-game-design.md §三「服务端房间协议」与 docs/g2-game-ui.md 的大厅需求
// （4 人匹配 / 8 人匹配 / 自定义房间邀请）。
//
// 覆盖：建房（座位锁死 / custom 2~8）/ 房号形状与唯一索引 / 进房（码错 / 满员 / 已开局 / 重复进 /
// 在别的房里 / 大小写）/ ready / 开局（仅房主 / 人数 / 全员 ready / 只开一次）/ 退房（房主转移 /
// 最后一人的房间当场删）/ 踢人（仅房主 / 不能踢自己 / 不在房里）/ 过期懒清理（waiting 30 分钟、
// playing 2 小时、0 人的房、轮询续命、路人看不续命）/ 匹配撮合（3 人不成、4 人成、8 人池互不干扰、
// 排队顺序 = 房主顺序、心跳过期的人不参与、换模式要显式离队、房没了重新排）/ 能力位 / 总开关。
//
// ★ 这一组的判据错了都**零症状**（房间还是建出来了、人还是进去了），所以每条都要有反例：
//   · 座位数不锁死 → 客户端以为 6 人局、服务端给 4 座，一个错都不报；
//   · 进房不判满员 → 5 个人坐 4 个位置；
//   · 开局不看 ready → 有人还在一脸懵就被拖进对局；
//   · 房主走了不转移 → 剩下的人谁都不能开局，只能全部退房重来；
//   · 过期不清理 → 每开一局留一行永远不死的房，那个人永远「已经在房间里」，再也排不了队；
//   · 撮合不按排队顺序 → 后来的人当房主（先来的反而要等房主点开局）。
//
// ★ 不联网、不花钱：只用 MongoMemoryServer + supertest。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let config;
let GameRoom;
let GameQueue;

const ENV_KEYS = ["GAME_ROOMS"];
let savedEnv;

const MIN = 60 * 1000;

/** 建一个账号（走真的注册路由：房间成员的用户名是读 User 表拼出来的，得先有这个人） */
let seq = 0;
async function registerUser(tag) {
  seq += 1;
  const name = `gr_${tag}_${seq}_${Date.now().toString(36)}`;
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
const enqueue = (u, mode) => request(app).post("/api/game/queue").set(u.auth).send({ mode });
const queueState = (u) => request(app).get("/api/game/queue").set(u.auth);
const dequeue = (u) => request(app).delete("/api/game/queue").set(u.auth);

/** 直接把库里的时间往前挪（模拟「30 分钟没人动它」），不经过路由 */
async function ageRoom(code, patch) {
  await GameRoom.updateOne({ code }, { $set: patch }, { timestamps: false });
}
async function ageQueue(filter, patch) {
  await GameQueue.updateMany(filter, { $set: patch }, { timestamps: false });
}

/** 造一间 custom 房并把 n 个人塞进去（第一个人是房主）。返回 { code, users, host } */
async function customRoomWith(n, seats = 8) {
  const users = [];
  for (let i = 0; i < n; i += 1) users.push(await registerUser(`seat${i}`));
  const created = await create(users[0], { mode: "custom", seats }).expect(201);
  const code = created.body.room.code;
  for (let i = 1; i < n; i += 1) await join(users[i], code).expect(200);
  return { code, users, host: users[0] };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  config = require("../src/config/gameRoom");
  GameRoom = require("../src/models/GameRoom");
  GameQueue = require("../src/models/GameQueue");
  await Promise.all([GameRoom.createIndexes(), GameQueue.createIndexes()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await GameRoom.deleteMany({});
  await GameQueue.deleteMany({});
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─────────────────────────────────────────────────────────────────────
describe("建房：座位数由模式锁死，房号 6 位", () => {
  test("match4 → 4 座 / requiredPlayers 4 / 房主是创建者且已 ready / 座位 0", async () => {
    const u = await registerUser("create4");
    const res = await create(u, { mode: "match4" }).expect(201);
    const room = res.body.room;
    expect(room).toMatchObject({
      mode: "match4",
      seats: 4,
      requiredPlayers: 4,
      status: "waiting",
      origin: "create",
      memberCount: 1,
      hostId: u.id,
      canStart: false,
      startBlockedBy: "not-enough-players",
    });
    expect(room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/); // 没有 I/O/0/1
    expect(room.code).toHaveLength(config.CODE_LENGTH);
    expect(room.members).toHaveLength(1);
    expect(room.members[0]).toMatchObject({ userId: u.id, seat: 0, ready: true, isHost: true, username: u.username });
    expect(room.roomId).toBeTruthy();
    expect(new Date(room.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("match8 → 8 座；custom 自选 5 座但**开局只要 2 人**", async () => {
    const a = await registerUser("create8");
    const b = await registerUser("createC");
    expect((await create(a, { mode: "match8" }).expect(201)).body.room).toMatchObject({ seats: 8, requiredPlayers: 8 });
    expect((await create(b, { mode: "custom", seats: 5 }).expect(201)).body.room).toMatchObject({
      seats: 5,
      requiredPlayers: config.MIN_PLAYERS_TO_START,
    });
  });

  test("custom 的座位必须是 2~8 的整数；不给也拒（不猜一个缺省座位数）", async () => {
    const u = await registerUser("create-bad");
    for (const seats of [1, 9, 0, 2.5, "三", undefined, null]) {
      const res = await create(u, { mode: "custom", seats });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code: "BAD_SEATS" });
    }
    expect(await GameRoom.countDocuments({})).toBe(0); // 一个都没建出来
  });

  test("match4 给了 6 座 → 400 SEATS_LOCKED（**不静默忽略**：客户端以为建了 6 人局）", async () => {
    const u = await registerUser("create-locked");
    const res = await create(u, { mode: "match4", seats: 6 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "SEATS_LOCKED", seats: 4 });
    expect(await GameRoom.countDocuments({})).toBe(0);
  });

  test("模式不认 → 400 BAD_MODE；未登录 → 401", async () => {
    const u = await registerUser("create-mode");
    expect((await create(u, { mode: "match2" })).body).toMatchObject({ code: "BAD_MODE" });
    expect((await create(u, {})).body).toMatchObject({ code: "BAD_MODE" });
    await request(app).post("/api/game/rooms").send({ mode: "match4" }).expect(401);
  });

  test("两个房主各建一间 → 两个不同的 6 位码；房号有唯一索引（并发建房的闸）", async () => {
    const a = await registerUser("codes-a");
    const b = await registerUser("codes-b");
    const one = (await create(a, { mode: "match4" }).expect(201)).body.room.code;
    const two = (await create(b, { mode: "match4" }).expect(201)).body.room.code;
    expect(two).not.toBe(one);
    const indexes = await GameRoom.collection.indexes();
    const codeIndex = indexes.find((i) => i.key && i.key.code === 1);
    expect(codeIndex).toBeTruthy();
    expect(codeIndex.unique).toBe(true);
  });

  test("一个人同时只能在一间房里：已经在房里再建 → 409 ALREADY_IN_ROOM（带那间房的码）", async () => {
    const u = await registerUser("one-room");
    const first = (await create(u, { mode: "custom", seats: 4 }).expect(201)).body.room;
    const again = await create(u, { mode: "custom", seats: 4 });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "ALREADY_IN_ROOM", roomCode: first.code });
    expect(await GameRoom.countDocuments({})).toBe(1);
  });

  test("房间与队列里**不存敏感信息**：只有 ObjectId，用户名是读 User 表拼的", async () => {
    const u = await registerUser("privacy");
    const room = (await create(u, { mode: "match4" }).expect(201)).body.room;
    const doc = await GameRoom.findOne({ code: room.code }).lean();
    expect(JSON.stringify(doc)).not.toMatch(/@test\.local/);
    expect(JSON.stringify(doc)).not.toMatch(new RegExp(u.username));
    // 回合引擎（2026-11-23）起成员多了 hp（开局 100）；除它之外仍然只有 id / ready / joinedAt
    expect(doc.members[0]).toEqual({
      userId: doc.members[0].userId,
      ready: true,
      hp: 100,
      joinedAt: expect.any(Date),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("进房：码错 / 满员 / 已开局 / 重复 / 在别的房里", () => {
  test("码错或形状不对 → 404 ROOM_NOT_FOUND（与「过期了」同一句话）", async () => {
    const u = await registerUser("join-bad");
    expect((await join(u, "ZZZZZZ")).status).toBe(404);
    expect((await join(u, "ZZZZZZ")).body).toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect((await join(u, "ABC")).body).toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect((await join(u, "")).body).toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect((await join(u, undefined)).body).toMatchObject({ code: "ROOM_NOT_FOUND" });
  });

  test("房号大小写不敏感（手抄 / 口述都要认）", async () => {
    const host = await registerUser("join-case-host");
    const guest = await registerUser("join-case-guest");
    const code = (await create(host, { mode: "match4" }).expect(201)).body.room.code;
    const res = await join(guest, code.toLowerCase()).expect(200);
    expect(res.body.room.memberCount).toBe(2);
    expect(res.body.room.members[1]).toMatchObject({ userId: guest.id, seat: 1, ready: false, isHost: false });
  });

  test("满员 → 409 ROOM_FULL（带 seats 与 memberCount）；重复进房 → 409 ALREADY_IN_ROOM（带快照）", async () => {
    const { code, users } = await customRoomWith(2, 2);
    const third = await registerUser("join-full");
    const full = await join(third, code);
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ code: "ROOM_FULL", seats: 2, memberCount: 2 });
    const dup = await join(users[1], code);
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: "ALREADY_IN_ROOM", roomCode: code });
    expect(dup.body.room.memberCount).toBe(2); // 重复点击也当「你已经在里面」，直接给快照
  });

  test("并发抢最后一个空位：只有一个人进得去（容量写在原子更新的条件里）", async () => {
    const host = await registerUser("race-host");
    const one = await registerUser("race-1");
    const two = await registerUser("race-2");
    const code = (await create(host, { mode: "custom", seats: 2 }).expect(201)).body.room.code;
    const [a, b] = await Promise.all([join(one, code), join(two, code)]);
    const okCount = [a, b].filter((r) => r.status === 200).length;
    expect(okCount).toBe(1);
    const failed = [a, b].find((r) => r.status !== 200);
    expect(failed.status).toBe(409);
    expect(failed.body.code).toBe("ROOM_FULL");
    expect((await GameRoom.findOne({ code })).members).toHaveLength(2);
  });

  test("已经在别的房里 → 409 ALREADY_IN_ROOM（带那间房的码，不让一个人挂两间）", async () => {
    const a = await registerUser("join-other-a");
    const b = await registerUser("join-other-b");
    const one = (await create(a, { mode: "custom", seats: 4 }).expect(201)).body.room.code;
    const two = (await create(b, { mode: "custom", seats: 4 }).expect(201)).body.room.code;
    const res = await join(a, two);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ALREADY_IN_ROOM", roomCode: one });
    expect((await GameRoom.findOne({ code: two })).members).toHaveLength(1);
  });

  test("开局之后进不去了 → 409 ROOM_ALREADY_STARTED", async () => {
    const { code, users } = await customRoomWith(2);
    await ready(users[1], code, true).expect(200);
    await start(users[0], code).expect(200);
    const late = await registerUser("join-late");
    const res = await join(late, code);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ROOM_ALREADY_STARTED" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("准备 / 开局：仅房主、人数达标、全员 ready", () => {
  test("ready 只认布尔；非成员准备 → 409 NOT_IN_ROOM", async () => {
    const { code, users } = await customRoomWith(2);
    expect((await ready(users[1], code, true).expect(200)).body.room.members[1].ready).toBe(true);
    expect((await ready(users[1], code, false).expect(200)).body.room.members[1].ready).toBe(false);
    expect((await ready(users[1], code, "true")).body).toMatchObject({ code: "BAD_READY" });
    const outsider = await registerUser("ready-outsider");
    expect((await ready(outsider, code, true)).body).toMatchObject({ code: "NOT_IN_ROOM" });
  });

  test("非房主开局 → 403 NOT_HOST（带 hostId）", async () => {
    const { code, users } = await customRoomWith(2);
    await ready(users[1], code, true).expect(200);
    const res = await start(users[1], code);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "NOT_HOST", hostId: users[0].id });
  });

  test("4 人匹配房只有 2 个人 → 409 NOT_ENOUGH_PLAYERS（need 4 / have 2）", async () => {
    const host = await registerUser("start-4host");
    const guest = await registerUser("start-4guest");
    const code = (await create(host, { mode: "match4" }).expect(201)).body.room.code;
    await join(guest, code).expect(200);
    await ready(guest, code, true).expect(200);
    const res = await start(host, code);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "NOT_ENOUGH_PLAYERS", need: 4, have: 2 });
  });

  test("有人没准备 → 409 NOT_ALL_READY（waitingOn 是那些没准备好的人）", async () => {
    const { code, users } = await customRoomWith(3);
    await ready(users[2], code, true).expect(200);
    const snap = await snapshot(users[0], code).expect(200);
    expect(snap.body.room.startBlockedBy).toBe("not-all-ready");
    const res = await start(users[0], code);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_ALL_READY");
    expect(res.body.waitingOn).toEqual([users[1].id]);
  });

  test("custom 只要 2 个人、全员 ready 就能开；开了之后 ready / 开局都不认", async () => {
    const { code, users } = await customRoomWith(2);
    await ready(users[1], code, true).expect(200);
    const started = await start(users[0], code).expect(200);
    expect(started.body.room.status).toBe("playing");
    expect(started.body.room.startedAt).toBeTruthy();
    expect(started.body.room.startBlockedBy).toBe("already-started");
    expect((await start(users[0], code)).body).toMatchObject({ code: "ROOM_ALREADY_STARTED" });
    expect((await ready(users[1], code, true)).body).toMatchObject({ code: "ROOM_ALREADY_STARTED" });
  });

  test("4 人匹配房凑齐 4 个人 + 全员 ready → 开得动", async () => {
    const users = [];
    for (let i = 0; i < 4; i += 1) users.push(await registerUser(`start4-${i}`));
    const code = (await create(users[0], { mode: "match4" }).expect(201)).body.room.code;
    for (let i = 1; i < 4; i += 1) {
      await join(users[i], code).expect(200);
      await ready(users[i], code, true).expect(200);
    }
    const res = await start(users[0], code).expect(200);
    expect(res.body.room).toMatchObject({ status: "playing", memberCount: 4, canStart: false });
  });

  test("房号不存在 → 404（开局 / 准备 / 踢人都是同一句）", async () => {
    const u = await registerUser("start-missing");
    expect((await start(u, "AAAAAA")).status).toBe(404);
    expect((await ready(u, "AAAAAA", true)).status).toBe(404);
    expect((await kick(u, "AAAAAA", u.id)).status).toBe(404);
    expect((await leave(u, "AAAAAA")).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("退房 / 踢人", () => {
  test("退房后人数少一个；没在房里退 → 409 NOT_IN_ROOM", async () => {
    const { code, users } = await customRoomWith(3);
    const res = await leave(users[2], code).expect(200);
    expect(res.body).toMatchObject({ left: true, closed: false, code });
    expect(res.body.room.memberCount).toBe(2);
    expect((await leave(users[2], code)).body).toMatchObject({ code: "NOT_IN_ROOM" });
  });

  test("★ 房主退房 → 房主转移给最早进房的人，新房主能开局", async () => {
    const { code, users } = await customRoomWith(3);
    const res = await leave(users[0], code).expect(200);
    expect(res.body.hostTransferred).toBe(true);
    expect(res.body.hostId).toBe(users[1].id);
    const snap = await snapshot(users[1], code).expect(200);
    expect(snap.body.room.hostId).toBe(users[1].id);
    expect(snap.body.room.members.find((m) => m.userId === users[1].id).isHost).toBe(true);
    // 座位按加入顺序派生：走了第 0 位之后，剩下的人重新排成 0/1
    expect(snap.body.room.members.map((m) => m.seat)).toEqual([0, 1]);
    await ready(users[1], code, true).expect(200);
    await ready(users[2], code, true).expect(200);
    await start(users[1], code).expect(200); // 新房主真的开得动
    expect((await start(users[0], code)).body).toMatchObject({ code: "NOT_HOST" });
  });

  test("最后一个人退房 → 房间当场删掉（closed:true / room:null / 再查 404）", async () => {
    const host = await registerUser("last-out");
    const code = (await create(host, { mode: "match4" }).expect(201)).body.room.code;
    const res = await leave(host, code).expect(200);
    expect(res.body).toMatchObject({ left: true, closed: true, room: null, hostId: null });
    expect(await GameRoom.countDocuments({})).toBe(0);
    expect((await snapshot(host, code)).status).toBe(404);
  });

  test("踢人：仅房主 / 不能踢自己 / 不在房里 404；踢掉之后那个人要重新准备", async () => {
    const { code, users } = await customRoomWith(3);
    expect((await kick(users[1], code, users[2].id)).body).toMatchObject({ code: "NOT_HOST" });
    expect((await kick(users[0], code, users[0].id)).body).toMatchObject({ code: "CANNOT_KICK_SELF" });
    const outsider = await registerUser("kick-outsider");
    expect((await kick(users[0], code, outsider.id)).status).toBe(404);
    expect((await kick(users[0], code, outsider.id)).body).toMatchObject({ code: "MEMBER_NOT_FOUND" });
    expect((await kick(users[0], code, "not-an-id")).body).toMatchObject({ code: "BAD_USER" });
    const kicked = await kick(users[0], code, users[2].id).expect(200);
    expect(kicked.body).toMatchObject({ kicked: users[2].id });
    expect(kicked.body.room.memberCount).toBe(2);
    expect((await ready(users[2], code, true)).body).toMatchObject({ code: "NOT_IN_ROOM" });
  });

  test("开局之后踢不动（座次已定）", async () => {
    const { code, users } = await customRoomWith(3);
    await ready(users[1], code, true).expect(200);
    await ready(users[2], code, true).expect(200);
    await start(users[0], code).expect(200);
    expect((await kick(users[0], code, users[2].id)).body).toMatchObject({ code: "ROOM_ALREADY_STARTED" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("过期清理：懒清理（没有定时任务）", () => {
  test("waiting 房超过 30 分钟没人动 → 读一次就 404，而且库里那行被删掉", async () => {
    const u = await registerUser("ttl-waiting");
    const code = (await create(u, { mode: "match4" }).expect(201)).body.room.code;
    await ageRoom(code, { lastSeenAt: new Date(Date.now() - 31 * MIN) });
    expect((await snapshot(u, code)).status).toBe(404);
    expect((await snapshot(u, code)).body).toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect(await GameRoom.countDocuments({ code })).toBe(0);
  });

  test("★ 成员轮询**续命**：29 分钟没动 + 读一次 = 还活着，而且 updatedAt（最后状态变化）没有被轮询改掉", async () => {
    const u = await registerUser("ttl-touch");
    const code = (await create(u, { mode: "match4" }).expect(201)).body.room.code;
    const before = await GameRoom.findOne({ code }).lean();
    await ageRoom(code, { lastSeenAt: new Date(Date.now() - 29 * MIN) });
    const res = await snapshot(u, code).expect(200);
    expect(res.body.room.code).toBe(code);
    const after = await GameRoom.findOne({ code }).lean();
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5 * 1000);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime()); // ★ timestamps:false
    expect(res.body.room.updatedAt).toBe(before.updatedAt.toISOString());
  });

  test("路人读快照**不续命**（看一眼邀请不该让一间没人管的房活着）", async () => {
    const host = await registerUser("ttl-watcher-host");
    const watcher = await registerUser("ttl-watcher");
    const code = (await create(host, { mode: "match4" }).expect(201)).body.room.code;
    const old = new Date(Date.now() - 20 * MIN);
    await ageRoom(code, { lastSeenAt: old });
    await snapshot(watcher, code).expect(200);
    const doc = await GameRoom.findOne({ code }).lean();
    expect(doc.lastSeenAt.getTime()).toBe(old.getTime());
  });

  test("playing 房寿命更长：40 分钟没动还活着，3 小时没动才清", async () => {
    const a = await registerUser("ttl-play-a");
    const b = await registerUser("ttl-play-b");
    const one = (await create(a, { mode: "custom", seats: 4 }).expect(201)).body.room.code;
    await join(b, one).expect(200);
    await ready(b, one, true).expect(200);
    await start(a, one).expect(200);
    await ageRoom(one, { lastSeenAt: new Date(Date.now() - 40 * MIN) });
    expect((await snapshot(a, one)).status).toBe(200);

    // ★ 第二间房必须换人：a / b 已经在上面那局里（一人一间，建房会被 409 挡住）
    const c = await registerUser("ttl-play-c");
    const d = await registerUser("ttl-play-d");
    const two = (await create(c, { mode: "custom", seats: 4 }).expect(201)).body.room.code;
    await join(d, two).expect(200);
    await ready(d, two, true).expect(200);
    await start(c, two).expect(200);
    await ageRoom(two, { lastSeenAt: new Date(Date.now() - 3 * 60 * MIN) });
    expect((await snapshot(c, two)).status).toBe(404);
  });

  test("sweepExpired 只删过期的与 0 人的房；新鲜的、还在 playing 的都留着", async () => {
    const u = await registerUser("sweep");
    const fresh = (await create(u, { mode: "match4" }).expect(201)).body.room.code;
    // 再造两间「没人」的房：直接写库（路由不会留下 0 人的房）
    await GameRoom.create({ code: "AAAAA2", mode: "custom", seats: 2, hostId: u.id, status: "waiting", members: [], lastSeenAt: new Date() });
    await GameRoom.create({
      code: "AAAAA3",
      mode: "custom",
      seats: 2,
      hostId: u.id,
      status: "waiting",
      members: [{ userId: u.id, ready: false, joinedAt: new Date() }],
      lastSeenAt: new Date(Date.now() - 45 * MIN),
    });
    const removed = await require("../src/services/gameRoom.service").sweepExpired({ force: true });
    expect(removed).toBe(2);
    expect(await GameRoom.countDocuments({})).toBe(1);
    expect(await GameRoom.countDocuments({ code: fresh })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("匹配撮合：3 人不成、4 人成（8 人池互不干扰）", () => {
  test("3 个人排 match4 都还是 waiting（queued 3 / need 4 / etaSec 30），一间房都没建出来", async () => {
    const users = [];
    for (let i = 0; i < 3; i += 1) users.push(await registerUser(`q3-${i}`));
    const res = await enqueue(users[0], "match4").expect(200);
    expect(res.body).toMatchObject({ status: "waiting", mode: "match4", queued: 1, need: 4, position: 1, etaSec: 90 });
    for (let i = 1; i < 3; i += 1) {
      const r = await enqueue(users[i], "match4").expect(200);
      expect(r.body.status).toBe("waiting");
      expect(r.body.queued).toBe(i + 1);
    }
    expect((await queueState(users[0])).body).toMatchObject({ status: "waiting", queued: 3, need: 4, etaSec: 30, position: 1 });
    expect((await queueState(users[2])).body.position).toBe(3);
    expect(await GameRoom.countDocuments({})).toBe(0);
  });

  test("★ 第 4 个人进队 → 服务端当场建房，四个人的队列响应里都带同一个房号", async () => {
    const users = [];
    for (let i = 0; i < 4; i += 1) users.push(await registerUser(`q4-${i}`));
    for (let i = 0; i < 3; i += 1) await enqueue(users[i], "match4").expect(200);
    const matched = await enqueue(users[3], "match4").expect(200);
    expect(matched.body).toMatchObject({ status: "matched", mode: "match4", need: 4, etaSec: 0 });
    expect(matched.body.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(matched.body.room).toMatchObject({ mode: "match4", seats: 4, status: "waiting", memberCount: 4, origin: "match" });
    // 前三位下一次轮询就能读到房号（撮合发生在别人的请求里，房号必须留在队列行上）
    for (let i = 0; i < 3; i += 1) {
      const st = await queueState(users[i]).expect(200);
      expect(st.body).toMatchObject({ status: "matched", mode: "match4", code: matched.body.code, roomId: matched.body.room.roomId });
      expect(st.body.room.members).toHaveLength(4);
    }
    expect(await GameRoom.countDocuments({})).toBe(1);
    // 房主 = 最早排队的人；撮合出来的人都是 ready
    const room = await GameRoom.findOne({ code: matched.body.code }).lean();
    expect(String(room.hostId)).toBe(users[0].id);
    expect(room.members.every((m) => m.ready)).toBe(true);
    expect(room.members.map((m) => String(m.userId))).toEqual(users.map((u) => u.id));
  });

  test("匹配成功的房主自己就能开局（4 人、全员 ready）", async () => {
    const users = [];
    for (let i = 0; i < 4; i += 1) users.push(await registerUser(`qm-${i}`));
    for (let i = 0; i < 3; i += 1) await enqueue(users[i], "match8").expect(200);
    await enqueue(users[3], "match8").expect(200);
    expect(await GameRoom.countDocuments({})).toBe(0); // 8 人池：4 个人还不够
    for (let i = 4; i < 8; i += 1) users.push(await registerUser(`qm-${i}`));
    let code = null;
    for (let i = 4; i < 8; i += 1) {
      const r = await enqueue(users[i], "match8").expect(200);
      if (r.body.status === "matched") code = r.body.code;
    }
    expect(code).toBeTruthy();
    const room = (await snapshot(users[0], code).expect(200)).body.room;
    expect(room.memberCount).toBe(8);
    const res = await start(users[0], code).expect(200);
    expect(res.body.room.status).toBe("playing");
  });

  test("4 人池与 8 人池互不干扰：3 个 match8 + 1 个 match4 不会凑成一局", async () => {
    const users = [];
    for (let i = 0; i < 4; i += 1) users.push(await registerUser(`qp-${i}`));
    for (let i = 0; i < 3; i += 1) await enqueue(users[i], "match8").expect(200);
    const lonely = await enqueue(users[3], "match4").expect(200);
    expect(lonely.body).toMatchObject({ status: "waiting", mode: "match4", queued: 1, need: 4 });
    expect(await GameRoom.countDocuments({})).toBe(0);
    const st = await queueState(users[0]).expect(200);
    expect(st.body.pools).toMatchObject({ match4: { queued: 1, need: 4 }, match8: { queued: 3, need: 8 } });
  });

  test("换模式要显式离队：409 QUEUE_MODE_CONFLICT，DELETE 之后能换", async () => {
    const u = await registerUser("qmode");
    await enqueue(u, "match4").expect(200);
    const conflict = await enqueue(u, "match8");
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "QUEUE_MODE_CONFLICT", queuedMode: "match4" });
    expect((await dequeue(u).expect(200)).body).toMatchObject({ left: true });
    expect((await enqueue(u, "match8").expect(200)).body).toMatchObject({ status: "waiting", mode: "match8", need: 8 });
  });

  test("离队是幂等的：本来没排也回 200 + left:false；离队之后状态是 idle", async () => {
    const u = await registerUser("qdeq");
    expect((await dequeue(u).expect(200)).body).toMatchObject({ ok: true, left: false });
    await enqueue(u, "match4").expect(200);
    expect((await dequeue(u).expect(200)).body).toMatchObject({ left: true });
    expect((await queueState(u)).body).toMatchObject({ status: "idle", mode: null, queued: null });
    expect((await queueState(u)).body.pools).toMatchObject({ match4: { queued: 0, need: 4 } });
  });

  test("已经在房里的人不能排队（409 ALREADY_IN_ROOM，带房号）", async () => {
    const u = await registerUser("qinroom");
    const code = (await create(u, { mode: "custom", seats: 4 }).expect(201)).body.room.code;
    const res = await enqueue(u, "match4");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ALREADY_IN_ROOM", roomCode: code });
  });

  test("custom 不能排队（400 BAD_MODE）；未登录 401", async () => {
    const u = await registerUser("qbad");
    expect((await enqueue(u, "custom")).body).toMatchObject({ code: "BAD_MODE" });
    expect((await enqueue(u, "match6")).body).toMatchObject({ code: "BAD_MODE" });
    await request(app).post("/api/game/queue").send({ mode: "match4" }).expect(401);
    await request(app).get("/api/game/queue").expect(401);
    await request(app).delete("/api/game/queue").expect(401);
  });

  test("★ 心跳过期的人不参与撮合（关屏 / 杀进程的人不该被塞进房）", async () => {
    const users = [];
    for (let i = 0; i < 4; i += 1) users.push(await registerUser(`qstale-${i}`));
    for (let i = 0; i < 3; i += 1) await enqueue(users[i], "match4").expect(200);
    // 前面三个人全部超时（心跳 90 秒）
    await ageQueue({ status: "waiting" }, { lastSeenAt: new Date(Date.now() - 5 * MIN) });
    const res = await enqueue(users[3], "match4").expect(200);
    expect(res.body).toMatchObject({ status: "waiting", queued: 1, need: 4 });
    expect(await GameRoom.countDocuments({})).toBe(0);
    // 懒清理会把这几行清掉
    const service = require("../src/services/gameRoom.service");
    await service.sweepExpired({ force: true });
    expect(await GameQueue.countDocuments({})).toBe(1);
  });

  test("匹配到但房没了（过期 / 被删）→ 队列状态回到 idle，重新排队能排上", async () => {
    const users = [];
    for (let i = 0; i < 4; i += 1) users.push(await registerUser(`qgone-${i}`));
    for (let i = 0; i < 3; i += 1) await enqueue(users[i], "match4").expect(200);
    const matched = await enqueue(users[3], "match4").expect(200);
    await GameRoom.deleteOne({ code: matched.body.code });
    expect((await queueState(users[0])).body).toMatchObject({ status: "idle" });
    expect(await GameQueue.countDocuments({ userId: users[0].id })).toBe(0);
    expect((await enqueue(users[0], "match4").expect(200)).body).toMatchObject({ status: "waiting", queued: 1 });
  });

  test("并发进队不会超员 / 不会一个人进两间房；再补一拍就能撮合", async () => {
    const users = [];
    for (let i = 0; i < 4; i += 1) users.push(await registerUser(`qrace-${i}`));
    await Promise.all(users.map((u) => enqueue(u, "match4")));
    expect(await GameRoom.countDocuments({})).toBeLessThanOrEqual(1);
    // 补一拍（客户端每 2~5 秒就这么干一次）：只补还在等的人 —— 已经匹配上的
    // 再 POST 会 409 ALREADY_IN_ROOM（它已经在房里了），客户端那时候读的是 GET
    for (const u of users) {
      const st = await queueState(u).expect(200);
      if (st.body.status === "waiting") await enqueue(u, "match4").expect(200);
    }
    const codes = new Set();
    for (const u of users) {
      const st = await queueState(u).expect(200);
      expect(st.body.status).toBe("matched");
      codes.add(st.body.code);
    }
    expect(codes.size).toBe(1);
    const room = await GameRoom.findOne({ code: [...codes][0] }).lean();
    expect(room.members).toHaveLength(4);
    expect(new Set(room.members.map((m) => String(m.userId))).size).toBe(4);
  });

  test("队列表：一个人只有一行（userId 唯一索引）", async () => {
    const indexes = await GameQueue.collection.indexes();
    const userIndex = indexes.find((i) => i.key && i.key.userId === 1);
    expect(userIndex).toBeTruthy();
    expect(userIndex.unique).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("能力位与总开关", () => {
  test("/api/ark/health 亮出 gameRooms 能力位（App 见不到就不摆大厅入口）", async () => {
    const h = await request(app).get("/api/ark/health").expect(200);
    expect(h.body).toMatchObject({
      gameRooms: true,
      gameRoomModes: ["match4", "match8", "custom"],
      gameRoomMaxSeats: 8,
      // SSE 推送（2026-11-23，tests/gameRoomStream.spec.js）：有 /rooms/:code/stream
      gameRoomStream: true,
      // 跨实例（2026-11-24）：没有 REDIS_URL 时是 false（本套不配）；集成测试在 tests/gameRoomBusRedis.spec.js。
      // 用 any(Boolean) 不把开发机导出的 REDIS_URL 变成假红
      gameRoomStreamShared: expect.any(Boolean),
    });
  });

  test("GAME_ROOMS=off：房间与匹配 503 GAME_ROOMS_OFF，能力位 false；游戏券端点**不受影响**", async () => {
    process.env.GAME_ROOMS = "off";
    const u = await registerUser("off");
    const created = await create(u, { mode: "match4" });
    expect(created.status).toBe(503);
    expect(created.body).toMatchObject({ code: "GAME_ROOMS_OFF" });
    expect((await request(app).get("/api/game/queue").set(u.auth)).status).toBe(503);
    expect((await request(app).get("/api/game/rooms/AAAAAA").set(u.auth)).status).toBe(503);
    const h = await request(app).get("/api/ark/health").expect(200);
    expect(h.body).toMatchObject({
      gameRooms: false,
      gameRoomModes: [],
      gameRoomStream: false,
      // 总开关关着时跨实例一位也必须是 false（没有流可推）
      gameRoomStreamShared: false,
    });
    // ★ 关对局不该顺手关掉出片扣券：同前缀的另一个路由照常
    const tickets = await request(app).get("/api/game/tickets").set(u.auth).expect(200);
    expect(tickets.body.ok).toBe(true);
    expect(await GameRoom.countDocuments({})).toBe(0);
  });
});
