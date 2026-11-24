// tests/gameRound.spec.js
// 「工坊对局」的**回合引擎**（2026-11-23，G5 联机第二块：交片 → 展映 → 点赞 → 投票 → 结算 → 下一回合）。
// 设计正本在 app 仓 docs/workshop-game-design.md §2.0 / §2.5、docs/game-rules-engine.md §5-8、
// src/studio/game/rules.ts（damageForRank / tallyRound / settleRound）。
//
// 覆盖：开回合（仅房主 / 必须 playing / 只能开一次）/ 交片（一人一条、重复覆盖、阶段闸、字段校验）/
// 阶段推进（全员交片才能 screening、房主才能推进、voting 可提前进）/ 点赞（只在 screening、
// 不能给自己、幂等、并发不重复计数）/ 投票（只在 voting、不能给自己、弃权、幂等）/ 结算
// （房主可提前、全员投完任何成员自动生效、两个榜与综合名次、扣血 20/15/10/5 的缩放、淘汰、winners）/
// 下一回合（清当前状态、历史不丢、只剩胜者名额 → GAME_OVER）/ 能力位 / GAME_ROUNDS=off。
//
// ★ 这些判据错了都**零症状**（房间还在、按钮还在、结算也出了个数），所以每条都要有反例：
//   · 全员没交片就进 screening → 有人这一期没片子，两个榜各少一行，扣血按错的人数缩放；
//   · 点赞 / 投票不写进原子条件 → 双击一次多一票，名次悄悄变；
//   · 扣血不按人数缩放 → 3 人局最后一名仍扣 20，跟 App 的 15 对不上（两仓各算一遍就漂）；
//   · next 不清当前回合 → 上一期的点赞 / 票被当成这一期的；
//   · 2 人局照字面「剩 ≤2 人」判 → 第 1 回合结算完直接两个胜者，这一局等于没打。
//
// ★ 不联网、不花钱：只用 MongoMemoryServer + supertest。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let GameRoom;
let roundConfig;

const ENV_KEYS = ["GAME_ROUNDS", "GAME_ROOMS"];
let savedEnv;

/** 建一个账号（走真的注册路由：回合快照里的 name 是读 User 表拼出来的，得先有这个人） */
let seq = 0;
async function registerUser(tag) {
  seq += 1;
  const name = `rr_${tag}_${seq}_${Date.now().toString(36)}`;
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
const current = (u, code) => request(app).get(`/api/game/rooms/${code}/rounds/current`).set(u.auth);
const phase = (u, code, value) => request(app).post(`/api/game/rooms/${code}/rounds/phase`).set(u.auth).send({ phase: value });
const like = (u, code, targetUserId) =>
  request(app).post(`/api/game/rooms/${code}/rounds/like`).set(u.auth).send({ targetUserId });
const vote = (u, code, targetUserId) =>
  request(app).post(`/api/game/rooms/${code}/rounds/vote`).set(u.auth).send({ targetUserId });
const settle = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/settle`).set(u.auth).send({});
const next = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/next`).set(u.auth).send({});

/** 造一间 n 人的 custom 房并开局（第一个人是房主，其余人 join + ready）。返回 { code, users, host } */
async function playingRoom(n, seats = n) {
  const users = [];
  for (let i = 0; i < n; i += 1) users.push(await registerUser(`p${n}-${i}`));
  const created = await create(users[0], { mode: "custom", seats }).expect(201);
  const code = created.body.room.code;
  for (let i = 1; i < n; i += 1) {
    await join(users[i], code).expect(200);
    await ready(users[i], code, true).expect(200);
  }
  await startRoom(users[0], code).expect(200);
  return { code, users, host: users[0] };
}

/** 开局 + 开第 1 回合 + 全员交片，停在 creating。返回 { code, users, host } */
async function submittedRound(n = 4) {
  const room = await playingRoom(n);
  await roundsStart(room.host, room.code).expect(200);
  for (let i = 0; i < n; i += 1) {
    await submit(room.users[i], room.code, {
      prompt: `第 ${i + 1} 个人的片子`,
      cardNames: ["角色卡", "场景卡"],
      videoUrl: `https://example.test/r1-${i}.mp4`,
      posterUrl: `https://example.test/r1-${i}.jpg`,
      placeholder: false,
      modelTier: "draft",
    }).expect(200);
  }
  return room;
}

/** 把房间里的某个人血量改成指定值（模拟已经打了几回合） */
async function setHp(code, userId, hp) {
  await GameRoom.updateOne({ code, "members.userId": userId }, { $set: { "members.$.hp": hp } });
}

/** 从 /rounds/current 里拿出某个人的作品（entries 是按座位排的） */
function entryOf(snapshotBody, userId) {
  return snapshotBody.entries.find((entry) => entry.userId === String(userId));
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  GameRoom = require("../src/models/GameRoom");
  roundConfig = require("../src/config/gameRound");
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
describe("扣血公式：与 App rules.damageForRank 逐字一致（不需要数据库）", () => {
  test("4 人局从最后一名往前 20/15/10/5；8 人局 40/30/20/10；3 人局 15/10/5；2 人局 10/5", () => {
    expect([0, 1, 2, 3].map((rankFromLast) => roundConfig.damageForRank(4, rankFromLast))).toEqual([20, 15, 10, 5]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((rankFromLast) => roundConfig.damageForRank(8, rankFromLast))).toEqual([
      40, 30, 20, 10, 10, 10, 10, 10,
    ]);
    expect([0, 1, 2].map((rankFromLast) => roundConfig.damageForRank(3, rankFromLast))).toEqual([15, 10, 5]);
    expect([0, 1].map((rankFromLast) => roundConfig.damageForRank(2, rankFromLast))).toEqual([10, 5]);
    // 地板 5：1 人局最后一名不会因为 floor(20/4/5)=1 而变成 0
    expect(roundConfig.damageForRank(1, 0)).toBe(5);
  });

  test("胜者名额：4/8 人局 2 名、2 人局 1 名（否则 2 人局开局就结束）", () => {
    expect(roundConfig.winnerTargetOf(2)).toBe(1);
    expect(roundConfig.winnerTargetOf(3)).toBe(2);
    expect(roundConfig.winnerTargetOf(4)).toBe(2);
    expect(roundConfig.winnerTargetOf(8)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("开回合：仅房主、房间必须 playing、只能开第 1 回合", () => {
  test("开局后房主开第 1 回合 → round 1 / phase creating / 空作品；再开 → ROUND_ALREADY_STARTED", async () => {
    const { code, users, host } = await playingRoom(4);
    const res = await roundsStart(host, code).expect(200);
    expect(res.body).toMatchObject({ round: 1, phase: "creating", entries: [], allSubmitted: false, likesPending: 4, votesPending: 4 });
    const again = await roundsStart(host, code);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "ROUND_ALREADY_STARTED", round: 1 });
    expect((await roundsStart(users[1], code)).body).toMatchObject({ code: "NOT_HOST" });
  });

  test("房间还在 waiting → 409 ROOM_NOT_PLAYING；外面的人 → 403 NOT_HOST", async () => {
    const users = [];
    for (let i = 0; i < 2; i += 1) users.push(await registerUser(`wait-${i}`));
    const code = (await create(users[0], { mode: "custom", seats: 4 }).expect(201)).body.room.code;
    await join(users[1], code).expect(200);
    await ready(users[1], code, true).expect(200);
    const res = await roundsStart(users[0], code);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ROOM_NOT_PLAYING" });
    await startRoom(users[0], code).expect(200);
    const outsider = await registerUser("rounds-outsider");
    expect((await roundsStart(outsider, code)).body).toMatchObject({ code: "NOT_HOST" });
  });

  test("还没开回合就读 current → 404 ROUND_NOT_FOUND；开回合前交片也是 404", async () => {
    const { code, users } = await playingRoom(2);
    expect((await current(users[0], code)).status).toBe(404);
    expect((await current(users[0], code)).body).toMatchObject({ code: "ROUND_NOT_FOUND" });
    expect((await submit(users[0], code, { prompt: "hi", cardNames: [] })).body).toMatchObject({ code: "ROUND_NOT_FOUND" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("交片：一人一条、重复提交覆盖、字段校验", () => {
  test("★ 重复提交是**覆盖**（不是第二条）：作品数仍 1、prompt 更新、allSubmitted 同步", async () => {
    const { code, users, host } = await playingRoom(4);
    await roundsStart(host, code).expect(200);
    const first = await submit(users[0], code, { prompt: "第一次", cardNames: ["A"] }).expect(200);
    expect(first.body).toMatchObject({ round: 1, phase: "creating", allSubmitted: false, likesPending: 4 });
    expect(first.body.entries).toHaveLength(1);
    const second = await submit(users[0], code, {
      prompt: "第二次（覆盖）",
      cardNames: ["B", "C"],
      videoUrl: "https://example.test/v2.mp4",
      placeholder: true,
    }).expect(200);
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.entries[0]).toMatchObject({
      userId: users[0].id,
      name: users[0].username,
      prompt: "第二次（覆盖）",
      cardNames: ["B", "C"],
      videoUrl: "https://example.test/v2.mp4",
      placeholder: true,
      likes: 0,
      likedByMe: false,
      votes: 0,
      votedByMe: false,
    });
    // 全员交片之前还是 creating，allSubmitted 为假
    expect(second.body.allSubmitted).toBe(false);
    expect((await current(users[0], code)).body.entries).toHaveLength(1);
    // 库里的 round.entries 也只有一条（不是只在外层去重）
    const doc = await GameRoom.findOne({ code }).lean();
    expect(doc.rounds[0].entries).toHaveLength(1);
    expect(doc.rounds[0].entries[0].prompt).toBe("第二次（覆盖）");
  });

  test("非成员不能交片；淘汰的人不能交片", async () => {
    const { code, users, host } = await playingRoom(4);
    await roundsStart(host, code).expect(200);
    const outsider = await registerUser("entry-outsider");
    expect((await submit(outsider, code, { prompt: "x", cardNames: [] })).body).toMatchObject({ code: "NOT_IN_ROOM" });
    await setHp(code, users[3].id, 0);
    expect((await submit(users[3], code, { prompt: "x", cardNames: [] })).body).toMatchObject({ code: "PLAYER_ELIMINATED" });
  });

  test("字段校验：空 / 超长 prompt、cardNames 不是数组、placeholder 不是布尔 → 400，且一条都没写进去", async () => {
    const { code, users, host } = await playingRoom(2);
    await roundsStart(host, code).expect(200);
    expect((await submit(users[0], code, { prompt: "   ", cardNames: [] })).body).toMatchObject({ code: "BAD_PROMPT" });
    expect((await submit(users[0], code, { prompt: "长".repeat(81), cardNames: [] })).body).toMatchObject({
      code: "PROMPT_TOO_LONG",
      limit: 80,
    });
    expect((await submit(users[0], code, { prompt: "ok", cardNames: "不是数组" })).body).toMatchObject({ code: "BAD_CARD_NAMES" });
    expect((await submit(users[0], code, { prompt: "ok", cardNames: [], placeholder: "true" })).body).toMatchObject({
      code: "BAD_ENTRY_FIELD",
      field: "placeholder",
    });
    expect((await current(users[0], code)).body.entries).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("阶段推进：全员交片才能 screening；房主才能推进；voting 从 screening 进", () => {
  test("★ 还有人没交片 → 409 NOT_ALL_SUBMITTED（带 waitingOn）；交齐后房主推进 screening", async () => {
    const { code, users, host } = await playingRoom(4);
    await roundsStart(host, code).expect(200);
    for (let i = 0; i < 3; i += 1) await submit(users[i], code, { prompt: `p${i}`, cardNames: [] }).expect(200);
    const blocked = await phase(host, code, "screening");
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: "NOT_ALL_SUBMITTED", waitingOn: [users[3].id], count: 1, need: 4 });
    expect((await current(users[1], code)).body.phase).toBe("creating");
    await submit(users[3], code, { prompt: "p3", cardNames: [] }).expect(200);
    const screened = await phase(host, code, "screening").expect(200);
    expect(screened.body).toMatchObject({ round: 1, phase: "screening", allSubmitted: true, likesPending: 4 });
    // 同阶段重复调用幂等
    expect((await phase(host, code, "screening").expect(200)).body.phase).toBe("screening");
  });

  test("非房主不能推进；creating 不能直接跳 voting；screening 之后交片 → WRONG_PHASE", async () => {
    const room = await submittedRound(4);
    expect((await phase(room.users[1], room.code, "screening")).body).toMatchObject({ code: "NOT_HOST" });
    expect((await phase(room.host, room.code, "voting")).body).toMatchObject({ code: "WRONG_PHASE" });
    await phase(room.host, room.code, "screening").expect(200);
    expect((await submit(room.users[0], room.code, { prompt: "改稿", cardNames: [] })).body).toMatchObject({
      code: "WRONG_PHASE",
      phase: "screening",
      expected: "creating",
    });
    expect((await phase(room.host, room.code, "bogus")).body).toMatchObject({ code: "BAD_PHASE" });
    const voting = await phase(room.host, room.code, "voting").expect(200);
    expect(voting.body.phase).toBe("voting");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("点赞：只在 screening、不能给自己、一人一条一次、并发不重复计数", () => {
  test("点赞计数 / likedByMe 正确；别人点了谁不暴露（只有计数）", async () => {
    const room = await submittedRound(4);
    await phase(room.host, room.code, "screening").expect(200);
    const res = await like(room.users[0], room.code, room.users[1].id).expect(200);
    const mine = entryOf(res.body, room.users[1].id);
    expect(mine).toMatchObject({ likes: 1, likedByMe: true, votes: 0, votedByMe: false });
    expect(entryOf(res.body, room.users[0].id)).toMatchObject({ likes: 0, likedByMe: false });
    // 契约列出的字段之外不出现「谁点过」的数组
    expect(mine.likedBy).toBeUndefined();
    expect(mine.votedBy).toBeUndefined();
    const seenByOther = await current(room.users[2], room.code).expect(200);
    expect(entryOf(seenByOther.body, room.users[1].id)).toMatchObject({ likes: 1, likedByMe: false });
  });

  test("不能给自己点赞（400 CANNOT_LIKE_SELF）；给外面的人点 → 404 TARGET_NOT_IN_ROOM；creating 阶段 → WRONG_PHASE", async () => {
    const room = await submittedRound(4);
    expect((await like(room.users[0], room.code, room.users[1].id)).body).toMatchObject({ code: "WRONG_PHASE" });
    await phase(room.host, room.code, "screening").expect(200);
    expect((await like(room.users[0], room.code, room.users[0].id)).body).toMatchObject({ code: "CANNOT_LIKE_SELF" });
    const outsider = await registerUser("like-outsider");
    expect((await like(room.users[0], room.code, outsider.id)).body).toMatchObject({ code: "TARGET_NOT_IN_ROOM" });
    expect((await like(room.users[0], room.code, "not-an-id")).body).toMatchObject({ code: "BAD_TARGET" });
  });

  test("★ 重复 / 并发点赞幂等：一个回合同一人只算一票", async () => {
    const room = await submittedRound(4);
    await phase(room.host, room.code, "screening").expect(200);
    const [a, b] = await Promise.all([
      like(room.users[0], room.code, room.users[1].id),
      like(room.users[0], room.code, room.users[1].id),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const snap = await current(room.users[0], room.code).expect(200);
    expect(entryOf(snap.body, room.users[1].id).likes).toBe(1);
    expect(snap.body.likesPending).toBe(3);
    // 再来一次（顺序重试）也是 200、计数不涨
    expect((await like(room.users[0], room.code, room.users[1].id).expect(200)).body.phase).toBe("screening");
    const doc = await GameRoom.findOne({ code: room.code }).lean();
    expect(doc.rounds[0].likes).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("投票：只在 voting、不能给自己、可弃权、一人一次", () => {
  test("投票 / 弃权都算表态；votesPending 减少；不能给自己；重复投票第一票作数", async () => {
    const room = await submittedRound(4);
    await phase(room.host, room.code, "screening").expect(200);
    // screening 里还不能投
    expect((await vote(room.users[0], room.code, room.users[1].id)).body).toMatchObject({ code: "WRONG_PHASE" });
    await phase(room.host, room.code, "voting").expect(200);
    expect((await vote(room.users[0], room.code, room.users[0].id)).body).toMatchObject({ code: "CANNOT_VOTE_SELF" });
    const outsider = await registerUser("vote-outsider");
    expect((await vote(room.users[0], room.code, outsider.id)).body).toMatchObject({ code: "TARGET_NOT_IN_ROOM" });
    expect((await vote(room.users[0], room.code, undefined)).body).toMatchObject({ code: "BAD_TARGET" });

    const voted = await vote(room.users[0], room.code, room.users[1].id).expect(200);
    expect(voted.body.votesPending).toBe(3);
    expect(entryOf(voted.body, room.users[1].id)).toMatchObject({ votes: 1, votedByMe: true });
    // 第一票作数：改成别人 / 改弃权都不生效
    expect((await vote(room.users[0], room.code, room.users[2].id).expect(200)).body.votesPending).toBe(3);
    expect((await vote(room.users[0], room.code, null).expect(200)).body.votesPending).toBe(3);
    expect(entryOf((await current(room.users[0], room.code).expect(200)).body, room.users[1].id).votes).toBe(1);

    // 其余三个人：两个投票 + 一个弃权 —— 全都算表态
    await vote(room.users[1], room.code, room.users[0].id).expect(200);
    await vote(room.users[2], room.code, room.users[3].id).expect(200);
    const abstained = await vote(room.users[3], room.code, null).expect(200);
    expect(abstained.body.votesPending).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("结算：两个榜 + 综合名次 + 扣血 + 淘汰 + winners", () => {
  test("★ 房主可提前结算（未全员投票）；非房主在未投完时 → 403 NOT_HOST", async () => {
    const room = await submittedRound(4);
    await phase(room.host, room.code, "screening").expect(200);
    await phase(room.host, room.code, "voting").expect(200);
    const denied = await settle(room.users[1], room.code);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "NOT_HOST", votesPending: 4 });
    const res = await settle(room.host, room.code).expect(200);
    expect(res.body).toMatchObject({ round: 1, phase: "settled" });
    expect(res.body.settlement.ranking).toHaveLength(4);
    expect(res.body.settlement.winners).toBeUndefined(); // 4 个人都还活着
    // 已结算重复调用 → 同一份结果（幂等，不重复扣血）
    const again = await settle(room.host, room.code).expect(200);
    expect(again.body.settlement.ranking.map((row) => row.hp)).toEqual(res.body.settlement.ranking.map((row) => row.hp));
  });

  test("★ 两个榜 / 综合名次 / 扣血：4 人局从好到差 5 / 10 / 15 / 20，hp 95/90/85/80", async () => {
    const room = await submittedRound(4);
    await phase(room.host, room.code, "screening").expect(200);
    // 点赞：0→1、1→2、2→0、3→0（一人一次，不能自己）
    await like(room.users[0], room.code, room.users[1].id).expect(200);
    await like(room.users[1], room.code, room.users[2].id).expect(200);
    await like(room.users[2], room.code, room.users[0].id).expect(200);
    await like(room.users[3], room.code, room.users[0].id).expect(200);
    await phase(room.host, room.code, "voting").expect(200);
    // 投票：全员表态（0→1, 1→0, 2→3, 3→2）
    await vote(room.users[0], room.code, room.users[1].id).expect(200);
    await vote(room.users[1], room.code, room.users[0].id).expect(200);
    await vote(room.users[2], room.code, room.users[3].id).expect(200);
    await vote(room.users[3], room.code, room.users[2].id).expect(200);

    const res = await settle(room.users[2], room.code).expect(200); // 全员投完 → 任何成员都能触发
    expect(res.body).toMatchObject({ round: 1, phase: "settled" });
    const ranking = res.body.settlement.ranking;
    expect(ranking).toHaveLength(4);
    // 名次从好到差：damage 递增（5/10/15/20），hp 是 100 减掉它
    expect(ranking.map((row) => row.damage)).toEqual([5, 10, 15, 20]);
    expect(ranking.map((row) => row.hp)).toEqual([95, 90, 85, 80]);
    // 综合名次 = 两个榜名次相加；榜单本身按计数用竞赛排名（并列同名次）
    for (const row of ranking) {
      expect(row.composite).toBe(row.likeRank + row.voteRank);
      expect(row.eliminated).toBe(false);
      expect(row.name).toBeTruthy();
    }
    // 综合名次升序（不并列）
    for (let i = 1; i < ranking.length; i += 1) {
      expect(ranking[i - 1].composite).toBeLessThanOrEqual(ranking[i].composite);
    }
    // 库里也落下了最终的 hp
    const doc = await GameRoom.findOne({ code: room.code }).lean();
    const hpById = new Map(doc.members.map((member) => [String(member.userId), member.hp]));
    for (const row of ranking) expect(hpById.get(row.userId)).toBe(row.hp);
  });

  test("★ 淘汰：hp 扣到 0 的标记 eliminated；只剩 2 人时给 winners，next 回 GAME_OVER", async () => {
    const room = await submittedRound(4);
    await phase(room.host, room.code, "screening").expect(200);
    await phase(room.host, room.code, "voting").expect(200);
    // 两个人只剩 5 血：这一回合无论名次都要挨 ≥5，必死；另外两个满血 → 剩 2 人
    await setHp(room.code, room.users[2].id, 5);
    await setHp(room.code, room.users[3].id, 5);
    const res = await settle(room.host, room.code).expect(200);
    const ranking = res.body.settlement.ranking;
    expect(ranking.filter((row) => row.eliminated).map((row) => row.userId).sort()).toEqual(
      [room.users[2].id, room.users[3].id].sort(),
    );
    expect(res.body.settlement.winners.sort()).toEqual([room.users[0].id, room.users[1].id].sort());
    expect((await settle(room.host, room.code).expect(200)).body.settlement.winners.sort()).toEqual(
      [room.users[0].id, room.users[1].id].sort(),
    );
    const over = await next(room.host, room.code);
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: "GAME_OVER" });
    expect(over.body.winners.sort()).toEqual([room.users[0].id, room.users[1].id].sort());
    // 没有偷偷建出第 2 回合
    expect((await GameRoom.findOne({ code: room.code })).rounds).toHaveLength(1);
  });

  test("淘汰一个人但还剩 3 人 → 没有 winners，next 照常开第 2 回合", async () => {
    const room = await submittedRound(4);
    await phase(room.host, room.code, "screening").expect(200);
    await phase(room.host, room.code, "voting").expect(200);
    await setHp(room.code, room.users[3].id, 5);
    const res = await settle(room.host, room.code).expect(200);
    expect(res.body.settlement.winners).toBeUndefined();
    expect(res.body.settlement.ranking.find((row) => row.userId === room.users[3].id).eliminated).toBe(true);
    expect((await next(room.host, room.code).expect(200)).body).toMatchObject({ round: 2, phase: "creating" });
  });

  test("★ 2 人局结算后不是「两人都是胜者」：可以继续下一回合（胜者名额 1）", async () => {
    const room = await submittedRound(2);
    await phase(room.host, room.code, "screening").expect(200);
    await phase(room.host, room.code, "voting").expect(200);
    await vote(room.users[0], room.code, room.users[1].id).expect(200);
    await vote(room.users[1], room.code, room.users[0].id).expect(200);
    const res = await settle(room.users[1], room.code).expect(200); // 全员投完 → 非房主也能结算
    expect(res.body.settlement.ranking).toHaveLength(2);
    expect(res.body.settlement.winners).toBeUndefined();
    expect((await next(room.host, room.code).expect(200)).body).toMatchObject({ round: 2, phase: "creating" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("下一回合：当前状态清空、历史回合不丢、仅房主、必须已结算", () => {
  test("★ next 之后 round+1 / creating / entries.likes.votes 都空；上一回合的榜单与票仍在库里", async () => {
    const room = await submittedRound(4);
    await phase(room.host, room.code, "screening").expect(200);
    await like(room.users[0], room.code, room.users[1].id).expect(200);
    await phase(room.host, room.code, "voting").expect(200);
    await vote(room.users[0], room.code, room.users[1].id).expect(200);
    await vote(room.users[1], room.code, room.users[0].id).expect(200);
    await vote(room.users[2], room.code, room.users[3].id).expect(200);
    await vote(room.users[3], room.code, null).expect(200);
    await settle(room.host, room.code).expect(200);

    // 未结算 / 非房主 的反例先走一遍：这一局里不能再造一个未结算状态，所以换一间房测
    expect((await next(room.users[1], room.code)).body).toMatchObject({ code: "NOT_HOST" });

    const res = await next(room.host, room.code).expect(200);
    expect(res.body).toMatchObject({
      round: 2,
      phase: "creating",
      entries: [],
      allSubmitted: false,
      likesPending: 4,
      votesPending: 4,
    });
    const currentSnap = await current(room.users[2], room.code).expect(200);
    expect(currentSnap.body).toMatchObject({ round: 2, phase: "creating", entries: [], likesPending: 4, votesPending: 4 });

    const doc = await GameRoom.findOne({ code: room.code }).lean();
    expect(doc.rounds).toHaveLength(2);
    expect(doc.rounds[0]).toMatchObject({ round: 1, phase: "settled" });
    expect(doc.rounds[0].entries).toHaveLength(4);
    expect(doc.rounds[0].likes).toHaveLength(1);
    expect(doc.rounds[0].votes).toHaveLength(4);
    expect(doc.rounds[0].settlement.ranking).toHaveLength(4);
    expect(doc.rounds[1]).toMatchObject({ round: 2, phase: "creating", entries: [], likes: [], votes: [] });
  });

  test("没结算就 next → ROUND_NOT_SETTLED；还没开回合就 next → ROUND_NOT_FOUND", async () => {
    const room = await submittedRound(4);
    expect((await next(room.host, room.code)).body).toMatchObject({ code: "ROUND_NOT_SETTLED" });
    const fresh = await playingRoom(2);
    expect((await next(fresh.host, fresh.code)).body).toMatchObject({ code: "ROUND_NOT_FOUND" });
  });

  test("下一回合的点赞 / 投票不会读到上一回合的状态；新回合可以正常交片", async () => {
    const room = await submittedRound(2);
    await phase(room.host, room.code, "screening").expect(200);
    await like(room.users[0], room.code, room.users[1].id).expect(200);
    await phase(room.host, room.code, "voting").expect(200);
    await vote(room.users[0], room.code, room.users[1].id).expect(200);
    await vote(room.users[1], room.code, null).expect(200);
    await settle(room.host, room.code).expect(200);
    await next(room.host, room.code).expect(200);
    const res = await submit(room.users[0], room.code, { prompt: "第二回合", cardNames: [] }).expect(200);
    expect(res.body.round).toBe(2);
    expect(res.body.entries[0].likes).toBe(0);
    expect(res.body.entries[0].likedByMe).toBe(false);
    expect(res.body.entries[0].votes).toBe(0);
    expect(res.body.entries[0].votedByMe).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("房间快照带上 hp / 能力位 / 总开关", () => {
  test("GET /api/game/rooms/:code 的每个成员带 hp（开局 100）", async () => {
    const room = await playingRoom(2);
    const snap = await snapshot(room.host, room.code).expect(200);
    expect(snap.body.room.members.map((member) => member.hp)).toEqual([100, 100]);
  });

  test("★ 房间过期被懒清理 → 回合数据跟着一起没（回合内嵌在房间文档里，没有独立集合要级联）", async () => {
    const room = await playingRoom(2);
    await roundsStart(room.host, room.code).expect(200);
    await submit(room.users[0], room.code, { prompt: "会被清掉的作品", cardNames: [] }).expect(200);
    await GameRoom.updateOne(
      { code: room.code },
      { $set: { lastSeenAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } },
      { timestamps: false },
    );
    const res = await current(room.host, room.code);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "ROOM_NOT_FOUND" });
    // 房间整份文档被删 = rounds[] 一起没；库里也不存在任何按 code 找得到的回合行
    expect(await GameRoom.countDocuments({ code: room.code })).toBe(0);
  });

  test("/api/ark/health 亮出 gameRounds；GAME_ROUNDS=off → false 且回合端点 503 GAME_ROUNDS_OFF（房间照常）", async () => {
    const on = await request(app).get("/api/ark/health").expect(200);
    expect(on.body).toMatchObject({ gameRooms: true, gameRounds: true });

    process.env.GAME_ROUNDS = "off";
    const off = await request(app).get("/api/ark/health").expect(200);
    expect(off.body).toMatchObject({ gameRooms: true, gameRounds: false });

    const room = await playingRoom(2);
    const started = await roundsStart(room.host, room.code);
    expect(started.status).toBe(503);
    expect(started.body).toMatchObject({ code: "GAME_ROUNDS_OFF" });
    expect((await current(room.host, room.code)).status).toBe(503);
    expect((await phase(room.host, room.code, "screening")).status).toBe(503);
    expect((await settle(room.host, room.code)).status).toBe(503);
    expect((await next(room.host, room.code)).status).toBe(503);
    // ★ 关回合引擎不该把房间本身也关掉
    expect((await snapshot(room.host, room.code).expect(200)).body.room.code).toBe(room.code);
    expect((await GameRoom.findOne({ code: room.code })).rounds).toHaveLength(0);
  });
});
