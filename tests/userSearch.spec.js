// tests/userSearch.spec.js
// 覆盖：GET /api/users/search —— @提及选人 / 找人用的搜索。
//
// ★ 盯的是三个【做错了不报错】的问题：
//   S1 只按 username 匹配 → 用户搜自己**每天看到的那个名字**（displayName）一个人都搜不到，
//      而接口返回 200 + users: []，看起来就是"这个人不存在"。
//   S2 回包只有 _id/username → 客户端画不出头像和显示名，只能退成一串字母底 + 注册名。
//   S3 不排序 → 输入一个完整用户名时，本人可能排在第七位。@提及选人时选中的是 userId，
//      顺序错就是**@ 错人**，而且完全不报错。
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

let seq = 0;
async function registerUser(nameOverride) {
  seq += 1;
  const name = nameOverride || `us${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name.toLowerCase()}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id), username: name };
}

async function setProfile(token, patch) {
  await request(app)
    .put("/api/me/profile")
    .set("Authorization", `Bearer ${token}`)
    .send(patch)
    .expect(200);
}

function search(q, extra = "") {
  return request(app).get(`/api/users/search?q=${encodeURIComponent(q)}${extra}`);
}

describe("用户搜索", () => {
  test("S1/S2 按 displayName 也能搜到，且回包带 displayName 与 avatarUrl", async () => {
    const u = await registerUser();
    // 用户名和显示名故意毫无字面关系：只按 username 匹配的实现在这里必然空手而归
    await setProfile(u.token, {
      displayName: "李小明",
      avatarUrl: "https://cdn.example.com/avatar-lxm.png",
    });

    const res = await search("李小明").expect(200);
    // 响应键必须还叫 users（官网客户端读的就是它）
    expect(Array.isArray(res.body.users)).toBe(true);

    const hit = res.body.users.find((x) => String(x._id) === u.userId);
    expect(hit).toBeTruthy();
    // ★ 老键一个都不能少（官网客户端读 u.username），新键必须真的有值
    expect(hit.username).toBe(u.username);
    expect(hit.displayName).toBe("李小明");
    expect(hit.avatarUrl).toBe("https://cdn.example.com/avatar-lxm.png");

    // 显示名的中间一段也要搜得到（找人是"看见了就点"，不是必须从头打对）
    const mid = await search("小明").expect(200);
    expect(mid.body.users.map((x) => String(x._id))).toContain(u.userId);
  });

  test("S3 输全用户名时本人排第一：前缀/子串、以及冒名的 displayName 都压不过它", async () => {
    const suffix = `${seq}${Date.now().toString(36)}`;
    const target = `bob_${suffix}`;

    // ★ 干扰项**先注册**：不排序的话它们会按自然序排在真身前面
    const substring = await registerUser(`zz${target}`); // 用户名里含 target → 子串档
    const impostor = await registerUser(); // displayName 冒充成 target → 显示名档
    await setProfile(impostor.token, { displayName: target });
    const real = await registerUser(target); // 用户名精确等于 target

    const res = await search(target).expect(200);
    const ids = res.body.users.map((x) => String(x._id));

    expect(ids[0]).toBe(real.userId);
    // ★ username 精确 > displayName 精确：displayName 谁都能改成别人的用户名，
    //   让它压过真身就是一条现成的冒名路径
    expect(ids.indexOf(real.userId)).toBeLessThan(ids.indexOf(impostor.userId));
    expect(ids.indexOf(real.userId)).toBeLessThan(ids.indexOf(substring.userId));
  });

  test("S4 limit 夹取仍然生效，空 q 返回空列表", async () => {
    const prefix = `lim${seq}${Date.now().toString(36)}`;
    for (let i = 0; i < 4; i += 1) await registerUser(`${prefix}_${i}`);

    const two = await search(prefix, "&limit=2").expect(200);
    expect(two.body.users).toHaveLength(2);

    // 上限 20：给个离谱的值也不该把整张表倒出来
    const huge = await search(prefix, "&limit=9999").expect(200);
    expect(huge.body.users.length).toBeLessThanOrEqual(20);

    expect((await search("").expect(200)).body.users).toEqual([]);
    expect((await search("   ").expect(200)).body.users).toEqual([]);
  });

  test("S6 精确命中永远在候选集里：干扰项多到把模糊那一页塞满也要能搜到本人", async () => {
    // ★ 这条盯的是一个**只在库大了以后才出现**的静默 bug：
    //   模糊查询上的 .limit(fetchLimit) 是 mongod **先夹**、searchRank 在 Node 里**后排**，
    //   所以排序看到的只是自然序里随手截的一段。干扰项超过 fetchLimit(=limit*5，默认 40) 时，
    //   真身可能压根没被取回来 —— 用户把朋友的完整用户名一字不差打进去，
    //   搜出来的是一屏陌生人，而且没有任何"结果被截断了"的提示。
    const User = require("../src/models/User");
    const suffix = `${seq}${Date.now().toString(36)}`;
    const target = `bob${suffix}`;

    // ★ 干扰项**先建**，且数量要**超过 fetchLimit**（默认 limit=8 → 40 条），
    //   这样自然序里前 40 条全是干扰项，真身必然落在窗口外。
    //   直接建库（不走注册接口）：这里要的是"库里有很多条"，不是"注册流程对不对"，
    //   41 次 bcrypt 只会让这条用例慢十几秒。
    const distractors = [];
    for (let i = 0; i < 45; i += 1) {
      distractors.push({
        username: `zz${target}_${i}`,
        email: `zz${target}_${i}@test.local`,
        passwordHash: "hashed",
      });
    }
    await User.insertMany(distractors);

    // 真身最后建 → 自然序排在 45 个干扰项后面
    const real = await User.create({
      username: target,
      email: `${target}@test.local`,
      passwordHash: "hashed",
    });
    // 显示名精确等于查询词的人，同样埋在窗口外（app 里满屏显示的就是 displayName，
    // 用户照着屏幕上的名字搜，搜不到同样是"这个人不存在"）
    const byDisplay = await User.create({
      username: `dn${suffix}`,
      email: `dn${suffix}@test.local`,
      passwordHash: "hashed",
      displayName: target,
    });

    const res = await search(target).expect(200);
    const ids = res.body.users.map((x) => String(x._id));
    // ★ 找不到它 = 用户永远联系不上这个朋友，且界面上看起来像"查无此人"
    expect(ids).toContain(String(real._id));
    expect(ids[0]).toBe(String(real._id));
    // 精确的 displayName 也要越过截断（但排在 username 精确之后：displayName 谁都能改）
    expect(ids).toContain(String(byDisplay._id));
    expect(ids.indexOf(String(real._id))).toBeLessThan(ids.indexOf(String(byDisplay._id)));

    // 合并不能产生重复：精确那条查回来的人也在模糊结果里时只出现一次
    expect(new Set(ids).size).toBe(ids.length);
  }, 30000);

  test("S7 一群冒名者把昵称改成你的账号名，也挤不掉账号真的叫这个名字的人", async () => {
    // 盯的是"精确档取回来的那一页会不会被 displayName 冒名者占满"。
    //
    // ⚠ 诚实标注：这条用例**抓不住**它对应的那次改动。把实现换回原来的
    //   `$or: [{username: raw}, {displayName: raw}]` + .limit(limit) 之后本用例照样绿
    //   （实测过）—— 因为 username 上有唯一索引与 ci 索引，`$or` 会走索引并集，
    //   username 等值那一支几乎必然把真身带回来。也就是说原写法在**当前的执行计划下**
    //   并不真的漏人。
    //   保留它的理由是它盯的是**性质**而不是那次改动：真身必须排第一、且不依赖
    //   mongod 选了哪个计划。现在的实现（username 单发一条 findOne）把这件事从
    //   "计划碰巧对"变成"结构上保证"，这条用例就是那个保证的锚点。
    const User = require("../src/models/User");
    const suffix = `${seq}${Date.now().toString(36)}`;
    const target = `carol${suffix}`;

    // ★ 两个窗口都要撑破，缺一条这用例就抓不到 bug：
    //   ① 精确档那一页（limit，默认 8）—— 用 ≥8 个 displayName 冒名者占满；
    //   ② 模糊档那一页（fetchLimit = limit*5，默认 40）—— 否则真身还是会从模糊那条路
    //      被捞回来，用例照样绿，等于什么都没盯住。
    //   两批都**先建**，真身最后建，这样自然序里真身落在两个窗口之外。
    const fillers = [];
    for (let i = 0; i < 12; i += 1) {
      fillers.push({
        username: `imp${suffix}_${i}`,
        email: `imp${suffix}_${i}@test.local`,
        passwordHash: "hashed",
        displayName: target, // 昵称不唯一，谁都能改成这个
      });
    }
    for (let i = 0; i < 45; i += 1) {
      fillers.push({
        username: `zz${target}_${i}`, // 含 target 子串 → 落进模糊结果，把那一页也撑破
        email: `zz${target}_${i}@test.local`,
        passwordHash: "hashed",
      });
    }
    await User.insertMany(fillers);

    // 真身最后建：自然序排在 12 个冒名者之后
    const real = await User.create({
      username: target,
      email: `${target}@test.local`,
      passwordHash: "hashed",
    });

    const res = await search(target).expect(200);
    const ids = res.body.users.map((x) => String(x._id));
    expect(ids).toContain(String(real._id));
    // 账号名是唯一的、改不了的；昵称谁都能抄。所以真身必须排第一
    expect(ids[0]).toBe(String(real._id));
  }, 30000);

  test("S5 用户输入不构造正则：ReDoS 载荷只能匹配它自己的字面量", async () => {
    // 转义失效的实现会把它变成 new RegExp("(a+)+$") 交给 mongod 执行
    const res = await search("(a+)+$").expect(200);
    expect(res.body.users).toEqual([]);
  });
});
