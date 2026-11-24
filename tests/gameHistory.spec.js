// tests/gameHistory.spec.js
// 「工坊对局」的**历史回合 + 战绩**（2026-11-24，GET /api/game/rooms/:code/rounds/history）。
// 设计需求：App 的「战绩 + 每回合影片回放」一次读全 —— 房间文档 `rounds[]` 里本来就有每回合的
// 交片 / 点赞 / 投票 / 结算，但之前没有读历史的端点，一局打完后客户端只能看到最后一回合。
//
// 覆盖：成员可读与完整形状（全部回合、按 round 升序、`settled` 标记、`settlement` 只出现在已结算
// 回合、entries 带 `modelTier`、likes/votes 是计数）/ 非成员 403 / 未登录 401 / 房间不存在或已过期
// 404（过期是硬删，历史跟着没）/ 结束的一局带 state + winners + finishedAt / summary 两个回合的
// 累加（wins 看综合名次第一、likesTotal/votesTotal 全回合累加、bestRound 取最好名次、没上榜的人
// 没有 bestRound）/ 成员读续命 / 能力位与两个急停开关（GAME_HISTORY / GAME_ROUNDS 的先后）。
//
// ★ 战绩口径错了零症状（数字都长得像对的），所以每一条都拿**两回合的手算结果**钉住；
//   排序用「库里故意乱序」造出来 —— 依赖存储顺序的话，生产上 next 之后再追加就会错位。
// ★ 不联网、不花钱：只用 MongoMemoryServer + supertest（与 gameRound.spec 同一套）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let GameRoom;

const ENV_KEYS = ["GAME_HISTORY", "GAME_ROUNDS", "GAME_ROOMS"];
let savedEnv;

/** 建一个账号（名字是读 User 表拼出来的，历史回包里的 name 要能对上） */
let seq = 0;
async function registerUser(tag) {
  seq += 1;
  const name = `gh_${tag}_${seq}_${Date.now().toString(36)}`;
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
const roundsStart = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/start`).set(u.auth).send({});
const history = (u, code) => request(app).get(`/api/game/rooms/${code}/rounds/history`).set(u.auth);
const current = (u, code) => request(app).get(`/api/game/rooms/${code}/rounds/current`).set(u.auth);

/** 造一间 n 人的 custom 房并开局（第一个人是房主，其余人 join + ready）：返回 { code, users } */
async function playingRoom(n) {
  const users = [];
  for (let i = 0; i < n; i += 1) users.push(await registerUser(`p${n}-${i}`));
  const created = await create(users[0], { mode: "custom", seats: n }).expect(201);
  const code = created.body.room.code;
  for (let i = 1; i < n; i += 1) {
    await join(users[i], code).expect(200);
    await ready(users[i], code, true).expect(200);
  }
  await startRoom(users[0], code).expect(200);
  return { code, users, host: users[0] };
}

async function setMemberHp(code, userId, hp) {
  await GameRoom.updateOne({ code, "members.userId": userId }, { $set: { "members.$.hp": hp } }, { timestamps: false });
}

/** 直接把 rounds[] 写进库（历史端点只读；手造两回合才能把累加口径钉死） */
async function seedRounds(code, rounds) {
  await GameRoom.updateOne({ code }, { $set: { rounds } }, { timestamps: false });
}

const oid = () => new mongoose.Types.ObjectId();

function entryDoc(entryId, user, prompt) {
  return {
    entryId,
    userId: user.id,
    prompt,
    cardNames: ["角色卡", "场景卡"],
    videoUrl: `https://example.test/${prompt}.mp4`,
    posterUrl: `https://example.test/${prompt}.jpg`,
    placeholder: false,
    modelTier: "draft",
    submittedAt: new Date(),
  };
}

const likeDoc = (from, to) => ({ userId: from.id, targetUserId: to.id, at: new Date() });
const abstainDoc = (from) => ({ userId: from.id, targetUserId: null, at: new Date() });

/**
 * 两回合都结算 + 一个正在打的第 3 回合。故意**乱序**放进库里（round3 → round1 → round2），
 * 端点必须自己按 round 升序。
 *
 * 手算口径（下面 summary 的期望值就是这么来的）：
 *   round1 点赞 B→A、C→A、A→C ⇒ A=2 B=0 C=1；投票 B→A、C→A、A→B ⇒ A=2 B=1 C=0；
 *          综合名次 [A, B, C]。
 *   round2 点赞 A→B、C→B、B→C ⇒ B=2 C=1 A=0；投票 A→B、B→C、C→B + D 弃权 ⇒ B=2 C=1 A=0；
 *          综合名次 [B, C, A]。
 *   round3（creating，未结算）点赞 C→A ⇒ 只累加计数，不进 roundsPlayed / wins。
 */
function historyFixture(users) {
  const [a, b, c, d] = users;
  const e1 = { a: oid(), b: oid(), c: oid() };
  const e2 = { a: oid(), b: oid(), c: oid() };
  const e3 = { a: oid(), b: oid(), c: oid() };
  return {
    entries: { e1, e2, e3 },
    rounds: [
      // 故意乱序：第 3 回合排在最前
      {
        round: 3,
        phase: "creating",
        startedAt: new Date(),
        phaseChangedAt: new Date(),
        entries: [entryDoc(e3.a, a, "r3-a"), entryDoc(e3.b, b, "r3-b"), entryDoc(e3.c, c, "r3-c")],
        likes: [likeDoc(c, a)],
        votes: [],
        settlement: null,
      },
      {
        round: 1,
        phase: "settled",
        startedAt: new Date(),
        phaseChangedAt: new Date(),
        entries: [entryDoc(e1.a, a, "r1-a"), entryDoc(e1.b, b, "r1-b"), entryDoc(e1.c, c, "r1-c")],
        likes: [likeDoc(b, a), likeDoc(c, a), likeDoc(a, c)],
        votes: [likeDoc(b, a), likeDoc(c, a), likeDoc(a, b)],
        settlement: {
          ranking: [
            { userId: a.id, likes: 2, votes: 2, likeRank: 1, voteRank: 1, composite: 2, damage: 5, hp: 95, eliminated: false },
            { userId: b.id, likes: 0, votes: 1, likeRank: 3, voteRank: 2, composite: 5, damage: 10, hp: 90, eliminated: false },
            { userId: c.id, likes: 1, votes: 0, likeRank: 2, voteRank: 3, composite: 5, damage: 15, hp: 85, eliminated: false },
          ],
          winners: [],
          settledAt: new Date(),
        },
      },
      {
        round: 2,
        phase: "settled",
        startedAt: new Date(),
        phaseChangedAt: new Date(),
        entries: [entryDoc(e2.a, a, "r2-a"), entryDoc(e2.b, b, "r2-b"), entryDoc(e2.c, c, "r2-c")],
        likes: [likeDoc(a, b), likeDoc(c, b), likeDoc(b, c)],
        votes: [likeDoc(a, b), likeDoc(b, c), likeDoc(c, b), abstainDoc(d)],
        settlement: {
          ranking: [
            { userId: b.id, likes: 2, votes: 2, likeRank: 1, voteRank: 1, composite: 2, damage: 5, hp: 85, eliminated: false },
            { userId: c.id, likes: 1, votes: 1, likeRank: 2, voteRank: 2, composite: 4, damage: 10, hp: 75, eliminated: false },
            { userId: a.id, likes: 0, votes: 0, likeRank: 3, voteRank: 3, composite: 6, damage: 15, hp: 80, eliminated: false },
          ],
          winners: [b.id, c.id],
          settledAt: new Date(),
        },
      },
    ],
  };
}

/** 造好「4 人房 + 两回合历史」：A/B/C 参赛，D 只是房里的第四个人（没有投稿） */
async function seededRoom() {
  const room = await playingRoom(4);
  const [a, b, c, d] = room.users;
  const fixture = historyFixture(room.users);
  await setMemberHp(room.code, a.id, 80);
  await setMemberHp(room.code, b.id, 85);
  await setMemberHp(room.code, c.id, 75);
  await seedRounds(room.code, fixture.rounds);
  return { ...room, a, b, c, d, fixture };
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
describe("形状与排序：成员可读、全部回合、按 round 升序、settled 标清", () => {
  test("★ 两个已结算 + 一个正在打的回合：升序返回、settled 正确、settlement 只在已结算回合出现", async () => {
    const { code, a, b, c, fixture } = await seededRoom();
    const res = await history(a, code).expect(200);

    // 顶层就是这四块（不多不少：客户端按这个形状解析）
    expect(Object.keys(res.body).sort()).toEqual(["ok", "room", "rounds", "summary"]);
    expect(res.body.room).toEqual({ code, state: "playing", winners: null, finishedAt: null });

    // 库里是 round3 → round1 → round2，端点按 round 升序
    expect(res.body.rounds.map((round) => round.round)).toEqual([1, 2, 3]);
    expect(res.body.rounds.map((round) => round.settled)).toEqual([true, true, false]);

    for (const round of res.body.rounds) {
      expect(Object.keys(round).sort()).toEqual(round.settled ? ["entries", "round", "settled", "settlement"] : ["entries", "round", "settled"]);
      expect(round.entries).toHaveLength(3);
    }
    // 未结算的回合没有 settlement 这一格（不是 null）
    expect("settlement" in res.body.rounds[2]).toBe(false);

    // 投稿形状：App 回放要的字段一个不少（含 current 快照里没有的 modelTier）
    const firstEntry = res.body.rounds[0].entries[0];
    expect(Object.keys(firstEntry).sort()).toEqual(
      ["cardNames", "entryId", "likes", "modelTier", "name", "placeholder", "posterUrl", "prompt", "userId", "videoUrl", "votes"].sort(),
    );
    expect(firstEntry).toMatchObject({
      entryId: String(fixture.entries.e1.a),
      userId: a.id,
      name: a.username,
      prompt: "r1-a",
      cardNames: ["角色卡", "场景卡"],
      videoUrl: "https://example.test/r1-a.mp4",
      posterUrl: "https://example.test/r1-a.jpg",
      placeholder: false,
      modelTier: "draft",
      likes: 2,
      votes: 2,
    });
    // 计数按 targetUserId 算（不是「这个人点过几个」）
    const round1 = res.body.rounds[0];
    const entryOf = (round, userId) => round.entries.find((entry) => entry.userId === userId);
    expect([entryOf(round1, a.id).likes, entryOf(round1, b.id).likes, entryOf(round1, c.id).likes]).toEqual([2, 0, 1]);
    expect([entryOf(round1, a.id).votes, entryOf(round1, b.id).votes, entryOf(round1, c.id).votes]).toEqual([2, 1, 0]);
    // 结算榜照旧带 name（只存 id、读的时候现拼）
    expect(round1.settlement.ranking.map((row) => row.userId)).toEqual([a.id, b.id, c.id]);
    expect(round1.settlement.ranking.map((row) => row.name)).toEqual([a.username, b.username, c.username]);
    expect(res.body.rounds[1].settlement.winners).toEqual([b.id, c.id]);
  });

  test("成员读续命：距过期只差一会儿的房间，读一次历史就刷新 lastSeenAt", async () => {
    const { code, a } = await seededRoom();
    const before = new Date(Date.now() - 100 * 60 * 1000); // playing 寿命 120 分钟：还活着，但快了
    await GameRoom.updateOne({ code }, { $set: { lastSeenAt: before } }, { timestamps: false });

    await history(a, code).expect(200);
    const doc = await GameRoom.findOne({ code }).lean();
    expect(doc.lastSeenAt.getTime()).toBeGreaterThan(before.getTime() + 50 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("战绩 summary：两回合累加口径", () => {
  test("★ roundsPlayed / wins / likesTotal / votesTotal / bestRound 全按手算结果", async () => {
    const { code, a, b, c, d } = await seededRoom();
    const res = await history(a, code).expect(200);
    const summary = res.body.summary;

    // 只数已结算的回合（正在打的第 3 回合不算）
    expect(summary.roundsPlayed).toBe(2);

    // 顺序与房间快照 members[] 一致（座位 = 加入顺序）
    expect(summary.perPlayer.map((row) => row.userId)).toEqual([a.id, b.id, c.id, d.id]);
    const byId = new Map(summary.perPlayer.map((row) => [row.userId, row]));

    // A：round1 综合第一（1 胜）；点赞 2+0+1、投票 2+0
    expect(byId.get(a.id)).toMatchObject({
      name: a.username,
      hp: 80,
      wins: 1,
      likesTotal: 3,
      votesTotal: 2,
      bestRound: 1,
    });
    // B：round2 综合第一；点赞 0+2、投票 1+2
    expect(byId.get(b.id)).toMatchObject({ name: b.username, hp: 85, wins: 1, likesTotal: 2, votesTotal: 3, bestRound: 2 });
    // C：一次第一都没有；两回合里名次最好的是 round2（第 2 名）；点赞 1+1、投票 0+1
    expect(byId.get(c.id)).toMatchObject({ name: c.username, hp: 75, wins: 0, likesTotal: 2, votesTotal: 1, bestRound: 2 });
    // D：全程没投稿、也没进过结算榜 → 0 分，且**没有 bestRound 这一格**（不是 null）
    expect(byId.get(d.id)).toMatchObject({ name: d.username, hp: 100, wins: 0, likesTotal: 0, votesTotal: 0 });
    expect("bestRound" in byId.get(d.id)).toBe(false);
    // 弃权行（D 的 targetUserId: null）没有算给任何人：三人的投票总数加起来 = 进榜的票数 6
    expect([a, b, c].reduce((sum, u) => sum + byId.get(u.id).votesTotal, 0)).toBe(6);
  });

  test("结束的一局：room.state over + winners（空数组 = 平局）+ finishedAt；战绩照旧可读", async () => {
    const { code, a, b } = await seededRoom();
    const finishedAt = new Date();
    await GameRoom.updateOne(
      { code },
      { $set: { status: "over", winners: [b.id, a.id], finishedAt } },
      { timestamps: false },
    );
    const res = await history(a, code).expect(200);
    expect(res.body.room).toMatchObject({ state: "over", winners: [b.id, a.id] });
    expect(res.body.room.finishedAt).toBe(finishedAt.toISOString());
    expect(res.body.summary.roundsPlayed).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("权限与过期：非成员 403、未登录 401、房间没了 404", () => {
  test("★ 非成员 403 NOT_IN_ROOM（读接口用 403，不是回合写接口那个 409）；未登录 401", async () => {
    const { code } = await seededRoom();
    const outsider = await registerUser("outsider");
    const res = await history(outsider, code);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, code: "NOT_IN_ROOM", roomCode: code });
    expect((await request(app).get(`/api/game/rooms/${code}/rounds/history`)).status).toBe(401);
  });

  test("★ 房间不存在 / 已过期被懒清理 → 404 ROOM_NOT_FOUND；过期是硬删，回合数据一起没", async () => {
    const { code, a } = await seededRoom();
    expect((await history(a, "ZZZZZZ")).body).toMatchObject({ code: "ROOM_NOT_FOUND" });

    // playing 寿命 120 分钟：推到 3 小时前 = 过期
    await GameRoom.updateOne({ code }, { $set: { lastSeenAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } }, { timestamps: false });
    const gone = await history(a, code);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect(await GameRoom.countDocuments({ code })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("能力位与急停开关", () => {
  test("/api/ark/health 亮出 gameHistory；GAME_HISTORY=off → false 且只有历史端点 503 GAME_HISTORY_OFF", async () => {
    const on = await request(app).get("/api/ark/health").expect(200);
    expect(on.body).toMatchObject({ gameHistory: true, gameRounds: true, gameRooms: true });

    process.env.GAME_HISTORY = "off";
    const off = await request(app).get("/api/ark/health").expect(200);
    // 只有这一位变：回合引擎本身还开着（与 GAME_ROUNDS 分开报）
    expect(off.body).toMatchObject({ gameHistory: false, gameRounds: true, gameRooms: true });

    const room = await playingRoom(2);
    await roundsStart(room.host, room.code).expect(200);
    const res = await history(room.host, room.code);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, code: "GAME_HISTORY_OFF" });
    // 其余回合端点照常
    expect((await current(room.host, room.code)).status).toBe(200);
  });

  test("★ GAME_ROUNDS=off 时先回 GAME_ROUNDS_OFF（历史闸在回合闸之后），gameHistory 也报 false", async () => {
    const room = await playingRoom(2);
    await roundsStart(room.host, room.code).expect(200);
    process.env.GAME_ROUNDS = "off";
    const health = await request(app).get("/api/ark/health").expect(200);
    expect(health.body).toMatchObject({ gameHistory: false, gameRounds: false });
    const res = await history(room.host, room.code);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "GAME_ROUNDS_OFF" });
  });

  test("GAME_ROOMS=off（大厅关掉）：history 先回 GAME_ROOMS_OFF，gameHistory 报 false", async () => {
    const { code, a } = await seededRoom();
    process.env.GAME_ROOMS = "off";
    const health = await request(app).get("/api/ark/health").expect(200);
    expect(health.body).toMatchObject({ gameHistory: false, gameRooms: false });
    const res = await history(a, code);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "GAME_ROOMS_OFF" });
  });
});
