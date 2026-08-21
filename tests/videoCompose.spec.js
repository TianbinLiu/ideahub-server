// tests/videoCompose.spec.js
// 覆盖：成片合并端点（POST /api/branch/compose）与它背后的拼接规则。
//
// ★★ 这一套里最要紧的不是"功能对不对"，是**三个静默陷阱**（2026-08-21 在真账号上实测
//   出来的，见 utils/videoCompose 文件头）。它们的共同特征是 HTTP 200、无错误头、
//   产物却是另一个东西：
//     ① fl_splice 没和 l_video 写在同一格 → 产物是**画中画叠加**，时长=基片
//     ② 裁剪参数写进 fl_layer_apply 那格 → 被**静默忽略**，整段被接上
//     ③ 尺寸没归一 → 这条是响亮的 400，但少写一格就整单失败
//   拼装形状一旦被人"顺手整理"，以上任何一条都会悄悄回来，而功能测试照样全绿
//   （能出片、有文件、能播）。所以下面用**纯函数断言把形状本身钉死**，
//   再加一条端到端的时长自检 —— 那是产物侧最后一道闸。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

// ★ 必须在 require app 之前：config/cloudinary 在模块加载时就读这几个值，
//   没有 cloud_name 的话签名地址根本拼不出来（buildComposeUrl 返回 null）
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "testcloud";
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "123456789";
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "test-secret-abc";

let mongod;
let app;
let token, userId;
let otherToken, otherUserId;
let uploadSpy, destroySpy, resourceSpy;

const compose = () => require("../src/services/videoCompose.service");
const { buildComposeTransform, parseOwnBranchVideoUrl, isBranchVideoUrl, COMPOSE_LIMITS } = require("../src/utils/videoCompose");

const CLOUD = "https://res.cloudinary.com/testcloud/video/upload";
/** 段落地址：与两个真实生成方的形状一致（arkTransfer 的 -seg、发布转存的 -<序号>-<slug>） */
const segUrl = (uid, ts, suffix = "seg") => `${CLOUD}/v1/ideahub/branch-videos/${uid}-${ts}-${suffix}.mp4`;
const pid = (uid, ts, suffix = "seg") => `ideahub/branch-videos/${uid}-${ts}-${suffix}`;

async function registerUser(tag) {
  const name = `cmp_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, id: res.body.user._id };
}

/** 默认的合并请求体：两段各 5 秒的竖屏 */
function body(uid, over = {}) {
  return {
    clips: [
      { url: segUrl(uid, 1001), startSec: 0, endSec: 5 },
      { url: segUrl(uid, 1002), startSec: 0, endSec: 5 },
    ],
    width: 704,
    height: 1248,
    ...over,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  const a = await registerUser("main");
  token = a.token;
  userId = a.id;
  const b = await registerUser("other");
  otherToken = b.token;
  otherUserId = b.id;
});

afterAll(async () => {
  await compose().idle();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await require("../src/models/VideoCompose").deleteMany({});
  const { cloudinary } = require("../src/config/cloudinary");
  // 默认：Cloudinary 抓取成功，回执时长正好等于期望（两段各 5 秒 = 10 秒）
  uploadSpy = jest.spyOn(cloudinary.uploader, "upload").mockImplementation(async (_url, opts) => ({
    secure_url: `https://res.cloudinary.com/testcloud/video/upload/v1/${opts.folder}/${opts.public_id}.mp4`,
    public_id: `${opts.folder}/${opts.public_id}`,
    duration: 10.04,
    width: 704,
    height: 1248,
    bytes: 2_800_000,
    audio: { codec: "aac" },
  }));
  destroySpy = jest.spyOn(cloudinary.uploader, "destroy").mockResolvedValue({ result: "ok" });
  resourceSpy = jest.spyOn(cloudinary.api, "resource").mockResolvedValue({ duration: 3, public_id: "x" });
});

afterEach(async () => {
  await compose().idle();
  uploadSpy.mockRestore();
  destroySpy.mockRestore();
  resourceSpy.mockRestore();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

// ─────────────────────────────────────────────────────────────────────
describe("★★ 拼接形状：三个静默陷阱由形状本身堵死", () => {
  const clips = [
    { publicId: "ideahub/branch-videos/u-1-seg", startSec: 0, endSec: 5 },
    { publicId: "ideahub/branch-videos/u-2-seg", startSec: 1, endSec: 4 },
    { publicId: "ideahub/branch-videos/u-3-seg", startSec: 2, endSec: 3.5 },
  ];
  const tx = () => buildComposeTransform({ clips, width: 704, height: 1248 });

  test("整串就是这个样子（改动这条断言前先回去看那三个陷阱）", () => {
    expect(buildComposeTransform({ clips: clips.slice(0, 2), width: 704, height: 1248 })).toBe(
      "q_auto:good,c_fill,w_704,h_1248,so_0,du_5" +
        "/fl_splice,l_video:ideahub:branch-videos:u-2-seg/c_fill,w_704,h_1248,so_1,du_3/fl_layer_apply",
    );
  });

  test("陷阱①：每个带 l_video 的组件都必须同时带 fl_splice（否则产物是画中画，200 且无错误头）", () => {
    const comps = tx().split("/");
    const layerComps = comps.filter((c) => c.includes("l_video:"));
    expect(layerComps.length).toBe(clips.length - 1);
    for (const c of layerComps) expect(c).toMatch(/(^|,)fl_splice(,|$)/);
  });

  test("陷阱②：fl_layer_apply 那一格必须是**光杆**（挂参数会被静默忽略，或变成「拼到最前面」）", () => {
    for (const c of tx().split("/")) {
      if (c.includes("fl_layer_apply")) expect(c).toBe("fl_layer_apply");
    }
  });

  test("陷阱③：每一段（基片与图层）都必须带尺寸归一，否则 Cloudinary 整单 400", () => {
    const comps = tx().split("/");
    const sized = comps.filter((c) => c.includes("c_fill,w_704,h_1248"));
    expect(sized.length).toBe(clips.length); // 基片 1 格 + 每个图层各 1 格
  });

  test("逐段裁剪写的是 so_/du_（不是 eo_），且落在图层组件里", () => {
    const t = tx();
    expect(t).toContain("so_1,du_3");
    expect(t).toContain("so_2,du_1.5");
    expect(t).not.toContain("eo_");
  });

  test("图层引用里的斜杠换成冒号（官方规则，写错就是 400 找不到资源）", () => {
    expect(tx()).toContain("l_video:ideahub:branch-videos:u-2-seg");
    expect(tx()).not.toContain("l_video:ideahub/branch-videos");
  });

  test("画质档：默认 good，可选 best（br_ 那条实测无效，所以压根不提供）", () => {
    expect(tx()).toContain("q_auto:good");
    expect(buildComposeTransform({ clips, width: 704, height: 1248, quality: "best" })).toContain("q_auto:best");
    expect(tx()).not.toContain("br_");
  });
});

describe("背景音乐：循环次数与音量的换算", () => {
  const clips = [{ publicId: "ideahub/branch-videos/u-1-seg", startSec: 0, endSec: 10 }];
  const withBgm = (bgm) => buildComposeTransform({ clips, width: 704, height: 1248, bgm });

  test("BGM 比片子短 → 按 ceil(片长/BGM长)-1 补循环（实测语义：e_loop:N = 额外重复 N 次）", () => {
    // 10 秒片 + 3 秒 BGM → ceil(10/3)-1 = 3（共播 4 遍 = 12 秒，被片长截断）
    expect(withBgm({ publicId: "ideahub/workshop-media/u-9", durationSec: 3, volume: 1 })).toContain("e_loop:3");
  });

  test("BGM 比片子长 → 不加 e_loop（多一次循环就是白烧一次配额）", () => {
    const t = withBgm({ publicId: "ideahub/workshop-media/u-9", durationSec: 30, volume: 1 });
    expect(t).not.toContain("e_loop");
    expect(t).toContain("du_10"); // 截到片长
  });

  test("音量 0~1 → Cloudinary 的 -100..0；原样（1.0）时不写 e_volume", () => {
    expect(withBgm({ publicId: "p", durationSec: 30, volume: 0.5 })).toContain("e_volume:-50");
    expect(withBgm({ publicId: "p", durationSec: 30, volume: 0 })).toContain("e_volume:-100");
    expect(withBgm({ publicId: "p", durationSec: 30, volume: 1 })).not.toContain("e_volume");
  });

  test("replace=true 时 ac_none 要写进**每一格**（实测它只作用于所在那一格）", () => {
    const two = [
      { publicId: "ideahub/branch-videos/u-1-seg", startSec: 0, endSec: 5 },
      { publicId: "ideahub/branch-videos/u-2-seg", startSec: 0, endSec: 5 },
    ];
    const t = buildComposeTransform({
      clips: two, width: 704, height: 1248,
      bgm: { publicId: "p", durationSec: 30, volume: 1, replace: true },
    });
    // 只写基片那格的话，被拼段落的原声照样混进成片，而且不报错
    expect(t.split("/").filter((c) => c.includes("ac_none")).length).toBe(2);
  });

  test("不要 BGM 时整串里不该出现音频图层", () => {
    expect(buildComposeTransform({ clips, width: 704, height: 1248 })).not.toContain("l_audio");
  });
});

describe("段落归属：不判归属就等于替别人剪片 + 烧我们的配额", () => {
  test("本账号的三种真实形状都认（转存的 -seg / 发布转存的 -N-slug / 合并产物 -merged）", () => {
    for (const suffix of ["seg", "3-cover", "merged"]) {
      expect(parseOwnBranchVideoUrl(segUrl(userId, 1700, suffix), userId)?.publicId).toBe(pid(userId, 1700, suffix));
    }
  });

  test("别人的段落不认，但认得出「这是成片目录下的地址」（两种失败要分开说）", () => {
    const other = segUrl(otherUserId, 1700);
    expect(parseOwnBranchVideoUrl(other, userId)).toBeNull();
    expect(isBranchVideoUrl(other)).toBe(true);
  });

  test.each([
    ["别的目录（模板视频）", `${CLOUD}/v1/ideahub/template-videos/UID-1700.mp4`],
    ["带变换的地址（变换是我们拼的活儿，不收）", `${CLOUD}/c_fill,w_100,h_100/v1/ideahub/branch-videos/UID-1700-seg.mp4`],
    ["非 Cloudinary 域", "https://evil.example.com/ideahub/branch-videos/UID-1700-seg.mp4"],
    ["明文 http", "http://res.cloudinary.com/testcloud/video/upload/ideahub/branch-videos/UID-1700-seg.mp4"],
    ["方舟临时直链", "https://ark-x.tos-cn-beijing.volces.com/seedance/a.mp4"],
    ["多一层目录（伪造的形状）", `${CLOUD}/v1/ideahub/branch-videos/sub/UID-1700-seg.mp4`],
  ])("%s → 不认", (_label, url) => {
    expect(parseOwnBranchVideoUrl(url.replace(/UID/g, userId), userId)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("端点：受理与校验", () => {
  test("未登录 → 401，且不碰 Cloudinary", async () => {
    const res = await request(app).post("/api/branch/compose").send(body(userId));
    expect(res.status).toBe(401);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  test("段落还挂在方舟直链上 → 400 CLIPS_NOT_READY，且点名是第几段", async () => {
    const b = body(userId);
    b.clips[1].url = "https://ark-x.tos-cn-beijing.volces.com/seedance/a.mp4";
    const res = await request(app).post("/api/branch/compose").set(auth()).send(b);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CLIPS_NOT_READY");
    expect(res.body.message).toMatch(/第 2 段/);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  test("别人的段落 → 400，且**不是** CLIPS_NOT_READY（等多久都没用，得说实话）", async () => {
    const b = body(userId);
    b.clips[1].url = segUrl(otherUserId, 1002);
    const res = await request(app).post("/api/branch/compose").set(auth()).send(b);
    expect(res.status).toBe(400);
    expect(res.body.code).not.toBe("CLIPS_NOT_READY");
    expect(res.body.message).toMatch(/不是你自己的素材/);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  test("区间太短 → 400", async () => {
    const b = body(userId, { clips: [{ url: segUrl(userId, 1001), startSec: 1, endSec: 1.05 }] });
    const res = await request(app).post("/api/branch/compose").set(auth()).send(b);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/太短/);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  test("★ 奇数宽不是错误，服务端取偶（客户端 720p 竖屏算出来的正是 405×720）", async () => {
    const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId, { width: 405, height: 720 }));
    expect(res.status).toBe(202);
    await compose().idle();
    expect(uploadSpy.mock.calls[0][1].raw_transformation).toContain("c_fill,w_404,h_720");
  });

  test("405 与 404 命中同一条任务（差一像素不该白跑一遍、白花一份配额）", async () => {
    const a = await request(app).post("/api/branch/compose").set(auth()).send(body(userId, { width: 405, height: 720 }));
    const b = await request(app).post("/api/branch/compose").set(auth()).send(body(userId, { width: 404, height: 720 }));
    expect(b.body.jobId).toBe(a.body.jobId);
    await compose().idle();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });

  test("总时长超上限 → 400（成本上界，不是洁癖）", async () => {
    const b = body(userId, {
      clips: [
        { url: segUrl(userId, 1001), startSec: 0, endSec: 200 },
        { url: segUrl(userId, 1002), startSec: 0, endSec: 200 },
      ],
    });
    const res = await request(app).post("/api/branch/compose").set(auth()).send(b);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(new RegExp(String(COMPOSE_LIMITS.maxTotalSec)));
  });

  test("段数超上限 → 400（zod 挡在最前面）", async () => {
    const clips = Array.from({ length: COMPOSE_LIMITS.maxClips + 1 }, (_, i) => ({
      url: segUrl(userId, 2000 + i), startSec: 0, endSec: 2,
    }));
    const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId, { clips }));
    expect(res.status).toBe(400);
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});

describe("端点：跑通与自检", () => {
  test("受理 → 202 pending；跑完轮询拿到成片地址，且交给 Cloudinary 的是我们拼的那串变换", async () => {
    const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    expect(res.status).toBe(202);
    expect(res.body.state).toBe("pending");
    const jobId = res.body.jobId;
    expect(jobId).toBeTruthy();

    await compose().idle();
    const st = await request(app).get(`/api/branch/compose/${jobId}`).set(auth());
    expect(st.status).toBe(200);
    expect(st.body.state).toBe("done");
    expect(st.body.url).toMatch(/^https:\/\/res\.cloudinary\.com\//);

    // 端到端确认拼装形状真的送到了 Cloudinary（而不是只在单元测试里对）
    const [sentSource, sentOpts] = uploadSpy.mock.calls[0];
    expect(sentOpts.raw_transformation).toContain("fl_splice,l_video:ideahub:branch-videos:");
    expect(sentOpts.raw_transformation).toContain("c_fill,w_704,h_1248");
    // ★ 源必须是第 1 段的**原始**地址：变换要走 API 参数（入站变换），不能拼进投递地址 ——
    //   拼进地址的话 Cloudinary 抓到的是"边生成边发"的分片 MP4，会被原样存成成片，
    //   容器里没有样本表、播放器读不出时长（实测三条路的容器差别见 utils 的 buildSourceUrl）
    expect(sentSource).not.toContain("fl_splice");
    expect(sentSource).toContain("/video/upload/");
    // 落成**独立资产**：成片的命不能挂在第 1 段上
    expect(sentOpts).toMatchObject({ resource_type: "video", folder: "ideahub/branch-videos" });
    expect(sentOpts.public_id).toMatch(/-merged$/);
  });

  test("★★ 时长对不上 → 整单判失败并把产物删掉（这就是防静默失败那道闸）", async () => {
    // 产物只有基片那么长 = 图层被当成画中画那种形态（HTTP 200、无错误头）
    uploadSpy.mockImplementation(async (_url, opts) => ({
      secure_url: "https://res.cloudinary.com/testcloud/video/upload/v1/x.mp4",
      public_id: `${opts.folder}/${opts.public_id}`,
      duration: 5.04, // 期望 10
      width: 704, height: 1248, bytes: 1_400_000,
    }));
    const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    expect(res.status).toBe(202);
    await compose().idle();

    const st = await request(app).get(`/api/branch/compose/${res.body.jobId}`).set(auth());
    expect(st.body.state).toBe("failed");
    expect(st.body.message).toMatch(/时长不对/);
    expect(st.body.message).toMatch(/应约 10/); // 把期望与实得都说出来，便于回溯
    // 不能留一个没人认领的坏资产在账号里
    expect(destroySpy).toHaveBeenCalled();
    expect(destroySpy.mock.calls[0][0]).toMatch(/-merged$/);
  });

  test("同一份配方连点两次 → 只跑一次（合并每发都真烧配额）", async () => {
    const first = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    const second = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    expect(second.body.jobId).toBe(first.body.jobId);
    await compose().idle();
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });

  test("配方变一点（裁剪不同）→ 是另一件事，会重新跑", async () => {
    await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    const b2 = body(userId);
    b2.clips[0].endSec = 4;
    await request(app).post("/api/branch/compose").set(auth()).send(b2);
    await compose().idle();
    expect(uploadSpy).toHaveBeenCalledTimes(2);
  });

  test("失败过的配方，用户再点一次会重试（一次性抖动不该把人钉死）", async () => {
    uploadSpy.mockRejectedValueOnce(new Error("boom"));
    const first = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    await compose().idle();
    const failed = await request(app).get(`/api/branch/compose/${first.body.jobId}`).set(auth());
    expect(failed.body.state).toBe("failed");

    const retry = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    expect(retry.status).toBe(202);
    await compose().idle();
    const ok = await request(app).get(`/api/branch/compose/${first.body.jobId}`).set(auth());
    expect(ok.body.state).toBe("done");
  });

  test("别人的任务查不到（jobId 是配方指纹，可猜；不按人过滤就是泄露成片地址）", async () => {
    const mine = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    await compose().idle();
    const peek = await request(app)
      .get(`/api/branch/compose/${mine.body.jobId}`)
      .set({ Authorization: `Bearer ${otherToken}` });
    expect(peek.status).toBe(404);
  });
});

describe("★ 每日产出秒数预算（限流只管次数，管不住钱）", () => {
  test("超出当日额度 → 429 COMPOSE_QUOTA，且一秒钟的编码都不跑", async () => {
    const { DAILY_OUTPUT_SEC_BUDGET } = compose();
    // 先把额度用掉大半：造一条已受理过的大额记录（与真实受理走同一张表、同一个字段）
    await require("../src/models/VideoCompose").create({
      key: "seed-budget-" + Date.now(),
      userId,
      state: "done",
      expectedSec: DAILY_OUTPUT_SEC_BUDGET - 5,
    });
    const res = await request(app)
      .post("/api/branch/compose")
      .set(auth())
      .send(body(userId)); // 本次要 10 秒，超出剩余的 5 秒
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("COMPOSE_QUOTA");
    expect(res.body.message).toMatch(/额度/);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  test("额度用完也不影响**已经拼好**的那条（回来看昨天的成片不该被拦）", async () => {
    const first = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    await compose().idle();
    expect(first.status).toBe(202);

    const { DAILY_OUTPUT_SEC_BUDGET } = compose();
    await require("../src/models/VideoCompose").create({
      key: "seed-budget2-" + Date.now(),
      userId,
      state: "done",
      expectedSec: DAILY_OUTPUT_SEC_BUDGET,
    });
    // 同一份配方再要一次：不开新的一发，所以不该被预算拦下
    const again = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    expect(again.status).toBe(200);
    expect(again.body.state).toBe("done");
  });
});

describe("背景音乐：端点侧", () => {
  test("BGM 时长只从 Cloudinary 取，循环次数按它算（不收客户端报的数）", async () => {
    resourceSpy.mockResolvedValue({ duration: 4, public_id: `ideahub/workshop-media/${userId}-777` });
    const b = body(userId, {
      audio: { url: `https://res.cloudinary.com/testcloud/video/upload/v1/ideahub/workshop-media/${userId}-777.mp3`, volume: 0.4 },
    });
    const res = await request(app).post("/api/branch/compose").set(auth()).send(b);
    expect(res.status).toBe(202);
    await compose().idle();
    expect(resourceSpy).toHaveBeenCalled();
    const sent = uploadSpy.mock.calls[0][1].raw_transformation;
    expect(sent).toContain("l_audio:ideahub:workshop-media:");
    expect(sent).toContain("e_loop:2"); // ceil(10/4)-1 = 2
    expect(sent).toContain("e_volume:-60");
  });

  test("别人的 BGM → 400（归属判据复用 templateVideoAsset，一处实现）", async () => {
    const b = body(userId, {
      audio: { url: `https://res.cloudinary.com/testcloud/video/upload/v1/ideahub/workshop-media/${otherUserId}-777.mp3`, volume: 1 },
    });
    const res = await request(app).post("/api/branch/compose").set(auth()).send(b);
    expect(res.status).toBe(400);
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});
