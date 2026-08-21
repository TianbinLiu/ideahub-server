// tests/arkTransfer.spec.js
// 覆盖：方舟成片 → Cloudinary 的后台转存链路（2026-08-21 真机复盘后的形态）。
//
// ★ 为什么值得一份回归测试：这条链路的旧形态（客户端 POST 一趟、服务端同步搬完再应答）
//   在弱网真机上是**静默失败**的——客户端 180s 超时掐线、成片留在 24h 直链上、预览与
//   合并跟着全坏，而全程零报错。新形态的每一个关键性质拆掉也同样无症状：
//     ① 去重丢了      → 同一成片被搬两遍（20MB×2 带宽 + 双份存储），账单和磁盘知道
//     ② 失败不落库    → 客户端永远看到 pending，干等到预算耗尽（比报错更坏）
//     ③ 自动转存不 opt-in → 白模化/Seed3D 的轮询也顺手搬 20MB 去没人读的角落
//     ④ 阻塞形态丢了  → 已装机的老 APK 拿到 202 的 JSON 里没有 url，静默退回直链
//
// ★ 不真出网：方舟上游走 global.fetch 间谍，TOS 下载与 Cloudinary 上传直接
//   spy 掉 videoAsset 的两个函数（arkTransfer 是按模块对象调它们的，spy 得住）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let token;
let userId;
let fetchSpy;
let downloadSpy;
let uploadSpy;

const videoAsset = () => require("../src/services/videoAsset.service");
const arkTransfer = () => require("../src/services/arkTransfer.service");
const Model = () => require("../src/models/ArkVideoTransfer");

/** 方舟 TOS 直链的形状（真实产物的域）。sig 模拟每次轮询重签的 query */
const arkUrl = (name, sig = "a") =>
  `https://ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com/seedance/${name}.mp4?X-Tos-Signature=${sig}`;
const CLD = "https://res.cloudinary.com/demo/video/upload/v1/ideahub/branch-videos/x.mp4";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  delete process.env.ARK_API_KEY;

  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");

  const name = `tr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  token = res.body.token;
  userId = res.body.user._id;
});

afterAll(async () => {
  await arkTransfer().idle();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Model().deleteMany({});
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => {
    throw new Error("测试里不应该有任何出网请求");
  });
  downloadSpy = jest.spyOn(videoAsset(), "downloadToBuffer").mockResolvedValue(Buffer.from("fake-video"));
  uploadSpy = jest.spyOn(videoAsset(), "uploadVideoBuffer").mockResolvedValue(CLD);
});

afterEach(async () => {
  await arkTransfer().idle(); // 别把在途搬运留给下一条用例（它们会写库）
  fetchSpy.mockRestore();
  downloadSpy.mockRestore();
  uploadSpy.mockRestore();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe("鉴权与域名闸（新旧形态一致）", () => {
  test("未登录 → 401：transfer-video / status 一个都不许裸奔", async () => {
    expect((await request(app).post("/api/ark/transfer-video").send({ url: arkUrl("a") })).status).toBe(401);
    expect((await request(app).post("/api/ark/transfer-video/status").send({ urls: [] })).status).toBe(401);
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["非方舟域", "https://evil.example.com/x.mp4"],
    ["明文 http", "http://x.volces.com/a.mp4"],
    ["回环", "https://127.0.0.1/a.mp4"],
    ["空", ""],
  ])("transfer-video 收到 %s → 400，且一个字节都不搬", async (_label, url) => {
    const res = await request(app).post("/api/ark/transfer-video").set(auth()).send({ url });
    expect(res.status).toBe(400);
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});

describe("受理式（wait:false）+ 状态查询", () => {
  test("踢一脚立即 202 pending，后台搬完后 status 给出 Cloudinary 地址", async () => {
    const url = arkUrl("seg1");
    const kick = await request(app).post("/api/ark/transfer-video").set(auth()).send({ url, wait: false });
    expect(kick.status).toBe(202);
    expect(kick.body.state).toBe("pending");

    await arkTransfer().idle();
    const st = await request(app).post("/api/ark/transfer-video/status").set(auth()).send({ urls: [url] });
    expect(st.status).toBe(200);
    expect(st.body.results[url]).toEqual({ state: "done", url: CLD });
    expect(downloadSpy).toHaveBeenCalledTimes(1);
  });

  test("★ 同一产物换个签名再踢 → 不重搬（sourceKey 去重是带宽与存储的闸）", async () => {
    await request(app).post("/api/ark/transfer-video").set(auth()).send({ url: arkUrl("seg2", "sig-1"), wait: false });
    await arkTransfer().idle();
    const again = await request(app)
      .post("/api/ark/transfer-video")
      .set(auth())
      .send({ url: arkUrl("seg2", "sig-2"), wait: false });
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ state: "done", url: CLD }); // 直接给现成结果
    expect(downloadSpy).toHaveBeenCalledTimes(1);
  });

  test("搬失败要**落库可见**（failed+原因），显式再踢一脚会重试并成功", async () => {
    downloadSpy.mockRejectedValueOnce(new Error("HTTP 403"));
    const url = arkUrl("seg3");
    await request(app).post("/api/ark/transfer-video").set(auth()).send({ url, wait: false }).expect(202);
    await arkTransfer().idle();

    const st = await request(app).post("/api/ark/transfer-video/status").set(auth()).send({ urls: [url] });
    expect(st.body.results[url].state).toBe("failed");
    expect(st.body.results[url].message).toMatch(/HTTP 403/);

    // requestTransfer 对 failed 是复活重试；这次 download 走默认 mock（成功）
    const retry = await request(app).post("/api/ark/transfer-video").set(auth()).send({ url, wait: false });
    expect(retry.status).toBe(202);
    await arkTransfer().idle();
    const st2 = await request(app).post("/api/ark/transfer-video/status").set(auth()).send({ urls: [url] });
    expect(st2.body.results[url]).toEqual({ state: "done", url: CLD });
    expect(downloadSpy).toHaveBeenCalledTimes(2);
  });

  test("status 是只读的：没登记过 → none，且不触发任何搬运", async () => {
    const url = arkUrl("never");
    const st = await request(app).post("/api/ark/transfer-video/status").set(auth()).send({ urls: [url, "not-a-url"] });
    expect(st.body.results[url]).toEqual({ state: "none" });
    expect(st.body.results["not-a-url"]).toEqual({ state: "none" });
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});

describe("阻塞形态（老客户端，已装机 APK 改不了）", () => {
  test("缺省（不带 wait）→ 等搬完直接回 {url}，语义与老实现一致", async () => {
    const res = await request(app).post("/api/ark/transfer-video").set(auth()).send({ url: arkUrl("seg4") });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: CLD });
  }, 15_000);

  test("搬失败 → 502 + message（客户端据此退回方舟直链，发布老路再兜一次）", async () => {
    downloadSpy.mockRejectedValue(new Error("HTTP 500"));
    const res = await request(app).post("/api/ark/transfer-video").set(auth()).send({ url: arkUrl("seg5") });
    expect(res.status).toBe(502);
    expect(typeof res.body.message).toBe("string");
  }, 15_000);
});

describe("轮询自动转存（?transfer=1）", () => {
  const TASK = "cgt-transfer-0001";
  /** 让方舟上游（callArk 的 fetch）返回指定任务响应 */
  function upstreamTask(body) {
    fetchSpy.mockImplementation(async () => ({ status: 200, text: async () => JSON.stringify(body) }));
  }

  beforeEach(() => {
    process.env.ARK_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.ARK_API_KEY;
  });

  test("succeeded + 方舟域 video_url：第一眼挂 pending 并后台开搬，第二眼 done + 永久地址；video_url 原样保留", async () => {
    const vurl = arkUrl("seg6", "poll-sig");
    upstreamTask({ id: TASK, status: "succeeded", content: { video_url: vurl } });

    const first = await request(app).get(`/api/ark/contents/generations/tasks/${TASK}?transfer=1`).set(auth());
    expect(first.status).toBe(200);
    expect(first.body.transfer).toEqual({ state: "pending" });
    expect(first.body.content.video_url).toBe(vurl); // 不偷换：老客户端还要读它走老路

    await arkTransfer().idle();
    const second = await request(app).get(`/api/ark/contents/generations/tasks/${TASK}?transfer=1`).set(auth());
    expect(second.body.transfer).toEqual({ state: "done", url: CLD });
    expect(downloadSpy).toHaveBeenCalledTimes(1); // 两次轮询 = 一次搬运
  });

  test("★ 不带 ?transfer=1 → 不搬也不挂字段（白模化/Seed3D 的轮询不被顺手搬 20MB）", async () => {
    upstreamTask({ id: TASK, status: "succeeded", content: { video_url: arkUrl("seg7") } });
    const res = await request(app).get(`/api/ark/contents/generations/tasks/${TASK}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.transfer).toBeUndefined();
    await arkTransfer().idle();
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  test("产物已是非方舟域（比如早转存过的 Cloudinary 地址）→ 不搬也不挂字段", async () => {
    upstreamTask({ id: TASK, status: "succeeded", content: { video_url: CLD } });
    const res = await request(app).get(`/api/ark/contents/generations/tasks/${TASK}?transfer=1`).set(auth());
    expect(res.body.transfer).toBeUndefined();
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  test("running 的轮询不碰转存（succeeded 才是搬运的触发点）", async () => {
    upstreamTask({ id: TASK, status: "running" });
    const res = await request(app).get(`/api/ark/contents/generations/tasks/${TASK}?transfer=1`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.transfer).toBeUndefined();
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  test("与老客户端的 POST 汇流：轮询已搬完的产物，阻塞 POST 直接拿现成结果（不重搬）", async () => {
    const vurl = arkUrl("seg8", "poll-sig");
    upstreamTask({ id: TASK, status: "succeeded", content: { video_url: vurl } });
    await request(app).get(`/api/ark/contents/generations/tasks/${TASK}?transfer=1`).set(auth());
    await arkTransfer().idle();

    // 老客户端拿它自己轮询到的（签名不同的）URL 来 POST —— sourceKey 相同，直接命中
    const res = await request(app).post("/api/ark/transfer-video").set(auth()).send({ url: arkUrl("seg8", "post-sig") });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: CLD });
    expect(downloadSpy).toHaveBeenCalledTimes(1);
  }, 15_000);
});

describe("登记表本身的性质", () => {
  test("僵尸 pending（认领进程死了）会被重新认领，而不是永远 pending", async () => {
    const url = arkUrl("seg9");
    const key = arkTransfer().sourceKeyOf(url);
    // 造一条"很久没动静"的 pending（绕过 timestamps 的自动刷新）
    await Model().create({ sourceKey: key, sourceUrl: url, state: "pending" });
    const past = new Date(Date.now() - arkTransfer().STALE_PENDING_MS - 60_000);
    await Model().updateOne({ sourceKey: key }, { $set: { updatedAt: past } }, { timestamps: false });

    const job = await arkTransfer().ensureTransfer(url, userId);
    expect(job.state).toBe("pending"); // 认领成功 = 还在 pending，但已重新开搬
    await arkTransfer().idle();
    const after = await Model().findOne({ sourceKey: key }).lean();
    expect(after.state).toBe("done");
    expect(downloadSpy).toHaveBeenCalledTimes(1);
  });

  test("新鲜的 pending 不会被并发 ensure 抢走重搬（去重的另一半）", async () => {
    const url = arkUrl("seg10");
    await arkTransfer().ensureTransfer(url, userId);
    await arkTransfer().ensureTransfer(url, userId);
    await arkTransfer().ensureTransfer(url, userId);
    await arkTransfer().idle();
    expect(downloadSpy).toHaveBeenCalledTimes(1);
  });
});
