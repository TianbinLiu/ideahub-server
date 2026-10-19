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
  // 「app」不当词：标题里带「App」的四节（10.4 / 11 / 12 / 4.10）会凭它白拿标题加分，问话里一出现 app 就占掉前 5 的位置
  for (const word of cleaned.match(/[a-z0-9_@.]{2,}/g) || []) {
    if (word === "app") continue;
    out.push(word);
    // ★ 版本号「v2.63」整个是一个词，而用户多半只写「2.63」：2026-10-19 量的，58b934c 那份副本的 §9.2 标题只写了
    //   「当前版 v2.63」，「2.63 更新了什么」拿不到标题加分、掉到第 10。v + 数字.数字… 这一种形状另外再出一个去掉 v 的词
    //   （句末的英文句点不算进去），两种写法都对得上；只认这个形状，别的带点的词（support@ideahubs.org、1.25…）一个都不拆
    const ver = /^v(\d+(?:\.\d+)+)\.*$/.exec(word);
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
  [/注销|删号|删除账号|恢复账号/, "注销 软删除 support@ideahubs.org 恢复"],
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
  [/隐私|数据|服务器在哪|香港/, "隐私 服务器 香港 第三方 保留"],
  [/(qq|微信|手机号?|邮箱).{0,4}(登录|登陆)|(登录|登陆)(了|还是|一直|总是|老是|又|就|时|的时候|，|,){0,3}(提示)?(失败|不了|不上|不进去)|登不进|进不去账号/i, "登录方式 QQ 微信 手机号 邮箱 登录 验证码"],
  // 2.63 Google / GitHub 从浏览器回 App 的核对（§2.10：「忽略了一条不是本机发起的登录链接」「登录链接过期了」）。
  // ★ 必须带「登录链接」或 Google / GitHub / 本机发起：光说「登录过期了」多半是登录状态过期（App 说「登录状态过期了 /
  //   登录已过期，请重新登录」，401），不是这一节；「分享链接 / 下载链接过期」也不是
  [/(登录|登陆|授权)链接|本机发起|(google|谷歌|github)[^，。,.!?！？]{0,12}(回来|回到|回不|跳回|没反应|过期|忽略|卡住|停在)/i, "Google GitHub 登录链接 忽略 过期 本机发起"],
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

/**
 * 挑出与问题最相关的几节 + 固定三节，拼成提示词里的知识库正文。
 * @param {string} query 当前这轮用户说的话（可再附上前一轮，提高连续追问的召回）
 * ★ maxChars 8000（原 7000）：2.62 的钱相关小节（4.4 / 4.5 / 4.6）写长了，32 句钱的问法里 7000 有 9 句会把一节
 *   该有的钱相关小节挤掉，8000 是 4 句（9000 是 3 句，再往上收益很小）。2026-10-08 量的。
 */
function selectKnowledge(query, { maxChars = 8000, topK = 5 } = {}) {
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
    // 只有一行标题的章节（「## 4. AI 生成与费用」这种）没有内容，却照样吃标题加分、占前 5 的位置
    .filter((s) => !s.always && s.lines.slice(1).some((l) => l.trim() && l.trim() !== "---"))
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
  "安装提示「应用未安装」：多半是手机上还留着签名不同的旧测试版，要先卸载旧版再装。卸载会清掉这台手机上的草稿箱（没做完的工程，含已经花钱出好的段），旧版里有没做完的先做完发布，再卸载。更新失败不要建议清缓存/重装，等新版本号。",
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
const HANDOFF_RE = /^\s*\[handoff(?::([a-z_]+))?(?::([^\]]{0,60}))?\]\s*/i;

function buildSupportSystemPrompt({ name = agentName(), userName = "", knowledge = "", lang = "zh", personaLine = "" } = {}) {
  const who = userName ? `正在咨询的用户叫「${userName}」。` : "";
  const langLine = lang === "en" ? "Reply in English unless the user writes Chinese." : "默认用中文回复；用户用英文就用英文。";
  return [
    `你是「${name}」，启梦 App（安卓端，包名 com.ideahub.branchvideo；官网叫「启梦创作」）的官方 AI 客服，形象是官网首页的看板娘：银白长发带薄荷绿挑染的少女，亲切、专业、不卖萌过头。`,
    who,
    langLine,
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
