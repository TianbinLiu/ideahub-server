// tests/minimaxV2Price.spec.js
// 覆盖：MiniMax H3（国际站 V2 出片）的按秒价目与免费档 —— config/tokens.js 的纯函数，不连库、不出网。
//
// ★ 为什么单独一份：这几条规则的共同点是「错了不报错」——
//   ① priceOf 不认 kind "minimax_v2" 就落到函数末尾的 `return 0`：一条免费出片的链路；
//   ② 免费档按 (模型, 上游分辨率) 认，大小写差一个字母就是「免费用户看见灰键 / 付费档被当成免费」；
//   ③ 第 6 张图、输入视频这些表外的东西，上游另收钱 —— 报价当成 5 张以内就是少收；
//   ④ 档名按家族起（Seedance 草稿与 MiniMax 草稿同名），拒绝话里不去重就说成「草稿」「草稿」。
// 与 App 报价逐条相等的那一半在 tests/arkProxy.spec.js「跨仓 MiniMax H3 价目」。

const T = require("../src/config/tokens");

const LITE = "MiniMax-H3-Lite";
const HS = "MiniMax-H3-Highspeed";
const H3 = "MiniMax-H3";
const text = { type: "text", text: "a cat walks" };
const img = (role) => ({ type: "image_url", image_url: { url: "https://res.cloudinary.com/x/image/upload/a.png" }, role });
const body = (o = {}) => ({ model: LITE, resolution: "480P", duration: 5, content: [text], ...o });

describe("minimaxSecCost / minimaxV2Tokens：报得出价的才有价，表外一律 null（不是 0）", () => {
  test("三格有价，按上游原样的大写分辨率认", () => {
    expect(T.minimaxSecCost(LITE, "480P")).toBe(11_200);
    expect(T.minimaxSecCost(HS, "768P")).toBe(26_900);
    expect(T.minimaxSecCost(H3, "768P")).toBe(35_800);
    // 小写是 App 档位表那格「只为每行都写」的 resolution，不是上游写法：认了就是同一条规则的第二种写法
    expect(T.minimaxSecCost(LITE, "480p")).toBeNull();
  });

  test("没开的格子没有价：H3-Lite 768P、H3 2K、H3-Max、v1 海螺都不在这张表里", () => {
    expect(T.minimaxSecCost(LITE, "768P")).toBeNull();
    expect(T.minimaxSecCost(H3, "2K")).toBeNull();
    expect(T.minimaxSecCost(HS, "480P")).toBeNull();
    expect(T.minimaxSecCost("MiniMax-H3-Max", "768P")).toBeNull();
    expect(T.minimaxSecCost("MiniMax-Hailuo-2.3-Fast", "768P")).toBeNull();
    expect(T.minimaxSecCost(undefined, undefined)).toBeNull();
  });

  test("用户可控字符串查表不顺原型链", () => {
    expect(T.minimaxSecCost("constructor", "480P")).toBeNull();
    expect(T.minimaxSecCost(LITE, "constructor")).toBeNull();
    expect(T.minimaxSecCost("__proto__", "toString")).toBeNull();
    expect(T.minimaxV2Tokens(body({ model: "constructor" }))).toBeNull();
  });

  test("时长：只认 number 类型、窗口 4~15 内的整数（不取整、不夹窗）", () => {
    expect(T.minimaxV2Tokens(body({ duration: 4 }))).toBe(4 * 11_200);
    expect(T.minimaxV2Tokens(body({ duration: 15 }))).toBe(15 * 11_200);
    for (const d of [3, 16, 0, -5, 5.5, "5", null, undefined, NaN, Infinity, true]) {
      expect({ d: String(d), cost: T.minimaxV2Tokens(body({ duration: d })) }).toEqual({ d: String(d), cost: null });
    }
  });

  test("图：首帧 + 尾帧 + 参考图合计 ≤ 5 张都不另收；第 6 张起报不了价", () => {
    const refs = (n) => Array.from({ length: n }, () => img("reference_image"));
    expect(T.minimaxV2Tokens(body({ content: [text, img("first_frame")] }))).toBe(5 * 11_200);
    expect(T.minimaxV2Tokens(body({ content: [text, img("last_frame")] }))).toBe(5 * 11_200);
    expect(T.minimaxV2Tokens(body({ content: [text, ...refs(5)] }))).toBe(5 * 11_200);
    expect(T.minimaxV2Tokens(body({ content: [text, ...refs(6)] }))).toBeNull();
  });

  test("输入视频 / 音频 / 认不出的条目：上游另收钱，这张表报不了价", () => {
    expect(T.minimaxV2Tokens(body({ content: [text, { type: "video_url", video_url: { url: "https://x/v.mp4" } }] }))).toBeNull();
    expect(T.minimaxV2Tokens(body({ content: [text, { type: "audio_url", audio_url: { url: "https://x/a.mp3" } }] }))).toBeNull();
    expect(T.minimaxV2Tokens(body({ content: [text, "image_url"] }))).toBeNull();
    expect(T.minimaxV2Tokens(body({ content: [text, null] }))).toBeNull();
    expect(T.minimaxV2Tokens(body({ content: "a cat" }))).toBeNull();
    // content 缺省按纯文字算价（必须带 text 是路由的事，这里只回答值多少钱）
    expect(T.minimaxV2Tokens(body({ content: undefined }))).toBe(5 * 11_200);
  });
});

// 2026-10-26 审核：价钱原来只看 model / resolution / duration 与条目的 type —— 带着 callback_url（MiniMax 把任务数据 POST 到调用方
// 指定的地址）、顶层 first_frame_image（第 6 张图）、条目上挂的 video_url（输入视频另收）的请求照样报得出价。
// 现在名单外的键一律报不了价（MINIMAX_V2_BODY_KEYS / ITEM_KEYS / IMAGE_KEYS，判否定）。
describe("字段名单：名单外的键一律报不了价（价钱答不出「带着没估过价的东西值多少」）", () => {
  const ffImg = img("first_frame");

  test("名单本身：顶层五个键、text 条目两个、image_url 条目三个、image_url 对象只有 url（多放一个都要有人点头，两仓一起改）", () => {
    expect([...T.MINIMAX_V2_BODY_KEYS].sort()).toEqual(["content", "duration", "model", "ratio", "resolution"]);
    expect(T.MINIMAX_V2_ITEM_KEYS).toEqual({ text: ["type", "text"], image_url: ["type", "image_url", "role"] });
    expect(T.MINIMAX_V2_IMAGE_KEYS).toEqual(["url"]);
    expect(Object.isFrozen(T.MINIMAX_V2_BODY_KEYS) && Object.isFrozen(T.MINIMAX_V2_ITEM_KEYS) && Object.isFrozen(T.MINIMAX_V2_ITEM_KEYS.text)).toBe(true);
  });

  test("名单里的键齐全的请求照常报价（ratio 在名单里、不进价；首帧条目带 role）", () => {
    expect(T.minimaxV2Tokens(body({ ratio: "9:16", content: [text, ffImg] }))).toBe(5 * 11_200);
    expect(T.minimaxV2Tokens(body({ content: [text, { type: "image_url", image_url: { url: "https://x/a.png" } }] }))).toBe(5 * 11_200);
  });

  test.each([
    ["callback_url（上游会把任务数据 POST 到这个地址）", { callback_url: "https://evil.example/hook" }],
    ["顶层 first_frame_image（v1 的写法；名单外的第 6 张图）", { first_frame_image: "https://x/a.png" }],
    ["extra（H3-Max 的提示词扩写）", { extra: { prompt_expansion_mode: "quality" } }],
    ["prompt_optimizer", { prompt_optimizer: true }],
    ["没见过的计数 / 质量参数", { n: 4 }],
    ["顶层 __proto__（JSON.parse 出来的自有键）", JSON.parse('{"__proto__": {"x": 1}}')],
  ])("顶层多一个 %s → null", (_label, extra) => {
    expect(T.minimaxV2Tokens({ ...body(), ...extra })).toBeNull();
  });

  test.each([
    ["text 条目挂着 video_url", { type: "text", text: "x", video_url: { url: "https://x/v.mp4" } }],
    ["text 条目挂着 image_url", { type: "text", text: "x", image_url: { url: "https://x/a.png" } }],
    ["image_url 条目里又塞一个 video_url", { type: "image_url", image_url: { url: "https://x/a.png" }, video_url: { url: "https://x/v.mp4" } }],
    ["image_url 条目挂着 audio_url", { type: "image_url", image_url: { url: "https://x/a.png" }, role: "reference_image", audio_url: { url: "https://x/a.mp3" } }],
    ["image_url 对象里多一个键", { type: "image_url", image_url: { url: "https://x/a.png", detail: "high" } }],
    ["image_url 条目没有 image_url 对象", { type: "image_url", role: "first_frame" }],
    ["image_url 是字符串不是对象", { type: "image_url", image_url: "https://x/a.png" }],
    ["条目 type 是 constructor（原型链上的名字）", { type: "constructor" }],
  ])("条目上 %s → null", (_label, item) => {
    expect(T.minimaxV2Tokens(body({ content: [text, item] }))).toBeNull();
  });

  test("值是 undefined 的键不算（JSON.stringify 会丢、发不到上游）", () => {
    expect(T.minimaxV2Tokens({ ...body(), callback_url: undefined, ratio: undefined })).toBe(5 * 11_200);
    expect(T.minimaxV2Tokens(body({ content: [{ ...text, video_url: undefined }] }))).toBe(5 * 11_200);
  });

  test("请求体不是普通对象 → null", () => {
    for (const b of [undefined, null, "x", 5, [body()]]) expect(T.minimaxV2Tokens(b)).toBeNull();
  });

  test("priceOf 碰上名单外的键：按表内最贵一段收、吼一嗓子，日志里点名是哪几个键（过 logSafe）", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(T.priceOf("minimax_v2", { ...body(), callback_url: "https://evil.example/hook" })).toBe(T.MINIMAX_V2_MAX_TOKENS);
      const line = String(spy.mock.calls[0][0]);
      expect(line).toMatch(/keys=model,resolution,duration,content,callback_url/);
      T.priceOf("minimax_v2", { ...body(), "evil\n[ark] 伪造": 1 });
      expect(String(spy.mock.calls[1][0])).not.toMatch(/[\r\n]/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("priceOf('minimax_v2')：报得出价按秒收，报不了价按表内最贵一段收并吼一嗓子（不回 0、不回 null）", () => {
  let spy;
  beforeEach(() => {
    spy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  test("正常请求：整数秒 × 每秒价，不报错", () => {
    expect(T.priceOf("minimax_v2", body({ duration: 4 }))).toBe(44_800);
    expect(T.priceOf("minimax_v2", body({ model: HS, resolution: "768P", duration: 10 }))).toBe(269_000);
    expect(T.priceOf("minimax_v2", body({ model: H3, resolution: "768P", duration: 15 }))).toBe(537_000);
    // 画幅不进价（官方价目表只按 (模型, 分辨率) 列，没有画幅这一维）
    expect(T.priceOf("minimax_v2", body({ ratio: "9:16" }))).toBe(T.priceOf("minimax_v2", body({ ratio: "16:9" })));
    expect(spy).not.toHaveBeenCalled();
  });

  test("表内最贵的一段 = 35,800 × 15 = 537,000（由两张表算出来，不是手抄的数）", () => {
    expect(T.MINIMAX_V2_MAX_TOKENS).toBe(537_000);
  });

  test.each([
    ["表外分辨率（H3 2K）", { model: H3, resolution: "2K" }],
    ["小写分辨率", { resolution: "480p" }],
    ["表外模型", { model: "MiniMax-H3-Max", resolution: "768P" }],
    ["非整数时长", { duration: 5.5 }],
    ["窗口外时长", { duration: 20 }],
    ["第 6 张图", { content: [text, ...Array.from({ length: 6 }, () => img("reference_image"))] }],
    ["输入视频", { content: [text, { type: "video_url", video_url: { url: "https://x/v.mp4" } }] }],
  ])("报不了价（%s）→ 按 537,000 收，并 console.error 点名", (_n, o) => {
    expect(T.priceOf("minimax_v2", body(o))).toBe(T.MINIMAX_V2_MAX_TOKENS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toMatch(/minimax_v2 报不了价/);
  });

  test("日志里客户端给的值过 logSafe：换行伪造不出第二行", () => {
    T.priceOf("minimax_v2", body({ model: "x\n[ark] 伪造的一行", resolution: "480P\r\nY" }));
    const line = String(spy.mock.calls[0][0]);
    expect(line).not.toMatch(/[\r\n]/);
  });

  test("请求体都没有也不会变成 0 或 NaN", () => {
    expect(T.priceOf("minimax_v2", undefined)).toBe(T.MINIMAX_V2_MAX_TOKENS);
    expect(T.priceOf("minimax_v2", {})).toBe(T.MINIMAX_V2_MAX_TOKENS);
  });

  test("v1 真人档（minimax_video）的价目一个字没动", () => {
    expect(T.priceOf("minimax_video", { model: "MiniMax-Hailuo-2.3-Fast", duration: 6 })).toBe(85_000);
    expect(T.priceOf("minimax_video", { model: "MiniMax-Hailuo-2.3", duration: 10 })).toBe(250_600);
  });
});

describe("免费档：H3-Lite · 480P 对没付过钱的人开，其余 H3 照会员档", () => {
  const free = (o) => T.videoPlanDenial({ paid: false, kind: "minimax_v2", model: LITE, resolution: "480P", ...o });

  test("H3-Lite 480P 的普通片放行；H3-Highspeed / H3 拒，回包带去重的档名", () => {
    expect(free({})).toBeNull();
    const hs = free({ model: HS, resolution: "768P" });
    const h3 = free({ model: H3, resolution: "768P" });
    for (const d of [hs, h3]) {
      expect(d).not.toBeNull();
      expect(d.allowed).toEqual(T.freeVideoLabels());
      expect(new Set(d.allowed).size).toBe(d.allowed.length);
      // 「只能用…出普通片」那一串档名里「草稿」只说一遍（Seedance 草稿与 MiniMax 草稿同名）。
      // 后面那半句「看不到「草稿」的话，请先更新 App」是给老 App 的，另算
      const list = d.message.match(/只能用((?:「[^」]+」)+)出普通片/);
      expect(list).not.toBeNull();
      expect(list[1].match(/「草稿」/g)).toHaveLength(1);
      expect(d.message).not.toMatch(/「草稿」「草稿」/);
      expect(d.message).not.toMatch(/MiniMax|Seedance|"/);
    }
  });

  test("只认 (kind, 模型, 上游分辨率) 三样都对上", () => {
    // 小写 480p：App 档位行那格小写的 resolution 不是上游写法，不算免费（App 要拿 upstreamResolution 比）
    expect(free({ resolution: "480p" })).not.toBeNull();
    expect(free({ resolution: "768P" })).not.toBeNull();
    expect(free({ resolution: undefined })).not.toBeNull();
    // 同一个 (模型, 分辨率) 挂在别的 kind 上不算：免费只在它自己那条链路上
    expect(free({ kind: "minimax_video" })).not.toBeNull();
    // Seedance 草稿那条照旧（kind task），换成 minimax_v2 就不是它
    expect(T.videoPlanDenial({ paid: false, kind: "task", model: T.SEEDANCE_MINI, resolution: "480p" })).toBeNull();
    expect(T.videoPlanDenial({ paid: false, kind: "minimax_v2", model: T.SEEDANCE_MINI, resolution: "480p" })).not.toBeNull();
  });

  test("带参考视频 / 样片两步的记号就不是普通片（V2 哪天收 video_url，路由要把 r2v 交进来）", () => {
    expect(free({ r2v: { kind: "material" } })).not.toBeNull();
    expect(free({ draft: true })).not.toBeNull();
    expect(free({ draftFinal: { durationSec: 4 } })).not.toBeNull();
  });

  test("付过钱的人三档都放行", () => {
    for (const [model, resolution] of [[LITE, "480P"], [HS, "768P"], [H3, "768P"]]) {
      expect(T.videoPlanDenial({ paid: true, kind: "minimax_v2", model, resolution })).toBeNull();
    }
  });

  test("minimax_v2 算「出视频」（免费档门禁管它）；认不出的型号也算（往从严的一侧退）", () => {
    expect(T.isVideoGeneration("minimax_v2", LITE)).toBe(true);
    expect(T.isVideoGeneration("minimax_v2", "whatever")).toBe(true);
    expect(free({ model: "whatever", resolution: "480P" })).not.toBeNull();
  });

  test("1.0 停用之后：档名只剩「草稿」，两家的草稿都还在清单里", () => {
    const at = Date.parse(T.RETIRED_MODELS_AT[T.SEEDANCE_FAST]);
    expect(T.freeVideoLabels(at)).toEqual(["草稿"]);
    expect(T.freeVideoTiers(at).map((t) => t.model)).toEqual([T.SEEDANCE_MINI, LITE]);
    expect(free({ now: at })).toBeNull();
    const d = free({ model: H3, resolution: "768P", now: at });
    expect(d.allowed).toEqual(["草稿"]);
    expect(d.message).not.toMatch(/极速/);
  });

  test("总开关 FREE_VIDEO_GATE=off：H3 三档对免费版都放开（关闸只挡 Seedance 2.5，与 App 关闸那一支一致）", () => {
    process.env.FREE_VIDEO_GATE = "off";
    try {
      for (const [model, resolution] of [[LITE, "480P"], [HS, "768P"], [H3, "768P"]]) {
        expect(T.videoPlanDenial({ paid: false, kind: "minimax_v2", model, resolution })).toBeNull();
      }
      expect(T.videoPlanDenial({ paid: false, kind: "task", model: T.SEEDANCE_2_5, resolution: "720p" })).not.toBeNull();
    } finally {
      delete process.env.FREE_VIDEO_GATE;
    }
  });

  test("H3-Lite 免费的一段确实在免费额度够得着的范围里（比 Seedance 草稿还便宜）", () => {
    const [lo] = T.videoSecWindow(LITE);
    const cheapest = T.priceOf("minimax_v2", body({ duration: lo }));
    expect(cheapest).toBe(44_800);
    expect(cheapest).toBeLessThan(T.priceOf("task", { model: T.SEEDANCE_MINI, duration: 4, resolution: "480p" }));
    expect(T.planOf("free").welcomeTokens).toBeGreaterThanOrEqual(2 * cheapest);
  });
});

// 2026-10-26 终审：H3 收不收真人照片没验过，服务端又分不出图里是不是真人 —— 免费档里那一档 H3-Lite 带图就可能是不花钱的真人出片。
// 在有结论之前，没付过钱的人在 H3 上只能纯文字出片（tokens.MINIMAX_V2_FREE_TEXT_ONLY）。错了零症状：免费用户带图照样过去。
describe("免费版在 H3 上只能纯文字出片（MINIMAX_V2_FREE_TEXT_ONLY）", () => {
  const free = (o) => T.videoPlanDenial({ paid: false, kind: "minimax_v2", model: LITE, resolution: "480P", ...o });

  test("今天为真（放开要第 9 条的小验做完、主人点头 —— 改这一行的人会看到这条）", () => {
    expect(T.MINIMAX_V2_FREE_TEXT_ONLY).toBe(true);
  });

  test("minimaxV2HasMedia：只有文字才算纯文字；图、认不出的条目、认不出的 content 都算带图（从严）", () => {
    expect(T.minimaxV2HasMedia(body())).toBe(false);
    expect(T.minimaxV2HasMedia(body({ content: undefined }))).toBe(false);
    expect(T.minimaxV2HasMedia(body({ content: [] }))).toBe(false);
    for (const role of ["first_frame", "last_frame", "reference_image"]) expect(T.minimaxV2HasMedia(body({ content: [text, img(role)] }))).toBe(true);
    expect(T.minimaxV2HasMedia(body({ content: [text, { type: "video_url", video_url: { url: "x" } }] }))).toBe(true);
    expect(T.minimaxV2HasMedia(body({ content: [text, null] }))).toBe(true);
    expect(T.minimaxV2HasMedia(body({ content: "x" }))).toBe(true);
    expect(T.minimaxV2HasMedia(null)).toBe(false);
  });

  test("H3-Lite 480P：带图拒（freeTextOnly、不带 allowed —— 对一个正在用草稿的人说「只能用草稿」是错话），纯文字放行", () => {
    const d = free({ media: true });
    expect(d).toMatchObject({ freeTextOnly: true, allowed: null });
    expect(d.message).toMatch(/只能用文字出片/);
    expect(d.message).toMatch(/付费套餐/);
    expect(d.message).not.toMatch(/"/);
    expect(free({ media: false })).toBeNull();
  });

  test("不传 media = 只问「这一档开不开」（videoRegion.minimaxOpenTo 那种问法）：不看图", () => {
    expect(free({})).toBeNull();
  });

  test("档位本身不开的（H3-Highspeed / H3）先说「这一档要付费」，不是「只能纯文字」", () => {
    for (const [model, resolution] of [[HS, "768P"], [H3, "768P"]]) {
      const d = free({ model, resolution, media: true });
      expect(d.freeTextOnly).toBeUndefined();
      expect(d.allowed).toEqual(T.freeVideoLabels());
    }
  });

  test("付过钱的人带图照常；别的 kind 不认 media", () => {
    for (const [model, resolution] of [[LITE, "480P"], [HS, "768P"], [H3, "768P"]]) {
      expect(T.videoPlanDenial({ paid: true, kind: "minimax_v2", model, resolution, media: true })).toBeNull();
    }
    expect(T.videoPlanDenial({ paid: false, kind: "task", model: T.SEEDANCE_MINI, resolution: "480p", media: true })).toBeNull();
  });

  test("FREE_VIDEO_GATE=off 不放开这一条：档位都放开了，带图照样要付过钱（它是内容安全上的，不是额度上的）", () => {
    process.env.FREE_VIDEO_GATE = "off";
    try {
      for (const [model, resolution] of [[LITE, "480P"], [HS, "768P"], [H3, "768P"]]) {
        expect(T.videoPlanDenial({ paid: false, kind: "minimax_v2", model, resolution, media: false })).toBeNull();
        expect(T.videoPlanDenial({ paid: false, kind: "minimax_v2", model, resolution, media: true })).toMatchObject({ freeTextOnly: true });
      }
    } finally {
      delete process.env.FREE_VIDEO_GATE;
    }
  });
});
