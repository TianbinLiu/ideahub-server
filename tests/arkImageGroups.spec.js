// tests/arkImageGroups.spec.js
// 组图（POST/GET /api/ark/image-groups）+ 单张出图那条路的「只出一张」闸（2026-10-05）。
//
// ★ 这几条用例守的都是**钱**，而且都是「拆掉也不报错」的那种：
//   ① 单张出图带上组图 / 图层拆分参数 → 一张的钱换十几张（方舟按实际张数向我们收）；
//   ② 组图按上限预扣之后，没画出来的那几张要退 —— 不退就是多收，退进 addon 就是洗额度；
//   ③ 一张都没拿到要全退；中途断开按拿到手的张数收；进程没了的那一组要有人结掉；
//   ④ 同一个人同时只画一组：并发两发只扣一次。
// ★ 不真的打方舟：fetch 换成假的 SSE 流（事件形状照官方「图片生成流式响应事件」那一页）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let wallet;
let tokens;
let ArkImageGroup;
let fetchSpy;

const MODEL = "doubao-seedream-4-0-250828";
const UNIT = 13_333;

async function registerUser(tag) {
  const name = `ig_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, id: res.body.user._id, auth: { Authorization: `Bearer ${res.body.token}` } };
}

const balance = async (id) => {
  const w = await wallet.getWallet(id);
  return w.plan + w.addon;
};
/** 等余额变成预期值（最多 2 秒）。★ 服务先把这一组原子地改成终态、再结钱（谁改成功谁结，只结一次），
 *  所以查询看到「画完了」的那一拍，退款可能还差几毫秒才到账 —— 直接读会偶发读早 */
async function balanceSettles(id, expected) {
  let last;
  for (let k = 0; k < 100; k++) {
    last = await balance(id);
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  return last;
}

/** 假的 SSE 流：events 按顺序推；遇到 "GATE" 就停下等 release()；遇到 "BREAK" 就让流出错（模拟连接断开） */
function sseResponse(events) {
  const enc = new TextEncoder();
  let i = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const stream = new ReadableStream({
    async pull(c) {
      if (i >= events.length) return c.close();
      const ev = events[i++];
      if (ev === "GATE") {
        await gate;
        return;
      }
      if (ev === "BREAK") return c.error(Object.assign(new Error("socket hang up"), { name: "SocketError" }));
      c.enqueue(enc.encode(`event: ${ev.type || "error"}\ndata: ${JSON.stringify(ev)}\n\n`));
    },
  });
  return { response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }), release };
}
const ok = (i) => ({ type: "image_generation.partial_succeeded", model: MODEL, created: 1, image_index: i, url: `https://ark-content.tos-cn-beijing.volces.com/x/${i}.jpeg`, size: "1440x2560" });
const bad = (i) => ({ type: "image_generation.partial_failed", model: MODEL, created: 1, image_index: i, error: { code: "OutputImageSensitiveContentDetected", message: "The request failed because the output image may contain sensitive information." } });
const done = (n) => ({ type: "image_generation.completed", model: MODEL, created: 1, usage: { generated_images: n, output_tokens: n * 14400, total_tokens: n * 14400 } });

const groupBody = (extra = {}) => ({
  model: MODEL,
  prompt: "生成 6 张连续的电影分镜画面，一张一个镜头",
  image: ["https://res.cloudinary.com/x/a.jpg", "https://res.cloudinary.com/x/b.jpg"],
  size: "1440x2560",
  max_images: 6,
  ...extra,
});

/** 轮询到满足条件（后台在画，最多等 3 秒） */
async function waitGroup(u, id, pred) {
  for (let k = 0; k < 150; k++) {
    const res = await request(app).get(`/api/ark/image-groups/${id}`).set(u.auth);
    if (res.status === 200 && pred(res.body.group)) return res;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等不到这一组达到预期状态：${id}`);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  process.env.ARK_API_KEY = "test-key-not-real";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  wallet = require("../src/services/tokenWallet.service");
  tokens = require("../src/config/tokens");
  ArkImageGroup = require("../src/models/ArkImageGroup");
  await ArkImageGroup.init(); // 部分唯一索引要先建好，「同时只画一组」才有牙齿
});

afterAll(async () => {
  delete process.env.ARK_API_KEY;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => {
    throw new Error("这条用例不该出网");
  });
});
afterEach(() => fetchSpy.mockRestore());

describe("计价：一次出多张按上限算（第二道保险）", () => {
  test("单张 = 单价；组图 = 单价 × max_images（缺省 15）；图层拆分按 17 张", () => {
    expect(tokens.priceOf("image", { model: MODEL })).toBe(UNIT);
    expect(tokens.priceOf("image", { model: MODEL, sequential_image_generation: "disabled" })).toBe(UNIT);
    expect(tokens.priceOf("image", { model: MODEL, sequential_image_generation: "auto", sequential_image_generation_options: { max_images: 6 } })).toBe(6 * UNIT);
    expect(tokens.priceOf("image", { model: MODEL, sequential_image_generation: "auto" })).toBe(15 * UNIT);
    expect(tokens.priceOf("image", { model: MODEL, sequential_image_generation: "auto", sequential_image_generation_options: { max_images: 99 } })).toBe(15 * UNIT);
    expect(tokens.priceOf("image", { model: MODEL, layer_decomposition: true })).toBe(17 * UNIT);
  });

  test("能出组图的模型都在册、都有价；5.0 pro 与老客户端那一档不在里面", () => {
    for (const m of tokens.GROUP_IMAGE_MODELS) expect(tokens.IMAGE_MODELS.has(m)).toBe(true);
    // App 2.63 的九宫格发 4.0 新版本；≤ 2.62 发的老 4.0 / 4.5 也得留着（装机的包改不了）
    for (const m of ["doubao-seedream-4-0-20260415", "doubao-seedream-4-0-250828", "doubao-seedream-4-5-251128"]) {
      expect(tokens.GROUP_IMAGE_MODELS.has(m)).toBe(true);
    }
    expect(tokens.GROUP_IMAGE_MODELS.has("doubao-seedream-5-0-pro-260628")).toBe(false);
    expect(tokens.GROUP_IMAGE_MODELS.has("doubao-seedream-5-0-260128")).toBe(false);
  });
});

describe("单张出图那条路只出一张", () => {
  test.each([
    ["组图 auto", { sequential_image_generation: "auto", sequential_image_generation_options: { max_images: 15 } }],
    ["组图写法不规范", { sequential_image_generation: "Auto" }],
    ["图层拆分", { layer_decomposition: true }],
    ["流式", { stream: true }],
    ["n > 1", { n: 4 }],
    ["联网搜索", { tools: [{ type: "web_search" }] }],
  ])("%s → 400，不出网、不扣费", async (_label, extra) => {
    const u = await registerUser("pin");
    const before = await balance(u.id);
    const res = await request(app)
      .post("/api/ark/images/generations")
      .set(u.auth)
      .send({ model: MODEL, prompt: "x", size: "2K", ...extra })
      .expect(400);
    expect(res.body.code).toBe("IMAGE_PARAMS_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await balance(u.id)).toBe(before);
  });

  test("App 平常发的那几样一个字不拦（照常按一张收）", async () => {
    const u = await registerUser("plain");
    const before = await balance(u.id);
    fetchSpy.mockImplementation(async () => ({ status: 200, text: async () => JSON.stringify({ data: [{ url: "https://x/1.jpeg" }] }) }));
    await request(app)
      .post("/api/ark/images/generations")
      .set(u.auth)
      .send({ model: MODEL, prompt: "x", size: "2K", response_format: "url", watermark: false, image: ["https://x/a.jpg"], sequential_image_generation: "disabled", stream: false })
      .expect(200);
    expect(await balance(u.id)).toBe(before - UNIT);
  });
});

describe("组图：受理 → 后台画 → 按拿到手的张数结算", () => {
  test("参数不对 → 400，不出网、不扣费、不留任务", async () => {
    const u = await registerUser("params");
    const before = await balance(u.id);
    const cases = [
      groupBody({ model: "doubao-seedream-5-0-pro-260628" }),
      groupBody({ model: "doubao-seedream-5-0-260128" }),
      groupBody({ prompt: "  " }),
      groupBody({ max_images: 0 }),
      groupBody({ max_images: 16 }),
      groupBody({ max_images: "6" }),
      groupBody({ max_images: 14 }), // 2 张参考图 + 14 > 15
      groupBody({ image: ["http://insecure/a.jpg"] }),
      groupBody({ size: "huge" }),
    ];
    for (const b of cases) {
      const res = await request(app).post("/api/ark/image-groups").set(u.auth).send(b).expect(400);
      expect(res.body.code).toBe("IMAGE_GROUP_PARAMS");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await balance(u.id)).toBe(before);
    expect(await ArkImageGroup.countDocuments({ userId: u.id })).toBe(0);
  });

  test("没登录 → 401；看不到别人的组；乱写的 id → 404", async () => {
    await request(app).post("/api/ark/image-groups").send(groupBody()).expect(401);
    await request(app).get("/api/ark/image-groups/abc").expect(401);
    const a = await registerUser("own_a");
    const b = await registerUser("own_b");
    const g = await ArkImageGroup.create({ userId: a.id, model: MODEL, maxImages: 2, unitCost: UNIT, status: "done" });
    await request(app).get(`/api/ark/image-groups/${g._id}`).set(b.auth).expect(404);
    await request(app).get("/api/ark/image-groups/not-an-id").set(a.auth).expect(404);
    await request(app).get(`/api/ark/image-groups/${g._id}`).set(a.auth).expect(200);
  });

  test("画出 3 张（第 3 张没过审核）：按上限预扣 6 张，结束退 3 张；发给方舟的是白名单 + 流式", async () => {
    const u = await registerUser("happy");
    const before = await balance(u.id);
    const { response } = sseResponse([ok(0), ok(1), bad(2), ok(3), done(3)]);
    fetchSpy.mockImplementation(async () => response);

    const res = await request(app)
      .post("/api/ark/image-groups")
      .set(u.auth)
      .send(groupBody({ tools: [{ type: "web_search" }], seed: 7 })) // 白名单外的键不许被带出去
      .expect(202);
    expect(res.body).toMatchObject({ ok: true, maxImages: 6, unitCost: UNIT, prepaid: 6 * UNIT });
    expect(res.headers["x-wallet-plan"]).toBeDefined();

    const fin = await waitGroup(u, res.body.id, (g) => g.status !== "running");
    const g = fin.body.group;
    expect(g.status).toBe("done");
    expect(g.images.map((x) => x.index)).toEqual([0, 1, 3]);
    expect(g.failures).toEqual([expect.objectContaining({ index: 2, code: "OutputImageSensitiveContentDetected" })]);
    expect(g).toMatchObject({ generated: 3, charged: 3 * UNIT, prepaid: 6 * UNIT, interrupted: false });
    expect(await balanceSettles(u.id, before - 3 * UNIT)).toBe(before - 3 * UNIT);
    // 结束之后的查询带余额头（退款在后台发生，App 的钱包镜像靠这一趟同步）
    expect(fin.headers["x-wallet-plan"]).toBeDefined();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/images\/generations$/);
    expect(init.headers.Authorization).toBe("Bearer test-key-not-real");
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({
      // 老 4.0（MODEL，≤ 2.62 的九宫格发它）部署即由出口换成 4.0 新版本；价钱、库里记的 model 仍是 MODEL（见 arkImageAlias.spec）
      model: "doubao-seedream-4-0-20260415",
      prompt: groupBody().prompt,
      image: groupBody().image,
      size: "1440x2560",
      watermark: false,
      response_format: "url",
      sequential_image_generation: "auto",
      sequential_image_generation_options: { max_images: 6 },
      stream: true,
    });
  });

  test("边画边看：画好一张就查得到一张（还在 running 时）", async () => {
    const u = await registerUser("progress");
    const { response, release } = sseResponse([ok(0), "GATE", ok(1), done(2)]);
    fetchSpy.mockImplementation(async () => response);
    const res = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody({ max_images: 2 })).expect(202);
    const mid = await waitGroup(u, res.body.id, (g) => g.images.length === 1);
    expect(mid.body.group.status).toBe("running");
    expect(mid.headers["x-wallet-plan"]).toBeUndefined(); // 还在画：余额没变，不多读一次
    release();
    const fin = await waitGroup(u, res.body.id, (g) => g.status === "done");
    expect(fin.body.group.images).toHaveLength(2);
    expect(fin.body.group.charged).toBe(2 * UNIT);
  });

  test("方舟整发拒了（提示词敏感等）→ failed，钱全退", async () => {
    const u = await registerUser("reject");
    const before = await balance(u.id);
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ error: { code: "InputTextSensitiveContentDetected", message: "The request failed because the input text may contain sensitive information." } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody()).expect(202);
    const g = (await waitGroup(u, res.body.id, (x) => x.status !== "running")).body.group;
    expect(g).toMatchObject({ status: "failed", code: "InputTextSensitiveContentDetected", generated: 0, charged: 0 });
    expect(await balanceSettles(u.id, before)).toBe(before);
  });

  test("一张没拿到的全退**按原桶**：预扣从 plan 扣的回 plan（不把当月额度洗进 addon）", async () => {
    const u = await registerUser("bucket");
    await wallet.getWallet(u.id);
    const User = require("../src/models/User");
    // plan 够付整组的预扣（6 × 13,333 = 79,998）：全退之后 plan 回到原数、addon 一分没多
    await User.updateOne({ _id: u.id }, { $set: { "tokenWallet.plan": 100_000, "tokenWallet.addon": 5_000 } });
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ error: { code: "InputTextSensitiveContentDetected", message: "sensitive" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody()).expect(202);
    expect((await ArkImageGroup.findById(res.body.id).lean()).took).toEqual({ plan: 6 * UNIT, addon: 0 });
    await waitGroup(u, res.body.id, (x) => x.status !== "running");
    await balanceSettles(u.id, 105_000);
    const w = await wallet.getWallet(u.id);
    expect({ plan: w.plan, addon: w.addon }).toEqual({ plan: 100_000, addon: 5_000 });
  });

  test("流里只有顶层 error 事件、一张没有 → failed，钱全退", async () => {
    const u = await registerUser("errev");
    const before = await balance(u.id);
    const { response } = sseResponse([{ error: { code: "InternalServiceError", message: "boom" } }]);
    fetchSpy.mockImplementation(async () => response);
    const res = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody()).expect(202);
    const g = (await waitGroup(u, res.body.id, (x) => x.status !== "running")).body.group;
    expect(g).toMatchObject({ status: "failed", code: "InternalServiceError", charged: 0 });
    expect(await balanceSettles(u.id, before)).toBe(before);
  });

  test("画到一半连接断了 → 画到哪张算哪张（interrupted），其余退回", async () => {
    const u = await registerUser("broke");
    const before = await balance(u.id);
    const { response } = sseResponse([ok(0), "BREAK"]);
    fetchSpy.mockImplementation(async () => response);
    const res = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody()).expect(202);
    const g = (await waitGroup(u, res.body.id, (x) => x.status !== "running")).body.group;
    expect(g).toMatchObject({ status: "done", interrupted: true, code: "INTERRUPTED", generated: 1, charged: UNIT });
    expect(await balanceSettles(u.id, before - UNIT)).toBe(before - UNIT);
  });

  test("同一个人同时只画一组：第二发 409，不多扣", async () => {
    const u = await registerUser("busy");
    const before = await balance(u.id);
    const { response, release } = sseResponse(["GATE", ok(0), done(1)]);
    fetchSpy.mockImplementation(async () => response);
    const first = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody({ max_images: 2 })).expect(202);
    const second = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody({ max_images: 2 })).expect(409);
    expect(second.body).toMatchObject({ code: "IMAGE_GROUP_BUSY", id: first.body.id });
    expect(await balance(u.id)).toBe(before - 2 * UNIT);
    release();
    await waitGroup(u, first.body.id, (g) => g.status === "done");
    expect(await balanceSettles(u.id, before - UNIT)).toBe(before - UNIT);
  });

  test("余额不够 → 402，不出网、不留任务（下一组照样能开）", async () => {
    const u = await registerUser("poor");
    const User = require("../src/models/User");
    await wallet.getWallet(u.id);
    await User.updateOne({ _id: u.id }, { $set: { "tokenWallet.plan": 1000, "tokenWallet.addon": 0 } });
    const res = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody()).expect(402);
    expect(res.body.code).toBe("INSUFFICIENT_TOKENS");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await ArkImageGroup.countDocuments({ userId: u.id })).toBe(0);
  });

  test("跑它的进程没了（一直 running）→ 懒回收按已写进库的张数结掉、退差价", async () => {
    const u = await registerUser("stale");
    const prepaid = 4 * UNIT;
    await wallet.debit(u.id, prepaid, `image ${MODEL} 组图×4`);
    const before = await balance(u.id);
    const g = await ArkImageGroup.create({
      userId: u.id,
      model: MODEL,
      maxImages: 4,
      unitCost: UNIT,
      prepaid,
      images: [{ index: 0, url: "https://x/0.jpeg" }],
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    const res = await request(app).get(`/api/ark/image-groups/${g._id}`).set(u.auth).expect(200);
    expect(res.body.group).toMatchObject({ status: "done", interrupted: true, generated: 1, charged: UNIT });
    expect(await balance(u.id)).toBe(before + 3 * UNIT);
    // 再查一次不会再退一次（只结一次）
    await request(app).get(`/api/ark/image-groups/${g._id}`).set(u.auth).expect(200);
    expect(await balance(u.id)).toBe(before + 3 * UNIT);
  });

  test("最近的几组能列出来（App 丢了任务号时接回来）；健康端点报能力位", async () => {
    const u = await registerUser("list");
    await ArkImageGroup.create({ userId: u.id, model: MODEL, maxImages: 2, unitCost: UNIT, status: "done", images: [{ index: 0, url: "https://x/0.jpeg" }] });
    const res = await request(app).get("/api/ark/image-groups").set(u.auth).expect(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toMatchObject({ status: "done", maxImages: 2, images: [{ index: 0, url: "https://x/0.jpeg" }] });
    const h = await request(app).get("/api/ark/health").expect(200);
    expect(h.body).toMatchObject({ ok: true, imageGroups: true });
  });
});

describe("SSE 解析", () => {
  const { sseData } = require("../src/services/arkImageGroup.service");
  const streamOf = (chunks) => {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
  };
  const collect = async (chunks) => {
    const out = [];
    for await (const d of sseData(streamOf(chunks))) out.push(d);
    return out;
  };

  test("一条事件拆在两个 chunk 里、一个 chunk 里好几条、\\r\\n 换行、末尾没有空行，都能切对", async () => {
    expect(await collect(['event: a\ndata: {"x":', '1}\n\ndata: {"y":2}\r\n\r\ndata: {"z":3}'])).toEqual(['{"x":1}', '{"y":2}', '{"z":3}']);
  });
  test("注释行、event 行忽略；[DONE] 原样交出去", async () => {
    expect(await collect([": ping\n\nevent: x\ndata: [DONE]\n\n"])).toEqual(["[DONE]"]);
  });
});
