// tests/branchProject.spec.js
// 覆盖：已发布作品的「工坊工程」（画布快照）四条端点 —— /api/branch/projects*
//
// ★ 这套用例盯的是五类【做错了不报错】的问题：
//   P1 不变量：canvas 里残留 dataURL / `idb:` / 方舟临时地址一律 400。
//      放行的表现是"跨设备取回来一片死指针 / 24h 后全是死链"，播放器对死链是静默回退。
//   P2 体积与配额：超了要整句拒（且**不自动淘汰** —— 那是替用户删他自己的东西）。
//   P3 归属：只有作者能读/写/删。读别人的工程 = 读到他还没发出去的创作过程。
//   P4 级联：删作品（purgeVideo）与删号（purgeUserCascade）**两处都要**把工程带走。
//      漏了哪一处都零症状 —— 库里只是多出一批谁也查不到、也再删不掉的画布。
//   P5 列表**绝不回 canvas**：那是"有没有"的问题，回正文等于每次进个人页下载几十 MB。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let BranchProject;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  BranchProject = require("../src/models/BranchProject");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `pj${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

async function publish(token, title = "工程测试作品") {
  const res = await request(app)
    .post("/api/branch/videos")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title,
      category: "剧情",
      segments: [{ title: "第一段", videoUrl: "https://cdn.example.com/s1.mp4", durationSec: 3 }],
    })
    .expect(201);
  return String(res.body.video._id);
}

const CLEAN_CANVAS = {
  v: 1,
  flow: {
    nodes: [
      {
        id: "n1",
        // 这一格是**自由文本**：裸 `"data:` 判据会把它误判成 dataURL，
        // 所以 NO_LOCAL 那条正则必须带 mime 前缀（`data:[a-z]+/`）。这一条钉它。
        requirement: "镜头说明里提到 data: 这个词，不该被判成本机地址",
        firstFrame: "https://res.cloudinary.com/demo/image/upload/ideahub/branch-frames/a.jpg",
      },
    ],
    alts: {},
    cursor: 0,
  },
  deck: [],
};

const put = (token, videoId, body) =>
  request(app).put(`/api/branch/projects/by-video/${videoId}`).set("Authorization", `Bearer ${token}`).send(body);

describe("工坊工程：写入不变量", () => {
  test("正常留存 → 200，bytes 是服务端自己量的（不信客户端报的数）", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);

    const res = await put(author.token, videoId, {
      title: "我的工程",
      videoRevision: 0,
      lostCount: 3,
      canvas: CLEAN_CANVAS,
      bytes: 999999999, // ← 客户端瞎报的，必须被忽略
    }).expect(200);

    expect(res.body.project.videoRevision).toBe(0);
    expect(res.body.project.lostCount).toBe(3);
    const doc = await BranchProject.findOne({ video: videoId }).lean();
    expect(doc.bytes).toBe(Buffer.byteLength(JSON.stringify(CLEAN_CANVAS)));
    expect(String(doc.owner)).toBe(author.userId);
  });

  test("PUT 是覆盖（upsert）：第二次不会多出一条，正文与版次都换成新的", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    await put(author.token, videoId, { videoRevision: 0, canvas: CLEAN_CANVAS }).expect(200);
    await put(author.token, videoId, {
      videoRevision: 1,
      canvas: { ...CLEAN_CANVAS, marker: "第二版" },
    }).expect(200);

    expect(await BranchProject.countDocuments({ video: videoId })).toBe(1);
    const got = await request(app)
      .get(`/api/branch/projects/by-video/${videoId}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(got.body.project.canvas.marker).toBe("第二版");
    expect(got.body.project.videoRevision).toBe(1);
  });

  test("P1 canvas 里有 dataURL → 400", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    await put(author.token, videoId, {
      videoRevision: 0,
      canvas: { v: 1, flow: { nodes: [{ firstFrame: "data:image/png;base64,iVBORw0KGgo=" }] } },
    }).expect(400);
    expect(await BranchProject.countDocuments({ video: videoId })).toBe(0);
  });

  test("P1 canvas 里有 idb: 指针 → 400（换台设备就是死指针）", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    await put(author.token, videoId, {
      videoRevision: 0,
      canvas: { v: 1, flow: { nodes: [{ videoUrl: "idb:merged:abc123" }] } },
    }).expect(400);
  });

  test("P1 canvas 里有方舟临时地址 → 400（约 24h 过期）", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    await put(author.token, videoId, {
      videoRevision: 0,
      canvas: { v: 1, flow: { nodes: [{ videoUrl: "https://ark-content.volces.com/x/y.mp4" }] } },
    }).expect(400);
    await put(author.token, videoId, {
      videoRevision: 0,
      canvas: { v: 1, flow: { nodes: [{ videoUrl: "https://foo.volccdn.com/x/y.mp4" }] } },
    }).expect(400);
  });

  test("P2 单份画布超过 2MB → 400", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    await put(author.token, videoId, {
      videoRevision: 0,
      canvas: { v: 1, blob: "x".repeat(2 * 1024 * 1024 + 10) },
    }).expect(400);
  });

  test("P2 配额（条数）满了整句拒，且**不自动淘汰**已有的那些", async () => {
    const author = await registerUser();
    const owner = new mongoose.Types.ObjectId(author.userId);
    // 直接造 100 条已有工程（走端点要发 100 条作品，太慢且与这条要测的东西无关）
    await BranchProject.insertMany(
      Array.from({ length: 100 }, () => ({
        owner,
        video: new mongoose.Types.ObjectId(),
        canvas: { v: 1 },
        bytes: 10,
      }))
    );
    const videoId = await publish(author.token);
    const res = await put(author.token, videoId, { videoRevision: 0, canvas: CLEAN_CANVAS }).expect(400);
    expect(res.body.code).toBe("PROJECT_QUOTA");
    expect(res.body.message).toContain("已达上限");
    // ★ 一条都没被淘汰
    expect(await BranchProject.countDocuments({ owner })).toBe(100);
  });

  test("覆盖自己那份不会被自己的旧体积挡住（配额排除本条）", async () => {
    const author = await registerUser();
    const owner = new mongoose.Types.ObjectId(author.userId);
    const videoId = await publish(author.token);
    await put(author.token, videoId, { videoRevision: 0, canvas: CLEAN_CANVAS }).expect(200);
    // 把这一条撑到接近总量上限，再覆盖一次 —— 排除了本条就该过
    await BranchProject.updateOne({ video: videoId }, { $set: { bytes: 49 * 1024 * 1024 } });
    await put(author.token, videoId, { videoRevision: 1, canvas: CLEAN_CANVAS }).expect(200);
    expect(await BranchProject.countDocuments({ owner })).toBe(1);
  });
});

describe("工坊工程：归属与读取", () => {
  test("P3 别人的作品：PUT 403、GET 403、DELETE 403", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const videoId = await publish(author.token);
    await put(author.token, videoId, { videoRevision: 0, canvas: CLEAN_CANVAS }).expect(200);

    await put(other.token, videoId, { videoRevision: 0, canvas: CLEAN_CANVAS }).expect(403);
    await request(app)
      .get(`/api/branch/projects/by-video/${videoId}`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(403);
    await request(app)
      .delete(`/api/branch/projects/by-video/${videoId}`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(403);
    // 一个字都没被改掉
    expect(await BranchProject.countDocuments({ video: videoId })).toBe(1);
  });

  test("没有工程 → 404 PROJECT_NOT_FOUND + 一句人话（编辑页据此画灰键）", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    const res = await request(app)
      .get(`/api/branch/projects/by-video/${videoId}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(404);
    expect(res.body.code).toBe("PROJECT_NOT_FOUND");
    expect(res.body.message).toContain("没有留存工坊工程");
  });

  test("作品不存在 → PUT 404（不能给一个不存在的 id 留工程）", async () => {
    const author = await registerUser();
    await put(author.token, String(new mongoose.Types.ObjectId()), {
      videoRevision: 0,
      canvas: CLEAN_CANVAS,
    }).expect(404);
  });

  test("未登录一律 401", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    await request(app).get(`/api/branch/projects/by-video/${videoId}`).expect(401);
    await request(app).get("/api/branch/projects").expect(401);
  });

  test("P5 列表只回元信息，绝不回 canvas", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    await put(author.token, videoId, { title: "甲", videoRevision: 0, canvas: CLEAN_CANVAS }).expect(200);

    const res = await request(app)
      .get("/api/branch/projects")
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe("甲");
    expect(res.body.items[0].bytes).toBeGreaterThan(0);
    expect(res.body.items[0].canvas).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("镜头说明");
  });

  test("DELETE 之后 GET 404（用户主动放弃留存，作品本身不受影响）", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    await put(author.token, videoId, { videoRevision: 0, canvas: CLEAN_CANVAS }).expect(200);
    await request(app)
      .delete(`/api/branch/projects/by-video/${videoId}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    await request(app)
      .get(`/api/branch/projects/by-video/${videoId}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(404);
    await request(app).get(`/api/branch/videos/${videoId}`).expect(200); // 作品还在
  });
});

describe("工坊工程：级联删除（两处都要）", () => {
  test("P4 删作品（purgeVideo）把工程一起带走", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token);
    await put(author.token, videoId, { videoRevision: 0, canvas: CLEAN_CANVAS }).expect(200);

    await request(app)
      .delete(`/api/branch/videos/${videoId}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(await BranchProject.countDocuments({ video: videoId })).toBe(0);
  });

  test("P4 删号（purgeUserCascade）把工程一起带走（含作品早已不在的孤儿）", async () => {
    const { purgeUserCascade } = require("../src/controllers/branchAdmin.controller");
    const author = await registerUser();
    const owner = new mongoose.Types.ObjectId(author.userId);
    const videoId = await publish(author.token);
    await put(author.token, videoId, { videoRevision: 0, canvas: CLEAN_CANVAS }).expect(200);
    // 再造一条孤儿（作品早先被管理员删过、工程当时没跟着走的历史数据）
    await BranchProject.create({
      owner,
      video: new mongoose.Types.ObjectId(),
      canvas: { v: 1 },
      bytes: 5,
    });
    expect(await BranchProject.countDocuments({ owner })).toBe(2);

    await purgeUserCascade(author.userId);
    expect(await BranchProject.countDocuments({ owner })).toBe(0);
  });
});
