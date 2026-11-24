// tests/gameReport.spec.js
// 工坊对局里的两类用户内容**可被举报**（2026-11-24）：玩家本人（`user`）与回合投稿（`game-entry`）。
//
// 覆盖：两类举报成功 + 受理时抄下的冗余上下文 / 靶子不存在 404 TARGET_NOT_FOUND /
// 同一举报人重复举报 409（含"靶子后来没了"仍 409 的次序）/ entryId 从快照拿得到 /
// 管理端列表能显示两类的新 target 形状（房间被清理后 target.exists=false 但上下文还在）/
// 这两类的"下架"如实 400 且举报原地 pending（本轮后台不深做）/ 能力位 gameReports。
//
// ★ 这套用例盯的是**做错了不报错**的几处：
//   · entryId 被覆盖提交换掉 —— App 那格举报键指向的是一条再也找不到的投稿，而两边都不报错；
//   · 受理时把 targetContext 写成请求体里来的东西 —— 伪造一段脏话栽赃，管理员看到的就是它；
//   · 靶子不存在却 201 —— 队列里多一条什么也答不出的死条目，还占掉那个人的唯一索引名额；
//   · 管理端列表碰到不认识的 targetType 抛错 —— 整个队列打不开（新增类型最容易踩的就是这个）；
//   · 对这两类假装"下架成功" —— 管理员以为处理完了，实际什么都没发生（report.spec.js 的 R4 同一条）。
//
// ★ 不联网、不花钱：MongoMemoryServer + supertest。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let User;
let Report;
let GameRoom;
const ENV_KEYS = ["GAME_ROUNDS", "GAME_ROOMS"];
let savedEnv;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = require("../src/models/User");
  Report = require("../src/models/Report");
  GameRoom = require("../src/models/GameRoom");
  // 唯一索引是异步建的：不等它建完，"重复举报"那条会偶发地变成两次都成功
  await Report.init();
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

let seq = 0;
async function registerUser(tag) {
  seq += 1;
  const name = `gr_${tag}_${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { id: String(res.body.user._id), username: name, auth: { Authorization: `Bearer ${res.body.token}` } };
}

async function promoteToAdmin(userId) {
  await User.updateOne({ _id: userId }, { $set: { role: "admin" } });
}

function report(user, body) {
  return request(app).post("/api/branch/reports").set(user.auth).send(body);
}

// ── 房间 / 回合（判定在 services/gameRoom|gameRound，这里只搭台）──────────────
const createRoom = (u, body) => request(app).post("/api/game/rooms").set(u.auth).send(body);
const joinRoom = (u, code) => request(app).post("/api/game/rooms/join").set(u.auth).send({ code });
const readyRoom = (u, code) => request(app).post(`/api/game/rooms/${code}/ready`).set(u.auth).send({ ready: true });
const startRoom = (u, code) => request(app).post(`/api/game/rooms/${code}/start`).set(u.auth).send({});
const roundsStart = (u, code) => request(app).post(`/api/game/rooms/${code}/rounds/start`).set(u.auth).send({});
const submitEntry = (u, code, body) => request(app).post(`/api/game/rooms/${code}/rounds/entries`).set(u.auth).send(body);
const currentRound = (u, code) => request(app).get(`/api/game/rooms/${code}/rounds/current`).set(u.auth);

/** 造一间两人局，开第 1 回合并让 host 交一条片。返回 { code, users, host, entry } */
async function roomWithEntry({ prompt = "第一回合的交片", videoUrl = "https://example.test/r1.mp4" } = {}) {
  const users = [await registerUser("host"), await registerUser("guest")];
  const created = await createRoom(users[0], { mode: "custom", seats: 2 }).expect(201);
  const code = created.body.room.code;
  await joinRoom(users[1], code).expect(200);
  await readyRoom(users[1], code).expect(200);
  await startRoom(users[0], code).expect(200);
  await roundsStart(users[0], code).expect(200);
  const submitted = await submitEntry(users[0], code, {
    prompt,
    cardNames: ["角色卡", "场景卡"],
    videoUrl,
    posterUrl: "https://example.test/r1.jpg",
    modelTier: "draft",
  }).expect(200);
  const entry = submitted.body.entries.find((row) => row.userId === users[0].id);
  return { code, users, host: users[0], entry };
}

// ─────────────────────────────────────────────────────────────────────
describe("受理：user / game-entry 两类", () => {
  test("user：举报玩家本人 → 201，落 targetContext.offenderUserId", async () => {
    const reporter = await registerUser("reporter");
    const offender = await registerUser("offender");

    const res = await report(reporter, {
      targetType: "user",
      targetId: offender.id,
      reason: "abuse",
      detail: "局内一直骂人",
    }).expect(201);

    expect(res.body.ok).toBe(true);
    expect(res.body.report).toMatchObject({
      targetType: "user",
      targetId: offender.id,
      reason: "abuse",
      status: "pending",
      // 两类都回全部六个键（不适用的给空串 / null），管理端不用先判"这类有没有这一格"
      targetContext: {
        offenderUserId: offender.id,
        roomCode: "",
        round: null,
        entryId: null,
        prompt: "",
        videoUrl: "",
      },
    });

    // 落库才算数：回包对、库里没写是另一种"200 但没做事"
    const inDb = await Report.findById(res.body.report._id).lean();
    expect(String(inDb.targetContext.offenderUserId)).toBe(offender.id);
  });

  test("game-entry：按快照里的 entryId 举报回合投稿 → 201，冗余上下文是服务端自己抄的", async () => {
    const { code, users, entry } = await roomWithEntry({ prompt: "一条会被举报的投稿" });

    // App 那格举报键拿的就是快照里的 entryId（24-hex）
    expect(entry.entryId).toMatch(/^[a-f0-9]{24}$/);

    const res = await report(users[1], {
      targetType: "game-entry",
      targetId: entry.entryId,
      reason: "violence",
    }).expect(201);

    expect(res.body.report).toMatchObject({
      targetType: "game-entry",
      targetId: entry.entryId,
      targetContext: {
        offenderUserId: users[0].id,
        roomCode: code,
        round: 1,
        entryId: entry.entryId,
        prompt: "一条会被举报的投稿",
        videoUrl: "https://example.test/r1.mp4",
      },
    });

    // ★ 请求体里塞 targetContext / roomCode 不算数（z.object strip + controller 不读）：
    //   能塞的话，伪造一段脏话栽赃谁都做得到（models/Report.js 的 ★）
    const forged = await report(users[0], {
      targetType: "game-entry",
      targetId: entry.entryId,
      reason: "spam",
      targetContext: { offenderUserId: users[1].id, roomCode: "FAKE01", prompt: "伪造" },
    }).expect(201);
    expect(forged.body.report.targetContext).toMatchObject({
      offenderUserId: users[0].id,
      roomCode: code,
      prompt: "一条会被举报的投稿",
    });
  });

  test("game-entry：冗余 prompt 按码点截断到 200（正常投稿 ≤80 字不会被切）", async () => {
    const { entry, code } = await roomWithEntry({ prompt: "正常长度" });
    // 直接改库把提示词拉长（接口那道 80 字上限不放开，这里要验的是冗余那一份自己的截断）
    const longPrompt = "长".repeat(300);
    await GameRoom.updateOne(
      { code },
      { $set: { "rounds.$[r].entries.$[e].prompt": longPrompt } },
      { arrayFilters: [{ "r.round": 1 }, { "e.entryId": entry.entryId }] },
    );
    expect(entry.entryId).toBeTruthy();

    const reporter = await registerUser("trunc");
    const res = await report(reporter, {
      targetType: "game-entry",
      targetId: entry.entryId,
      reason: "other",
    }).expect(201);
    expect(Array.from(res.body.report.targetContext.prompt)).toHaveLength(200);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("靶子必须存在（404 TARGET_NOT_FOUND）", () => {
  test("user / game-entry 都查不到 → 404，且一条举报都不落库", async () => {
    const reporter = await registerUser("ghost");
    const ghost = new mongoose.Types.ObjectId().toString();

    for (const targetType of ["user", "game-entry"]) {
      const res = await report(reporter, { targetType, targetId: ghost, reason: "other" }).expect(404);
      expect(res.body).toMatchObject({ ok: false, code: "TARGET_NOT_FOUND", details: { targetType } });
    }
    expect(await Report.countDocuments({ reporter: reporter.id })).toBe(0);
  });

  test("房间过期被懒清理之后，那条投稿也就不存在了 → 404（房间整份删 = 回合数据一起没）", async () => {
    const { users, entry, code } = await roomWithEntry();
    await GameRoom.deleteOne({ code });

    const res = await report(users[1], { targetType: "game-entry", targetId: entry.entryId, reason: "porn" }).expect(404);
    expect(res.body.code).toBe("TARGET_NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("重复举报：同一个人 × 同一个靶子只算一次", () => {
  test("第二次 409 并带首次的 reportId；换个人可以再报", async () => {
    const reporterA = await registerUser("dupA");
    const reporterB = await registerUser("dupB");
    const offender = await registerUser("dupTarget");

    const first = await report(reporterA, { targetType: "user", targetId: offender.id, reason: "abuse" }).expect(201);
    const dup = await report(reporterA, {
      targetType: "user",
      targetId: offender.id,
      reason: "porn", // 换个理由也不行：去重维度是"谁 + 哪个靶子"
    }).expect(409);
    expect(dup.body.ok).toBe(false);
    expect(String(dup.body.details.reportId)).toBe(String(first.body.report._id));

    await report(reporterB, { targetType: "user", targetId: offender.id, reason: "porn" }).expect(201);
    expect(await Report.countDocuments({ targetType: "user", targetId: offender.id })).toBe(2);
  });

  test("靶子后来没了，重复举报仍然 409（去重预检在存在性校验之前）", async () => {
    const { users, entry, code } = await roomWithEntry();
    const first = await report(users[1], { targetType: "game-entry", targetId: entry.entryId, reason: "spam" }).expect(201);
    await GameRoom.deleteOne({ code });

    // ★ 顺序反了（先 404）的话，客户端会把"你已举报过"显示成"没报上"，用户于是反复点
    const again = await report(users[1], { targetType: "game-entry", targetId: entry.entryId, reason: "spam" }).expect(409);
    expect(String(again.body.details.reportId)).toBe(String(first.body.report._id));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("管理端队列：两类新 target 能显示、不炸", () => {
  test("user / game-entry 都能列出来；房间被清理后 target.exists=false 但 targetContext 还在", async () => {
    const admin = await registerUser("admin");
    await promoteToAdmin(admin.id);
    const { code, users, entry } = await roomWithEntry({ prompt: "管理员要看的投稿" });
    const reporter = await registerUser("listReporter");

    await report(reporter, { targetType: "user", targetId: users[0].id, reason: "abuse" }).expect(201);
    await report(reporter, { targetType: "game-entry", targetId: entry.entryId, reason: "violence" }).expect(201);

    const usersPage = await request(app)
      .get("/api/admin/branch/reports?targetType=user&limit=50")
      .set(admin.auth)
      .expect(200);
    expect(usersPage.body.targetType).toBe("user");
    const userRow = usersPage.body.items.find((row) => String(row.targetId) === users[0].id);
    expect(userRow.target).toMatchObject({ exists: true, userId: users[0].id, username: users[0].username });
    expect(userRow.targetContext.offenderUserId).toBe(users[0].id);

    const entriesPage = await request(app)
      .get("/api/admin/branch/reports?targetType=game-entry&limit=50")
      .set(admin.auth)
      .expect(200);
    const entryRow = entriesPage.body.items.find((row) => String(row.targetId) === entry.entryId);
    expect(entryRow.target).toMatchObject({
      exists: true,
      entryId: entry.entryId,
      roomCode: code,
      round: 1,
      userId: users[0].id,
      username: users[0].username,
      prompt: "管理员要看的投稿",
    });
    expect(entryRow.targetContext).toMatchObject({ roomCode: code, entryId: entry.entryId });

    // ★ 房间过期懒清理 = 整份文档删掉（GameRoom 文件头）：target 查不到，但受理时抄下的
    //   roomCode / prompt / videoUrl 仍然答得出"报的是哪条投稿"—— 这正是冗余上下文存在的理由
    await GameRoom.deleteOne({ code });
    const after = await request(app)
      .get("/api/admin/branch/reports?targetType=game-entry&limit=50")
      .set(admin.auth)
      .expect(200);
    const gone = after.body.items.find((row) => String(row.targetId) === entry.entryId);
    expect(gone.target).toEqual({ exists: false });
    expect(gone.targetContext).toMatchObject({ roomCode: code, prompt: "管理员要看的投稿" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("后台处置：本轮不深做，但绝不许假装办成了", () => {
  test("对 user 举报点下架 / 删除 → 400 一句人话，举报原地 pending；dismiss 可以收尾", async () => {
    const admin = await registerUser("admin2");
    await promoteToAdmin(admin.id);
    const reporter = await registerUser("pendingReporter");
    const offender = await registerUser("pendingTarget");
    const created = await report(reporter, { targetType: "user", targetId: offender.id, reason: "abuse" }).expect(201);
    const reportId = String(created.body.report._id);

    const denied = await request(app)
      .patch(`/api/admin/branch/reports/${reportId}`)
      .set(admin.auth)
      .send({ action: "takedown" })
      .expect(400);
    expect(denied.body.message).toMatch(/封人|dismiss/);

    const stillPending = await Report.findById(reportId).lean();
    expect(stillPending.status).toBe("pending");
    expect(stillPending.handler).toBeNull();

    const dismissed = await request(app)
      .patch(`/api/admin/branch/reports/${reportId}`)
      .set(admin.auth)
      .send({ action: "dismiss", note: "已改为走封禁流程" })
      .expect(200);
    expect(dismissed.body.report.status).toBe("dismissed");
    expect(dismissed.body.applied).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("能力位与枚举", () => {
  test("Report.TARGET_TYPES 含 user / game-entry；/api/ark/health 带 gameReports: true", async () => {
    expect(Report.TARGET_TYPES).toEqual(expect.arrayContaining(["user", "game-entry"]));

    const health = await request(app).get("/api/ark/health").expect(200);
    expect(health.body.gameReports).toBe(true);
  });
});
