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

// ─────────────────────────────────────────────────────────────────────
// 发布时的兜底转存（controller 的 transferVideo）：段的 videoUrl 还挂在**上游的临时成片**上时，下载下来存进图床再落库。
// ★ 2026-10-26 审核：H3 上线时这里从「只认方舟」换成了 videoAsset.isUpstreamTempVideoUrl，可全仓只有 minimaxV2.spec 用到 H3 的 CDN 地址、
//   测的又只是那个函数本身与产物代理 / 转存端点 —— 把 controller 改回 isArkVideoUrl，所有用例照样全绿，H3 的成片就原样发布、过几天作品变黑。
//   这一组钉的是**发布这条路**真的去搬了它。
// ★ 不出网：fetch 换成间谍（只认那两条成片地址），图床的上传流换成假的（回一条 Cloudinary 地址）；Cloudinary 上的地址原样保留、不下载。
describe("发布时的兜底转存：上游的临时成片（方舟 / MiniMax H3）会被下载并存进图床", () => {
  const { cloudinary } = require("../src/config/cloudinary");
  const H3_URL = "https://video-product.cdn.minimax.io/h3-480p/2000/01/01/test/100000000000001-1-0000000000000000_aigc.mp4";
  const ARK_URL = "https://ark-content.tos-cn-beijing.volces.com/doubao-seedance/x/out.mp4";

  test("H3 的成片地址 → 下载 + 转存，落库的是图床地址；方舟的同样；图床上的原样留着、不下载", async () => {
    const fetched = [];
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      fetched.push(u);
      if (u === H3_URL || u === ARK_URL) return new Response("mp4-bytes", { status: 200, headers: { "content-type": "video/mp4" } });
      throw new Error(`测试里没有为这个地址准备回应：${u}`);
    });
    const uploads = [];
    const uploadSpy = jest.spyOn(cloudinary.uploader, "upload_stream").mockImplementation((opts, cb) => ({
      end: (buf) => {
        uploads.push({ opts, bytes: Buffer.from(buf).toString() });
        cb(null, { secure_url: `https://res.cloudinary.com/demo/video/upload/v1/${opts.folder}/${opts.public_id}.mp4` });
      },
    }));
    try {
      const { token } = await registerUser();
      const draft = richDraft({ visibility: "public" });
      draft.segments = [
        { ...seg(1), videoUrl: H3_URL },
        { ...seg(2), videoUrl: ARK_URL },
        seg(3), // 已经是图床地址
      ];
      const res = await request(app).post("/api/branch/videos").set("Authorization", `Bearer ${token}`).send(draft);
      expect(res.status).toBe(201);
      const urls = res.body.video.segments.map((s) => s.videoUrl);
      expect(urls[0]).toMatch(/^https:\/\/res\.cloudinary\.com\/demo\/video\/upload\/v1\/ideahub\/branch-videos\//);
      expect(urls[1]).toMatch(/^https:\/\/res\.cloudinary\.com\/demo\/video\/upload\/v1\/ideahub\/branch-videos\//);
      expect(urls[2]).toBe(seg(3).videoUrl);
      expect(JSON.stringify(res.body.video)).not.toMatch(/minimax\.io|volces\.com/);
      // 两条上游地址各下载一次、各存一次（resource_type video），图床那条一个字节都没碰
      expect(fetched.sort()).toEqual([ARK_URL, H3_URL].sort());
      expect(uploads).toHaveLength(2);
      expect(uploads.every((u) => u.opts.resource_type === "video" && u.bytes === "mp4-bytes")).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      uploadSpy.mockRestore();
    }
  });
});
