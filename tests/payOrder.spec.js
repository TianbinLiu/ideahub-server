// tests/payOrder.spec.js
// 覆盖：充值订单 + 支付回调结算。
//
// ★ 盯的是 services/payment/order.service.js 文件头那三条不变量。三条都属于
//   「做错了不报错、只会多发或少发 token」，也就是只有用例能看见的那类错：
//     O1 一笔订单只发一次币（重复回调、并发回调都不能多发）
//     O2 金额以订单快照为准，回调体里的商品信息一概不信；实付不足不发币
//     O3 未注册的渠道一律拒绝（没有 adapter 就没有验签）
//
// ★ 本文件必须自己打开 PAY_ALLOW_MOCK：默认是关的（生产环境开着会被自检拒绝启动），
//   关着的时候一个渠道都没注册，回调根本进不来，这套用例也就无从测起。
//   注意要在 require("../src/app") **之前**设，channels.js 在模块加载时就读了它。
process.env.PAY_ALLOW_MOCK = "1";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let TokenOrder;
let User;
let orders;

const FREE = 300_000;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  TokenOrder = require("../src/models/TokenOrder");
  User = require("../src/models/User");
  orders = require("../src/services/payment/order.service");
});

afterAll(async () => {
  delete process.env.PAY_ALLOW_MOCK;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `pay${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

/** 余额（plan + addon）。先 GET 一次钱包，顺带完成初始化 */
async function balanceOf(token) {
  const r = await request(app).get("/api/me/wallet").set("Authorization", `Bearer ${token}`).expect(200);
  return Number(r.body.wallet.plan || 0) + Number(r.body.wallet.addon || 0);
}

function order(token, body) {
  return request(app).post("/api/pay/orders").set("Authorization", `Bearer ${token}`).send(body);
}

describe("下单", () => {
  test("直充包：只收在册面额，金额按目录快照进订单", async () => {
    const u = await registerUser();
    const res = await order(u.token, { kind: "recharge", tokens: 1_000_000 }).expect(201);
    expect(res.body.order.kind).toBe("recharge");
    expect(res.body.order.packTokens).toBe(1_000_000);
    expect(res.body.order.amountFen).toBe(2500); // ¥25，与 app 的 RECHARGE_PACKS 对齐
    expect(res.body.order.status).toBe("created");
    expect(res.body.order.orderNo).toMatch(/^IH\d{14}[0-9a-f]{18}$/);

    // 不在册的数字一律 400 ——「充 999999999」不能是一句话的事
    await order(u.token, { kind: "recharge", tokens: 999_999_999 }).expect(400);
    await order(u.token, { kind: "recharge", tokens: 1 }).expect(400);
  });

  test("套餐：unknown planId 400；免费档不生成订单", async () => {
    const u = await registerUser();
    const res = await order(u.token, { kind: "plan", planId: "std" }).expect(201);
    expect(res.body.order.amountFen).toBe(3000); // 30 元

    await order(u.token, { kind: "plan", planId: "nope" }).expect(400);
    await order(u.token, { kind: "plan", planId: "free" }).expect(400);
  });

  test("下单本身不发币 —— 余额一分不动", async () => {
    const u = await registerUser();
    expect(await balanceOf(u.token)).toBe(FREE);
    await order(u.token, { kind: "recharge", tokens: 5_000_000 }).expect(201);
    expect(await balanceOf(u.token)).toBe(FREE);
  });

  test("未登录不能下单", async () => {
    await request(app).post("/api/pay/orders").send({ kind: "recharge", tokens: 200_000 }).expect(401);
  });
});

describe("回调结算", () => {
  async function paidCallback(orderNo, over = {}) {
    const o = await TokenOrder.findOne({ orderNo });
    return request(app)
      .post("/api/pay/callback/mock")
      .send({ orderNo, channelTxnId: `txn_${orderNo}`, paidFen: o.amountFen, ...over });
  }

  test("正常一次：发币、订单转 settled、流水记得住订单号", async () => {
    const u = await registerUser();
    await balanceOf(u.token); // 先初始化钱包
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 1_000_000 })).body.order.orderNo;

    expect((await paidCallback(orderNo)).status).toBe(200);

    expect(await balanceOf(u.token)).toBe(FREE + 1_000_000);
    const o = await TokenOrder.findOne({ orderNo });
    expect(o.status).toBe("settled");
    expect(o.grantedTokens).toBe(1_000_000);
    expect(o.settledAt).toBeTruthy();

    const led = await request(app)
      .get("/api/me/wallet/ledger")
      .set("Authorization", `Bearer ${u.token}`)
      .expect(200);
    const entry = led.body.items.find((x) => x.reason === "recharge");
    expect(entry.memo).toContain(orderNo);
  });

  test("O1 重复回调只发一次币（渠道重推是常态，必须回 ok 否则它会一直推）", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 200_000 })).body.order.orderNo;

    expect((await paidCallback(orderNo)).status).toBe(200);
    const after1 = await balanceOf(u.token);

    for (let i = 0; i < 4; i++) expect((await paidCallback(orderNo)).status).toBe(200);
    expect(await balanceOf(u.token)).toBe(after1);
    expect(after1).toBe(FREE + 200_000);
  });

  test("O1 并发回调只发一次币", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 200_000 })).body.order.orderNo;

    // 10 条同时打进来：抢 settledAt 的条件更新只能成功一次
    await Promise.all(Array.from({ length: 10 }, () => paidCallback(orderNo)));

    expect(await balanceOf(u.token)).toBe(FREE + 200_000);
    const o = await TokenOrder.findOne({ orderNo });
    expect(o.grantedTokens).toBe(200_000);
  });

  test("O2 实付少于应付：不发币，订单转 failed", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 1_000_000 })).body.order.orderNo;

    expect((await paidCallback(orderNo, { paidFen: 1 })).status).toBe(400);

    expect(await balanceOf(u.token)).toBe(FREE);
    const o = await TokenOrder.findOne({ orderNo });
    expect(o.status).toBe("failed");
    expect(o.settledAt).toBeNull();
  });

  test("O2 回调里夹带商品信息不作数：发的是【订单快照】里的量", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 200_000 })).body.order.orderNo;

    // 回调体里塞一个大额度和一个大金额，看服务端信不信
    expect((await paidCallback(orderNo, { packTokens: 99_000_000, tokens: 99_000_000, amountFen: 1 })).status).toBe(200);

    expect(await balanceOf(u.token)).toBe(FREE + 200_000);
  });

  test("O3 未注册的渠道一律 400，绝不当成功处理", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 5_000_000 })).body.order.orderNo;

    const o = await TokenOrder.findOne({ orderNo });
    await request(app)
      .post("/api/pay/callback/wechat") // 没接的渠道
      .send({ orderNo, channelTxnId: "x", paidFen: o.amountFen })
      .expect(400);
    await request(app)
      .post("/api/pay/callback/")
      .send({ orderNo, paidFen: o.amountFen })
      .expect(404); // 空渠道名连路由都不匹配

    expect(await balanceOf(u.token)).toBe(FREE);
  });

  test("不存在的订单号不炸也不发币", async () => {
    await request(app)
      .post("/api/pay/callback/mock")
      .send({ orderNo: "IH00000000000000deadbeefdeadbeefdead", channelTxnId: "t", paidFen: 100 })
      .expect(400);
  });

  test("渠道回报失败：订单转 failed，不发币", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 200_000 })).body.order.orderNo;

    expect((await paidCallback(orderNo, { failed: true })).status).toBe(200);
    expect(await balanceOf(u.token)).toBe(FREE);
    expect((await TokenOrder.findOne({ orderNo })).status).toBe("failed");
  });

  test("套餐订单结算后 plan 额度到账", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "plan", planId: "std" })).body.order.orderNo;

    expect((await paidCallback(orderNo)).status).toBe(200);

    const r = await request(app).get("/api/me/wallet").set("Authorization", `Bearer ${u.token}`).expect(200);
    expect(r.body.wallet.planId).toBe("std");
    // ★ 是 FREE + 2M 而不是 2M：buyPlan 用的是 $inc，买套餐**叠加**在没花完的额度上，
    //   不没收用户已有的余额（tokenWallet.service 的既定口径，那边也有用例）
    expect(r.body.wallet.plan).toBe(FREE + 2_000_000);
    expect((await TokenOrder.findOne({ orderNo })).status).toBe("settled");
  });

  test("已关闭的订单不再接受结算", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 200_000 })).body.order.orderNo;

    await request(app)
      .post(`/api/pay/orders/${orderNo}/close`)
      .set("Authorization", `Bearer ${u.token}`)
      .expect(200);

    expect((await paidCallback(orderNo)).status).toBe(400);
    expect(await balanceOf(u.token)).toBe(FREE);
  });

  test("超时的订单不再接受结算", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 200_000 })).body.order.orderNo;

    // 把创建时间推回两小时前（默认 TTL 30 分钟）
    await TokenOrder.collection.updateOne(
      { orderNo },
      { $set: { createdAt: new Date(Date.now() - 2 * 3600_000) } }
    );
    expect(orders.isExpired(await TokenOrder.findOne({ orderNo }))).toBe(true);

    expect((await paidCallback(orderNo)).status).toBe(400);
    expect(await balanceOf(u.token)).toBe(FREE);
  });
});

describe("老的钱包路径不再发币", () => {
  test("POST /api/me/wallet/recharge 返回 202 + 订单，余额不动", async () => {
    const u = await registerUser();
    expect(await balanceOf(u.token)).toBe(FREE);

    const res = await request(app)
      .post("/api/me/wallet/recharge")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ tokens: 5_000_000 })
      .expect(202); // ★ 不是 200：请求收下了，但余额还没变

    expect(res.body.order.orderNo).toBeTruthy();
    expect(res.body.order.status).toBe("created");
    expect(await balanceOf(u.token)).toBe(FREE);
  });

  test("POST /api/me/wallet/plan 同样只下单", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const res = await request(app)
      .post("/api/me/wallet/plan")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ planId: "pro" })
      .expect(202);
    expect(res.body.order.planId).toBe("pro");

    const r = await request(app).get("/api/me/wallet").set("Authorization", `Bearer ${u.token}`).expect(200);
    expect(r.body.wallet.planId).not.toBe("pro"); // 没付款就不该生效
  });

  test("刷 100 次也刷不出额度（这正是改成订单要堵的洞）", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    for (let i = 0; i < 15; i++) {
      await request(app)
        .post("/api/me/wallet/recharge")
        .set("Authorization", `Bearer ${u.token}`)
        .send({ tokens: 5_000_000 });
    }
    expect(await balanceOf(u.token)).toBe(FREE);
  });
});

describe("查单", () => {
  test("只能查自己的订单", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const orderNo = (await order(a.token, { kind: "recharge", tokens: 200_000 })).body.order.orderNo;

    await request(app)
      .get(`/api/pay/orders/${orderNo}`)
      .set("Authorization", `Bearer ${a.token}`)
      .expect(200);
    await request(app)
      .get(`/api/pay/orders/${orderNo}`)
      .set("Authorization", `Bearer ${b.token}`)
      .expect(404);
  });

  test("订单视图不外泄回调原文", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const orderNo = (await order(u.token, { kind: "recharge", tokens: 200_000 })).body.order.orderNo;
    const o = await TokenOrder.findOne({ orderNo });
    await request(app)
      .post("/api/pay/callback/mock")
      .send({ orderNo, channelTxnId: "t", paidFen: o.amountFen, secretFromChannel: "不该出现在响应里" });

    const res = await request(app)
      .get(`/api/pay/orders/${orderNo}`)
      .set("Authorization", `Bearer ${u.token}`)
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain("不该出现在响应里");
    expect(res.body.order.raw).toBeUndefined();
  });

  test("GET /api/pay/config 告诉客户端有没有可用渠道", async () => {
    const res = await request(app).get("/api/pay/config").expect(200);
    expect(res.body.payable).toBe(true); // 本套用例开了 mock
    expect(res.body.channels).toContain("mock");
    expect(res.body.packs.length).toBe(3);
  });
});

describe("生产配置自检", () => {
  test("PAY_ALLOW_MOCK 在生产环境会被拒绝", () => {
    const { collectPaymentProblems } = require("../src/config/payment");
    expect(collectPaymentProblems({ PAY_ALLOW_MOCK: "1", NODE_ENV: "production" })).toHaveLength(1);
    expect(collectPaymentProblems({ PAY_ALLOW_MOCK: "1", NODE_ENV: "development" })).toHaveLength(0);
    expect(collectPaymentProblems({ NODE_ENV: "production" })).toHaveLength(0);
  });
});

describe("跨仓价目一致性", () => {
  // ★ app 的 economy.ts 是【报价】（按下按钮前给用户看的），这边是【结算】（真扣钱的）。
  //   对不上就是"页面写 ¥25、扣了 ¥15"。两仓不在一个 CI 里，只能把 app 那份的数
  //   抄一遍钉在这里 —— 改价时这条会红，提醒你另一边也要改。
  const APP_RECHARGE_PACKS = [
    { tokens: 200_000, price: 6 },
    { tokens: 1_000_000, price: 25 },
    { tokens: 5_000_000, price: 98 },
  ];
  const APP_PLANS = [
    { id: "free", price: 0, monthlyTokens: 300_000 },
    { id: "std", price: 30, monthlyTokens: 2_000_000 },
    { id: "pro", price: 98, monthlyTokens: 8_000_000 },
  ];

  test("直充包的价与 app/src/data/economy.ts 逐条相等", () => {
    expect(orders.RECHARGE_PACKS).toEqual(
      APP_RECHARGE_PACKS.map((p) => ({ tokens: p.tokens, amountFen: p.price * 100 }))
    );
  });

  test("套餐的价与月额度与 app 一致", () => {
    const { PLANS } = require("../src/config/tokens");
    expect(PLANS.map((p) => ({ id: p.id, price: p.price, monthlyTokens: p.monthlyTokens }))).toEqual(APP_PLANS);
  });
});
