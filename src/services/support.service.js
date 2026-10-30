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
 *          isEnglishAsk, replyInEnglish, parseHandoff, HANDOFF_RE, stripHandoffTags, summarizeTicket, categoryFromText
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
  // 当前版本号从 §9.2 的标题里读（「最新版本：当前版 2.64（v2.64）…」），§9.3 收的最早一版从它的标题里读（「2.58 ~ 2.63 各版更新」），
  // 版本问法靠这两个数分去哪一节（见 versionExtras）
  const latest = merged.find((s) => /^9\.2\s/.test(s.title));
  const cur = latest && /当前版\s*v?(\d+\.\d+)/.exec(latest.title);
  const older = merged.find((s) => /^9\.3\s/.test(s.title));
  const floor = older && /^9\.3\s+(\d+\.\d+)\s*~/.exec(older.title);
  cache = { sections: merged, df, total: merged.length, currentVersion: cur ? cur[1] : null, olderFloor: floor ? floor[1] : null };
  return cache;
}

// 英文虚词：只从**一个汉字都没有**的那几行问话里剥（selectKnowledge 里），知识库正文与带汉字的问话一个词都不剥。
// 知识库里零星有几句英文界面原文（§4.4b 的「Voiceover is free, up to … per account per day」等），英文问法里的 is / to / up / per
// 会凭它们给这几节白加分（2026-10-20 量的：181 句英文问法里 §4.4b 被喂进去 68 次，只去掉虚词就降到 18 次，剩下的多是真在问
// 对话 / 语音价钱的）。
// ★ 别挪回 bigrams() 里两边一起剥（第一版就是那么写的，复核抓到）：那样带汉字的问话也被剥，表里一旦混进知识库的实词就悄悄改了
//   中文检索 ——「出片报错说没配 key 是怎么回事」原来 §4.8 排第 2，剥了之后 §4.5 / §4.8 最好的一节也只排第 13（「501 没配 key」「未配 key」）。只剥纯英文行，
//   带汉字的问话检索结果与没有这张表时逐字节相同（2026-10-20 拿 158 句带汉字的问法 × 往里插英文词的 12,008 个变体比过；
//   测试钉着 key 这一问与「纯英文多几个虚词结果不变」）。
// ★ key 不进表：知识库里出现它的只有「没配 key」那两节（§4.5 / §4.8），英文问「no API key」要的正是它们
const EN_STOPWORDS = new Set(
  ("a an the is am are was were be been being do does did done can could will would shall should may might must " +
    "to of in on at by for with from into onto about as up out off over than then so if or and but not " +
    "i me my mine you your yours we us our it its this that these those there here what which who whom whose how why where when " +
    "have has had get gets got getting just any some all more much many very really also still again one way please thanks thank " +
    "new start create type run head false true per")
    .split(/\s+/)
    .filter(Boolean),
);

/** 检索用：这一行一个汉字都没有、而且有连着两个以上的字母 —— 英文表（EN_GLOSSARY）与英文虚词只认这种行，带汉字的行一个都不碰 */
function latinLine(text) {
  const t = String(text || "");
  return !/[㐀-鿿]/.test(t) && /[a-z]{2,}/i.test(t);
}

// 不算「英文词」的：中文用户顺手打的应答 / 口头语，和产品里本来就用拉丁字母写的名字（缩写另由「全大写」挡掉，这里只收小写也会打的）
const NOT_EN_WORDS = new Set(
  ("ok okay okk hi hey hmm emm en haha hhh lol thx thks tks ty pls plz bye " +
    "token tokens app apk qq uid id vip hd ai ios iphone ipad android google github wechat")
    .split(/\s+/)
    .filter(Boolean),
);

// ★ 不是在说话的那几块整块不看（2026-10-20 复核）：链接、邮箱、带数字的串。客服会让人报任务号 / UID / 邮箱，中文用户常常只贴这一行 ——
//   方舟任务号「cgt-20251020150103-abx9z」里的 cgt 和 abx、邮箱「abc123@qq.com」里的 abc 和 com、「ideahubs.org/download」都凑得出两个「词」，
//   原来照样说死英文（main 上也一样，这次一起收）。按空白切块：块里有数字、@、://，或者字母.字母（域名、e.g.）就整块不算；
//   「failed.」这种句末句点不算字母.字母，「Is 1080p free?」去掉 1080p 还剩两个词
const NOT_PROSE_CHUNK = /\d|@|:\/\/|[A-Za-z]\.[A-Za-z]/;
// 笑声 / 语气词的变体（表里只收了 haha / hhh / emm / okk 这几个固定写法）：hhhh、hahaha、hehe、xixi、hmm、emmm、okkk
const FILLER_RE = /^(?:h{2,}|(?:ha){2,}h?|(?:he){2,}|(?:xi){2,}|h+m+|e+m+|o+k+)$/i;

/**
 * 提示词用：这一问是不是英文（路由拿这一轮的原话判，判出来是英文就在提示词里说死「这一轮用英文回答」并带上英文界面叫法表）。
 * 一个汉字都没有，而且至少有两个「英文词」：两个字母以上、不是全大写（QQ / UID / APK / VIP / HD / OK 是缩写）、不在上面那张表里、不是笑声；
 *   链接 / 邮箱 / 带数字的串整块不算（见 NOT_PROSE_CHUNK）。路由不直接调它，调的是下面的 replyInEnglish（短追问跟着上一问走）。
 * ★ 与检索的 latinLine 分开（2026-10-20 生产核对）：原来两边共用「没汉字 + 有两个字母」，中文用户追问一句「ok」「QQ」「token」「HD」，
 *   提示词就说死「用户这一问是英文，这一轮就用英文回答」（模型照做就是一整段英文）。真英文问法再短也有两个实词（merge failed / Refund please /
 *   thanks a lot）；只有一个词的（「Refund」「Help」）判不了，退回「默认用中文回复；用户用英文就用英文」那一句、让模型自己看。
 *   整句全大写的英文（HOW DO I UNDO）也落在这一档，同样只是不说死。
 * ★ 检索那边不跟着收：带汉字的行本来就不经过英文表（逐字节不变），只有一个拉丁词的行（「HD」「APK」）照旧走英文表 ——
 *   中文追问一句「HD」拿到「高清 档位」正是想要的
 */
function isEnglishAsk(text) {
  const t = String(text || "");
  if (!latinLine(t)) return false;
  const prose = t
    .split(/\s+/)
    .filter((c) => !NOT_PROSE_CHUNK.test(c))
    .join(" ");
  const words = (prose.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).filter(
    (w) => w.length >= 2 && w !== w.toUpperCase() && !NOT_EN_WORDS.has(w.toLowerCase()) && !FILLER_RE.test(w),
  );
  return words.length >= 2;
}

/**
 * 路由用：这一轮要不要在提示词里说死「用英文回答」。turns 是用户最近几问（旧 → 新，最后一条是这一问）。
 * 这一问是真英文 → 是；这一问一个汉字都没有、自己又判不了（「Why?」「Refund」「ok」、任务号、UID、👍）→ 跟着上一问走；其余 → 否。
 * ★ 为什么要看上一问（2026-10-20 复核）：isEnglishAsk 收紧之后，英文用户的短追问（「Why?」「Thanks!」「Refund?」、贴一个任务号）
 *   从「说死英文」退成了那句软话，而软话下真模型一问短英文有 1/6 回了整段中文（见 buildSupportSystemPrompt 头上）。
 *   中文会话里上一问是中文、这一条恒为否 —— 中文用户追问一句「ok」「QQ」照旧不说死（与只看这一问时逐字节相同）
 */
function replyInEnglish(turns) {
  const list = (Array.isArray(turns) ? turns : []).map((x) => String(x || ""));
  const last = list[list.length - 1] || "";
  if (isEnglishAsk(last)) return true;
  if (/[㐀-鿿]/.test(last) || list.length < 2) return false;
  return isEnglishAsk(list[list.length - 2]);
}

/** 中文按相邻两字切，英文/数字按整词；全部小写 */
function bigrams(text) {
  const out = [];
  const cleaned = String(text || "").toLowerCase();
  // 「app」不当词：标题里带「App」的四节（10.4 / 11 / 12 / 4.10）会凭它白拿标题加分，问话里一出现 app 就占掉前 5 的位置
  for (const word of cleaned.match(/[a-z0-9_@.]{2,}/g) || []) {
    if (word === "app") continue;
    out.push(word);
    // ★ 版本号「v2.63」整个是一个词，而用户多半只写「2.63」：2026-10-19 量的，58b934c 那份副本的 §9.2 标题只写了
    //   「当前版 v2.63」，「2.63 更新了什么」拿不到标题加分、掉到第 10。v + 数字.数字… 这一种形状另外再出一个去掉 v 的词
    //   （句末的英文句点不算进去），两种写法都对得上；只认这个形状，别的带点的词（support@ideahubs.org、1.25…）一个都不拆
    // ★ 「version2.63」「ver2.63」同理（2026-10-20 在主人手机上问客服时实测：输入法吞掉了空格，「What Is New In Version2.63」
    //   一节都没选到，模型回「手上没有 2.63 的完整更新说明」）。只多认这两个前缀词，别的「字母 + 版本号」照旧是一个整词
    const ver = /^(?:v|ver|version)(\d+(?:\.\d+)+)\.*$/.exec(word);
    if (ver) out.push(ver[1]);
  }
  const han = cleaned.replace(/[^㐀-鿿]/g, " ");
  for (const run of han.split(/\s+/)) {
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

// 剪辑页的「合成」（§3.8；2.62 及更早叫「合并」、主键叫「下一步」）。下面两条同义词共用这一个判据：剪辑页那条拿它加词，
// 「失败 → 敏感词」那条拿它让开 —— 两处各写一份的话，一处放宽、一处没跟，「剪辑页合成失败」又会被顶成 §4.8，或者反过来
// 把 AI 出片失败的问法也让掉（2026-10-19 复核抓到的就是后一种：那条原来写成「这一行有合成 / 合并二字就让开」，
// 「AI 合成视频失败了扣 token 吗」的 §4.8 掉出前 5、而剪辑页这条又没触发，两边都没带上）。
// ★ 语音合成 / 配音 / 合成预览图 / 挂卡合成 / 账号合并都不是这件事。
// ★ 「视频合成」「AI 合成」不算：用户嘴里多半是 AI 出片（「视频合成要多少钱」「视频合成失败了扣钱吗」）。原来算进来时，
//   「视频合成要多少钱」喂进去的只剩 §3.8（合成在本机做、不花 token），4.2 / 4.4 两节价钱都被挤掉 —— 往「不要钱」那边说错。
//   「视频合并」照旧算（AI 出片没有「合并」这个说法）
const CUT_MERGE_RE = /^(?!.*(语音|声音|配音|朗读|音色|预览图|挂卡|账号|帐号)).*(剪辑.{0,8}(合成|合并)|((?<!视频\s?|[Aa][Ii]\s?)合成|合并)(并去发布|失败|不了|不出|中|卡|取消|一直|好|完|要|花|扣|收费)|取消合成|成片.{0,4}(合成|合并)|(片段|几段|两段|多段).{0,4}(合并|合成)|视频.{0,4}合并|下一步.{0,6}(去哪|不见|没了|找不到|改名|变成))/;

// 「失败」这一支把 §4.8（AI 出片被拒、敏感词）顶上来。让开两种：登录失败 / 登不进（那是 2.x 登录那几节），以及这一行
// 命中 CUT_MERGE_RE 的剪辑页合成失败（§3.8 讲的是临时链接 403、取消、BUSY；2026-10-19 量的：不让开的话「剪辑页合成失败怎么办」
// 第 1 名是 §4.8）。带「敏感 / 拒绝 / 400 / 审核」的照旧算。
// ★ 由正则字面量的 .source 拼出来，不手抄剪辑页那条（同一条规则的第二处实现）；CUT_MERGE_RE 没有标志位，拼进来不丢东西。
//   它以 ^ 开头、整体是一个序列，放进行首的否定前瞻里就是「这一行整行命中它」
const LOGIN_FAIL_GUARD = /^(?!.*(登录|登陆)(了|还是|一直|总是|老是|又|就|时|的时候|，|,){0,3}(提示)?失败)(?!.*登不进)/;
const FAIL_SENSITIVE_RE = new RegExp(`${/敏感|拒绝|400|审核/.source}|${LOGIN_FAIL_GUARD.source}(?!(?:${CUT_MERGE_RE.source}))${/.*失败/.source}`);

// 问的是注销 / 删掉整个账号（§2.6）。两处用：「注销 → 软删除 恢复」那条同义词拿它加词，SECTION_VETOES 拿它（再加上找回账号）把 §3.6 挡在外面。
// ★ 销号 / 账号删了 / 删除账号这几种说法原来不在同义词里：「我要销号」一节都没喂进去（2026-10-20 量的）。只认「删」与「账号」
//   挨着的说法（删除账号 / 账号被删了）；「删掉账号里的卡片」「账号里删掉的草稿」删的不是账号，不算。
//   「找回账号」不进同义词：多半是忘了密码、被盗，喂注销那一节答偏了
const ACCOUNT_DELETE_RE = /注销|删号|销号|恢复账号|(删除|删掉|删了|删)(我的|这个)?(账号|帐号)(?![里中上内])|(账号|帐号)(被)?(删除|删掉|删了|销)/;

// 这一问像 X 时，某一节不喂（[判据, 小节标题里的一段字, 这一问里出现了就不拦]）。判据逐行看；「不拦」看整份查询（上一轮 + 这一轮）：
// 上一轮问的是删段、这一轮接着问注销（或者反过来）时照旧喂 —— 只在整份查询都与段 / 草稿无关时才挡。
// ★ 为什么要挡：§3.6「删掉一段与撤销」（2.63）正文里有「恢复 / 找回 / 删除」，问注销的那几句正好带着这几个字（扩展词里也有「软删除 … 恢复」）。
//   2026-10-20 生产核对量的：「注销了还能找回吗」§3.6 排第 2、「我想删号」第 3、「注销之后还能恢复吗」第 4、「注销账号之后还能恢复吗」第 5
//   —— 喂进去模型就可能把「6 秒内点撤销」说成注销也能撤回。只拿掉扩展词里的「软删除 / 恢复」挡不住（同日量的：用户原话自己就有找回 / 恢复，
//   「注销了还能找回吗」§3.6 仍排第 3、「注销之后还能恢复吗」「删号之后能恢复吗」第 5）。找回账号（忘了密码、被盗）也挡：§3.6 讲的是段，
//   对哪种找回账号都是噪音。英文「Can I recover my deleted account?」早由英文表的排除挡住（「删除 删掉」那条见了 account 不补）。
// ★ 标题按一段字认、不按编号认：知识库从 app 仓重新生成时编号会挪（测试钉着这一节还在、还认得出）
const ACCOUNT_RECOVER_RE = /找回(我的|这个)?(账号|帐号)|(账号|帐号)[^，。,.!?！？]{0,6}找回/;
// ★ 「不拦」也认英文的段 / 草稿（2026-10-20 复核）：中文问完注销、接着用英文问「how do I undo deleting a segment」，只认中文的话
//   §3.6 一节都不喂（main 上是第 1）。判据只看到中文的注销，英文那一行的段 / 草稿也得看得见
const SECTION_VETOES = [[new RegExp(`${ACCOUNT_DELETE_RE.source}|${ACCOUNT_RECOVER_RE.source}`), "删掉一段与撤销", /段|草稿|\b(segments?|clips?|drafts?|nodes?)\b/i]];

/** 常见口语 → 知识库用词，补几条同义词让检索更准（不是分类逻辑，只是召回） */
const SYNONYMS = [
  // 快捷问题「出片失败了，扣的 token 会退吗？」里只有「会退吗」「扣的」——原来两条都不认，检索掉到 11.2 充值订单
  // 不算退钱的：「会退出（登录）」「会退到 / 退回桌面、首页、上一步…」（「会退到哪 / 余额」是退钱）、「闪退」「退化」；「折扣的」不是扣费
  [/退钱|退款|退回(?!到?(?:首页|主页|桌面|后台|登录|上一|上个|上页))|(?<!闪)退吗|会退(?!出|化|回?到?(?:桌面|首页|主页|后台|登录|上一|上个|上页))|退不退|退没退|(?<!闪)退了吗|没(?:有)?退(?!出)|退了没|退还|返还|赔|补偿/, "计费 退款 退回 受理 原样退回 自动退回 不退"],
  [/扣钱|扣费|扣了|(?<!折)扣的|扣掉|花了|白花|多扣|钱呢|那钱(?!包)|钱怎么办|(token|余额)呢|还我(?!.{0,3}(头像|草稿|作品|视频|账号))|还给我|(?<!(验证码|短信|通知|消息).{0,4})收了.{0,3}(两|二|几)次|又收(?!到|藏)|重复(扣|收(?!到|藏))/i, "计费 退款 先扣钱 受理 自动退回 不退 取回"],
  [/收不到.{0,4}(退款|通知|消息)|(退款|通知|消息|提醒).{0,6}收不到|退款通知/, "通知 生成失败 token 已退回 2.61 及更早收不到 老师通知 2.57 及更早收不到"],
  // 「新人物卡 / 新人格 / 新人设」不是新人额度；「每天发几条弹幕 / 发布几个」「2000 字 / 元 / 年」不是每天补的那 2,000
  [/每个?月.{0,4}(送|给|刷新|发(?!.{0,4}(布|帖|作品|弹幕|评论|视频)))|按月|(?<![\d.])30\s*万|300\s*k|(?<![\d,])300,?000(?![\d,])/i, "额度 免费版 不再按月发 改版前 300,000 老账号 每天 2,000 钱包"],
  [/新人(?!物|格|设|类)|17\s*万|170,?000|170k|注册送|送了?多少/i, "钱包 套餐 额度 新人额度 老账号 170,000"],
  [/每天.{0,6}(补|送|到账)|每天.{0,4}发(?!.{0,4}(布|帖|作品|弹幕|评论|视频))|每日.{0,4}(补|额度)|(?<![\d,])2,?000(?![\d,]|字|元|块|年)|几点(补|重置|刷新)/, "每天 2,000 额度 UTC 0 点 补到 14,000 每日用量上限"],
  [/token|额度|余额|不够|不足|充的钱|钱.{0,2}(丢了|不见了|没了|少了)/i, "token 钱包 套餐 额度 扣减 余额不足"],
  // 问 AI 客服 / 数字人自己收不收钱：每轮 400 + 开着声音时按字符扣（§4.4）
  [/^(?!.*(退|赔|补偿|要回|被扣|扣了|扣掉|没出|取回|失败|去哪|不见|少了)).*(客服|小梦|聊天|陪聊|问你|数字人|试聊).{0,6}(钱|收费|token|扣)/, "AI 客服 数字人陪聊 对话 400 语音合成 按字符 token 每日上限"],
  [/取回|没出片|没结果|一直转|卡住|等很久|没生成|^(?!.*(最长|最短|最多(?!.{0,3}等)|(能|可以)(做|出|生成|拍)(出)?(多久|多长|几秒))).*(?:(出片|生成|视频|出来).{0,6}(要多久|多长时间|几分钟|多久)|(要多久|多长时间|多久).{0,4}(出片|生成|出来|出成|算))|要等多久|等了?多久/, "取回 凭据 24 小时 任务 二次付费 出片 放弃等待的上限"],
  [/最长|最短|最多(?!.{0,4}(等|保留|留|放|存)).{0,8}(多久|多长|几秒)|多少秒|几秒|时长|秒数/, "时长 按档位 下限 档位 数量限制"],
  // 「草稿」也是一个档位名（2.62）。明说档位的（极速 / 草稿档 / 高清 / 电影级…）一律算档位；光说「草稿」的，问画质 /
  // 价钱 / 能不能用 / 多长时才算档位，句子里带草稿箱、丢、换手机、卸载、存几条、打开这些词的归草稿箱（第二条整条让开）。
  // ★ 扩展词里不放「草稿」二字：它会把 3.2 草稿那几节的分数也抬上去，档位 / 价钱问题的 4.2 / 4.4 就掉出前 5
  [/极速|草稿档|高清|电影级|档位|会员档|免费版.{0,4}(能用|只能)|免费(用户|账号|的人)|没(付|充)过?钱|哪些档|什么档/i, "档位 免费版 付过钱 极速 高清 电影级 会员档 480p"],
  [/^(?!.*(草稿箱|草稿库|存.{0,2}草稿|草稿.{0,6}存(?!在)|丢|不见|没了|找回|换手机|换了手机|卸载|重装|同步|保存|存几|几条|20条|打开))(?:.*(草稿(?!箱|库).{0,8}(分辨率|画质|清晰|糊|多少钱|价|便宜|贵|token|能用|可以用|480|几秒|多长|模型|收费|要钱|免费|花|扣|费|一段|出片)|(免费|只能|能用|可以用).{0,6}草稿(?!箱|库)|草稿和(高清|极速|标准|电影级)|(高清|极速|标准|电影级)和草稿))/i, "档位 免费版 付过钱 极速 高清 电影级 会员档 480p"],
  [/样片|定稿|1080/i, "样片 定稿 1080p 480p 电影级"],
  // 出图档「定妆」2.63 撤了（§4.3）：「定妆档怎么没了」只靠正文里一个「定妆」，§4.3 排第 5（2026-10-19 量的）。
  // ★ 「主角定妆 · 多镜头」是一种做法的名字、还在，不加词
  [/(?<!主角)定妆/, "出图档位 速写 精绘"],
  [/充值|买|订阅|套餐|付费|支付/, "充值 套餐 支付渠道 订单"],
  [/苹果|iphone|ios|ipad/i, "iOS 安卓安装包 下载页"],
  // 「去升级 / 升级套餐 / 升级会员」是买套餐，不是装新版
  [/装不上|应用未安装|安装失败|更新不了|(?<!去)升级(?!.{0,3}(套餐|会员|档))/, "应用未安装 签名 卸载 更新 versionCode"],
  // 判据在上面的 ACCOUNT_DELETE_RE（与 SECTION_VETOES 共用）
  [ACCOUNT_DELETE_RE, "注销 软删除 support@ideahubs.org 恢复"],
  [/密码|登不上|登不进|登录不了|验证码|(?<!(通知|退款|消息|提醒).{0,6})收不到(?!.{0,4}(通知|退款|消息|提醒))/, "密码 验证码 登录 限流 重置"],
  [/改名|用户名|昵称|头像/, "昵称 用户名 username displayName 头像"],
  // 「token / 余额 / 钱不见了」不是草稿箱
  [/草稿(?!档)|(?<!(token|余额|钱|额度).{0,4})(丢了|不见了)|换手机/i, "草稿 草稿箱 IndexedDB 本机 卸载 换设备 20 条"],
  // 2.63 删段 / 删草稿 6 秒内能「撤销」（§3.6 / §3.2 用的词是「撤销」），用户说的是撤回 / 找回 / 恢复 / 还原 / 放回。
  // ★ 只认「删」领着的（或「误删 / 删错」本身）：注销、删号、账号、作品、评论、卡片…删了能不能恢复是别的事，那些没有 6 秒撤销；
  //   剪辑页的片段删了是「＋ 段N」加回来，也不是这一条。只加「撤销」一个词：段还是草稿由原话自己分（加「删掉一段」的话
  //   「删草稿能撤销吗」第 1 名会变成 §3.6；加「轻提示」会把 §2.10 也拉进来）。2026-10-19 拿 11 句正例、12 句反例逐句跑过，
  //   检索结果钉在 tests/support.spec.js
  [/^(?!.*(注销|删号|账号|帐号|作品|评论|弹幕|私信|卡片|卡组|人物卡|模板|视频|消息|好友|关注|剪辑|头像|昵称|简介|封面)).*(删[^，。,.!?！？]{0,8}(撤回|撤销|撤消|恢复|找回|还原|放回|反悔)|(撤回|撤销|撤消|恢复|找回|还原|放回)[^，。,.!?！？]{0,6}删|误删|删错)/, "撤销"],
  // 2.63 工作流画布右上角的缩放键（§3.7）。★ 要有「画布 / 工作流 / 段卡」在场：视频全屏、看图放大、字幕字号、头像裁剪都不是这一节
  [/(画布|工作流|段卡).{0,10}(放大|缩小|缩放|太小|太大|看不清|看不全|看全|找不到|挤|1:1|原来大小|原大小)|(放大|缩小|缩放).{0,6}(画布|工作流)/, "工作流画布 放大 缩小 缩放"],
  // 「出的视频没声音」是档位不出环境音，不是铸卡师的中文语音包
  [/(视频|片子|成片|出片|出的片|生成的).{0,6}(没声音|没有声音|无声|静音|没声)/, "环境音 档位 极速 标准 草稿 高清 无声 白模"],
  [/(?<!(视频|片子|成片|出片).{0,6})没声音|不出声|语音|音色/, "语音 TTS 中文语音包 音色"],
  [/配音|旁白|朗读/, "配音 剪辑页 字幕 语音合成 按字数 token 新版免费 每天 1,000 个字符"],
  // 「试听音色要扣钱吗」只靠「音色」那条时，前 5 节里没有 4.4b（试听一次 858 token 写在那一节），2026-10-09 量的。
  // ★ 只认问「试听本身要不要钱」的问法：钱字在试听**后面**（试听要付费吗 / 试听扣钱吗），或者是扣 / 钱 / 收费在前面（要花钱才能试听吗）。
  //   「付费X能试听吗」（付费模板 / 付费人格 / 付费课程）里的付费是在说 X，不加词 —— 那几问要的是人格市场、模板、启梦老师那几节；
  //   不带钱字的「试听」（模板能试听吗、启梦老师有试听课吗）也不加。2026-10-09 拿二十来句正反例探过
  [/试听.{0,6}(付费|收费|扣|钱|费用|token)|(扣|钱|收费|费用|token).{0,10}试听/i, "试听 858 声音面板 混音 按字符扣"],
  [/(铸|炼|做|画)卡(?!师|通)|卡面|卡片.{0,4}(生成|失败|没画)/, "铸卡 卡面 原图 顶上 可能已经扣了 自己传图做卡片"],
  [/回炉|改内容|换内容|重新剪|改成片|发布.{0,6}(改|换)/, "回炉重做 换内容 编辑页 工坊工程 弹幕 版次"],
  [/下架|举报|申诉|封禁|封号/, "下架 举报 封禁 管理员 处置"],
  // ── 2.64（2026-10-21）新加的几处：问法里的词知识库正文多半也有，但新小节都写着「2.64 起」，一个「2.64」就把它们一起抬上来，
  //    短的 §1.9 常把真正该答的那一节挤到第 6、7 名（10-21 拿 62 句探针量的）。每条都只补那一节标题 / 正文里的原词
  // 拉黑（§2.9）：主页上拉黑是 2.64 新加的，「怎么在主页拉黑」§2.9 原来排第 6。
  // ★「屏蔽弹幕」是关掉弹幕显示（§6.4 的总开关），不是拉黑人 —— 不让开的话 §6.4 整个掉出去（10-21 复核量的）；「屏蔽这个人的弹幕」照旧算拉黑
  // ★「提示词 / 出片被屏蔽」是内容审核（§4.8 敏感词），没点到人的时候让开（10-21 第二轮复核）；补一个 §2.9 标题里的「黑名单」，
  //   免得短的 §1.9 凭「拉黑」排到它前面
  [/拉黑|黑名单|^(?!(?!.*(这个人|那个人|(?<!其)他|她|用户|作者|某人|别人|对方)).*(敏感|违禁|违规|审核|词|出片|生成|推演|铸卡|要求|描述)).*屏蔽(?!.{0,3}弹幕)/, "拉黑 双向 已拉黑的人 不是举报 黑名单"],
  // 关掉弹幕显示（§6.4，2.64 写进知识库的那颗总开关）。「弹幕能关吗 / 关了 / 关不掉」都要认，「关注 / 关于 / 关系」不是
  [/(关|屏蔽|隐藏|不看|不想看|挡|看不到|看不见).{0,4}弹幕|弹幕.{0,6}(关(?!注|于|系)|挡住?|太多|隐藏|不见了|没了|消失)/, "弹幕 开关 关闭弹幕显示"],
  // 发弹幕失败（§6.4：上限 40 字、走服务端、不做乐观插入）—— §6.4 加了开关那一条变长之后，这一问它掉出过前 5
  [/弹幕.{0,6}(发不|发送失败|没发出|失败)|发.{0,2}弹幕.{0,6}(失败|不了|没反应|没显示)/, "弹幕上限 40 字 走服务端 不做乐观插入 发弹幕"],
  // 倍速 / 快进（§1.6）：「更新到 2.64 后倍速在哪」里的版本号把 §9.2 / §7.4 这些带「2.64」的节抬上来，§1.6 落到第 4
  [/倍速|快进/, "倍速 首页 长按菜单 更多操作"],
  // 清屏 / 转屏观看（§1.6）：「清屏观看怎么退出」的「退出」会把退出登录那一节顶到第一
  [/清屏|转屏观看/, "清屏观看 收起按钮和文字 缩小键 按返回"],
  // 没登录点「+」关注（§1.6）：原来一节都排不上（第 7）
  [/(没|不|未)登录.{0,8}关注|关注.{0,8}(没|不|未)登录/, "没登录也能点「+」关注 首页 头像"],
  // 更新后「我的卡片 / 卡组 / 模板 / 3D 工坊入口不见了」：挪进了创意工坊的「我的仓库」（§1.7）；「更新后我的卡片不见了」§1.7 原来只排第 5。
  // ★ 只让开声音那几个词与「取回」：「模板原声没了」是白模成片无声（§3.8 / §4.2），「取回的卡片」是出片的取回卡；
  //   删 / 下架不让开 ——「更新后卡片都没了，是不是被删了」正是这一条要接住的问法（10-21 复核）
  [/^(?!.*(声音|原声|音轨|配乐|音乐|配音|取回))(?:.*(卡片|卡组|模板|3D ?工坊|从市场添加).{0,8}(不见|没了|找不到|消失|去哪)|.*(找不到|不见了).{0,6}(卡片|卡组|模板|3D ?工坊))/i, "我的仓库 不见了 创意工坊"],
  // 模板 / 白模成片没声音（§3.8：「选的那条音轨本身没有声音（多半是白模模板的原片…）」）：§3.9 标题里的「模板的」把 §3.8 挤出过前 5。
  // ★ 语音合成、数字人、老师、配音这些「合成的声音」让开
  [/^(?!.*(样本|数字人|老师|铸卡师|配音|语音|混音|音色|试听|客服|看板娘)).*(模板|白模|原片|合成(?!器)).{0,10}(原声|声音|配乐|音乐|音轨|哑|无声)/, "剪辑页合成 音轨 模板原声 白模 无声"],
  // 对话正反打 / 九宫格那张图上的 ⚠（§4.3b）。★ 要有图 / 格子 / 机位这类上下文：App 里 ⚠ 到处都是（个人页待上传横幅、发布页渐变回退、
  //   做模板的真人面孔提示、档位提示），光认 ⚠ 会把满是「不退」的 §4.3b 顶到每一问的第一名（10-21 复核量的）
  [/(九宫格|正反打|机位|格子|这一格|这一张|过肩|双人镜头|分镜|图片?|画面).{0,12}(感叹号|⚠|警告)|(感叹号|⚠|警告(标|图标|符号)).{0,12}(九宫格|正反打|机位|格子|这一格|这一张|过肩|双人镜头|分镜|画面里|拼图|同一个人)|没核对上/, "⚠ AI 看一遍 机位 九宫格"],
  // 草稿那格的锁变成了笔（§1.9）：「草稿上的锁不见了 / 草稿的锁变成笔了」原来一节都排不上 §1.9。
  // ★ 只认「图标变了」的说法：「那笔钱 / 这笔 token」的笔是量词，「段锁着 / 锁住 / 解锁 / 锁屏」的锁是别的事
  [/(?<!解)锁(?![着住定屏])(的?图标)?.{0,3}(不见|没了|没有了|消失|变成|换成|成了)|(没有|没|不见|少了)(那把|小)?锁(?![着住定屏])|(变成|换成|成了)(一支|一只|一个|个)?笔(?![钱账费款单])|(一支|一只)笔|笔(形|的)?图标|草稿.{0,10}铅笔(?![素画风])|铅笔(?![素画风]).{0,10}草稿/, "草稿 笔形图标 未发布 仅自己可见"],
  // 「修这一段」的钱（§4.4d）：只改几秒也按整段计价，原来「修这一段要多少钱」「只改其中几秒会便宜吗」一节都排不上 §4.4d
  [/修这一段|重拍这一段|只改(其中|中间)?(几|[0-9０-９一二两三四五六七八九十]+)秒/, "片段重拍 计价 整段"],
  // 保存到本地（§6.7）：§4.4d 原来的标题带「视频」时把它挤掉过；要以作品 / 视频为对象，装 App、更新、草稿、卡片、模板让开
  [/^(?!.*(安装包|apk|app|启梦|新版|更新|草稿|卡片|模板))(?:.*(视频|作品|成片|片子)[^，。,.!?！？]{0,8}(下载|保存|存到|存进|导出)|.*(下载|保存|导出)[^，。,.!?！？]{0,6}(视频|作品|成片|片子)|.*(视频|作品|成片|片子)[^，。,.!?！？]{0,8}(相册|图库))/i, "保存到本地"],
  // 装新版（§7.2）：「我手机上是 2.61，怎么更新到 2.64」原来 §7.2 一节都没喂进去 —— 版本号把 §9.2 / §9.3 这些长节抬了上来。
  // ★ 要有版本 / App 这个对象在场；改头像 / 昵称 / 作品内容、升级套餐 / 档位、问「更新了什么」的都让开。
  // ★ 「更新到 2.64 之后 X 在哪 / X 不好用」「更新了 2.64，X 怎么用」是发版后最常见的问法，问的是 X、不是怎么更新 ——
  //   第一版这条一律把 §7.2 / §7.3 顶上去，§1.6、§2.3 这些真要答的节被挤掉（10-21 第二轮复核量的）。所以「更新之后 / 以后」、
  //   整行只是「我更新了」、以及「更新了 / 更新完 X，」后面接的不是更新这件事的，都让开（「更新不了」不算过去时）
  [/^(?!.*(头像|昵称|简介|资料|作品|内容|模板|卡片|卡组|草稿|套餐|会员|密码|手机号|邮箱|高清|电影级|极速|真人档|档位|付费|专业版))(?!.*更新(了|的)?(什么|啥|哪些|内容|说明|日志))(?!.*(更新|升级)[^，。,;；？?！!\n]{0,12}(之后|以后|后))(?!\s*我?(刚刚?|已经|已|才)?(更新|升级)了?(到|成)?\s*(app|启梦|新版本?|最新版本?|最新的?|v?\d+\.\d{2})(版本?)?了?\s*[。.!！~～]?\s*$)(?!.*(更新|升级)(?:(?!不了)[^，。,;；？?！!\n]){0,10}(?<!不)了[^，。,;；？?！!\n]{0,8}[，,；;。](?!.*(更新|升级|提示|弹|安装|下载|装)))(?=.*(\d+\.\d{2}|版本|新版|最新|app|启梦|安装包|安全)).*(更新|升级)/i, "更新机制 立即更新 官网下载页"],
  // AI 客服用哪种语言回答（§7 那一行，2.64 起跟着界面语言）。★ 老师 / 数字人 / 视频里人物的台词让开
  [/^(?!.*(老师|数字人|台词|视频|人物|配音)).*((客服|小梦).{0,12}(英文|中文|语言|English)|(英文|中文|语言).{0,8}(回答|回复))/i, "AI 客服 问小梦 用哪种语言回答 界面语言"],
  [/隐私|数据|服务器在哪|香港/, "隐私 服务器 香港 第三方 保留"],
  [/(qq|微信|手机号?|邮箱).{0,4}(登录|登陆)|(登录|登陆)(了|还是|一直|总是|老是|又|就|时|的时候|，|,){0,3}(提示)?(失败|不了|不上|不进去)|登不进|进不去账号/i, "登录方式 QQ 微信 手机号 邮箱 登录 验证码"],
  // 2.63 Google / GitHub 从浏览器回 App 的核对（§2.10：「忽略了一条不是本机发起的登录链接」「登录链接过期了」）。
  // ★ 必须带「登录链接」或 Google / GitHub / 本机发起：光说「登录过期了」多半是登录状态过期（App 说「登录状态过期了 /
  //   登录已过期，请重新登录」，401），不是这一节；「分享链接 / 下载链接过期」也不是
  [/(登录|登陆|授权)链接|本机发起|(google|谷歌|github)[^，。,.!?！？]{0,12}(回来|回到|回不|跳回|没反应|过期|忽略|卡住|停在)/i, "Google GitHub 登录链接 忽略 过期 本机发起"],
  // 在 Google / GitHub 的页面上点了「取消」/ 拒绝授权（§2.10：2026-10-20 起会回到 App 登录页、没登上、不扣钱）。上一条只认回不来 / 过期，
  // 「我在谷歌登录页点了取消，现在怎么办」「谷歌登录取消了」§2.10 只排第 4（2026-10-20 生产核对量的）。
  // ★ 要 Google / GitHub 在场：光说「取消」（取消订阅 / 合成 / 关注 / 授权）不是这一节。整行带订阅 / 续费 / 商店 / Play / 下载 / 安装 /
  //   更新的让开：「Google Play 上的订阅怎么取消」是买东西，「GitHub 下载到一半取消了」是装包（§7.2 的 GitHub 镜像）。
  //   「取消」在前的那种要紧跟登录 / 授权（「取消了谷歌登录」），免得「取消……谷歌」隔着半句话凑上
  [/^(?!.*(订阅|续费|商店|play|下载|安装|更新|升级|apk))(?:.*(google|谷歌|github)[^，。,.!?！？]{0,12}(取消|拒绝|不同意|没同意|不授权|没授权)|.*(取消|拒绝)了?[^，。,.!?！？]{0,4}(google|谷歌|github)[^，。,.!?！？]{0,4}(登录|登陆|授权))/i, "Google GitHub 登录链接 忽略 过期 本机发起"],
  // 剪辑页的「合成」：判据在上面的 CUT_MERGE_RE（与下一条共用）
  [CUT_MERGE_RE, "剪辑页 合成 合并"],
  // 「失败 → 敏感词」：让开登录失败与剪辑页合成失败，判据见上面的 FAIL_SENSITIVE_RE
  [FAIL_SENSITIVE_RE, "敏感词 400 失败 InputTextSensitiveContentDetected"],
  [/无缝|衔接|圈选|不按我/, "无缝 软引导 圈选 承接段"],
  [/客服|人工|联系|邮箱|投诉/, "客服 support@ideahubs.org 人工"],
  // ── 英文问法（2026-10-19）：知识库是中文、英文按整词比，「Can I undo deleting a segment?」「How do I update the app?」
  //    一节都打不中，只能在这里把意思换成知识库的用词。只收 2.63 这几件；每条都要动作 + 对象两个意思同时在场，
  //    单个常见词（update / delete / link / merge）不加词，免得把无关的英文问法拉偏
  // 删了能不能撤销：「撤销」+ 删的是什么（草稿 → §3.2，其余按段 → §3.6）。账号 / 作品 / 评论 / 卡片删了不是这件事
  [/^(?!.*\b(accounts?|works?|posts?|videos?|comments?|cards?|decks?)\b)(?=.*\b(undo|undelete|restore|recover|get\s+(it|them)\s+back|bring\s+(it|them)\s+back)\b)(?=.*\b(un)?(delet|remov)\w*).*\bdrafts?\b/i, "撤销 删草稿 草稿箱"],
  [/^(?!.*\b(accounts?|works?|posts?|videos?|comments?|cards?|decks?|drafts?)\b)(?=.*\b(undo|undelete|restore|recover|get\s+(it|them)\s+back|bring\s+(it|them)\s+back)\b)(?=.*\b(un)?(delet|remov)\w*)/i, "撤销 删掉一段"],
  [/\b(zoom|pinch|scale)\w*\b.{0,40}\b(canvas|workflow|nodes?)\b|\b(canvas|workflow)\b.{0,40}\b(zoom\w*|pinch\w*|too\s+small|tiny|bigger|larger|fit)\b/i, "工作流画布 放大 缩小 缩放"],
  // 装新版（§7.2）：update / upgrade 要与「App / 版本 / 最新」这个对象同时在场；「被强制 / 必须更新」只认 update
  // （Will I be forced to update?）；「版本 / 更新 + 是不是强制的」也算（Is version 2.63 forced? / Is the update mandatory?）。★ 光说 upgrade 多半是买套餐：App 英文界面里会员档那颗「去升级」
  // 就是 "Upgrade"（app 仓 en.po），与上面中文那条「去升级 / 升级套餐」让开是同一个口径 ——「Do I need to upgrade?」
  // 「I want to upgrade to premium to use HD」原来第 1 名是 §7.2、把 §4.2 视频档位挤掉了（2026-10-19 复核抓到）。
  // 句子里说的是昵称 / 资料 / 付款方式 / 套餐 / 会员 / 余额 / 画质档位这些的，整句不算
  [/^(?!.*\b(nicknames?|names?|usernames?|profiles?|avatars?|bios?|emails?|passwords?|phones?|payments?|cards?|drafts?|captions?|plans?|subscriptions?|tiers?|memberships?|members?|premium|pro|vip|accounts?|balances?|wallets?|tokens?|credits?|prices?|pricing|hd|cinema)\b)(?:.*\b(updat|upgrad)(e|es|ed|ing)\b.*\b(app|apps|application|version|versions|apk|build|release|latest|newest)\b|.*\b(app|apps|application|version|versions|apk|build|release|latest|newest)\b.*\b(updat|upgrad)(e|es|ed|ing)\b|.*\b(forced?|forcing|mandatory|required|must|have\s+to|has\s+to|keeps?\s+(asking|telling|prompting))\b.{0,30}\bupdat(e|es|ed|ing)\b|.*\b(version|updat(e|es|ed|ing)|v?\d+\.\d+)\b.{0,30}\b(forced|mandatory|required|compulsory)\b)/i, "更新机制 检查更新 必须更新 新版本"],
  [/\bwhat'?s\s+new\b|\bchangelog\b|\brelease\s+notes?\b|\b(new|latest|current)\s+version\b/i, "最新版本 当前版 更新"],
  [/\b(sign[\s-]?in|log[\s-]?in|login)\b.{0,12}\blinks?\b|\b(google|github)\b.{0,40}\b(sign[\s-]?in|log[\s-]?in|login)\b.{0,40}\b(back|return\w*|stuck|nothing|expired|ignored)\b/i, "Google GitHub 登录链接 忽略 过期 本机发起"],
  [/^(?!.*\baccounts?\b).*(\bmerg\w*\b.{0,40}\b(fail\w*|error|cancel\w*|stuck|slow|cost|free)\b|\b(fail\w*|error|cancel\w*|can'?t)\b.{0,40}\bmerg\w*\b|\bmerge\s*&\s*go\b)/i, "剪辑页 合成 合并"],
];

// ── 英文问法 → 知识库用词（2026-10-20）────────────────────────────────
// 知识库是中文的，英文问法按整词比只打得中零星几个英文词（token / Google / UID…），50 句常见英文问法只有 23 句能把对的那一节
// 排进前 3、真的喂给模型（中文同一批 48 句）。这里按「英文词 → 知识库里那个中文词」补词，只对**一个汉字都没有**的那一行生效：
// 中文问法（哪怕夹着 token / App / Google）一行都不经过这张表，检索结果逐字节不变。
// ★ 补的是知识库原文里的词（多数取小节标题里的说法），不是意译；英文界面的叫法照 app 仓 en.po（Cinematic / Refined / Card smith /
//   Remake / Recover / Undo…），用户照着屏幕上的英文问。
// ★ 一条只认一个意思：「plan」是套餐、「update」交给上面那条动作 + 对象的规则。「draft」在英文界面里是草稿箱（Drafts）与
//   电影级的样片（preview draft）；出片档位「草稿」英文叫 **Lite**，不叫 Draft（v2.62 / v2.63 en.po 都是），各走各的那一条。
//   别把整句意思写进来（那是上面 SYNONYMS 的事），也别给太泛的词（video / app / use）补词。
// ★ 为什么不先请模型把问题译成中文再检索：每句英文问话多一次对话、首句跟着晚。2026-10-20 在方舟上拿同一个模型
//   （deepseek-v4-flash）量的：关思考约 1.9 秒 / 约 ¥0.0004 一问，默认思考（生产没关）4.4~6.1 秒 / 约 ¥0.003~0.005 一问；
//   而且译出来的话照样未必是知识库的用词（「My clips don't line up」译成「对不齐」，「衔接 / 无缝」那两节一样排不上）。
//   这张表零成本、零延迟、能在测试里逐句钉住。量法与结果：50 句英文问法 23 → 49 句排进前 3；另写的三批 52 / 38 / 31 句
//   26 → 51、14 → 38、10 → 28（最后一批在调表之前先跑过一次是 19）；复核另写的 37 句 18 → 32（Lite / 画布 / 更新弹层三条是
//   照着它补的，不算盲测）。带汉字的问话一行都不经过这张表：158 句 × 插英文词的 12,008 个变体，检索结果与没有这张表时逐字节相同。
const EN_GLOSSARY = [
  // 钱
  // 这两条补的词与中文「退钱 / 扣钱」那两条同义词一样（钱的问法要的是 §4.5 / §4.6，光补「退款」「扣费」排不上去）
  [/\brefund\w*|\b(money|tokens?|credits?)\s+back\b|\breimburs\w*|\b(tokens?|money|credits?)\b.{0,25}\breturn(ed)?\b|\breturn\w*\s+(my\s+|the\s+)?(tokens?|money|credits?)\b/i, "计费 退款 退回 受理 原样退回 自动退回 不退"],
  [/\b(charg|deduct|bill)\w*|\bpaid\b|\bspent\b/i, "计费 退款 先扣钱 受理 自动退回 不退 取回"],
  [/\bcosts?\b|\bcosting\b|\bprices?\b|\bpricing\b|\bfees?\b|\bhow\s+much\b|\bexpensive\b|\bcheap\w*/i, "多少钱 价格"],
  [/\bfree\b/i, "免费"],
  [/\bplans?\b|\bsubscri\w*|\bmembership\b|\bpremium\b/i, "套餐"],
  [/\b(standard|pro|professional)\s+(plan|package|subscription|membership)s?\b/i, "标准套餐 专业套餐"],
  [/\btop[\s-]?up\w*|\brecharg\w*|\b(buy|purchas)\w*|\bpay(ing|ment|ments)?\b/i, "充值 支付"],
  [/\bwallet\b|\bbalance\b/i, "钱包 余额"],
  [/\bcash\s*(it\s+)?out\b|\bwithdraw\w*|\bcash\b|\bredeem\w*/i, "提现 现金"],
  [/\bdaily\b|\b(each|every|per|a)\s+day\b/i, "每天"],
  [/\bquota\b|\ballowance\b|\bcredits?\b|\blimit\w*/i, "额度"],
  // 出片
  [/\bgenerat\w*|\brender\w*/i, "出片 生成"],
  [/\bfail\w*|\berrors?\b|\bdidn'?t\s+work\b/i, "失败"],
  [/\bstuck\b|\bnever\s+(finish|complet|came|arriv)\w*|\bno\s+result\w*|\bstill\s+(processing|generating|waiting|loading)\b|\btak\w+\s+(so|too)\s+long\b|\bpending\b|\bspinn\w*|\bkeeps?\s+(loading|spinning|going)\b|\bnever\s+(appear|show)\w*/i, "没结果 取回 凭据 二次付费"],
  // 出片中途关掉 App / 切走：任务照跑，回来用「取回」（§4.6）
  [/\b(close|quit|leave|exit|kill)\w*\s+(the\s+)?app\b.{0,40}\b(generat|render)\w*|\b(generat|render)\w*.{0,40}\b(close|quit|leave|exit|kill)\w*\s+(the\s+)?app\b/i, "取回 凭据 离开"],
  // 「取回」是领出片结果（§4.6）；找回密码 / 账号 / 评论不是
  [/^(?!.*\b(accounts?|passwords?|comments?|drafts?|usernames?)\b).*(\brecover\w*|\bretriev\w*|\bget\s+(it|them|this|that|my\s+(video|clip|segment)s?)\s+back\b)/i, "取回 凭据"],
  // 成片留多久（方舟档 24 小时）
  [/\bhow\s+long\b.{0,25}\b(kept|stored|saved|available|valid|last)\b|\b(videos?|clips?|results?)\b.{0,20}\bexpir\w*/i, "保留 24 小时 取回 过期"],
  [/\btiers?\b|\bquality\b|\bresolution\b/i, "档位"],
  // 档名（照 en.po）带上「档位」：「How many tokens does one HD video take」只靠「高清」一个词，压不过满篇 token 的钱包那几节
  [/\bcinematic\b|\bcinema\b/i, "电影级 档位"],
  [/\bhd\b|\b720p\b/i, "高清 档位"],
  // 出片档位「草稿」（2.0 mini 480p）在英文界面叫 Lite（en.po 那一条的 msgctxt 写明了「不是草稿箱的草稿，也不是电影级的样片」）
  [/\blite\b/i, "草稿 档位 480p"],
  [/\bpreview\s+drafts?\b|\bsample\s+(mode|clip|video)s?\b/i, "样片 定稿"],
  [/\blongest\b|\bmax(imum)?\s+(length|duration|seconds?)\b|\bhow\s+long\s+can\b|\bduration\b/i, "时长 最长"],
  [/\bseamless\w*|\b(connect|transition|continu)\w*|\b(match|line)\s+up\b|\bjump\w*\s+between\b|\b(characters?|faces?|people|person)\b.{0,20}\b(look|looks|looked)\s+different\b|\binconsisten\w*/i, "衔接 无缝 承接"],
  // ★ 不认 muted：首页视频静音自动播放（点一下开声）不是这两件事
  [/\bno\s+(sound|audio)\b|\bsilent\b|\bwithout\s+(sound|audio)\b|\bcan'?t\s+hear\b/i, "没声音 无声"],
  // 出的片子没声音是档位不出环境音（§4.2），不是铸卡师的中文语音包 —— 与中文那条同一个分法
  [/\b(videos?|clips?|generated|output|results?|segments?)\b.{0,30}(\bno\s+(sound|audio)\b|\bsilent\b|\bwithout\s+(sound|audio)\b)/i, "环境音 档位 无声 白模"],
  [/\bcard\s*smith\b/i, "铸卡师"],
  [/\bvoice[\s-]?overs?\b|\bnarrat\w*/i, "配音 旁白"],
  // 试听音色（§4.4b：点一次扣一次）
  [/\bvoice\s+(preview|sample|demo)s?\b|\b(preview|try|test)\w*\s+(a\s+|the\s+)?voices?\b/i, "试听 858 声音面板"],
  [/\bchat\w*|\btalk\w*\s+(to|with)\s+(you|support|the\s+bot)\b|\b(customer\s+)?support\b|\bassistant\b|\bask(ing)?\s+(you|questions)\b/i, "客服 对话"],
  // 问客服 / 数字人自己收不收钱（§4.4b）：与中文「客服 … 钱」那条补同一批词
  [/^(?=.*(\bchat\w*|\btalk\w*\s+(to|with)\s+(you|support)\b|\bsupport\b|\bassistant\b|\bask(ing)?\s+(you|questions)\b|\bcompanion\b))(?=.*(\bcosts?\b|\btokens?\b|\bcharg\w*|\bfree\b|\bpay\w*|\bprice\w*|\buse\s+up\b))/i, "AI 客服 数字人陪聊 对话 400 语音合成 按字符 每日上限"],
  [/\bcards?\b/i, "卡片 铸卡"],
  [/\brefined\b/i, "定妆 出图档位"],
  [/\bsketch\b/i, "速写 出图档位"],
  [/\bimage\s+tiers?\b/i, "出图档位"],
  [/\btemplates?\b/i, "模板"],
  // 剪辑、草稿、发布
  [/\bmerg\w*|\bcombin\w*|\bexport\w*/i, "合成 合并"],
  [/\beditor\b|\bedit(ing)?\s+(page|screen)\b|\bcut\s+page\b/i, "剪辑页"],
  // 工作流画布的放大 / 缩小 / 1:1（§3.7，2.63 新加的三颗键）
  [/\bcanvas\b|\bzoom\w*/i, "画布 放大 缩小"],
  [/\bdrafts?\b|\bunfinished\b|\bwork[\s-]in[\s-]progress\b/i, "草稿"],
  [/\bundo\b/i, "撤销"],
  // 删的是账号 / 作品 / 评论 / 卡片…时不补：那几样删了没有 6 秒撤销，补了会把 §3.6「删掉一段与撤销」拉进来（与中文「撤回 → 撤销」那条同一张排除表）
  [/^(?!.*\b(accounts?|works?|posts?|videos?|comments?|danmaku|messages?|cards?|decks?|templates?|avatars?|nicknames?|profiles?|followers?)\b).*\b(delet|remov|eras)\w*/i, "删除 删掉"],
  [/\bpublish\w*|\bpost(ed|ing)?\b/i, "发布 作品"],
  [/\bremake\b|\bchange\s+the\s+(content|video)\b|\breplace\s+the\s+video\b/i, "回炉重做 换内容"],
  [/\bsave\w*\s+(\w+\s+){0,5}(phone|device|gallery|album|camera\s+roll)\b|\bdownload\w*\s+(my\s+)?(own\s+)?(video|work|clip)s?\b/i, "保存到本地"],
  [/\bprivate\b|\bpublic\b|\bonly\s+me\b|\bvisib\w*|\bhide\b|\bunlisted\b/i, "可见性 仅自己可见"],
  [/\baigc\b|\bai[\s-]+(generated\s+)?(labels?|tags?|marks?|badges?)\b|\bwatermark\w*/i, "AIGC 标识"],
  [/\breport\w*/i, "举报"],
  [/\bshar(e|es|ed|ing)\b/i, "分享"],
  [/\btaken\s+down\b|\btakedown\b|\bremoved\s+by\b|\bappeal\w*|\bbanned\b|\b(videos?|works?|posts?|clips?)\b.{0,20}\b(removed|hidden|disappeared)\b/i, "下架 申诉"],
  [/\bcache\b|\bstorage\b|\bspace\b/i, "缓存 存储 清理"],
  // 账号
  [/\baccounts?\b/i, "账号"],
  [/\b(delete|close|deactivat\w*|cancel)\s+(my\s+)?account\b|\baccount\s+(deletion|deactivation)\b/i, "注销"],
  [/\brestor\w*|\breactivat\w*|\bundelete\b/i, "恢复"],
  [/\bpasswords?\b/i, "密码"],
  [/\bforg[oe]t\w*|\breset\w*/i, "忘记 重置"],
  // username 本来就是知识库里的词（§2.5）；再补「用户名」反而被「用户」二字摊薄到别的长节上。只把两种写法并成一个
  [/\buser\s+name\b/i, "username"],
  [/\bnicknames?\b|\bdisplay\s+name\b/i, "昵称"],
  [/\bbio\b|\bself[\s-]intro\w*/i, "简介 昵称"],
  [/\bavatar\w*|\bprofile\s+(picture|photo)\b/i, "头像"],
  [/\blog\s*-?in\b|\blog(ged|ging)?\s+in\b|\bsign(ed|ing)?[\s-]?in\b/i, "登录"],
  [/\bsign(ed|ing)?[\s-]?up\b|\bregist\w*/i, "注册"],
  [/\bwechat\b|\bweixin\b/i, "微信 登录方式"],
  [/\bphone\s+numbers?\b|\bmobile\s+numbers?\b|\bsms\b/i, "手机号 登录方式"],
  [/\bemails?\b/i, "邮箱"],
  [/\blog(ged|s|ging)?\s+(me\s+)?out\b|\bkick\w*\s+out\b|\bsign(ed|s)?\s+(me\s+)?out\b/i, "登出 登录态"],
  // 补的词与中文「拉黑」那条同义词一样（2.64 起主页上也能拉黑，§1.9 很短、光一个「拉黑」会把它排在 §2.9 前面）；
  // 「block danmaku / bullet comments」是关掉弹幕显示（下面 2.64 那一组另有一条），这里让开
  //   点到人（user / someone / him…）的照样是拉黑：「block a user who spams danmaku」（与中文「屏蔽这个人的弹幕」同一个口径）
  [/(?:^(?!.*\b(danmaku|bullet\s+comments?)\b)|^(?=.*\b(users?|someone|somebody|people|persons?|guys?|him|her|them|accounts?|creators?|authors?|trolls?|spammers?)\b)).*\b(un)?block\w*/i, "拉黑 双向 已拉黑的人 不是举报 黑名单"],
  [/\binstall\w*/i, "安装 卸载"],
  [/\bapple\b|\bmac\s*os\b/i, "iOS 安卓安装包 下载页"],
  // 「哪一版 / 版本号」：§7.2 / §9.2（「update」那条动作 + 对象的规则管不到只问版本号的）
  //   ★ 「Pro version / premium version」说的是套餐，与上面 update 那条的排除同一个口径
  [/^(?!.*\b(plans?|pro|premium|tiers?|subscriptions?|memberships?|vip)\b).*(\bversions?\b|\breleases?\b|\bchangelog\b)/i, "版本 更新"],
  // 更新弹层关不掉 = 强制更新（§7.2）；上面 SYNONYMS 里 update 那条要「App / 版本 / 最新」这个对象在场，「The update popup won't close」够不着
  [/\bupdat\w*.{0,30}\b(pop-?up|dialog|won'?t\s+close|can'?t\s+close|forced|mandatory|required)\b|\b(pop-?up|dialog)\b.{0,30}\bupdat\w*/i, "必须更新 强制更新 关不掉"],
  [/\bages?\b|\bminors?\b|\bunder\s*1[0-8]\b|\bchildren\b|\bkids?\b/i, "年龄 未成年"],
  [/\bservers?\b|\bdata\b|\bprivacy\b/i, "服务器 隐私"],
  [/\btutor\b|\bteacher\b|\bcourses?\b|\blessons?\b/i, "启梦老师 课程"],
  [/\bnotifications?\b/i, "通知"],
  [/\bhuman\b|\b(real|live)\s+(person|agent)\b/i, "人工"],
  [/\bcomments?\b/i, "评论"],
  [/\bdanmaku\b|\bbullet\s+comments?\b/i, "弹幕"],
  // ── 2.64（2026-10-21）：照 app 仓 en.po 的叫法（Playback speed / More options / Clear screen / My Library / Workshop…），
  //    同一批 62 句探针里 9 句英文有 7 句一节都没排上
  [/\bplayback\s+speed\b|\bspeed\s+up\b|\b[0-9.]+\s*x\s+speed\b|\b2x\b|\bfast[\s-]?forward\w*|\bslow[\s-]?motion\b/i, "倍速 快进"],
  [/\b(long[\s-]?press|press\s+and\s+hold|hold\s+(down|the\s+screen))\b|\bmore\s+options\b/i, "按住 长按 更多操作"],
  [/\bclear[\s-]?screen\b|\bimmersive\b/i, "清屏观看"],
  [/\bnot\s+interested\b/i, "不感兴趣"],
  [/\bdouble[\s-]?tap\w*/i, "双击 点赞"],
  [/\bhome\s+(feed|page|screen)\b|\bfor\s+you\b/i, "首页"],
  [/\bsearch\s+(history|records?)\b|\brecent\s+searches\b|\bpast\s+searches\b/i, "搜索历史 清空"],
  [/\brecently\s+popular\b|\btrending\b/i, "近期热播"],
  [/\bmy\s+library\b|\bworkshop\b|\b3d\s+studio\b/i, "创意工坊 我的仓库"],
  // 更新之后「我的卡片 / 卡组 / 模板不见了」：东西挪进了「我的仓库」（§1.7）；模板的声音没了、取回的卡不是这件事（与中文那条同一个让法）
  [/^(?!.*\b(audio|sound|voice|music|soundtrack|recover\w*)\b)(?:.*\b(cards?|decks?|templates?)\b.{0,30}\b(disappear\w*|gone|missing|vanish\w*)\b|.*\bcan'?t\s+find\s+(my\s+)?(cards?|decks?|templates?)\b)/i, "我的仓库 不见了"],
  // 「extend my subscription / plan / trial」是套餐，不是往后延长
  [/^(?!.*\b(subscri\w*|plans?|memberships?|trials?|premium|vip)\b).*\bextend\w*/i, "往后延长 延长"],
  [/\bminimum\s+(usage|billed|billing|charge)\b/i, "最低用量"],
  // 2.64 修的安全漏洞（§7.2）：只认漏洞 / 补丁 / 更新的说法。★ 光一个 security / hacked 多半是在说自己的账号 ——
  //   原来「My account was hacked」被领去 §7.2 的漏洞那一条、§2.3 密码重置掉了出去，还会诱导模型把账号被盗和漏洞扯到一起（12b 禁止的）
  [/\bvulnerab\w*|\bexploit\w*|\bsecurity\s+(updates?|fix(es)?|patch(es)?|issues?|holes?|flaws?|bugs?|problems?|risks?|releases?)\b|\b(updates?|fix(es)?|patch(es)?|releases?|versions?|v?\d+\.\d+)\b.{0,20}\bsecurity\b/i, "安全更新 高危安全漏洞 尽快更新"],
  [/\bhack(ed|ing|ers?)?\b|\bcompromised\b|\bstolen\b/i, "密码重置 忘记密码 账号被盗 转人工"],
  // 关掉弹幕显示（§6.4 的总开关）；「block danmaku」是这个，不是拉黑人（下面 block 那条让开它）
  [/\b(turn\s+off|hide|disable|block|stop|too\s+many)\b.{0,20}\b(danmaku|bullet\s+comments?)\b|\b(danmaku|bullet\s+comments?)\b.{0,20}\b(off|hide|disable|block)\b/i, "弹幕 开关 关闭弹幕显示"],
  // en.po 里 2.64 那几样的英文叫法（Remix / + Add / Shot / reverse shot / Storyboard grid / Fix this segment / Reshoot）
  // ★ 不补「简介」：它是 §2.5（昵称 / 简介 / 头像）标题里的词，会把改资料那一节拉进每一问 remix
  [/^(?!.*\b(rewards?|earn\w*|bonus)\b).*\bremix\w*/i, "做同款 铺这一下不花钱 首页"],
  [/\bremix\w*.{0,40}\b(rewards?|earn\w*|bonus)\b|\b(rewards?|earn\w*|bonus)\b.{0,40}\bremix\w*/i, "同款奖励 通知"],
  [/^(?!.*\b(voice|persona|personas|model|models|live2d|avatar|teacher|tutor|template|templates|scheme)\s+market).*(\b(cards?|decks?|workflows?)\b.{0,40}\bmarket(place)?\b|\bmarket(place)?\b.{0,40}\b(cards?|decks?|workflows?)\b|\+\s*add\b)/i, "创意工坊 市场 ＋ 添加 不花钱"],
  [/\breverse[\s-]?shots?\b|\bover[\s-]the[\s-]shoulder\b|\bcamera\s+angles?\b/i, "对话正反打 机位 过肩 AI 看一遍"],
  [/\bstoryboard\s+grid\b|\bgrid\s+panels?\b/i, "九宫格分镜 每格 AI 看一遍"],
  [/\bre-?shoot\w*|\bfix\s+this\s+segment\b/i, "片段重拍 修这一段 计价"],
  // 检查更新 / 下载更新失败（§7.4）：2.64 起这些话按界面语言说，英文界面的用户会把英文原话贴进来。只认 en.po 里那几句的说法
  [/\bcheck\w*\s+for\s+updates?\b|\b(update|version)\s+manifest\b|\bdownload\s+server\b|\bfailed\s+verification\b|\bsystem\s+installer\b|\binstall\s+unknown\s+apps\b|\balready\s+downloaded\b.{0,40}\bresume\b|\bthis\s+version'?s\s+package\b|\b(couldn'?t|can'?t|cannot|unable\s+to)\s+write\s+to\s+(your\s+|my\s+|the\s+)?phone'?s?\s+storage\b|\bthe\s+download\s+(timed?\s*out|didn'?t\s+finish)\b|\bconnection\s+dropped\s+during\s+the\s+download\b/i, "检查更新 更新失败 下载 校验不通过 手机存储写不进去 重试"],
  [/^(?!.*\b(nicknames?|names?|usernames?|profiles?|avatars?|bios?|emails?|passwords?|payments?|cards?|decks?|drafts?|captions?|plans?|subscriptions?|tiers?|memberships?|accounts?|balances?|wallets?|tokens?|templates?|videos?|works?|posts?|settings?)\b).*\bupdat\w*\b.{0,40}\b(fail\w*|errors?|stuck|won'?t\s+(download|install|finish))\b/i, "检查更新 更新失败 下载 校验不通过 重试"],
  // AI 客服用哪种语言回答（§7，2.64 起跟着界面语言）。★ 老师 / 视频里的人物 / 数字人让开
  //   名词那一支（「Why is customer service in Chinese」）只认客服 / 机器人这类名词形式，不认动词 support（「Does Seedance support Chinese」）
  [/^(?!.*\b(tutors?|teachers?|characters?|videos?|voice\w*|digital\s+humans?|avatars?|dialogue)\b).*(\b(customer\s+service|help\s*desk|xiao\s?meng|chat\s*bot|support\s+(bot|agent|team|chat|staff)|(the|this|ai|your)\s+(support|bot|assistant))\b(?!\s+(supports?|on|in\s+the\s+(canvas|workflow|workshop))\b)[^.?!]{0,40}\b(chinese|english)\b|\b(reply|replies|replying|answer\w*|respond\w*|talk\w*|speak\w*)\b.{0,40}\b(chinese|english|language)\b|\b(chinese|english|language)\b.{0,40}\b(reply|replies|answer\w*|respond\w*)\b)/i, "AI 客服 问小梦 用哪种语言回答 界面语言"],
];

/**
 * 挑出与问题最相关的几节 + 固定三节，拼成提示词里的知识库正文。
 * @param {string} query 当前这轮用户说的话（可再附上前一轮，提高连续追问的召回）
 * ★ maxChars 8000（原 7000）：2.62 的钱相关小节（4.4 / 4.5 / 4.6）写长了，32 句钱的问法里 7000 有 9 句会把一节
 *   该有的钱相关小节挤掉，8000 是 4 句（9000 是 3 句，再往上收益很小）。2026-10-08 量的。
 */
/**
 * 问话里点了 App 的版本号时补词（2026-10-21，2.64 发版时加的）：点的是当前版 → §9.2「最新版本 当前版」；比它早的 →
 * §9.3 / §9.4「各版更新 更早的版本」；比它新的（还没发）不补。
 * ★ 当前版从知识库 §9.2 的标题里读（loadKnowledge 的 currentVersion），不写死：每发一版只改知识库，这里自己跟着变。
 *   写死成 2.64 的话，下一版发布之后「2.64 更新了什么」会被领去当前版那一节，而那一节已经换成下一版了。
 * ★ 为什么要有它：2.64 的 §9.2 写 2.64，2.63 那些挪进了 §9.3；「2.63 更新了什么」只剩「更新」二字可比，§7.2 / §7.4 的标题
 *   （更新机制 / 检查更新）加分比 §9.3 多，§9.3 掉到第 4（10-21 量的）。
 * ★ 只认「主版本号与当前版相同 + 两位小版本号」的形状（2.63 / v2.63 / Version2.63）：「1.5 倍」「2.5 秒」「13.7k」都不是版本号；
 *   后面紧跟金额 / 时长单位的（「扣了我 2.50 元」）也不是。
 * ★ 只在这一行问的就是那一版（问更新了什么 / 新功能 / 区别…，或者整行除了版本号就是「的 / 吗」这类虚字）时才补：
 *   「我是 2.62，九宫格一张多少钱」里的版本号是随口报的，补了会把两节几千字的更新记录塞进 8000 字的预算、挤掉真正要答的那一节
 *   （10-21 复核量的；客服自己就会先问用户是哪一版）。
 * ★ 比当前版早的只补它所在的那一节：§9.3 收的最早一版从它的标题里读（olderFloor），更早的去 §9.4 —— 两节一起补就是 7 千字
 */
const VERSION_ASK_RE = /更新了?(什么|啥|哪些)|新功能|新增|新加|加了|撤了|去掉了|(有|加|改|变)了?(什么|啥|哪些)|变化|区别|不一样|是什么|介绍|更新(内容|说明|日志)|版本说明|\bwhat'?s\s+new\b|\bchangelog\b|\brelease\s+notes?\b|\bwhat\s+(changed|is\s+new)\b|\bnew\s+in\b|\bchanges?\b|\babout\b|\bdiff\w*|\bwhat\s+did\b|\bnotes?\b/i;
const VERSION_NUM_RE = /(?<![\d.])(\d+)\.(\d{2})(?![\d])/g;
function versionExtras(lines, current, olderFloor) {
  if (!current) return "";
  const [curMajor, curMinor] = current.split(".").map(Number);
  const floorMinor = olderFloor ? Number(olderFloor.split(".")[1]) : 0;
  let extra = "";
  for (const raw of lines) {
    const l = String(raw);
    const rest = l.replace(VERSION_NUM_RE, "").replace(/\b(v|ver|version)\b|版本号?|新版|[的是吗呢啊了？?！!。.,，、\s]/gi, "");
    if (!VERSION_ASK_RE.test(l) && rest.length > 0) continue;
    for (const m of l.matchAll(VERSION_NUM_RE)) {
      if (Number(m[1]) !== curMajor) continue;
      const after = l.slice(m.index + m[0].length);
      const before = l.slice(0, m.index);
      if (/^\s*(元|块|万|千|秒|倍|[kK%]|tokens?\b)/i.test(after) || /[¥￥$]\s*$/.test(before)) continue;
      const minor = Number(m[2]);
      if (minor === curMinor) extra += " 最新版本 当前版";
      else if (minor < curMinor) extra += minor >= floorMinor ? " 各版更新" : " 更早的版本";
    }
  }
  return extra;
}

function selectKnowledge(query, { maxChars = 8000, topK = 5 } = {}) {
  const kb = loadKnowledge();
  if (!kb.sections.length) return "";
  // ★ 同义词只对用户的原话判、而且逐行判：① 扩展词不再去触发别的同义词（原来「档位」扩展里的「草稿」会接着触发
  //   草稿箱、再触发回炉，一串拉偏，档位 / 价钱问题的 4.2 / 4.4 掉出前 5）；② 查询是「上一轮\n这一轮」，带 ^ 的规则
  //   按行判才看得到这一轮（不按行的话 . 过不了换行，只看得到上一轮）
  const q0 = String(query || "");
  const lines = q0.split("\n");
  let extras = "";
  for (const [re, extra] of SYNONYMS) if (lines.some((l) => re.test(l))) extras += " " + extra;
  extras += versionExtras(lines, kb.currentVersion, kb.olderFloor);
  // 英文问法：只认一个汉字都没有的那一行（见 EN_GLOSSARY 头上）；英文虚词也只从这几行里剥（见 EN_STOPWORDS 头上）
  const enLines = lines.filter(latinLine);
  for (const [re, extra] of EN_GLOSSARY) if (enLines.some((l) => re.test(l))) extras += " " + extra;
  const qGrams = new Set([
    ...bigrams(lines.filter((l) => !latinLine(l)).join("\n") + extras),
    ...bigrams(enLines.join("\n")).filter((w) => !EN_STOPWORDS.has(w)),
  ]);
  // 这一问不该喂的小节（见 SECTION_VETOES 头上）
  const vetoed = SECTION_VETOES.filter(([re, , keep]) => lines.some((l) => re.test(l)) && !lines.some((l) => keep.test(l))).map(([, title]) => title);
  const scored = kb.sections
    // 只有一行标题的章节（「## 4. AI 生成与费用」这种）没有内容，却照样吃标题加分、占前 5 的位置
    .filter((s) => !s.always && s.lines.slice(1).some((l) => l.trim() && l.trim() !== "---"))
    .filter((s) => !vetoed.some((t) => s.title.includes(t)))
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
  "出片一直没结果/钱扣了：钱在提交那一刻就已扣掉，任务还在方舟那边跑，不是失败；到出片页点「取回」即可拿到成片，取回不再花钱；方舟档成片只保留 24 小时，过期就取不回了（出成了却没取回的钱不退；新规则上线（北京时间 2026-10-09 清晨）之后受理、方舟明说失败 / 取消 / 过期的会自动退回，以余额和通知为准；更早受理的服务器没有这笔账、不会自动退（App 上写的是「已经花掉的钱无法挽回」）；服务器问了 8 天还问不出结局的也不会自动退，转人工核对（本机取回卡那时多半已经清掉了，让用户报提交时间和是哪一段，有任务号就带上））；点「重新生成」是重新下单、会再花一次钱。真人档（MiniMax）不说 24 小时，过期让用户把任务号发给客服。",
  "出片失败了 token 退不退：上游没受理（敏感词 400 / 限流 429 / 5xx / 没配 key）会当场原样退回；任务被受理之后 AI 明说失败 / 取消 / 过期作废的，token 也会自动退回、只退一次（新规则上线 —— 北京时间 2026-10-09 清晨 —— 之后受理的任务；2.62 起出片页会显示「已经退回」，人不在会收到「生成失败，token 已退回」通知）。App 这边等超时、没收到结果或还在生成中，不算失败、也不决定退不退：先用「取回」领（不花钱，多半出成了），上游最后明说失败的照样自动退。不退的：出成了（哪怕不满意，或者没取回、过期了）、出片前已经画好的画面（2.62 起，当场失败时 —— 视频那一发失败，或补画到一半某张失败 —— 已经补画好的设定帧留在方案上、不关 App 也不换开别的工程时重试不再收（失败时不自动存草稿，没存就关掉 App 或换了流水线的会重画重收）；没等到结果、事后才判失败退款的不留，重试会重画重收；按圈选改过的画面不留，重试会再收）、白模化看画面那一步、AI 老师的生成（上课的一轮在老师开口之前就失败的会当场退回）、新规则上线之前受理的任务、问了 8 天还问不出结局的（转人工）。2.61 及更早的 App 收不到退款通知，还写着「受理之后的失败不退款」，那句话过时了 —— 钱照样退，以余额为准。不承诺规则之外的退款。",
  "单段视频时长按档位（App 2.62 起；2.61 及更早的包各档最长只能选 10 秒，先更新）：极速、标准 3~10 秒；草稿、高清 4~15 秒；电影级 4~30 秒；真人档只有 6 秒 / 10 秒两档。",
  "额度：免费版是新人一次 170,000 token（不过期）+ 每天 2,000（按 UTC 日算，北京时间早上 8 点换日；换日后第一次用到钱包时补上，最多攒 7 天 = 14,000）。新人额度只在新规则上线（北京时间 2026-10-09 清晨）之后第一次建钱包时发；那之前就有钱包的老账号（在 App 里注册或登录过、或在官网用过看板娘聊天 / 试听声音 / 启梦老师这类花 token 的功能，就已经有钱包了，包括 10-07、10-08 注册的；拿不准以余额为准）不补发，原来剩下的额度原样留着，用到 14,000 以下才开始每天补。标准套餐 ¥30/月 1,660,000（约 10 段 5 秒高清）；专业套餐 ¥98/月 5,800,000（约 35 段）；直充包 ¥6/200k、¥25/1M、¥98/5M 永不过期。目前支付渠道还没接入，App 内暂时不能真的充值成功。token 不能提现、不能换现金。",
  "免费版（没付过钱）只能用「极速」「草稿」两档出片；标准、高清、电影级、真人档、白模模板这些要付过钱（开通任意付费套餐，或充值过任意一次）才能用，免费版在 2.62 里能看见这些档但点不动（这是默认规则；运维可以临时放开，以 App 里档位点不点得动为准，点得动就能用，不用为此付费）。旧版 App（档位里没有「草稿」）里，免费用户的标准、高清、真人档还点得动（电影级和白模模板是灰的），推演和补画的设定帧会照常扣钱，到出视频那一步才被服务器拒，所以先更新到 2.62 再出片。「极速」「标准」2026-11-24 停用，之后免费版只剩「草稿」；档位里没有「草稿」的是旧版 App，要先更新。",
  "「草稿」有两个意思：一是 2.62 新加的出片档位（和「高清」同一个模型，480p，免费版也能用，但照样按秒扣 token：5 秒约 77,004，比高清便宜；单段 4~15 秒）；二是草稿箱（没做完的工程，只存在本机，最多 20 条）。用户问画质、价钱、能不能用、能出多长时说的是档位，问丢了、存不住、换手机时说的是草稿箱。存草稿、草稿箱本身不花 token（只存在这台设备上）；花钱的是出片，「草稿」档出片照样按秒扣。",
  "没有 iOS 版，只有安卓安装包（官网 ideahubs.org/download）；也不在应用商店，别承诺上架时间。",
  "安装提示「应用未安装」：多半是手机上还留着签名不同的旧测试版，要先卸载旧版再装。卸载会清掉这台手机上的草稿箱（没做完的工程，含已经花钱出好的段），旧版里有没做完的先做完发布，再卸载。更新失败照屏幕上那句原因处理：网络问题（超时、断网、没下完）换个网络点「重试」，已经下好的会接着下；存储写不进去先腾空间；拉不起安装器、或应用内一直更新不成的，去官网下载页 ideahubs.org/download 下载、直接覆盖安装；不要建议清缓存或卸载重装。只有提示「这个地址上没有这一版的包」或同一个包反复校验不通过时，才是等新版本号 / 转人工。",
  "注销账号：设置页「退出登录」下方小字「注销账号」，需原样输入用户名确认；注销是软删除，数据不会立刻抹除，恢复或彻底删除数据要发邮件到 support@ideahubs.org 由管理员处理，不能自助恢复。",
  "密码：服务器只存哈希，看不到也找不回原密码，只能在登录页「忘记密码？」走邮箱验证码重置。用户名（@句柄）注册后不能改，能改的是昵称/头像/简介（设置 → 编辑资料）。",
  "草稿箱（没做完的工程）只存在这台设备本机（IndexedDB），不跨设备同步，卸载/换手机就没了，上限 20 条（同一台手机按账号分开、各算各的）；简约模式不进草稿库。已发布作品可以在编辑页改标题/分类/简介/标签/封面/可见性；要换成片内容用编辑页的「🛠 回炉重做」（链接、播放、点赞、评论都保留，原有弹幕会被清空；只限 2026-09-07 之后发布、留存了工坊工程的作品，按分集收费的、下架期间的、还在上传的不行）。",
  "铸卡师嘴动没声音：先看声音开关是不是关了（铸卡师对话框上显示 🔇；在客服页或上课页关掉的也算，是同一个开关）；再看 token 余额或当天用量是不是到了上限（这时云端语音不出声，会退回系统自带的语音）；都不是，才是系统没装中文语音包（装完要完全退出再开）。",
  "出的视频没声音：极速、标准、真人档出片本身不生成环境音（免费版默认的「极速」就是无声的），草稿、高清、电影级带 AI 环境音；白模模板段出片本身无声，回看和合成时用的是模板原声。这和铸卡师不出声（声音开关 / 余额 / 中文语音包）是两回事。",
  "问 AI 客服、和数字人聊天、工坊里和铸卡师打字聊天、做人格时「试聊」都花 token：每问一轮扣 400（客服 / 陪聊 / 试聊一个字都没回出来的那一轮退回）；开着声音时，每一句送去合成语音的文字按字符另扣 33（标点、空格也算，包括点一下看板娘她说的那句）。客服页、上课页右上角的 🔊 和铸卡师对话框的声音键是同一个开关，关掉只省自动念出来的那部分；以上都算进每日上限。设置页 / 声音面板的试听、剪辑页配音（含一键成片的「用完就配音」、在「💬 说一句」里让它配音）不受这个开关管：试听点一次扣一次；剪辑页配音在 2.62 及以前按句扣（几段就几句，念不完重合成的那次另扣，也算进每日上限），看得见剪辑页按钮下「配音免费，每个账号每天 1000 字」那行小字（英文界面是「Voiceover is free, up to 1000 characters per account per day」）的新版免费、不算进每日上限、每个账号每天 1,000 个字符（UTC 0 点重置，不转成扣钱；说「今天的免费配音用完了」也可能只是剩下的字不够这一句，短一点的还配得上）。启梦老师上课：每问一次约 400，自动或手动「整理」每次约 600（每满 8 问、自检通过、30 分钟没动静时会自动整理），按钮上都不标价。",
  "段与段衔接是软引导（参考图 + 提示词点名），不能保证无缝；圈选改帧也是软引导，不能保证一定按圈的改。",
  "服务器在中国香港（阿里云），数据库 MongoDB Atlas；隐私政策在官网 ideahubs.org/privacy 和 App 设置页。联系邮箱 support@ideahubs.org。",
];

// ── 提示词 ───────────────────────────────────────────────────────────
// ★ 分隔符与 companion.parseTags 同一个口径（2026-10-20）：「:」「：」「=」都认，两边与方括号里头可以有空格。原来只认半角冒号，
//   而关思考之后模型更爱写 [action=explain] 这种等号写法（parseTags 已经认了）—— 写成 [handoff=billing] / [handoff：billing] 时，
//   这一段标记照样被路由的清理正则剥掉（字幕上看不见），parseHandoff 却认不出（handoff 为假）：没有 handoff 事件、没有「转人工」卡片，
//   用户要找人工什么都等不到，全程零报错
const HANDOFF_RE = /^\s*\[\s*handoff(?:\s*[:：=]\s*([a-z_]+))?(?:\s*[:：=]\s*([^\]]{0,60}))?\s*\]\s*/i;

/** 句中 / 句尾漏网的转人工标记一律剥掉（不念、不进字幕、不进历史）。与 HANDOFF_RE 认同一批写法；路由只调这一个，别再手写一份 */
function stripHandoffTags(text) {
  return String(text || "").replace(/\[\s*handoff[^\]]*\]\s*/gi, "");
}

function buildSupportSystemPrompt({ name = agentName(), userName = "", knowledge = "", lang = "zh", personaLine = "", enNames = false, appVersion = null, caps = [] } = {}) {
  const capGoto = Array.isArray(caps) && caps.includes("goto");
  const capAsk = Array.isArray(caps) && caps.includes("ask");
  const who = userName ? `正在咨询的用户叫「${userName}」。` : "";
  // enNames（这一轮原话是英文）而 lang 不是 en 时把话说死：App 发的 lang 恒为 zh，「用户用英文就用英文」这句在 2026-10-20 的真模型复跑里
  // 一问短英文（「I want a refund.」）有一次回了整段中文（6 发里 1 发）
  const langLine =
    lang === "en"
      ? "Reply in English unless the user writes Chinese."
      : enNames
        ? "默认用中文回复；用户这一问是英文，这一轮就用英文回答。"
        : "默认用中文回复；用户用英文就用英文。";
  // ★ 英文界面的叫法（照 app 仓 src/locales/en.po，v2.62 / v2.63 两版 2026-10-20 逐条核对；Refined 只在 v2.62 及更早）：知识库是中文的，
  //   模型回英文时会自己意译界面上的名字 —— 真模型实测把「极速」说成 Quick / Speed、「白模」说成 White-model、「取回」说成 Retrieve、
  //   「注销账号」说成 Delete account，「Refined 档去哪了」认不出就是「定妆」、直接转人工（2026-10-20，deepseek-v4-flash）。
  //   用户照着说的名字在屏幕上找不到。出片档位「草稿」英文叫 Lite（不是 Draft：Draft 是模板货架的状态角标，Drafts 是草稿箱）。
  // ★★ 什么时候带：lang === "en"，**或者**调用方判出这一问是英文（enNames，路由拿 isEnglishAsk 判这一轮的原话）。
  //   只认 lang 的话这张表在生产上一次都发不出去：App 的客服页发的 lang 写死 "zh"（app 仓 SupportPage.tsx，v2.63 也是），
  //   官网不调这个接口（2026-10-20 复核抓到）。中文问话一个字都不多（测试钉着）；en.po 改了名字这里要跟着改
  const enNamesLine =
    lang === "en" || enNames
      ? "【英文界面叫法】用英文回答时，界面上的名字照这张表原样说（括号里是知识库里的中文名）：Fast（极速）、Standard（标准）、Lite（出片档位里的「草稿」，480p）、HD（高清）、Cinematic（电影级）、Real-person（真人档）、preview draft / finalize（样片 / 定稿）、Blockout（白模）；出图档 Sketch（速写）、Master（精绘）、Refined（定妆，2.63 撤了）；Card smith（铸卡师）；Recover（取回）、Undo（撤销）、Drafts（草稿箱）、Remake（回炉重做）、Merge & go to publish（合成并去发布）、Cancel merge（取消合成）、Save to device（保存到本地）；Public / Anyone with the link / Only me（公开 / 凭链接可见 / 仅自己可见）；Settings（设置）、Me（「我的」页）、Top up / Plans（充值 / 套餐）、Standard plan / Pro plan（标准套餐 / 专业套餐）、Deactivate account（注销账号）、Log out（退出登录）、Forgot password?（忘记密码？）、Edit profile（编辑资料）、Check for updates / Update now / Later（检查更新 / 立即更新 / 以后再说）；Workflow（工作流）、Workshop（工坊）、One-tap finish（一键成片）、QiMeng Tutor（启梦老师）。表里没有的名字照知识库原文的意思说，别自己起一个像按钮名的英文名。知识库里的「草稿」有两个意思：出片档位英文叫 Lite（例：「草稿、高清、电影级带 AI 环境音」说成「Lite, HD and Cinematic include AI ambient sound」），草稿箱英文叫 Drafts；英文回答里不要单独用 Draft 这个词。"
      : null;
  return [
    // ★ 「成年」（2026-10-30 补齐）：09-24 已定数字人一律成年，陪聊那一份写的是「一个成年、银白长发…」，这里漏改了一处（Play 合规相关）
    `你是「${name}」，启梦 App（安卓端，包名 com.ideahub.branchvideo；官网叫「启梦创作」）的官方 AI 客服，形象是官网首页的看板娘：银白长发带薄荷绿挑染的成年女性，亲切、专业、不卖萌过头。`,
    who,
    // ★ 版本号静默进上下文（2026-10-30）：Intercom / Zendesk 都把 App 版本当元数据带上、不显示。省掉「你用的是哪一版」那一轮；
    //   知识库里按版本说的话（「2.75 起…」）让模型按这个版本挑。契约「X-App-Version」原来写「只进日志」，10-30 起多了这一个用处，仍不拿它做任何判断
    appVersion && appVersion.name
      ? `【用户版本】对方装的 App 是 ${appVersion.name}${appVersion.code ? `（${appVersion.code}）` : ""}。不要再问他用哪一版；知识库里按版本分开说的事，按这个版本答，也别把版本号念出来。`
      : null,
    langLine,
    enNamesLine,
    "【依据】只根据下面「知识库」里的事实回答；知识库里没有的功能、价格、时限、政策一律说「这个我不确定，需要人工核实」，并按下面【转人工】第 5 条处理（回复开头写 [handoff:other]，告诉用户怎么提交），绝不编造。",
    "【禁止承诺】知识库末尾的「客服禁止承诺的事项」是红线：涉及其中任何一条，只能如实说明现状，不能答应、不能暗示以后会有。",
    "【表达】口语、直接、先给结论再给一步步的操作；每次回复 2～5 句，每句不超过 40 字；不用 Markdown 标记、不用列表符号、不用表情符号。涉及钱和时限的数字要和知识库一字不差。",
    // 用户给客服装了人格市场的人格：只改语气与措辞，【依据】【禁止承诺】【转人工】一条不松（companionSetting.service.personaPromptLine）
    personaLine || null,
    "【转人工】出现以下任一情况，回复的最开头先写 [handoff:类别]，然后告诉用户：点下面的「转人工」，在弹出的框里写上任务号、大概时间、屏幕上的提示，再点「提交给人工客服」—— 提交了才算交给人工。不要说「已经帮你转了」；不要让用户在聊天里补充（再发一句那张转人工卡片就没了）；工单里传不了图：先提交，再把截图发到 support@ideahubs.org，邮件里写上提交后显示的工单号或自己的 UID。用英文回复时按钮叫 \"Talk to a human\" 和 \"Send to a human agent\"（原样引用）：",
    "  1) 用户要求退款/补偿、余额对不上、充值没到账、取回过期后要求处理；类别 billing",
    "  2) 注销后要恢复、要求彻底删除数据、封禁申诉、账号被盗；类别 account",
    "  3) 作品被下架申诉、举报结果异议、侵权投诉；类别 content",
    "  4) 明确要找人工客服、或同一问题连续两轮仍没解决；类别 other（疑似程序缺陷用 bug）",
    "  5) 知识库找不到依据、你无法确定答案；类别 other",
    `  类别只能是 ${CATEGORIES.join("/")}。不满足条件时绝不要输出 [handoff]。`,
    "【演出协议】除了可选的 [handoff] 标记外，每一句话开头都要带三个标签：[情绪][face:表情][action:动作]，然后紧跟正文。",
    `情绪只能取：${EMOTIONS.join("/")}。表情只能取：${FACES.join("/")}。动作只能取：${ACTIONS.join("/")}。`,
    // ★ 动作白名单（2026-10-30）：用户要举手 / 抬腿 / 指按钮时，原来模型会拿别的动作顶替还嘴上答应；现在照实说做不到
    "【动作】你能做的动作只有上面列的这几种。用户要你举手、抬腿、指按钮、转圈、跳舞这类不在列表里的动作时，如实说这个形象做不到，不要拿别的动作顶替、也不要答应。",
    // ★ 「带我去」与「拿不准先问」（2026-10-30，只对声明了 caps 的新客户端说）：支付宝 / 店小蜜的答案里直接给站内入口；
    //   Material 的 suggestion chips 是对等的 2～4 个。两种标记都写在整段回复的**最末尾**、各最多一个，路由在 done 之前解析成事件、字幕与语音里剥掉
    capGoto
      ? `【带我去】答案的下一步是让用户去 App 里某一页时，在整段回复的最末尾单独写一个 [goto:页面id]，用户会看到一颗能点的「带我去」键。页面 id 只能是：${Object.entries(GOTO_TARGETS).map(([id, v]) => `${id}（${v.zh}）`).join("、")}。一段回复最多一个，不是这几页的事不要写。`
      : null,
    capAsk
      ? "【拿不准先问】用户的问题有两种以上可能、答下去会答错时，先用一句话说清为什么要问，然后在整段回复的最末尾写 [ask:你的问题|选项A|选项B]（2～4 个选项，每个不超过 12 字，推荐的放第一个，选项都必须是不花钱、能退回的）。用户点了选项等于把那个选项的字发给你。"
      : null,
    "示例：[neutral][face:normal][action:explain] 这一发的钱在提交那一刻就扣掉了，取回不再花钱。 [happy][face:happy][action:acknowledge] 打开出片页点「取回」就行，方舟档的成片 24 小时内有效。",
    "转人工示例：[handoff:billing] [sad][face:sad][action:comfort] 退款要人工核对，我这边没法直接处理。 [neutral][face:normal][action:explain] 请点下面的「转人工」，写上任务号和下单时间。 [neutral][face:normal][action:explain] 再点「提交给人工客服」，提交了客服才看得到。",
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

/**
 * 「带我去」的落点白名单（2026-10-30）。★ 服务端只认 id 与给人看的名字，**不认路由**：路由是 App 的事（app `pages/SupportPage` 的 GOTO_ROUTES），
 *   两边按 id 对；加一个落点两边一起加。模型写了不在表里的 id 一律丢。
 */
const GOTO_TARGETS = Object.freeze({
  settings: { zh: "设置", en: "Settings" },
  wallet: { zh: "钱包 / 套餐", en: "Wallet & plans" },
  models: { zh: "数字人形象", en: "Avatars" },
  personas: { zh: "数字人人格", en: "Personas" },
  voice: { zh: "声音设置", en: "Voice" },
  create: { zh: "创作中心", en: "Creator center" },
  templates: { zh: "视频模板", en: "Templates" },
  drafts: { zh: "草稿箱", en: "Drafts" },
  storage: { zh: "本机缓存", en: "Storage" },
  update: { zh: "检查更新", en: "Check for updates" },
  tickets: { zh: "我的工单", en: "My tickets" },
});
const GOTO_RE = /\[\s*goto\s*[:：=]\s*([a-z_]{1,24})\s*\]/gi;
const ASK_RE = /\[\s*ask\s*[:：=]\s*([^\]|]{1,80})((?:\|[^\]|]{1,24}){2,4})\s*\]/gi;

/** 回复里的 [goto:id]：取**最后一个**、且 id 在白名单里的；回 null = 没有 */
function parseGoto(text) {
  let last = null;
  for (const m of String(text || "").matchAll(GOTO_RE)) {
    const id = m[1].toLowerCase();
    if (GOTO_TARGETS[id]) last = id;
  }
  return last ? { id: last, label: GOTO_TARGETS[last] } : null;
}

/** 回复里的 [ask:问题|A|B]：取最后一个；选项去重、去空，剩不到两个就当没有 */
function parseAsk(text) {
  let last = null;
  for (const m of String(text || "").matchAll(ASK_RE)) {
    const question = m[1].trim();
    const options = [...new Set(m[2].split("|").map((s) => s.trim()).filter(Boolean))].slice(0, 4);
    if (question && options.length >= 2) last = { question, options };
  }
  return last;
}

/** 把两种动作标记从要念、要显示的文字里剥掉（字幕 / 语音 / 存进历史的那份都过它） */
function stripActionTags(text) {
  return String(text || "").replace(GOTO_RE, "").replace(ASK_RE, "");
}

module.exports = {
  agentName,
  QUICK_QUESTIONS,
  GOTO_TARGETS,
  parseGoto,
  parseAsk,
  stripActionTags,
  loadKnowledge,
  selectKnowledge,
  isEnglishAsk,
  replyInEnglish,
  buildSupportSystemPrompt,
  parseHandoff,
  HANDOFF_RE,
  stripHandoffTags,
  summarizeTicket,
  categoryFromText,
};
