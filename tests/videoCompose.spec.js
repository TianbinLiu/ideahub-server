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
    // 30 秒片 + 7 秒 BGM → ceil(30/7)-1 = 4（共播 5 遍 = 35 秒，被片长截断）
    // ★ 用 ≥ minBgmSec 的素材：更短的在端点侧就被整句拒了（那是另一条用例）
    const long = [{ publicId: "ideahub/branch-videos/u-1-seg", startSec: 0, endSec: 30 }];
    const t = buildComposeTransform({ clips: long, width: 704, height: 1248, bgm: { publicId: "ideahub/workshop-media/u-9", durationSec: 7, volume: 1 } });
    expect(t).toContain("e_loop:4");
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

describe("★★ 复审逮到的四个真缺陷（每条都曾经能跑通攻击）", () => {
  test("① 重试也要计费：同一份配方反复失败重试，跑不满额度就必须 429", async () => {
    uploadSpy.mockRejectedValue(new Error("boom")); // 让它稳定失败 —— 时长自检失败那条路同理
    const { DAILY_OUTPUT_SEC_BUDGET } = compose();
    const each = 10; // body() 是两段各 5 秒
    const allowed = Math.floor(DAILY_OUTPUT_SEC_BUDGET / each);
    let denied = 0;
    for (let i = 0; i < allowed + 3; i++) {
      const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
      await compose().idle();
      if (res.status === 429) denied++;
    }
    // 修之前：登记只有 1 行、expectedSec 恒为 10，spent 永远是 10，于是**一次都不会 429**
    expect(denied).toBeGreaterThan(0);
    expect(uploadSpy.mock.calls.length).toBeLessThanOrEqual(allowed);
  }, 30_000);

  test("② 预算不是先查后写：并发受理不该整体突破额度", async () => {
    const { DAILY_OUTPUT_SEC_BUDGET } = compose();
    // 六发**不同配方**（差 1 毫秒就是不同指纹，去重管不着）同时打进来，每发 200 秒
    const burst = Array.from({ length: 6 }, (_, i) =>
      request(app).post("/api/branch/compose").set(auth()).send(
        body(userId, { clips: [{ url: segUrl(userId, 1001), startSec: i * 0.001, endSec: i * 0.001 + 200 }] }),
      ),
    );
    const rs = await Promise.all(burst);
    await compose().idle();
    const accepted = rs.filter((r) => r.status === 202).length;
    // 200 秒一发 → 900 秒的额度最多装得下 4 发。修之前六发全部 202（实测放进 1799.99 秒）
    expect(accepted).toBeLessThanOrEqual(Math.floor(DAILY_OUTPUT_SEC_BUDGET / 200));
    expect(uploadSpy.mock.calls.length).toBe(accepted);
  }, 30_000);

  test("③ 晚到的 runner 不许打翻已完成的任务，且要销毁自己那份产物（否则成片变孤儿）", async () => {
    const VideoComposeModel = require("../src/models/VideoCompose");
    // 让这一趟的上传卡在闸门上，中途把记录改成"另一趟已经跑完了"——这正是僵尸重认领的形状
    let release;
    const gate = new Promise((r) => { release = r; });
    uploadSpy.mockImplementation(async (_url, opts) => {
      await gate;
      return {
        secure_url: `https://res.cloudinary.com/testcloud/video/upload/v1/${opts.folder}/${opts.public_id}.mp4`,
        public_id: `${opts.folder}/${opts.public_id}`,
        duration: 10.04, width: 704, height: 1248, bytes: 2_800_000,
      };
    });

    const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    const jobId = res.body.jobId;
    await VideoComposeModel.updateOne(
      { key: jobId },
      { $set: { state: "done", url: "https://winner.example/win.mp4", publicId: "ideahub/branch-videos/winner" } },
    );
    release();
    await compose().idle();

    const after = await VideoComposeModel.findOne({ key: jobId }).lean();
    expect(after.state).toBe("done");
    expect(after.url).toBe("https://winner.example/win.mp4"); // 没被晚到的那趟打翻
    expect(destroySpy).toHaveBeenCalled();                     // 晚到那份产物被销毁
    expect(destroySpy.mock.calls[0][0]).toMatch(/-merged$/);
  });

  test("④ 僵尸 pending 在**轮询**时就被判失败（不然客户端永远转圈，直到 48h 后变 404）", async () => {
    const VideoComposeModel = require("../src/models/VideoCompose");
    const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    const jobId = res.body.jobId;
    await compose().idle();
    // 造一条很久没动静的 pending（绕过 timestamps 自动刷新）
    const past = new Date(Date.now() - compose().STALE_PENDING_MS - 60_000);
    await VideoComposeModel.updateOne({ key: jobId }, { $set: { state: "pending", url: null } }, { timestamps: false });
    await VideoComposeModel.updateOne({ key: jobId }, { $set: { updatedAt: past } }, { timestamps: false });

    const st = await request(app).get(`/api/branch/compose/${jobId}`).set(auth());
    expect(st.body.state).toBe("failed");
    expect(st.body.message).toMatch(/没能跑完|重新开始/);
  });
});

describe("★★ 静默失败复审逮到的第二批", () => {
  test("① 产物恰好只有第 1 段那么长 → 判失败（容差拦不住的那个画中画形状）", async () => {
    // 两段各 0.3 秒：期望 0.6，画中画产物 0.3，差 0.3 < 容差 0.59 —— 只看总时长的话判过
    const b = body(userId, {
      clips: [
        { url: segUrl(userId, 1001), startSec: 0, endSec: 0.3 },
        { url: segUrl(userId, 1002), startSec: 0, endSec: 0.3 },
      ],
    });
    uploadSpy.mockImplementation(async (_u, opts) => ({
      secure_url: `https://res.cloudinary.com/testcloud/video/upload/v1/${opts.folder}/${opts.public_id}.mp4`,
      public_id: `${opts.folder}/${opts.public_id}`,
      duration: 0.3, width: 704, height: 1248, bytes: 100,
    }));
    const res = await request(app).post("/api/branch/compose").set(auth()).send(b);
    await compose().idle();
    const st = await request(app).get(`/api/branch/compose/${res.body.jobId}`).set(auth());
    expect(st.body.state).toBe("failed");
    expect(st.body.message).toMatch(/只有第 1 段那么长/);
    expect(destroySpy).toHaveBeenCalled();
  });

  test("② 时长对但没有画面（纯音频/坏产物）→ 判失败，不许发布出去", async () => {
    uploadSpy.mockImplementation(async (_u, opts) => ({
      secure_url: "https://x/y.mp4", public_id: `${opts.folder}/${opts.public_id}`,
      duration: 10.04, bytes: 1000, // 没有 width/height
    }));
    const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    await compose().idle();
    const st = await request(app).get(`/api/branch/compose/${res.body.jobId}`).set(auth());
    expect(st.body.state).toBe("failed");
    expect(st.body.message).toMatch(/没有画面/);
  });

  test("③ 自检失败的话术不再邀请重试（同一份配方重试还是同样结果，且每次都真花钱）", async () => {
    uploadSpy.mockImplementation(async (_u, opts) => ({
      secure_url: "https://x/y.mp4", public_id: `${opts.folder}/${opts.public_id}`,
      duration: 5.04, width: 704, height: 1248, bytes: 100,
    }));
    const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    await compose().idle();
    const st = await request(app).get(`/api/branch/compose/${res.body.jobId}`).set(auth());
    expect(st.body.message).toMatch(/重新剪|同样的结果/);
    expect(st.body.message).not.toMatch(/请重试/);
  });

  test("④ 派发之前就失败（这台服务器没配云存储）→ 不计预算、话术不邀请重试", async () => {
    const VideoComposeModel = require("../src/models/VideoCompose");
    const { cloudinary } = require("../src/config/cloudinary");
    // 真实可发生的那种"永久性失败"：配置缺失。buildSourceUrl 在没有 cloud_name 时返回 null，
    // 服务整句抛出去 —— 重试多少次都是同一个结果，而且一秒编码都没跑过
    const cfg = jest.spyOn(cloudinary, "config").mockReturnValue({});
    try {
      const res = await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
      await compose().idle();
      const st = await request(app).get(`/api/branch/compose/${res.body.jobId}`).set(auth());
      expect(st.body.state).toBe("failed");
      expect(st.body.message).toMatch(/没能开始/);
      expect(st.body.message).not.toMatch(/可以再试一次/);
      expect(uploadSpy).not.toHaveBeenCalled(); // 一秒编码都没跑
      // 预约的额度退回去了：没花的钱不能记在人家账上
      const row = await VideoComposeModel.findOne({ key: res.body.jobId }).lean();
      expect(row.spentSec).toBe(0);
    } finally {
      cfg.mockRestore();
    }
  });

  test("⑤ replace 模式下 BGM 没混上 → done 也要把话带给用户（不能只写日志）", async () => {
    resourceSpy.mockResolvedValue({ duration: 30, public_id: `ideahub/workshop-media/${userId}-777` });
    uploadSpy.mockImplementation(async (_u, opts) => ({
      secure_url: "https://x/y.mp4", public_id: `${opts.folder}/${opts.public_id}`,
      duration: 10.04, width: 704, height: 1248, bytes: 100,
      audio: {}, // ★ Cloudinary 无音轨时回的正是空对象（真值）——旧写法 !receipt.audio 永远为假
    }));
    const res = await request(app).post("/api/branch/compose").set(auth()).send(
      body(userId, {
        audio: { url: `https://res.cloudinary.com/testcloud/video/upload/v1/ideahub/workshop-media/${userId}-777.mp3`, volume: 1, replace: true },
      }),
    );
    await compose().idle();
    const st = await request(app).get(`/api/branch/compose/${res.body.jobId}`).set(auth());
    expect(st.body.state).toBe("done"); // 画面与时长都对，成片能用
    expect(st.body.message).toMatch(/背景音乐没能混进/);
  });
});

describe("★ 变换串注入：public_id 里的 , 与 : 是参数分隔符", () => {
  const { buildComposeTransform } = require("../src/utils/videoCompose");
  const good = { publicId: "ideahub/branch-videos/u-1-seg", startSec: 0, endSec: 5 };

  test.each([
    ["图层段落", { clips: [good, { publicId: "ideahub/branch-videos/x,fl_splice,l_video:ideahub:branch-videos:victim-1-seg", startSec: 0, endSec: 5 }] }],
    ["基片段落", { clips: [{ publicId: "ideahub/branch-videos/x,e_volume:400", startSec: 0, endSec: 5 }] }],
    ["BGM（归属判据对字符集是放行的，注入正是从这儿进）", {
      clips: [good],
      bgm: { publicId: "ideahub/x,fl_splice,l_video:ideahub:branch-videos:victim-1-seg/u-1", durationSec: 30, volume: 1 },
    }],
  ])("%s 带分隔符 → 响亮地抛，绝不拼进变换串", (_label, over) => {
    expect(() => buildComposeTransform({ clips: [good], width: 704, height: 1248, ...over })).toThrow(/不允许的字符/);
  });

  test("正常的 public_id 照旧能用（别把合法字符一起挡了）", () => {
    expect(() =>
      buildComposeTransform({
        clips: [good, { publicId: "ideahub/branch-videos/6993983f-1787213526158-3-cover", startSec: 0, endSec: 2 }],
        width: 704, height: 1248,
      }),
    ).not.toThrow();
  });
});

describe("★ BGM 循环次数不能没有上界", () => {
  const { buildComposeTransform, COMPOSE_LIMITS } = require("../src/utils/videoCompose");

  test("极短 BGM 不会算出天文数字的 e_loop（实测只验到 e_loop:3，没量过的形状不发出去）", () => {
    const t = buildComposeTransform({
      clips: [{ publicId: "ideahub/branch-videos/u-1-seg", startSec: 0, endSec: 300 }],
      width: 704, height: 1248,
      bgm: { publicId: "ideahub/workshop-media/u-9", durationSec: 0.1, volume: 1 },
    });
    const loops = Number(/e_loop:(\d+)/.exec(t)?.[1] ?? 0);
    expect(loops).toBeLessThanOrEqual(COMPOSE_LIMITS.maxBgmLoops);
  });

  test("太短的 BGM 在端点侧整句拒（不悄悄替用户改成别的循环节奏）", async () => {
    resourceSpy.mockResolvedValue({ duration: 1.2, public_id: `ideahub/workshop-media/${userId}-777` });
    const res = await request(app).post("/api/branch/compose").set(auth()).send(
      body(userId, { audio: { url: `https://res.cloudinary.com/testcloud/video/upload/v1/ideahub/workshop-media/${userId}-777.mp3`, volume: 1 } }),
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/太短/);
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});

describe("★ 产物命名要带配方指纹（同毫秒的两发不能互相覆盖）", () => {
  test("不同配方产出不同 public_id", async () => {
    await request(app).post("/api/branch/compose").set(auth()).send(body(userId));
    const b2 = body(userId);
    b2.clips[0].endSec = 4.5;
    await request(app).post("/api/branch/compose").set(auth()).send(b2);
    await compose().idle();
    const ids = uploadSpy.mock.calls.map((c) => c[1].public_id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{24}-\d+-[a-f0-9]{8}-merged$/);
  });
});

describe("背景音乐：端点侧", () => {
  test("BGM 时长只从 Cloudinary 取，循环次数按它算（不收客户端报的数）", async () => {
    resourceSpy.mockResolvedValue({ duration: 8, public_id: `ideahub/workshop-media/${userId}-777` });
    const b = body(userId, {
      audio: { url: `https://res.cloudinary.com/testcloud/video/upload/v1/ideahub/workshop-media/${userId}-777.mp3`, volume: 0.4 },
    });
    const res = await request(app).post("/api/branch/compose").set(auth()).send(b);
    expect(res.status).toBe(202);
    await compose().idle();
    expect(resourceSpy).toHaveBeenCalled();
    const sent = uploadSpy.mock.calls[0][1].raw_transformation;
    expect(sent).toContain("l_audio:ideahub:workshop-media:");
    expect(sent).toContain("e_loop:1"); // ceil(10/8)-1 = 1
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
