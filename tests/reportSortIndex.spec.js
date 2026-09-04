// tests/reportSortIndex.spec.js
// 钉住「待处理队列的排序真的走索引，没有阻塞 SORT 阶段」。
//
// ★★ 为什么值得单开一条：索引键序与 sort 键序差一列就退化成**内存排序**，
//   而它**零报错** —— 接口照常 200、顺序也照常对，只是慢；堆到 MongoDB 的
//   阻塞排序内存上限时才会整条查询抛错，那时屏幕上只写着"举报列表没拉到"。
//   2026-09-03 复核就是这么抓到第一版的：索引写成 {status, priority, createdAt}，
//   而 sort 是 {priority, createdAt, _id}，explain 里 SORT 阶段还在。
// ★ 判据取 explain 的**执行计划里有没有 SORT 阶段**，不是"结果顺序对不对"——
//   顺序永远是对的，那正是这个问题查不出来的原因。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let Report;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  Report = require("../src/models/Report");
  await Report.init(); // 索引是异步建的，不等它建完 explain 只会说"没有索引可用"
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

/** 把 explain 的 winningPlan 拍平成阶段名数组 */
function stagesOf(plan) {
  const out = [];
  let node = plan;
  while (node) {
    if (node.stage) out.push(node.stage);
    node = node.inputStage || (node.inputStages && node.inputStages[0]);
  }
  return out;
}

describe("举报队列的排序走不走索引", () => {
  test("S-IDX1 待处理队列（status + priority + createdAt + _id）没有阻塞 SORT 阶段", async () => {
    const exp = await Report.find({ status: "pending" })
      .sort({ priority: -1, createdAt: -1, _id: -1 })
      .limit(20)
      .explain("queryPlanner");

    const stages = stagesOf(exp.queryPlanner.winningPlan);
    expect(stages).toContain("IXSCAN");
    expect(stages).not.toContain("SORT");
  });

  test("S-IDX2 「全部」页（不筛状态，按时间）也走索引", async () => {
    const exp = await Report.find({}).sort({ createdAt: -1, _id: -1 }).limit(20).explain("queryPlanner");

    const stages = stagesOf(exp.queryPlanner.winningPlan);
    expect(stages).toContain("IXSCAN");
    expect(stages).not.toContain("SORT");
  });
});
