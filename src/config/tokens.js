// AI token 钱包的目录与定价 —— 服务端【权威】的那一份。
//
// ★ 与 app 仓 `src/data/economy.ts` 是同一套数，但**职责不同，不要混淆**：
//     app 侧那份是【报价】——按下按钮之前告诉用户"这一步大概多少"，纯展示；
//     这一份是【结算】——按每一次真实的方舟调用扣费，客户端说什么都不作数。
//   改了任何一个数，两边都要改（跨仓契约，见 app/docs/api-contract.md）。
//   两边不一致的后果是"报价 216k、余额掉了 243k"，用户会觉得被偷了钱。
//
// ★ 为什么不能只信客户端报的价：改客户端就能报 0。整个"把钱包搬到服务端"这件事，
//   要害就在这里——余额判断与扣费必须发生在**服务端拿到请求体之后、转发出去之前**。

/** 订阅套餐。plan 额度每月刷新（作废未用完的），addon 永不过期 */
const PLANS = [
  { id: "free", name: "免费版", price: 0, monthlyTokens: 300_000 },
  { id: "std", name: "标准套餐", price: 30, monthlyTokens: 2_000_000 },
  { id: "pro", name: "专业套餐", price: 98, monthlyTokens: 8_000_000 },
];

const DEFAULT_PLAN_ID = "free";

function planOf(id) {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

// ── 单次调用的 token 等价 ────────────────────────────────────────────────
// 折算基准：标准档视频 15 元/M token。其余按各自单价折成同一把尺子，
// 用户看到的数字就是真实资源消耗，不做虚拟汇率。

// ── 出图（Seedream）：按 model 计价，不是一口价 ─────────────────────────
//
// ★ 2026-08-11 之前这里是一个常量 `IMAGE_TOKENS = 13_300`，而 priceOf **拿到了请求体
//   却不读里面的 model** —— 也就是顶档按最低档收费。铸卡分成三档之后顶档与低档差 3 倍，
//   这个缺口就是每张顶档图白送 0.4 元。而它没有任何症状：用户无感、界面无错、
//   测试全绿，只有火山账单知道。这正是本仓最怕的那种错，所以价目必须挂在 model 上。
//
// 折算口径与视频同一把尺子：**元/张 ÷ 15 元/百万 token**（15 = Seedance 1.0-pro 标准档）。
// ⚠ 单价取自方舟公开价目（2026-08-11 核对），**尚未与控制台账单对过**。
//   真实结算永远以账单为准；发现偏差改这一张表，并同步 app 的 IMAGE_TOKENS_BY_MODEL。

/**
 * 三档铸卡（速写/定妆/精绘）用的出图模型与单价。
 * ★ 与 app 仓 `src/data/economy.ts` 的 `IMAGE_TOKENS_BY_MODEL` **逐条相等**（跨仓契约）。
 *   对照钉在 `tests/arkProxy.spec.js`「跨仓出图价目一致性」，改一边不改另一边就会红。
 */
const IMAGE_TOKENS_BY_MODEL = {
  // 0.20 元/张 ÷ 15 元/M = 13,333。像素区间实测 [921,600, 16,777,216]
  "doubao-seedream-4-0-250828": 13_333,
  // 0.25 元/张 ÷ 15 元/M = 16,667。像素区间实测 [3,686,400, 16,777,216]
  "doubao-seedream-4-5-251128": 16_667,
  // 0.60 元/张 ÷ 15 元/M = 40,000。
  // ★ 为什么按 0.60 不按 0.30：pro 的单价按**输出像素**分档（≤261 万 0.30、>261 万 0.60），
  //   而铸卡画布 CARD_SIZE = 1728×2304 = 3,981,312 像素，落在贵的那一档。
  //   app 的 ImageTier.size 是有意用满画布的（压到 261 万以下会让顶档比中档还小）。
  //   哪天 app 把 size 调小了，这个数要一起改成 20,000 —— 两张表都改。
  "doubao-seedream-5-0-pro-260628": 40_000,
};

/**
 * 老客户端还在发的出图模型。**不能从在册名单里删。**
 *
 * 新版 app 已经把 `arkClient.MODELS.image` 改成跟着默认档走
 * （`imageTierOf(DEFAULT_IMAGE_TIER).model` = 4.0），所以**新包不再发它**；
 * 但**已经装机的 APK 改不了** —— 它们补设定帧、推三套方案的首尾帧、出 AI 封面
 * 全都还在发这个 id。从白名单里删掉的表现不是"降级"，是那批用户**出图整条 400**
 * （而客户端把 400 当敏感词处理，连重试都不会做）。铁律七。
 *
 * ⚠⚠ 2026-08-13 **账单实测**：这个 id 在账单里的名字是 **Doubao-Seedream 5.0 Lite**，
 *   单价 **¥0.22/张**（文生图与图像编辑同价）⇒ 真值应是 0.22/15 = **14,667**。
 *   （此前这里写着"公开价目里查不到"—— 那句话是错的，查不到只是因为它在账单里
 *   叫另一个名字。app 的档位表当初把它排除在外，依据的正是那个错误前提。）
 *
 * ★★ 即便如此，这一格**仍然保持 13,300，不许改成 14,667**：
 *   老包的 `economy.IMAGE_TOKENS` 就是 13,300，它按这个数**给用户报价**。
 *   服务端改成 14,667 就成了"页面报 13,300、实际扣 14,667" —— 正是 CLAUDE.md 里
 *   「页面报 ¥25、实际扣 ¥15」那条事故，只是方向反过来、坑的是用户。
 *   老客户端改不了，所以只能让服务端迁就它。
 * ★ 代价是每张少收 1,367（约 10%），差价我们自己吃。**明知故犯，不是遗漏** ——
 *   多收才是骗人，少收只是我们亏钱；而且这批调用会随老版本淘汰而归零。
 * ★ 这张表的寿命 = 老版本的寿命。确认线上没有旧包在发它之后，连同白名单一起删。
 */
const LEGACY_IMAGE_TOKENS = {
  "doubao-seedream-5-0-260128": 13_300,
};

/**
 * 出图的完整查价表（在册档 + 老客户端那一档）。
 *
 * ★ 用 Map 而不是把两个对象拼成一个普通对象：`model` 是**用户可控的字符串**，
 *   普通对象上 `obj["constructor"]` / `obj["toString"]` 会顺着原型链返回一个**函数**，
 *   而那个"价格"再往下传就是把函数交给 Mongo 的 $inc —— 500，甚至更难看的东西。
 *   Map 只认自己塞进去的 key。（路由上其实够不着：在册检查排在扣费之前；
 *   但 imageTokensOf 是导出的，别的调用方不该依赖那个顺序。）
 */
const IMAGE_PRICES = new Map([
  ...Object.entries(IMAGE_TOKENS_BY_MODEL),
  ...Object.entries(LEGACY_IMAGE_TOKENS),
]);

/**
 * 出图的**在册模型**。★ 「在册」与「有价」是同一件事，所以只有这一处数据 ——
 * `routes/ark.routes.js` 的 ALLOWED_MODELS 直接摊开它，不另写一份字面量（铁律六）。
 * 分成两张表的话有两种漏法，而且都不报错：
 *   在册了没定价 → 落到下面的兜底，按最贵档收（用户被多扣）；
 *   定价了没在册 → 这一档永远 400（用户觉得"这档坏了"）。
 */
const IMAGE_MODELS = new Set(IMAGE_PRICES.keys());

/** 已知最贵的一档出图。认不出的模型按它收，理由见 imageTokensOf */
const MAX_IMAGE_TOKENS = Math.max(...Object.values(IMAGE_TOKENS_BY_MODEL));

/**
 * 一次出图扣多少 token。
 *
 * ★ 认不出的 model **按已知最贵的一档收，并且吼一嗓子**。三个选项各自的后果：
 *   - 按最便宜的收（或沿用老常量）：等于白送，而且**永远不会有人发现** ——
 *     界面正常、日志干净，只有火山账单知道。今天这个缺口就是这么来的。
 *   - 直接 throw / 500：billedForward 会把它变成 500，**整条出图链路当场全挂**。
 *     出图端点是用户可控 model 的转发口，老客户端随时可能发一个我们没登记的 id
 *     （`MODELS.image` 已经换过两次，每换一次就多一批发老 id 的存量装机），
 *     拿全站可用性去赌一次配置疏漏不划算（铁律七）。
 *   - 按最贵的收：方向选对了 —— 少收是隐形的，多收会被用户当天投诉出来。
 * ★ 而且这条兜底在路由上**够不着**：ALLOWED_MODELS 的出图部分就是 IMAGE_MODELS 本身，
 *   没登记的 model 在扣费之前就被 400 挡掉了。它是第二道保险，不是常规路径。
 *   真跑到这里说明有人扩了白名单却没定价，所以要 console.error；
 *   同时流水的 memo 里带着 `image <model>`，对账时能一眼看出是哪个模型被兜了底。
 * ★ 与 app 的同名函数**行为不同是刻意的**：app 那份是【报价】，在开发期就该当场炸
 *   （抛异常）把配置错暴露出来；这一份是【结算】，跑在真实用户的请求上，不能炸。
 */
function imageTokensOf(model) {
  const known = IMAGE_PRICES.get(model);
  if (known) return known;
  console.error(
    `[tokens] 出图模型 ${String(model).slice(0, 64)} 不在价目表里，` +
      `按最贵档 ${MAX_IMAGE_TOKENS} 收费。请补 IMAGE_TOKENS_BY_MODEL（两仓一起改）`,
  );
  return MAX_IMAGE_TOKENS;
}

/** 一次豆包对话往返（含人设与历史的保守值） */
const CHAT_TURN_TOKENS = 400;

/**
 * 语音合成：**每个字符** 33 token（豆包 TTS，大陆价）。
 *
 * ★ 数的来历（方案 §14.6，2026-09-24）：豆包语音合成按字符计费，折进全仓的
 *   token 锚（15 元/百万 = 系数 1）就是这个数。非大陆供应商是 27 token/字符 ——
 *   等多模型目录落地后按地区取，现在只有大陆这一档。
 * ⚠ **这条链路此前一分钱不扣**（`tts.routes.js` 里 priceOf / charge / wallet 零命中）。
 *   按它自己的闸门（30 次/分钟 × 300 字）算，单账号理论日上限约 **¥2,160/日** ——
 *   「把免费额度从 300,000 调小」对一个从来不扣款的链路一分钱都省不下来。
 */
const TTS_TOKENS_PER_CHAR = 33;

/**
 * 语音识别：**每分钟** 5,000 token（豆包 ASR，大陆价 ¥4.5/小时）。非大陆 2,800。
 * ★ 计费口径是**上游认定的时长**，不是文件大小 —— 但时长要等识别完才知道，
 *   所以路由先按字节数估一个**上界**预扣，拿到真实时长后多退（billing.settleOverCharge）。
 */
const ASR_TOKENS_PER_MINUTE = 5000;

/**
 * 预扣用的「每秒多少字节」下界表。**取下界是刻意的**：字节除以一个偏小的数
 * ⇒ 秒数偏大 ⇒ 预扣偏多，再按真实时长退回来。反过来（预扣偏少）就是白送，
 * 而白送不会有任何报错。
 * ★★ 这里要的是**下界**，不是「我们自己的录音参数」（2026-09-25 评审：原来 wav 写 48,000、
 *   mp3 写 8,000，取的是官方客户端的参数与 64kbps 的拍值 —— 而 16kHz WAV 是 32,000 B/s、
 *   32kbps mp3 是 4,000 B/s，两者都**低于**它 ⇒ 秒数估少 ⇒ 预扣偏少 ⇒ 白送）。
 *   取真正的下界之后典型 mp3 会预扣两倍，再由 settleOverCharge 按真实时长冲正回 plan。
 *  · wav：16kHz / 16bit / 单声道 = 32,000 B/s（比我们自己的 24kHz 更低，够兜住手搓请求）
 *  · mp3 / ogg：按 32kbps = 4,000 B/s
 */
const ASR_BYTES_PER_SECOND = Object.freeze({ wav: 32000, mp3: 4000, ogg: 4000 });
/** 一次 Seed3D 建模（约 2.4 元/次 ⇒ 160k）。全站最贵的单次操作 */
const MODEL3D_TOKENS = 160_000;

/**
 * Seedance 2.5 的模型 id。单独提出来是因为它同时出现在三个地方
 * （档位系数、仅付费白名单、ark.routes 的 ALLOWED_MODELS），
 * 写字面量的话改版本戳时必然漏一处，而漏掉的那处不会报错——
 * 只会表现成"这一档突然按 1 倍收费"或"付费门禁形同虚设"。
 */
const SEEDANCE_2_5 = "doubao-seedance-2-5-260628";

/** Seedance 档位系数（相对标准档 1-0-pro）。★ 与 app 的 VIDEO_TIERS 一一对应 */
const VIDEO_MULT = {
  // ✅ 2026-08-16 拿 8 月账单明细逐行核过（bill_detail…20260801）。三条口径一致的证据：
  //    · `Doubao-Seedance-1.0-pro推理`            ¥0.015/千token = ¥15/M ⇒ 基准 1（分母就是它）
  //    · `Doubao-Seedance-1.0-pro-fast推理`       ¥0.0042/千token = ¥4.2/M ⇒ 4.2/15
  //    · `Doubao-Seedance-2.0-mini在线推理（无输入视频）` ¥0.023/千token = ¥23/M ⇒ 23/15
  //   ⚠ 前两条此前写的是 0.3 与 1.6（拍的整数），比真实成本**高** 7% 与 4.3% ——
  //   方向是**多收用户**，而本文件的口径明写着"折算的是真实资源消耗"，所以照账单改。
  //   ★ 写成 `4.2 / 15` 而不是 0.28：分子就是账单上那个数，下次对账一眼能比对上；
  //     写成小数的话，谁都看不出它是从哪来的，而 23/15 = 1.5333… 本来也写不尽。
  "doubao-seedance-1-0-pro-fast-251015": 4.2 / 15,
  "doubao-seedance-1-0-pro-250528": 1,
  "doubao-seedance-2-0-mini-260615": 23 / 15,
  // ★ 4.7 = 70 ÷ 15（口径：该模型的 元/百万 token ÷ 标准档 1.0-pro 的 15 元/M）。
  //   ⚠ 这个 70 **不是从方舟官方价目表页面读到的**（那一页抓不到内容），是两个独立
  //   来源互相印证的结果：① 一处直接给出 "Seedance 2.5 = 70 元/百万 token"（不含视频
  //   输入；带参考视频输入是 42）；② 另一处给出 "720P 每秒约 1.51 元"，而 1 秒
  //   720p24 = 1280×720×24/1024 = 21600 token = 0.0216M ⇒ 1.51/0.0216 ≈ 69.9 元/M。
  //   两者吻合，所以取 70。**最终请以控制台实际账单为准**——发现偏差时改这一处，
  //   并同步 app/src/data/economy.ts 里同名档位的 mult（跨仓契约，见下面的一致性测试）。
  //   ⚠ 2026-08-16 核账单：**这一条仍然没有任何账单证据**（同批其它四条都对上了）。
  //   原因是我们至今没有走过 2.5 的**纯 t2v**（没有输入视频）—— 账单里 2.5 只有
  //   `在线推理480P/720P（有输入视频）` 一行，那一行对应的是 VIDEO_MULT_R2V 的 2.8。
  //   ⇒ 真开这一档的 t2v 之前，先打一发小的、回头看账单再定这个数。
  [SEEDANCE_2_5]: 4.7,
};

/**
 * 「这个模型出片带不带 AI 生成的环境音」—— **模型能力表，不是价目表**。
 *
 * ★★ 2026-08-15 实测 + 费用中心逐行核对（tasks/WM_V2_audio.md）：
 *   · **分界在模型代际，不在价钱**：2.x（2-0-mini / 2-5）传 `generate_audio: true`
 *     真出声（-30.2dB / -27.5dB 的真实内容）；1.x（1-0-pro 两档）**收下参数却静默忽略**。
 *   · **开音频零额外成本**：同素材有声/无声两发的用量与单价逐位相同
 *     （各 209.71 千 tokens × ¥0.042/千 = ¥8.807820），计费单元下拉里也没有给音频
 *     单列的条目 ⇒ 这张表**不进任何计价公式**，r2vTokens/segTokens 一个字都不用改。
 *
 * ★ 服务端为什么还要有这张表：resolveR2v 的参数钉子要判「这一发传的 generate_audio
 *   与该模型的支持情况一致吗」。原来那条钉子写的是「必须 false/缺省」——那是
 *   "这一版不开方舟音频"的代码表达；现在账单核完了，钉子改成**按能力钉**：
 *   支持的档允许 true，不支持的档只允许 false/缺省（发一个模型不认的参数没有好处，
 *   而且那正是"以为开了、其实是哑的"的来源）。
 * ★ 与 app 仓 `src/data/economy.ts` 的 `VideoTier.audio` **逐条相等**（跨仓契约，
 *   钉在 tests/arkProxy.spec.js「跨仓音频能力一致性」）。
 * ★ 认不出的 model 一律**不支持**（= 只许 false/缺省）：往"不传"这一侧退是安全的
 *   （实测有声无声同价，两个方向都不多收钱）。
 */
const VIDEO_AUDIO = {
  "doubao-seedance-1-0-pro-fast-251015": false,
  "doubao-seedance-1-0-pro-250528": false,
  "doubao-seedance-2-0-mini-260615": true,
  [SEEDANCE_2_5]: true,
};

/** 这个模型认不认 `generate_audio: true`。判据只有这一处（铁律六） */
function audioSupported(model) {
  return VIDEO_AUDIO[String(model || "")] === true;
}

/**
 * 仅付费套餐可调用的模型。★ **"这一档对不对某个套餐开放"的判据只有 `paidOnlyDenial` 一处**，
 * 这个集合只是它的数据。
 *
 * 为什么 2.5 要挡住免费版：按上面的系数，**即使取最短的 3 秒**，
 * 一段 = 3×1280×720×24/1024 × 4.7 ≈ 304,560 token，已经超过免费版**整月**的
 * 300,000 额度。也就是说免费用户点下去必定 402——与其让他花几十秒填完需求、
 * 推演完方案、在最后一步被"余额不足"打回来（钱还真扣过 Seedream 的图），
 * 不如在提交的那一刻就把原因说清楚。
 *
 * ★ 客户端也会把这一档置灰，但那只是**提示**，不是安全边界：改一行前端就能绕过去，
 *   而绕过去的代价是我们替他付 70 元/M 的账单。真正的门在这里。
 */
const PAID_ONLY_MODELS = new Set([SEEDANCE_2_5]);

/** 这个套餐是不是免费档。判据是**月费为 0**，不是 `id === "free"`——
 *  以后加一个 0 元的体验档，按 id 判会把它当付费用户放进来。 */
function isFreePlan(planId) {
  return planOf(planId).price <= 0;
}

/**
 * 免费套餐调用「仅付费」模型时的拒绝理由。
 *
 * @returns {string|null} null = 放行；字符串 = 直接显示给用户的原因
 *
 * ★ 返回的是**能直接显示的整句话**，不是错误码：全 app 没有任何地方监听
 *   `emitApiError`，服务端只回一个 `PLAN_REQUIRED` 的话，客户端要么显示成天书、
 *   要么自己再拼一遍文案（第二处实现，两边措辞一分叉就没人知道以哪份为准）。
 * ★ 与 402「余额不足」是**两件事**，不能合并：402 充值就能解决，这一条充多少钱
 *   都没用（要换套餐）。把它们做成同一个错误，用户会一直充值一直被拒。
 */
function paidOnlyDenial(planId, model) {
  if (!PAID_ONLY_MODELS.has(String(model || ""))) return null;
  if (!isFreePlan(planId)) return null;
  return `这一档（${model}）仅对付费套餐开放：单段消耗超过免费版整月额度，升级套餐后即可使用。`;
}

/**
 * Runway 的按秒价目（token/秒）。**每个数都能回溯到 Runway 自己的价目页**
 * （docs.dev.runwayml.com/guides/pricing，2026-09-24 读）：credit 面值 $0.01，
 * 按全仓锚 $1 = 447,563 token 折算、四舍五入到百位。
 *   gen4_turbo  5 cr/秒  = $0.05/秒 → 22,400
 *   h3_max      8 cr/秒  = $0.08/秒 → 35,800
 *   hailuo3    10 cr/秒  = $0.10/秒 → 44,800（与方案 §14.6 的 rw_hailuo3_768p 对上）
 *
 * ★★ **查不到价的档位一律拒绝，绝不能降级成免费**：这条链路此前完全不计费，
 *   而「没价就白跑」等于把那个口子原样留着。新增档位要先有出处再进表。
 * ★ hailuo3 另按**每张参考图 2 cr**（$0.02 → 9,000）加收；image_to_video 必然带一张
 *   promptImage，所以命中 hailuo3 时固定加一份。
 * ⇒ 多模型目录（方案 §15.1）落地后这张表并进目录，这里只留委派。
 */
const RUNWAY_TOKENS_PER_SECOND = Object.freeze({ gen4_turbo: 22400, h3_max: 35800, hailuo3: 44800 });
const RUNWAY_REF_IMAGE_TOKENS = Object.freeze({ hailuo3: 9000 });

/**
 * **每日 token 上限**（方案 §14.10）。余额是「一个月能花多少」，日上限是「一天能花多少」——
 * 两者不能互相替代：
 *  · 免费档：月额度本身就小，日上限防的是「一天之内把整月额度喂给刷子」；
 *  · **付费档：没有日上限就等于没有上限。** 一个被滥用（或被盗号）的订阅者一天能烧掉
 *    这个订阅二百多个月的净收入，而账单要到月底才看得见。
 *
 * ★ 迎新期单独放宽：刚注册那几天日上限压到 15,000，用户连一段最短的视频都出不了
 *   （最短一段 67,200），那是个**永远触发不到的死配置**，还正好毁掉第一印象。
 * ★ 超限**只拒当天、不封号**，且返回的是能直接显示给用户的整句话（照 paidOnlyDenial 的先例）。
 *
 * ★★ 判据是「**今天已经花掉的** ≥ 上限」，**刻意不把本次报价算进去**。
 *   写成 `已花 + 这次 > 上限` 看着更严谨，实际会制造一个**永远点不动的按钮**：
 *   一段 30 秒的 seedance-2.5 单发就是 3,045,600 token > 3,000,000 的硬线，
 *   于是这个用户从第一发起就没法用这个功能 —— 而这正是 §14.10 自己点名要避免的死配置形状
 *   （它举的例子是免费档 15,000/日 挡死 67,200 的视频，同一个错法）。
 *   代价是单日最多溢出「一发的钱」，这个溢出有上界、且不会重复发生（下一发就被拒了）。
 */
const DAILY_LIMITS = Object.freeze({
  // ⚠ 方案 §14.10 给的是 **15,000/日**，那个数配的是「月额度降到 30,000」之后的免费档。
  //   今天的免费档仍是 **300,000/月**（`PLANS.free`），15,000/日会让一段最短的视频
  //   （67,200）**永远出不来** —— 那正是 §14.10 自己点名要避免的「死配置」形状。
  //   ⇒ 这里先取 150,000/日：既挡住「一天烧光整月额度」，又不会把现有功能锁死。
  //   **调月额度的那次改动必须同时把这个数改回 15,000**，两者是一对。
  freeDaily: 150000,
  newcomerDaily: 150000,
  newcomerDays: 7,
  paidWarnDaily: 1_500_000,
  paidHardDaily: 3_000_000,
});

/**
 * 今天还能不能再花 `cost`。**判据只有这一处**（与 paidOnlyDenial 同一格调用）。
 * @returns {string|null} 整句拒绝理由；null = 放行
 */
function dailyCapDenial({ planId, spentToday, cost, accountAgeDays }) {
  const spent = Math.max(0, Number(spentToday) || 0);
  void cost; // 见下面 ★★：判据刻意**不含**本次报价
  if (isFreePlan(planId)) {
    const newcomer = Number(accountAgeDays) >= 0 && Number(accountAgeDays) < DAILY_LIMITS.newcomerDays;
    const cap = newcomer ? DAILY_LIMITS.newcomerDaily : DAILY_LIMITS.freeDaily;
    if (spent < cap) return null;
    return `今天的免费额度用完了（每日上限 ${cap} token，已用 ${spent}）。明天 0 点（UTC）重置，或升级套餐提高上限。`;
  }
  if (spent < DAILY_LIMITS.paidHardDaily) return null;
  return `今天的用量已达单日上限（${DAILY_LIMITS.paidHardDaily} token，已用 ${spent}）。这是防滥用的保护线，明天 0 点（UTC）重置；确有大批量需求请联系我们。`;
}

/** 到没到该提醒一声的线（只记日志/告警，不拒） */
function dailySoftWarn({ planId, spentToday }) {
  return !isFreePlan(planId) && Number(spentToday) >= DAILY_LIMITS.paidWarnDaily;
}

const MODEL3D_ID = "doubao-seed3d-2-0-260328";

/** 一段 720p 视频的 token（方舟公式：时长×宽×高×帧率/1024，×档位系数） */
function segTokens(durationSec, model) {
  const d = Math.max(3, Math.min(10, Math.round(Number(durationSec) || 5)));
  const base = (d * 1280 * 720 * 24) / 1024;
  return Math.round(base * (VIDEO_MULT[model] ?? 1));
}

// ── r2v（参考视频生视频 / 白模模板）─────────────────────────────────
//
// 计费公式已**逐 token 实测钉死**（2026-08-14 A3 两发账单，分毫不差）：
//   raw = (输入视频时长 + 输出时长) × 输出宽 × 输出高 × fps ÷ 1024
// 输出是 720p 档（16:9 给 1280×720=921,600px；自适应给 1266×728=921,648px，
// 都是 92 万 px 级）、fps=24 ⇒ 每秒 21,600 raw token。

/** r2v 每秒 raw token（720p 档 92 万 px × 24fps ÷ 1024）。上面公式的落点 */
const R2V_TOKENS_PER_SEC = 21_600;

/**
 * r2v 档位系数（相对标准档 1-0-pro 的 15 元/M 折算口径，与 VIDEO_MULT 同一把尺子）。
 * ★ 2.8 = 42 ÷ 15：2.5 的「视频输入」档官方刊例 42 元/M；A3 两发实测账单与该公式
 *   分毫不差。促销价（如 2.0-mini 视频输入档的 4 折）**不入表** —— 价目只写刊例价，
 *   按促销价定价等于促销一结束就开始亏钱且无任何症状（economy.ts:166-169 的教训）。
 * ★ 只有登记进这张表的模型才许发 r2v 任务（ark.routes 的 resolveR2v）——
 *   不在表 = 400 拒单，**绝不**静默落回 VIDEO_MULT 的纯任务系数结算：
 *   那等于输入视频时长一分不收（4.7 是不含视频输入的价），能通、少收、账目瞎。
 * ★ 与 app 仓 economy.ts 各档位的 r2vMult 逐条相等（跨仓契约，钉在 arkProxy.spec.js）。
 */
const VIDEO_MULT_R2V = {
  // ✅ 2026-08-16 账单实证：`Doubao-Seedance-2.5在线推理480P/720P（有输入视频）`
  //   ¥0.042/千token = ¥42/M ⇒ 42/15 = 2.8，**与这里逐位相等**。
  //   （同一份账单里 411.3 千token × ¥0.042 = ¥17.2746，原价 = 折后价 ——
  //    说明这是刊例价而不是促销价，可以直接当长期口径用。）
  [SEEDANCE_2_5]: 2.8,
};

/** 表里最贵的 r2v 系数。兜底方向与 imageTokensOf 同理：多收会被投诉、少收永远没人发现 */
const MAX_R2V_MULT = Math.max(...Object.values(VIDEO_MULT_R2V));

/**
 * 一次 r2v 出片扣多少 token。
 *
 * @param {number} inputDurationSec 模板视频的登记时长（服务端从 Cloudinary 写入的那份，
 *   见 models/BranchTemplate.refVideo —— 不收客户端报的数）
 *
 * ★ 输出时长按 **等于输入时长** 取上界，所以是 `inputSec × 2`：
 *   路线是 edit（duration=-1、全时长逐镜头复刻），输出≈输入是协议行为；
 *   实测方舟会略微裁短输出（14.04s 输入 → 13.67s 计费），即实收略低于报价（~1%）。
 *   方向刻意选「报价 ≥ 实收」：多估的那 1% 我们退不退都不算骗人，反过来
 *   报价 < 实收就是「页面报 X、扣了 X+」——CLAUDE.md 头号事故形状。
 * ★ 不走 clampDuration/segTokens 的 10s 上限：那是纯 t2v 档位的约束（用户自选时长），
 *   r2v 的时长跟随参考视频（验收窗口 [4,30]s），两条路的规则本来就不同。
 * ★ 时长夹回 [4,30]（参考视频验收窗口，middleware/upload.js 的 TEMPLATE_REF_RULES）：
 *   登记值只可能落在窗口里，夹到边界还不等于原值 = 登记数据被弄坏了，吼出来。
 * ★★ 上限 2026-08-15 随白模 V2 从 15 放宽到 30，**必须与那套窗口同时改**：
 *   窗口放到 30 而这里还夹 15 的话，一段 20s 的模板会按 15s 计价 ——
 *   页面报价 < 实际扣费，正是 CLAUDE.md 里的头号事故形状（且只有账单知道）。
 */
function r2vTokens(inputDurationSec, model) {
  const raw = Number(inputDurationSec);
  const d = Math.max(4, Math.min(30, Math.round(Number.isFinite(raw) ? raw : 0)));
  if (d !== raw) {
    console.error(`[tokens] r2v 输入时长异常（${String(inputDurationSec)}），已按 ${d}s 计价 —— 模板登记数据可能被弄坏了`);
  }
  let mult = VIDEO_MULT_R2V[model];
  if (mult === undefined) {
    // 路由上够不着（resolveR2v 已把不在表的模型 400 掉），这是导出函数的第二道保险
    console.error(`[tokens] r2v 模型 ${String(model).slice(0, 64)} 不在 VIDEO_MULT_R2V 里，按最贵档 ${MAX_R2V_MULT} 收费`);
    mult = MAX_R2V_MULT;
  }
  return Math.round(d * 2 * R2V_TOKENS_PER_SEC * mult);
}

/**
 * 素材参考出片（reference 子任务：用户素材视频 + 多图 + 提示词点名首中尾帧）扣多少 token。
 *
 * ★ 与 r2vTokens（edit 复刻）是**两个公式**：edit 输出≈输入所以是 输入×2；
 *   reference 的输出时长由用户选（3~10s），公式是 (输入 + 输出)×720p 锚×同一系数
 *   ——(输入+输出)×W×H×fps÷1024 那条账单公式的直接代入，系数同 VIDEO_MULT_R2V
 *   （方舟按"请求里有没有视频输入"分档，不按子任务分档）。
 * ★★ 两个夹取区间必须与 app 的 economy.materialRefCost **逐字相等**（报价=实扣，
 *   本仓头号事故形状）：输入夹 [4,30]（方舟 r2v 输入窗口），输出夹 [3,10]
 *   （resolveR2v 的素材钉子拒掉了区间外与 -1，这里的夹取只是导出函数的第二道保险）。
 */
function materialRefTokens(inputDurationSec, outputDurationSec, model) {
  const ri = Number(inputDurationSec);
  const i = Math.max(4, Math.min(30, Math.round(Number.isFinite(ri) ? ri : 0)));
  if (i !== ri) {
    console.error(`[tokens] 素材参考输入时长异常（${String(inputDurationSec)}），已按 ${i}s 计价 —— 登记数据可能被弄坏了`);
  }
  const ro = Number(outputDurationSec);
  const o = Math.max(3, Math.min(10, Math.round(Number.isFinite(ro) ? ro : 0)));
  let mult = VIDEO_MULT_R2V[model];
  if (mult === undefined) {
    console.error(`[tokens] 素材参考模型 ${String(model).slice(0, 64)} 不在 VIDEO_MULT_R2V 里，按最贵档 ${MAX_R2V_MULT} 收费`);
    mult = MAX_R2V_MULT;
  }
  return Math.round((i + o) * R2V_TOKENS_PER_SEC * mult);
}

/**
 * 这一次方舟调用要扣多少 token。
 *
 * @param {string} kind "image" | "chat" | "task"
 * @param {object} body 已解析的请求体
 * @param {{ durationSec: number }|null} [r2v] r2v 解析结果（ark.routes 的 resolveR2v 给的，
 *   durationSec 是模板的**服务端登记时长**）。有它 = 这是白模出片，按 r2vTokens 计价。
 *   ★ 定价规则仍只在本文件一处 —— 路由只负责把「是不是 r2v、输入多长」查清楚递进来。
 * @returns {number} 0 = 不计费（轮询、产物代理）
 *
 * ★ 只按**真实发生的调用**计费，不按"客户端说他要干什么"。
 *   于是 app 那边的打包报价天然等于服务端逐笔之和，例如炼一张卡 =
 *   1 次 chat(400) + 1 次 image(13.3k) = app 的 forgeCost(1)。
 *
 * ★ 与 app 报价的对应关系（两边都"如实按调用收"；对不上时改 app 的报价口径，不是改这里）：
 *   1. 「生成本段」时管线可能额外调 Seedream，服务端如实按 model 各收一次出图费。
 *      补画缺失的设定帧（app 的 economy.segmentCost，简约模式两张都补、走参考生视频一张都不补）
 *      与圈选改帧（economy.annRedrawCost，2026-08-21 补上；哪几条真跑由 segmentGen.redrawnAnns 定）
 *      app 都已经报进去了，别再往这边加一遍 —— 会变成双算。
 *   2. 看图说话（chatVision）是**一次 chat**，塞几帧都收 CHAT_TURN_TOKENS。app 2026-09-10 起
 *      按「chat 调用次数 × CHAT_TURN_TOKENS」报价与记账（economy.mintQuote）；此前按帧报 900×N，
 *      报价比实收高。钉子在 tests/arkProxy.spec.js「跨仓 chat 定额一致性」。
 *   （这一段原来的标题是"已知不完全一致的两处"，两处现在都对齐了。）
 *   ⚠ 第 2 条的前提是 chat **按调用、不按内容量**计价。哪天改成按用量，app 那几个没有帧数参数的
 *     报价函数（mintQuote / blockoutTemplateCost）必须一起改。
 */
/**
 * 真人档（MiniMax 海螺 2.3 · 768P）按发一口价（token/发，键 = 时长秒）。
 *
 * ★★ 跨仓钉子：app 的 src/data/economy.ts VIDEO_TIERS 里 id:"real" 的 flatCost
 *   必须与这张表**逐条相等**（报价=实扣；realPersonProxy.spec.js 末尾钉着）。
 * ★ 数的来历（2026-08-24）：MiniMax 官方 $0.28/发(768P·6s)、$0.56/发(768P·10s)，
 *   汇率 7.2 ⇒ ¥2.016/¥4.032；按全仓 token 锚（15 元/百万 = 系数 1）折算
 *   = 134,400 / 268,800，取整 135k / 270k。成本价 1.0x（仓库主人拍板）。
 * ⚠ 汇率会动：调价时**两仓同一个提交**改这两处，别让报价悄悄偏离实扣。
 * ★ 只有 768P 一档分辨率、6/10 两档时长 —— 路由在扣费**之前**把参数钉死在这
 *   张表能报价的范围内（计价参数与扣费同一拍，照 resolveR2v 的先例），
 *   表里查不到的组合根本走不到扣费。
 */
const MINIMAX_FLAT_COST = Object.freeze({ 6: 135000, 10: 270000 });
/** 真人档唯一在册的模型与分辨率（价目只锚了它们，别的组合没有价） */
const MINIMAX_REAL_MODEL = "MiniMax-Hailuo-2.3";
const MINIMAX_REAL_RESOLUTION = "768P";

function priceOf(kind, body, r2v = null) {
  // ★ 必须读 body.model。写成常量就是"顶档按最低档收费"，而那种错零症状（见上面的表）。
  if (kind === "image") return imageTokensOf(String(body?.model ?? ""));
  if (kind === "chat") return CHAT_TURN_TOKENS;
  // 语音合成：按字符。★ 与路由里截断后的长度用同一个值（路由把 text 截到 MAX_TEXT
  //   之后才报价），否则「报价按 5,000 字、实际只念 300 字」——报价与实扣必须同源。
  if (kind === "tts") return Math.max(1, Math.ceil(String(body?.text ?? "").length * TTS_TOKENS_PER_CHAR));
  // 语音识别：按秒（调用方把秒数算好递进来；预扣用字节估的上界，结算用上游给的真实时长）
  if (kind === "asr") return Math.max(1, Math.ceil((Number(body?.seconds) || 0) * (ASR_TOKENS_PER_MINUTE / 60)));
  // Runway：按秒 × 档位单价（+ 参考图）。**查不到价返回 null**，调用方据此拒绝这次调用 ——
  // 返回 0 会让它变成一条免费链路，而那正是这次要封的口子。
  if (kind === "runway") {
    const perSec = RUNWAY_TOKENS_PER_SECOND[String(body?.model ?? "")];
    if (!perSec) return null;
    const seconds = Number(body?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.ceil(seconds * perSec) + (RUNWAY_REF_IMAGE_TOKENS[String(body?.model ?? "")] || 0);
  }
  // 真人档：按发查表。路由已把 duration 钉在表内（见 MINIMAX_FLAT_COST 的 ★）；
  // 万一有人绕过路由校验把别的时长带进来，兜底取表内最贵档 —— 报价宁高不低
  // （与 segmentCost 的 r2v 兜底同一取向），并 console.error 点名让人当场看见。
  if (kind === "minimax_video") {
    const hit = MINIMAX_FLAT_COST[Number(body?.duration)];
    if (hit) return hit;
    console.error(`[tokens] minimax_video 计价表里没有 duration=${String(body?.duration)}（调用方该先校验）`);
    return Math.max(...Object.values(MINIMAX_FLAT_COST));
  }
  if (kind === "task") {
    const model = String(body?.model ?? "");
    if (model === MODEL3D_ID) return MODEL3D_TOKENS;
    // r2v（白模出片）：输入时长计进 token，走单独的公式与系数表。
    // ★ 判据是「resolveR2v 解析出了结果」而不是自己再翻一遍 body.content ——
    //   「这个请求是不是 r2v」只在 resolveR2v 一处判（铁律六），这里只消费结论。
    if (r2v) {
      // 素材参考（reference）与白模复刻（edit）各自的公式——kind 由 resolveR2v 定
      if (r2v.kind === "material") return materialRefTokens(r2v.durationSec, r2v.outputSec, model);
      return r2vTokens(r2v.durationSec, model);
    }
    return segTokens(body?.duration, model);
  }
  return 0;
}

// ★ 这里原来有 DAILY_RECHARGE_CAP / DAILY_PLAN_BUYS 两个「模拟支付的防滥用上限」。
//   那时 /api/me/wallet/recharge 调一下就到账，任何有登录态的人都能给自己发 token，
//   这两个数是唯一的兜底。2026-08 发币口搬到了支付回调（services/payment/），
//   下单不再发币，每日上限也就没有意义了——不给币，刷多少次都是 0。
//   现在挡刷单靠的是 routes/pay.routes.js 上的 aiRateLimit（下单本身也不该被刷爆）。
//   `tokenWallet.service.mintedToday` 还留着：它是查"今天发了多少币"的现成工具，
//   对账时用得上，只是没有调用方在拿它做闸门了。

// ★ 这里原来导出过一个 `IMAGE_TOKENS`（"一张图多少钱"）。**故意删掉**：
//   留着它就等于在按 model 的价目表旁边放第二处"一张图的价"，而两者迟早分叉
//   （今天这个缺口正是分叉的产物）。要一张图的价一律走 imageTokensOf(model)。
module.exports = {
  RUNWAY_TOKENS_PER_SECOND,
  RUNWAY_REF_IMAGE_TOKENS,
  DAILY_LIMITS,
  dailyCapDenial,
  dailySoftWarn,
  TTS_TOKENS_PER_CHAR,
  ASR_TOKENS_PER_MINUTE,
  ASR_BYTES_PER_SECOND,
  MINIMAX_FLAT_COST,
  MINIMAX_REAL_MODEL,
  MINIMAX_REAL_RESOLUTION,
  PLANS,
  DEFAULT_PLAN_ID,
  planOf,
  IMAGE_TOKENS_BY_MODEL,
  LEGACY_IMAGE_TOKENS,
  IMAGE_MODELS,
  imageTokensOf,
  CHAT_TURN_TOKENS,
  MODEL3D_TOKENS,
  MODEL3D_ID,
  SEEDANCE_2_5,
  VIDEO_MULT,
  VIDEO_AUDIO,
  audioSupported,
  VIDEO_MULT_R2V,
  R2V_TOKENS_PER_SEC,
  r2vTokens,
  materialRefTokens,
  PAID_ONLY_MODELS,
  isFreePlan,
  paidOnlyDenial,
  segTokens,
  priceOf,
};
