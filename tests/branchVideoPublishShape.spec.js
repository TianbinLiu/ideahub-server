// 发布三档可见性 × **App 真实形状的完整草稿**（带卡组/付费/幂等键/成片地址/客户端多带的字段）。
//
// ★ 与 branchVideoVisibility.spec 的区别：那边的草稿是最小形状（一段、只有首帧）；这里塞的是
//   剪辑页组稿后真正会发出来的东西 —— 卡组里带真人卡（realPerson / views / idLine / asset）、
//   段上带 App 新加的 `poster`（服务端 z.object 该 strip 掉）、merged/clientId/pricing 齐全。
//   2026-09-05 主人真机发「仅链接可看」回 Server error 时，这份用例是拿来排除"服务端代码本身
//   处理不了这个形状"的（三档都 201 ⇒ 问题在生产数据/外部调用，见 middleware/error.js 的 500 日志）。
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
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function registerUser() {
  const name = `pub_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

const CLD = "https://res.cloudinary.com/demo";
const seg = (i) => ({
  title: `第 ${i} 段`,
  plot: "白模模板复刻：红色人偶=赛博侦探",
  firstFrame: `${CLD}/image/upload/v1/ideahub/branch-frames/f${i}.jpg`,
  lastFrame: `${CLD}/image/upload/v1/ideahub/branch-frames/l${i}.jpg`,
  // App 2026-09-04 起段上带成片第一帧（dataURL，只管显示）。服务端不存它，也不能因它 400/500
  poster: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  durationSec: 17,
  videoUrl: `${CLD}/video/upload/v1/ideahub/branch-videos/u-${i}-seg.mp4`,
  videoTier: "ultra",
  aspect: "landscape",
});

function richDraft(extra) {
  return {
    title: "1",
    category: "剧情",
    description: "",
    tags: ["测试"],
    cover: `${CLD}/image/upload/v1/ideahub/branch-frames/cover.jpg`,
    segments: [seg(1)],
    deck: {
      name: "本片卡组",
      cards: [
        {
          id: "card_abc",
          cardId: "card_abc",
          type: "character",
          name: "居家少年",
          summary: "黑色长袖",
          cover: `${CLD}/image/upload/v1/ideahub/branch-cards/c1.jpg`,
          tags: ["黑衣"],
          realPerson: true,
          idLine: "黑色长袖 T 恤、黑裤、黑鞋",
          views: [
            { kind: "body", role: "primary", tag: "全身立绘", url: `${CLD}/image/upload/v1/ideahub/branch-cards/c1-body.jpg` },
            { kind: "face", role: "face", tag: "面部特写", url: `${CLD}/image/upload/v1/ideahub/branch-cards/c1-face.jpg` },
          ],
          asset: { assetId: "asset-20260901051846-fz777" },
          voice: { url: `${CLD}/video/upload/v1/ideahub/voice/v1.m4a`, durationSec: 4.2 },
        },
      ],
    },
    pricing: { mode: "free", partPrices: [] },
    merged: true,
    clientId: `cv_${Math.random().toString(36).slice(2)}`,
    ...extra,
  };
}

describe("完整形状的草稿 × 三档可见性", () => {
  test("公开 / 仅链接可看 / 纯私密 都 201，且 linkOnly 只在仅链接那一档回来", async () => {
    const { token } = await registerUser();
    const post = (extra) =>
      request(app).post("/api/branch/videos").set("Authorization", `Bearer ${token}`).send(richDraft(extra));

    const pub = await post({ visibility: "public" });
    expect(pub.status).toBe(201);
    expect(pub.body.video.linkOnly).toBeUndefined();

    const unlisted = await post({ visibility: "private", linkOnly: true });
    expect(unlisted.status).toBe(201);
    expect(unlisted.body.video.visibility).toBe("private");
    expect(unlisted.body.video.linkOnly).toBe(true);

    const priv = await post({ visibility: "private", linkOnly: false });
    expect(priv.status).toBe(201);
    expect(priv.body.video.linkOnly).toBeUndefined();

    // 段上多带的 poster 被 strip：不落库、不 400
    expect("poster" in unlisted.body.video.segments[0]).toBe(false);
  });
});
