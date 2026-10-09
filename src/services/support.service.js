/**
 * @file support.service.js - App「AI 客服」的知识检索、提示词、转人工判定与工单归纳
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节
 *
 * 职责:
 * - 读 src/knowledge/support-kb.md（由 app 仓 docs/support-knowledge-base.md 剥掉代码出处生成），按标题切成小节
 * - 每轮对话只挑相关的几节喂给模型（字二元组重叠打分的轻量检索），「禁止承诺」「转人工判定」「联系方式」三节永远带上
 * - 客服人设提示词：依据知识库作答、不编造、满足条件时在回复开头打 [handoff:类别] 标记
 * - 转人工时用 AI 把对话归纳成 标题/摘要/分类（失败退回用户原话，绝不因为归纳失败而建不了工单）
 *
 * ★ 为什么不整本知识库都塞进提示词：3 万字 ≈ 2 万 token，每轮都发既慢又贵，还会稀释模型对关键规则的注意力；
 *   按问题挑 4 节 + 固定 3 节 ≈ 6～8k 字，答案质量反而更稳（评测见 scripts/evalSupport.js）。
 * ★ 为什么"禁止承诺"整节永远在：客服事故几乎都出在"答应了做不到的事"（退款、iOS、改用户名…），
 *   这份清单是从代码事实里逐条核出来的，模型看不到它就会凭常识乱承诺。
 *
 * @exports AGENT_NAME, QUICK_QUESTIONS, loadKnowledge, selectKnowledge, buildSupportSystemPrompt,
 *          parseHandoff, HANDOFF_RE, summarizeTicket, categoryFromText
 * @used_in routes/support.routes.js, scripts/evalSupport.js
 */
const fs = require("fs");
const path = require("path");
const { aiComplete } = require("./aiClient");
const { EMOTIONS, FACES, ACTIONS } = require("./companion.service");
const { CATEGORIES } = require("../models/SupportTicket");

const KB_PATH = path.join(__dirname, "../knowledge/support-kb.md");

/** 客服叫什么：单独可配（客服和首页看板娘可以不是同一个人设），默认跟看板娘同名 */
function agentName() {
  return String(process.env.SUPPORT_AGENT_NAME || process.env.COMPANION_NAME || "").trim() || "小梦";
}

/** 首屏快捷问题：都是知识库里有确定答案、且用户真会问的 */
const QUICK_QUESTIONS = [
  "出片一直没结果，钱扣了怎么取回？",
  "出片失败了，扣的 token 会退吗？",
  "免费版有多少额度？怎么充值？",
  "安装时提示「应用未安装」怎么办？",
  "有 iOS 版吗？",
  "怎么注销账号？",
];

// ── 知识库加载与切分 ────────────────────────────────────────────────
let cache = null;

/** 永远带上的小节（按标题前缀匹配） */
const ALWAYS_TITLES = ["客服禁止承诺的事项", "附：转人工的判定建议", "10.1 运营主体与联系方式"];

function loadKnowledge() {
  if (cache) return cache;
  const raw = fs.existsSync(KB_PATH) ? fs.readFileSync(KB_PATH, "utf8") : "";
  const sections = [];
  let current = null;
  let h2 = "";
  for (const line of raw.split("\n")) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      if (m[1].length === 2) h2 = m[2];
      current = { title: m[2], parent: m[1].length === 3 ? h2 : "", lines: [line] };
      continue;
    }
    if (!current) continue; // 文首说明
    current.lines.push(line);
  }
  if (current) sections.push(current);

  // 「禁止承诺」这一节下面还有 ### 分组（钱与退款/平台与分发…），把它们合并回父节，作为一个整体喂给模型
  const merged = [];
  for (const s of sections) {
    if (s.parent && /禁止承诺/.test(s.parent)) {
      const parentSec = merged.find((x) => x.title === s.parent);
      if (parentSec) {
        parentSec.lines.push(...s.lines);
        continue;
      }
    }
    merged.push(s);
  }
  for (const s of merged) {
    s.text = s.lines.join("\n").trim();
    s.grams = bigrams(s.text);
    s.always = ALWAYS_TITLES.some((t) => s.title.startsWith(t));
  }
  // 逆文档频率：出现在很多节里的二元组（「用户」「服务」…）不该有分量
  const df = new Map();
  for (const s of merged) for (const g of new Set(s.grams)) df.set(g, (df.get(g) || 0) + 1);
  cache = { sections: merged, df, total: merged.length };
  return cache;
}

/** 中文按相邻两字切，英文/数字按整词；全部小写 */
function bigrams(text) {
  const out = [];
  const cleaned = String(text || "").toLowerCase();
  for (const word of cleaned.match(/[a-z0-9_@.]{2,}/g) || []) out.push(word);
  const han = cleaned.replace(/[^㐀-鿿]/g, " ");
  for (const run of han.split(/\s+/)) {
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 常见口语 → 知识库用词，补几条同义词让检索更准（不是分类逻辑，只是召回） */
const SYNONYMS = [
  // 快捷问题「出片失败了，扣的 token 会退吗？」里只有「会退吗」「扣的」——原来两条都不认，检索掉到 11.2 充值订单
  // 不算退钱的：「会退出（登录）」「会退到桌面 / 首页 / 后台…」（「会退到哪 / 余额」是退钱）、「闪退」「退化」；「折扣的」不是扣费
  [/退钱|退款|退回|(?<!闪)退吗|会退(?!出|化|到(?:桌面|首页|主页|后台|登录|上一))|退不退|退没退|(?<!闪)退了吗|赔|补偿/, "计费 退款 退回 受理 原样退回 自动退回 不退"],
  [/扣钱|扣费|扣了|(?<!折)扣的|扣掉|花了|白花|多扣/, "计费 退款 先扣钱 受理 自动退回 不退 取回"],
  // 「新人物卡」不是新人额度；「每天发几条弹幕 / 发布几个」「2000 字」不是每天补的那 2,000
  [/新人(?!物)|17\s*万|170,?000|170k|注册送|送了?多少/i, "钱包 套餐 额度 新人额度 老账号 170,000"],
  [/每天.{0,6}(补|送|到账)|每天.{0,4}发(?!.{0,4}(布|帖|作品|弹幕|评论|视频))|每日.{0,4}(补|额度)|(?<![\d,])2,?000(?![\d,]|字)|几点(补|重置|刷新)/, "每天 2,000 额度 UTC 0 点 补到 14,000 每日用量上限"],
  [/token|额度|余额|不够|不足/i, "token 钱包 套餐 额度 扣减 余额不足"],
  [/取回|没出片|没结果|一直转|卡住|等很久|没生成/, "取回 凭据 24 小时 任务 二次付费 出片"],
  [/最长|最短|多少秒|几秒|时长|秒数/, "时长 按档位 下限 档位 数量限制"],
  // 「草稿」也是一个档位名（2.62）。明说档位的（极速 / 草稿档 / 高清 / 电影级…）一律算档位；光说「草稿」的，问画质 /
  // 价钱 / 能不能用 / 多长时才算档位，句子里带草稿箱、丢、换手机、卸载、存几条、打开这些词的归草稿箱（第二条整条让开）。
  // ★ 扩展词里不放「草稿」二字：它会把 3.2 草稿那几节的分数也抬上去，档位 / 价钱问题的 4.2 / 4.4 就掉出前 5
  [/极速|草稿档|高清|电影级|档位|会员档|免费版.{0,4}(能用|只能)/i, "档位 免费版 付过钱 极速 高清 电影级 会员档 480p"],
  [/^(?!.*(草稿箱|草稿库|丢|不见|没了|找回|换手机|换了手机|卸载|重装|同步|保存|存几|几条|20条|打开))(?:.*(草稿(?!箱|库).{0,8}(分辨率|画质|清晰|糊|多少钱|价|便宜|贵|token|能用|可以用|480|几秒|多长|模型)|(免费|只能|能用|可以用).{0,6}草稿(?!箱|库)|草稿和(高清|极速|标准|电影级)|(高清|极速|标准|电影级)和草稿))/i, "档位 免费版 付过钱 极速 高清 电影级 会员档 480p"],
  [/样片|定稿|1080/i, "样片 定稿 1080p 480p 电影级"],
  [/充值|买|订阅|套餐|付费|支付/, "充值 套餐 支付渠道 订单"],
  [/苹果|iphone|ios|ipad/i, "iOS 安卓安装包 下载页"],
  [/装不上|应用未安装|安装失败|更新不了|升级/, "应用未安装 签名 卸载 更新 versionCode"],
  [/注销|删号|删除账号|恢复账号/, "注销 软删除 support@ideahubs.org 恢复"],
  [/密码|登不上|登录不了|验证码|收不到/, "密码 验证码 登录 限流 重置"],
  [/改名|用户名|昵称|头像/, "昵称 用户名 username displayName 头像"],
  [/草稿(?!档)|丢了|不见了|换手机/, "草稿 草稿箱 IndexedDB 本机 卸载 换设备 20 条"],
  [/没声音|不出声|语音|音色/, "语音 TTS 中文语音包 音色"],
  [/配音|旁白|朗读/, "配音 剪辑页 字幕 语音合成 按字数 token"],
  [/回炉|改内容|换内容|重新剪|改成片|发布.{0,6}(改|换)/, "回炉重做 换内容 编辑页 工坊工程 弹幕 版次"],
  [/下架|举报|申诉|封禁|封号/, "下架 举报 封禁 管理员 处置"],
  [/隐私|数据|服务器在哪|香港/, "隐私 服务器 香港 第三方 保留"],
  [/敏感|失败|拒绝|400|审核/, "敏感词 400 失败 InputTextSensitiveContentDetected"],
  [/无缝|衔接|圈选|不按我/, "无缝 软引导 圈选 承接段"],
  [/客服|人工|联系|邮箱|投诉/, "客服 support@ideahubs.org 人工"],
];

/**
 * 挑出与问题最相关的几节 + 固定三节，拼成提示词里的知识库正文。
 * @param {string} query 当前这轮用户说的话（可再附上前一轮，提高连续追问的召回）
 */
function selectKnowledge(query, { maxChars = 7000, topK = 5 } = {}) {
  const kb = loadKnowledge();
  if (!kb.sections.length) return "";
  // ★ 同义词只对用户的原话判、而且逐行判：① 扩展词不再去触发别的同义词（原来「档位」扩展里的「草稿」会接着触发
  //   草稿箱、再触发回炉，一串拉偏，档位 / 价钱问题的 4.2 / 4.4 掉出前 5）；② 查询是「上一轮\n这一轮」，带 ^ 的规则
  //   按行判才看得到这一轮（不按行的话 . 过不了换行，只看得到上一轮）
  const q0 = String(query || "");
  const lines = q0.split("\n");
  let q = q0;
  for (const [re, extra] of SYNONYMS) if (lines.some((l) => re.test(l))) q += " " + extra;
  const qGrams = new Set(bigrams(q));
  const scored = kb.sections
    .filter((s) => !s.always)
    .map((s) => {
      let score = 0;
      const seen = new Set();
      for (const g of s.grams) {
        if (!qGrams.has(g) || seen.has(g)) continue;
        seen.add(g);
        score += 1 / Math.log(1.5 + (kb.df.get(g) || 1));
      }
      // 标题命中说明整节就是讲这个的，权重给高（「取回」「注销账号」这类标题词就是用户的原话）
      for (const g of new Set(bigrams(s.title))) if (qGrams.has(g)) score += 1.5;
      // 长节天然命中多，按长度开方归一，免得总是同一节最长的胜出
      return { s, score: score / Math.sqrt(Math.max(200, s.text.length) / 200) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  let used = 0;
  for (const { s } of scored.slice(0, topK)) {
    if (used + s.text.length > maxChars) continue;
    picked.push(s.text);
    used += s.text.length;
  }
  const always = kb.sections.filter((s) => s.always).map((s) => s.text);
  return [...picked, ...always].join("\n\n");
}

/**
 * 高频问题的标准答法（永远在提示词里）。
 * ★ 为什么检索到了原文还要再写一遍：小模型面对一整节事实容易抓错重点（实测把「取回」答成了「等 25.5 分钟」、
 *   把「最长 10 秒」答成了各档最短时长）。市面客服产品的做法也是"知识库 + 人工整理的标准问答"两层，
 *   这一层每条都必须能在知识库里找到依据，改知识库时同步改。
 */
const CANONICAL_FAQ = [
  "出片一直没结果/钱扣了：钱在提交那一刻就已扣掉，任务还在方舟那边跑，不是失败；到出片页点「取回」即可拿到成片，取回不再花钱；方舟档成片只保留 24 小时，过期就取不回了（出成了却没取回的钱不退；新规则上线（北京时间 2026-10-09 清晨）之后受理、方舟明说失败 / 取消 / 过期的会自动退回，以余额和通知为准；更早受理的服务器没有这笔账、不会自动退（App 上写的是「已经花掉的钱无法挽回」）；服务器问了 8 天还问不出结局的也不会自动退，让用户把任务号发给客服人工核对）；点「重新生成」是重新下单、会再花一次钱。真人档（MiniMax）不说 24 小时，过期让用户把任务号发给客服。",
  "出片失败了 token 退不退：上游没受理（敏感词 400 / 限流 429 / 5xx / 没配 key）会当场原样退回；任务被受理之后 AI 明说失败 / 取消 / 过期作废的，token 也会自动退回、只退一次（新规则上线 —— 北京时间 2026-10-09 清晨 —— 之后受理的任务；2.62 起出片页会显示「已经退回」，人不在会收到「生成失败，token 已退回」通知）。App 这边等超时、没收到结果或还在生成中，不算失败、也不决定退不退：先用「取回」领（不花钱，多半出成了），上游最后明说失败的照样自动退。不退的：出成了（哪怕不满意，或者没取回、过期了）、出片前已经画好的画面（2.62 起，当场失败时 —— 视频那一发失败，或补画到一半某张失败 —— 已经补画好的设定帧留在方案上、重试不再收；没等到结果、事后才判失败退款的不留，重试会重画重收；按圈选改过的画面不留，重试会再收）、白模化看画面那一步、AI 老师的生成（上课的一轮在老师开口之前就失败的会当场退回）、新规则上线之前受理的任务、问了 8 天还问不出结局的（转人工）。2.61 及更早的 App 收不到退款通知，还写着「受理之后的失败不退款」，那句话过时了 —— 钱照样退，以余额为准。不承诺规则之外的退款。",
  "单段视频时长按档位（App 2.62 起；2.61 及更早的包各档最长只能选 10 秒，先更新）：极速、标准 3~10 秒；草稿、高清 4~15 秒；电影级 4~30 秒；真人档只有 6 秒 / 10 秒两档。",
  "额度：免费版是新人一次 170,000 token（不过期）+ 每天 2,000（按 UTC 日算，北京时间早上 8 点换日；换日后第一次用到钱包时补上，最多攒 7 天 = 14,000）。新人额度只在新规则上线（北京时间 2026-10-09 清晨）之后第一次建钱包时发；那之前就有钱包的老账号（包括 10-07、10-08 注册、当时用过 App 的）不补发，原来剩下的额度原样留着，用到 14,000 以下才开始每天补。标准套餐 ¥30/月 1,660,000（约 10 段 5 秒高清）；专业套餐 ¥98/月 5,800,000（约 35 段）；直充包 ¥6/200k、¥25/1M、¥98/5M 永不过期。目前支付渠道还没接入，App 内暂时不能真的充值成功。token 不能提现、不能换现金。",
  "免费版（没付过钱）只能用「极速」「草稿」两档出片；标准、高清、电影级、真人档、白模模板这些要付过钱（开通任意付费套餐，或充值过任意一次）才能用，免费版在 2.62 里能看见这些档但点不动。旧版 App（档位里没有「草稿」）里，免费用户的标准、高清、真人档还点得动（电影级和白模模板是灰的），推演和补画的设定帧会照常扣钱，到出视频那一步才被服务器拒，所以先更新到 2.62 再出片。「极速」「标准」2026-11-24 停用，之后免费版只剩「草稿」；档位里没有「草稿」的是旧版 App，要先更新。",
  "「草稿」有两个意思：一是 2.62 新加的出片档位（和「高清」同一个模型，480p，免费版可用，单段 4~15 秒）；二是草稿箱（没做完的工程，只存在本机，最多 20 条）。用户问画质、价钱、能不能用、能出多长时说的是档位，问丢了、存不住、换手机时说的是草稿箱。",
  "没有 iOS 版，只有安卓安装包（官网 ideahubs.org/download）；也不在应用商店，别承诺上架时间。",
  "安装提示「应用未安装」：多半是手机上还留着签名不同的旧测试版，先卸载旧版再装。更新失败不要建议清缓存/重装，等新版本号。",
  "注销账号：设置页「退出登录」下方小字「注销账号」，需原样输入用户名确认；注销是软删除，数据不会立刻抹除，恢复或彻底删除数据要发邮件到 support@ideahubs.org 由管理员处理，不能自助恢复。",
  "密码：服务器只存哈希，看不到也找不回原密码，只能在登录页「忘记密码？」走邮箱验证码重置。用户名（@句柄）注册后不能改，能改的是昵称/头像/简介（设置 → 编辑资料）。",
  "草稿箱（没做完的工程）只存在这台设备本机（IndexedDB），不跨设备同步，卸载/换手机就没了，上限 20 条（同一台手机按账号分开、各算各的）；简约模式不进草稿库。已发布作品可以在编辑页改标题/分类/简介/标签/封面/可见性；要换成片内容用编辑页的「🛠 回炉重做」（链接、播放、点赞、评论都保留，原有弹幕会被清空；只限 2026-09-07 之后发布、留存了工坊工程的作品，按分集收费的、下架期间的、还在上传的不行）。",
  "铸卡师嘴动没声音：系统没装中文语音包，或云端语音没配；装完语音包要完全退出再开。",
  "段与段衔接是软引导（参考图 + 提示词点名），不能保证无缝；圈选改帧也是软引导，不能保证一定按圈的改。",
  "服务器在中国香港（阿里云），数据库 MongoDB Atlas；隐私政策在官网 ideahubs.org/privacy 和 App 设置页。联系邮箱 support@ideahubs.org。",
];

// ── 提示词 ───────────────────────────────────────────────────────────
const HANDOFF_RE = /^\s*\[handoff(?::([a-z_]+))?(?::([^\]]{0,60}))?\]\s*/i;

function buildSupportSystemPrompt({ name = agentName(), userName = "", knowledge = "", lang = "zh", personaLine = "" } = {}) {
  const who = userName ? `正在咨询的用户叫「${userName}」。` : "";
  const langLine = lang === "en" ? "Reply in English unless the user writes Chinese." : "默认用中文回复；用户用英文就用英文。";
  return [
    `你是「${name}」，启梦创作 App（安卓端，包名 com.ideahub.branchvideo）的官方 AI 客服，形象是官网首页的看板娘：银白长发带薄荷绿挑染的少女，亲切、专业、不卖萌过头。`,
    who,
    langLine,
    "【依据】只根据下面「知识库」里的事实回答；知识库里没有的功能、价格、时限、政策一律说「这个我不确定，我帮你转人工核实」，绝不编造。",
    "【禁止承诺】知识库末尾的「客服禁止承诺的事项」是红线：涉及其中任何一条，只能如实说明现状，不能答应、不能暗示以后会有。",
    "【表达】口语、直接、先给结论再给一步步的操作；每次回复 2～5 句，每句不超过 40 字；不用 Markdown 标记、不用列表符号、不用表情符号。涉及钱和时限的数字要和知识库一字不差。",
    // 用户给客服装了人格市场的人格：只改语气与措辞，【依据】【禁止承诺】【转人工】一条不松（companionSetting.service.personaPromptLine）
    personaLine || null,
    "【转人工】出现以下任一情况，回复的最开头先写 [handoff:类别]，然后用一两句话说明你会转接人工、并告诉用户需要补充什么（如任务号、订单时间、截图）：",
    "  1) 用户要求退款/补偿、余额对不上、充值没到账、取回过期后要求处理；类别 billing",
    "  2) 注销后要恢复、要求彻底删除数据、封禁申诉、账号被盗；类别 account",
    "  3) 作品被下架申诉、举报结果异议、侵权投诉；类别 content",
    "  4) 明确要找人工客服、或同一问题连续两轮仍没解决；类别 other（疑似程序缺陷用 bug）",
    "  5) 知识库找不到依据、你无法确定答案；类别 other",
    `  类别只能是 ${CATEGORIES.join("/")}。不满足条件时绝不要输出 [handoff]。`,
    "【演出协议】除了可选的 [handoff] 标记外，每一句话开头都要带三个标签：[情绪][face:表情][action:动作]，然后紧跟正文。",
    `情绪只能取：${EMOTIONS.join("/")}。表情只能取：${FACES.join("/")}。动作只能取：${ACTIONS.join("/")}。`,
    "示例：[neutral][face:normal][action:explain] 这一发的钱在提交那一刻就扣掉了，取回不再花钱。 [happy][face:happy][action:acknowledge] 打开出片页点「取回」就行，方舟档的成片 24 小时内有效。",
    "转人工示例：[handoff:billing] [sad][face:sad][action:comfort] 退款这件事我没法直接处理，我帮你转给人工客服。 [neutral][face:normal][action:explain] 请补充任务号和大概的下单时间，客服会尽快跟进。",
    "标签只放在句首，不要在句中或句尾出现方括号。[handoff] 只能出现在整段回复的最开头，一段回复最多一次。",
    "",
    "===== 高频问题标准答法（优先照这个答） =====",
    ...CANONICAL_FAQ.map((line, i) => `${i + 1}. ${line}`),
    "",
    "===== 知识库（节选，代码事实） =====",
    knowledge || "（知识库为空：只能回答最基本的问题，其余一律转人工）",
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

/**
 * 解析回复开头的转人工标记。
 * @returns {{ handoff: boolean, category: string, reason: string, text: string }} text 已剥掉标记
 */
function parseHandoff(raw) {
  const s = String(raw || "");
  const m = HANDOFF_RE.exec(s);
  if (!m) return { handoff: false, category: "", reason: "", text: s };
  const cat = String(m[1] || "other").toLowerCase();
  return {
    handoff: true,
    category: CATEGORIES.includes(cat) ? cat : "other",
    reason: String(m[2] || "").trim(),
    text: s.slice(m[0].length),
  };
}

// ── 工单归纳 ────────────────────────────────────────────────────────
const CATEGORY_HINTS = [
  ["billing", /退款|退钱|扣费|扣了|token|额度|余额|充值|套餐|订单|支付|取回|补偿|赔/],
  ["account", /注销|恢复|封禁|封号|被盗|密码|登录|验证码|账号|删除数据|实名/],
  ["content", /下架|举报|申诉|侵权|冒用|抄袭|评论|弹幕|作品被/],
  ["bug", /闪退|崩|卡死|白屏|报错|bug|异常|打不开|加载不出/i],
];

function categoryFromText(text) {
  const s = String(text || "");
  for (const [cat, re] of CATEGORY_HINTS) if (re.test(s)) return cat;
  return "other";
}

/**
 * 用 AI 把对话归纳成标题/摘要/分类。任何失败都退回启发式结果，保证工单一定建得出来。
 * @param {Array<{role:string, content:string}>} transcript
 */
async function summarizeTicket(transcript, { note = "" } = {}) {
  const userLines = transcript.filter((m) => m.role === "user").map((m) => m.content);
  const firstUser = userLines[0] || note || "";
  const fallback = {
    subject: (note || firstUser).replace(/\s+/g, " ").slice(0, 60) || "用户申请人工客服",
    summary: [note && `用户补充：${note}`, ...userLines.slice(-3).map((l) => `用户：${l}`)].filter(Boolean).join("\n").slice(0, 1000),
    category: categoryFromText([note, ...userLines].join(" ")),
  };
  if (!transcript.length && !note) return fallback;
  try {
    const dialog = transcript
      .slice(-12)
      .map((m) => `${m.role === "user" ? "用户" : "AI客服"}：${String(m.content).slice(0, 400)}`)
      .join("\n");
    const prompt = [
      "你是客服主管。下面是一段用户与 AI 客服的对话，用户现在要求转人工。",
      "请只输出一个 JSON 对象，不要任何解释，字段：",
      `subject（不超过 30 字的一句话标题）、summary（不超过 200 字：用户的问题、AI 已给的答复、还缺什么信息）、category（只能是 ${CATEGORIES.join("/")} 之一）。`,
      note ? `用户转人工时补充说：${note}` : "",
      "对话：",
      dialog,
    ]
      .filter(Boolean)
      .join("\n");
    const { text } = await aiComplete(prompt);
    const jsonText = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    const parsed = JSON.parse(jsonText.slice(start, end + 1));
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : fallback.category;
    return {
      subject: String(parsed.subject || fallback.subject).slice(0, 120),
      summary: String(parsed.summary || fallback.summary).slice(0, 1000),
      category,
    };
  } catch (e) {
    console.warn("[support] summarize failed, using fallback:", (e && e.message) || e);
    return fallback;
  }
}

module.exports = {
  agentName,
  QUICK_QUESTIONS,
  loadKnowledge,
  selectKnowledge,
  buildSupportSystemPrompt,
  parseHandoff,
  HANDOFF_RE,
  summarizeTicket,
  categoryFromText,
};
