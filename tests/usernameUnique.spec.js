// tests/usernameUnique.spec.js
// 覆盖：用户名的**大小写不敏感唯一性**（2026-08-13 加）。
//
// ★ 为什么值得单独钉一份：username 是本 app 公开的 @ 句柄（补全面板里画的、
//   插进正文的、服务端 span 核对的都是它）。在这次改动之前，两道关**同时**漏：
//     ① 注册查重 `findOne({$or:[{username},{email}]})` 没带 collation；
//     ② 唯一索引 `username_1` 是区分大小写的（生产库 2026-08-13 实查确认）。
//   于是 "tianbinliu" 已存在时还能注册出 "TianbinLiu" —— 两个账号在 @ 面板里并排列出，
//   肉眼几乎分不出，这是最省事的冒名手法。而且**一个错都不报**：注册 201，
//   受害者永远不知道有这么个账号。
//
// ★ 这份测试盯的是"做错了不报错"的那一类，所以断言的是**状态码与库里的行数**，
//   不是某句提示文案。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  // 索引是异步建的；不等它建完，唯一性那两条会随机变红（而且是"偶发"这种最难查的形态）
  await mongoose.model("User").syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const reg = (username, email) =>
  request(app).post("/api/auth/register").send({ username, email, password: "Passw0rd!123" });

describe("用户名大小写不敏感唯一", () => {
  test("U1 原样重复 → 409（这条本来就过，作为对照组）", async () => {
    await reg("alice", "alice@example.com").expect(201);
    await reg("alice", "alice2@example.com").expect(409);
  });

  test("U2 **只有大小写不同**也要 409 —— 这是这次修的那条", async () => {
    await reg("bobby", "bobby@example.com").expect(201);
    const res = await reg("BoBBy", "bobby2@example.com");
    expect(res.status).toBe(409);
    // 断库：真正要防的是"多出来一行"，而不是"返回了某个状态码"
    const n = await mongoose.model("User").countDocuments({ username: /^bobby$/i });
    expect(n).toBe(1);
  });

  test("U3 邮箱大小写不同也不给注册出两个账号", async () => {
    await reg("carol", "Carol@example.com").expect(201);
    await reg("carol2", "carol@example.com").expect(409);
  });

  test("U4 唯一性由**索引**兜底，不只靠应用层查重", async () => {
    // 绕过 controller 直接写库：并发注册撞车时走的就是这条路
    const User = mongoose.model("User");
    await User.create({ username: "dave", email: "dave@example.com", passwordHash: "x" });
    await expect(
      User.create({ username: "DAVE", email: "dave2@example.com", passwordHash: "x" }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  test("U5 不相干的名字照常注册得了（别把闸门关成谁都进不来）", async () => {
    await reg("erin", "erin@example.com").expect(201);
    await reg("erin_2", "erin2@example.com").expect(201);
  });
});
