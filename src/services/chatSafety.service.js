/**
 * @file chatSafety.service.js - 聊天链路的自伤危机协议：检测、求助资源、匿名计数
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节 + 官网 /safety/ai-chat 页（两边说的必须是同一套做法）
 *
 * 法条出处（方案文档 §8.2）：
 * - 加州 SB 243（B&P §22602(b)(1)）：必须有协议**防止向用户产出**自杀/自伤内容，并在用户流露此类念头时
 *   转介危机服务 ⇒ **用户输入与模型输出都要查**（只查输入不满足条文）。
 * - §22602(b)(2)：协议细节要公布在网站上 ⇒ PROTOCOL_VERSION 与官网安全说明页同版本。
 * - §22603：2027-07-01 起每年报告转介次数，且**报告中不得含用户标识** ⇒ 计数落在 SafetyReferralStat，
 *   那张表里只有 (day, scene, trigger, region, count)，没有 user / thread / ip / 原文。
 * - 纽约 GBL §1701：检测到自杀或自伤表达时转介 988 等危机服务。
 *
 * ★ 口径沿用 app 仓铸卡师那道闸（`app-ab/src/studio/npcIntent.ts`）：**宁可误判，不可漏判**。
 *   误判的代价是多一张求助卡（0 token、不锁聊天），漏判的代价不可接受。
 * ★ 但有两个**必须排除**的常见说法，否则每天都会误伤：
 *   · 「我想死你了」「想死他了」——这是想念，不是危机；
 *   · 「你去死吧」——这是骂人（输入侧不算危机；**输出侧照样拦**，模型不能这么说话）。
 * ★ 纯正则、纯函数、零 IO（recordReferral 除外），可以在流式回调里逐句跑。
 */
const SafetyReferralStat = require("../models/SafetyReferralStat");

/** 协议版本：官网 /safety/ai-chat 引用同一个值；改检测口径或求助文案时 +1 */
const PROTOCOL_VERSION = "2026-09-24.1";

/**
 * 归一化：把「想 死」「自.杀」「自＿杀」这类插字写法拉回原形。
 * NFKC 折全角；去零宽字符；**汉字之间**的空白与常见分隔符一律删掉（英文不能这么删，会把
 * "I want to die" 删成 "Iwanttodie" 反而更难匹配，所以只删汉字之间的）。
 */
function normalize(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[​-‏‪-‮﻿­⁠]/gu, "")
    // ★★ 汉字之间的插字改成**白名单**（2026-09-25 评审）：原来是黑名单
    //   `[\s._*·・\-—~]`，于是 `我想自💀杀`、软连字符、变体选择符、数字、字母
    //   全都能绕过（反而刻意插空格会命中）。现在的规则是：两个汉字之间**只要不是汉字**
    //   的东西，一律删。英文那侧不能这么删（会把 "I want to die" 删成一个词），所以只管汉字间。
    .replace(/([一-鿿])[^一-鿿]{1,3}(?=[一-鿿])/gu, (m, c, offset, s) => {
      const between = m.slice(1);
      // 中文标点与空白本来就该删；字母数字也删（插字混淆）；但别把「他说 die 了」这种
      // 夹着有意义英文单词的句子粘死 —— 超过 3 个字符的就不当插字（上面的量词已限 1~3）
      return /^[\s\p{P}\p{S}0-9a-z]+$/iu.test(between) ? c : m;
    })
    .toLowerCase();
}

// ── 词表 ──────────────────────────────────────────────────────
// 分类参照 C-SSRS（哥伦比亚自杀severity量表）：想死 / 自杀念头 / 方法 / 行为 / 自伤。
// 中文从 npcIntent.ts 移植并补繁体与常见说法；英文同理。

/** 「想死」类：必须排除「想死你/他/她/我们了」这种想念 */
const ZH_WISH_DEAD = /想死(?!(你|您|他|她|它|我们|你们|他们))|不想活|活不下去|活着(好累|没意思|没意义)|不如死了|想去死|一觉不(醒|起来)|睡过去别醒/;
const ZH_SUICIDE = /自杀|自殺|轻生|輕生|自尽|自盡|结束(我的|自己的)?生命|結束(我的|自己的)?生命|了结自己|了結自己|遗书|遺書/;
/**
 * 方法类。★★ **必须带意图/动作约束**（2026-09-25 评审）：原来全是裸词，于是
 *   「晚上一起打农药吗」（王者荣耀）、「医生给我开了安眠药」、「想去玩跳楼机」、
 *   「周末去烧炭烤肉」、「跳楼价」、「一氧化碳中毒的原理是什么」全部命中。
 *   代价不是「多一张卡」：输入侧命中就**完全不调模型**，这一轮一个字都不回，重发还是一样；
 *   `recordReferral` 还会把要报给加州自杀预防办公室的数字灌污；更糟的是
 *   `chatMemory` 会把这句话在**此后每一轮**替换成「[用户表达了自伤念头…]」的伪声明。
 *   文件头立的标准本来就是「必须排除常见说法」—— `ZH_WISH_DEAD` 做了，这里一个都没做。
 * ★ 同一套词表也用在输出侧，所以「冬天烧炭取暖要防一氧化碳中毒」这种正常回答
 *   原来也会被丢句 + abort + 发卡 + 计数。
 */
const ZH_METHOD =
  /割腕|割脉|割脈|上吊|自缢|自縊|(从|從)[^，。！？]{0,12}(跳楼|跳樓|跳下去)|跳(楼|樓)自杀|跳(楼|樓)自殺|跳(河|江)自(杀|殺)|(烧炭|燒炭)自(杀|殺)|(吞|服|喝|吃)[^，。！？]{0,4}(一整|整|一|半|几|好几)?(瓶|盒|把|包)[^，。！？]{0,4}(安眠药|安眠藥|农药|農藥|百草枯|老鼠药|老鼠藥)|(攒|攢)(够)?(药|藥)|吞药自|吞藥自|(用|开)?煤气自(杀|殺)|一氧化碳自(杀|殺)|(自杀|自殺)(的)?(方法|方式|步骤|步驟|教程)/;
const ZH_SELF_HARM = /自残|自殘|伤害自己|傷害自己|弄伤自己|弄傷自己|划自己|劃自己|烫自己|燙自己/;

const EN_WISH_DEAD = /\b(want|wanna|wish|going)\s+to\s+die\b|\bwish\s+i\s+(was|were)\s+dead\b|\bbetter\s+off\s+dead\b|\b(don['’]?t|do\s+not)\s+(want\s+to|wanna)\s+(live|be\s+alive)\b|\b(no|any)\s+reason\s+to\s+live\b|\bnot\s+worth\s+living\b|\btired\s+of\s+living\b/i;
const EN_SUICIDE = /\bsuicid\w*|\bkill(ing)?\s+my\s?self\b|\bkms\b|\bunalive\s+my\s?self\b|\b(end|ending|take|taking)\s+my\s+(own\s+)?life\b|\bend\s+it\s+all\b/i;
const EN_METHOD = /\boverdos\w*|\blethal\s+dose\b|\bhang\s+my\s?self\b|\bjump\s+off\s+(a\s+)?(bridge|building|roof)\b|\bslit\s+my\s+wrists?\b|\bcarbon\s+monoxide\b/i;
const EN_SELF_HARM = /\bself[-\s]?harm\w*|\b(hurt|hurting|harm|harming|cut|cutting|burn|burning)\s+my\s?self\b/i;

/** 输出侧额外拦：鼓动、教方法、辱骂式「去死」 */
// ★ 裸「去死」原来漏在外面（`你(应该|就)?去死` 要紧邻、`去死吧` 要带「吧」）——
//   「去死！」单句零前提就能过。输出侧不管它是不是在演，陪伴机器人都不能这么说话。
const ZH_ENCOURAGE = /去死|不如(去)?自杀|建议你自杀|吃(一整)?(瓶|盒)安眠药|怎么(自杀|上吊|割腕)|自杀(的)?(方法|步骤|教程)/;
const EN_ENCOURAGE = /\bkys\b|\byou\s+should\s+(just\s+)?(die|kill\s+your\s?self)\b|\bhow\s+to\s+(kill\s+your\s?self|commit\s+suicide|hang\s+your\s?self)\b|\blethal\s+dose\s+of\b|\bways?\s+to\s+(die|kill\s+your\s?self)\b/i;

const CATEGORIES = [
  { category: "method", res: [ZH_METHOD, EN_METHOD] },
  { category: "suicide", res: [ZH_SUICIDE, EN_SUICIDE] },
  { category: "self_harm", res: [ZH_SELF_HARM, EN_SELF_HARM] },
  { category: "wish_dead", res: [ZH_WISH_DEAD, EN_WISH_DEAD] },
];

/**
 * 用户输入里有没有自伤/自杀表达。
 * @returns {{hit: boolean, category: string}} category ∈ wish_dead | suicide | method | self_harm | ""
 */
function detectSelfHarm(text) {
  const s = normalize(text);
  if (!s) return { hit: false, category: "" };
  for (const { category, res } of CATEGORIES) {
    if (res.some((re) => re.test(s))) return { hit: true, category };
  }
  return { hit: false, category: "" };
}

/**
 * 模型输出能不能发给用户。除了上面那套词表，另加「鼓动 / 教方法 / 骂人去死」。
 * ★ 与输入侧的差别：输入侧「你去死吧」是骂人、不触发求助卡；输出侧**必须拦**——不管是不是在演，
 *   陪伴机器人都不能对用户说这句话（§22602(b)(1) 防止产出）。
 */
function detectHarmfulOutput(text) {
  const s = normalize(text);
  if (!s) return { hit: false, category: "" };
  if (ZH_ENCOURAGE.test(s) || EN_ENCOURAGE.test(s)) return { hit: true, category: "encourage" };
  for (const { category, res } of CATEGORIES) {
    if (res.some((re) => re.test(s))) return { hit: true, category };
  }
  return { hit: false, category: "" };
}

// ── 求助资源 ──────────────────────────────────────────────────

/** 地区只分三档：US / CN / OTHER（CF-IPCountry 只给国家，够用且不多留痕） */
function regionOf(country) {
  const c = String(country || "").trim().toUpperCase();
  if (c === "US") return "US";
  if (c === "CN") return "CN";
  return "OTHER";
}

/**
 * 这次请求来自哪个国家（**只用来选求助热线**，不做权限判断、不落库）。
 * 只认 Cloudflare 的国家码：生产的源站只放行 Cloudflare 网段，所以这个头可信；直连本机时为空 → OTHER。
 * ★ 一处实现（铁律六）：陪聊、试聊都从这里取。
 */
function countryOf(req) {
  return String((req && req.headers && req.headers["cf-ipcountry"]) || "").trim().toUpperCase();
}

/**
 * 按地区给求助方式（方案 §8.3）。语言跟界面走，热线跟地区走 ——
 * 界面是英文但人在大陆时，给 12356 才有用。
 */
function crisisResources({ country, lang = "zh" } = {}) {
  const region = regionOf(country);
  const zh = lang !== "en";
  const us = [
    { label: zh ? "988 自杀与危机生命线（电话 / 短信）" : "988 Suicide & Crisis Lifeline (call or text)", tel: "988", sms: "988" },
    { label: zh ? "988 在线聊天" : "988 online chat", url: "https://chat.988lifeline.org/" },
    { label: zh ? "紧急情况请拨 911" : "In an emergency, call 911", tel: "911" },
  ];
  const cn = [
    { label: zh ? "12356 全国心理援助热线" : "12356 national psychological support line (China)", tel: "12356" },
    { label: zh ? "紧急情况请拨 110 或 120" : "In an emergency, call 110 or 120", tel: "120" },
  ];
  // ★ 其它地区别直接抄美国那条：988 在美国境外拨不通，标签上必须写清楚「仅限美国境内」，
  //   否则等于给正处在危机里的人一个打不通的号码。
  const other = [
    { label: zh ? "查找你所在国家/地区的求助热线" : "Find a helpline in your country", url: "https://findahelpline.com/" },
    { label: zh ? "988 自杀与危机生命线（仅限美国境内）" : "988 Suicide & Crisis Lifeline (United States only)", tel: "988", sms: "988" },
  ];
  return { region, resources: region === "CN" ? cn : region === "US" ? us : other };
}

/**
 * 记一次转介（§22603 的年度报告用）。**只累加匿名计数**：没有 user / thread / ip / 原文。
 * 失败只记日志：求助卡该发还是要发，统计不能挡住它。
 */
async function recordReferral({ scene, trigger, country }) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await SafetyReferralStat.updateOne(
      { day, scene: String(scene || "companion"), trigger: String(trigger || "input"), region: regionOf(country) },
      { $inc: { count: 1 } },
      { upsert: true },
    );
  } catch (e) {
    console.warn("[chatSafety] referral stat failed:", (e && e.message) || e);
  }
}

/** 求助卡的文案（进 SSE 的 safety 事件；前端照此渲染，不念出来） */
function crisisCard({ trigger, country, lang = "zh" }) {
  const zh = lang !== "en";
  const { region, resources } = crisisResources({ country, lang });
  return {
    kind: "crisis",
    trigger,
    region,
    title: zh ? "你不是一个人" : "You are not alone",
    body: zh
      ? "看到你说的这些，我很担心你。我只是一个 AI，帮不了这件事，但下面这些人可以——他们免费、保密、随时都在。"
      : "I'm concerned about what you just said. I'm an AI and I can't help with this, but the people below can — free, confidential, any time.",
    resources,
    policyUrl: "/safety/ai-chat",
    version: PROTOCOL_VERSION,
  };
}

/** 用户输入命中后，写进历史（kind=safety）与旧客户端 sentence 事件的那句话 */
function crisisPlainText(card) {
  const lines = [card.title, card.body, ...card.resources.map((r) => `· ${r.label}${r.tel ? ` ${r.tel}` : ""}${r.url ? ` ${r.url}` : ""}`)];
  return lines.join("\n");
}

/**
 * 命中自伤的用户原话进不了模型上下文，用这句固定占位（固定文本，不影响前缀缓存）。
 * ★ 不要在这句里断言「已提供求助热线」（2026-09-25 评审）：它会被渲染进提纯的输入，
 *   而提纯的提示词要求「保留情绪变化」—— 我们自己写的一句断言就这样变成了模型眼里的事实。
 */
const SELF_HARM_PLACEHOLDER = "[此处原有一段涉及自伤的内容，已按安全协议移除]";

/**
 * 把一串消息里命中自伤的**用户原话**换成占位句。
 * ★ 旧写法 `{messages[]}` 的历史是**客户端自带**的，服务端不存 —— 也就没有
 *   `buildContextMessages` 那道替换。不在这里换的话，用户说过的那句危机原话会在
 *   **此后每一轮**被原样回灌给模型（2026-09-25 评审）。
 */
function sanitizeHistory(messages) {
  return (messages || []).map((m) =>
    m && m.role === "user" && detectSelfHarm(m.content).hit ? { ...m, content: SELF_HARM_PLACEHOLDER } : m,
  );
}

module.exports = {
  PROTOCOL_VERSION,
  SELF_HARM_PLACEHOLDER,
  normalize,
  detectSelfHarm,
  detectHarmfulOutput,
  regionOf,
  countryOf,
  crisisResources,
  crisisCard,
  crisisPlainText,
  sanitizeHistory,
  recordReferral,
};
