// src/utils/mentionParser.js
// @提及解析：**全仓唯一一处**（铁律六）。两条产品线共用，但走的是**两个入口**：
//   · ideas（ideas.controller / ideaInteractions.controller）→ `parseMentions(text)`
//     纯文本解析，没有 span，签名一个字都没变。
//   · 分支视频（branchVideo.controller）→ `parseMentionsWithSpans(text, spans)`
//     客户端补全面板把「这一段是谁」一起报上来，服务端逐条核对后合并纯文本解析的结果。
//
// ★★★ 身份与显示是**两件事**（2026-08 产品决定，这段是对旧论证的改写，不是遗留）：
//
//   · **身份永远是 userId**。落库的是 userId，不是名字 —— 名字可变、不唯一，
//     谁都不该靠它认人。旧实现把「令牌必须是 @username」当成结论写在这里，
//     理由是 username 唯一且不可变；那个顾虑本身没错，错在把它当成了唯一解法。
//   · **显示永远取当下的 displayName**。渲染时按 userId 现查，所以对方改名之后，
//     已经发出去的那些 @ 会跟着显示新名字 —— 这正是产品要的「改名同步」，
//     而它恰恰要求**不要**把名字当身份存下来（存快照才会对不上，就是 app 仓
//     renameMyVideos 收拾过的那个坑）。
//   · 正文里那一段名字只是**当时打出来的字面**，不承担身份。它留在 `token` 里，
//     唯一用途是校验与老客户端的子串匹配。
//
// ★★ 中文没有词边界，所以「谁被 @ 了」不靠正则猜，靠客户端报、服务端核对：
//
//   `@我是王桑你看看这个` 用正则切不出「我是王桑」—— 贪婪匹配会把整句吃进去，
//   试前缀则等于一句话查 N 次库。而**选人这件事本来就是在补全面板里完成的**，
//   面板知道用户选了谁，于是让它把 `{userId, offset, length}` 一起发上来。
//
//   服务端**不盲信**这份名单（盲信 = 谁都能给任意人发通知），但**可以核对**：
//       text.slice(offset, offset + 1 + length) === '@' + 该用户当前的名字
//   核对通过 = 「客户端声称 @ 了某人」与「正文里真的写着那个人的名字」一致，
//   于是伪造不出一个正文里根本没出现的提及。核不过的**只丢这一条**，不整条 400 ——
//   一条 @ 没生效不该把用户写好的评论一起打回去（而且他看得见它没变成链接）。
//
// ★★ ASCII 的 `@username` 自动解析**保留**，两条路合并后统一去重。理由有两条，
//   都不是"顺手留着"：
//   ① 手打 `@tianbinliu`（不经补全面板，比如从别处粘贴过来的一句话）必须继续可用；
//   ② **老版本 App 发上来的评论没有 spans 字段**，三仓各自独立部署、彼此不知道对方
//      跑的哪个版本 —— 砍掉自动解析等于让已经装在用户手机上的那些包从此 @ 谁都没反应，
//      而它们不会自动更新。
//
// ⚠ 非 ASCII 用户名（`username` 是中文）仍然解析不到，这没变：那条路要在**注册侧**
//   修（给 username 加 handle 策略）。但它已经不再是"中文名 @ 不到"的全部 ——
//   中文**昵称**现在通过 span 这条路是 @ 得到的，那才是用户真正看得见的名字。

const User = require("../models/User");
// 用户名的长度上限与 ci 口径都只有一个出处（铁律六）：utils/username.js。
// ★ 这里的 {1,MAX_USERNAME_LEN} 和注册侧的长度校验**必须是同一个数** ——
//   令牌切得比允许的用户名短，那些账号就永远 @ 不到，而且"打了 @ 没反应"，一个错都不报。
const { MAX_USERNAME_LEN, CI_COLLATION } = require("./username");

/**
 * ★ ASCII 自动解析的令牌字符集**刻意只收 ASCII**（与原实现一致）：
 *
 *   把字符类放宽到 `\p{L}` 会立刻踩中日韩没有词边界的坑 ——
 *   `@张三你好啊，今天更新了吗` 会被贪婪吃成一个 12 字的令牌，匹配不到任何人；
 *   想正确切出"张三"就需要分词，没有任何非任意的切法（试前缀 = 一句话 N 次查库）。
 *   于是放宽的净效果是：中文名**仍然**解析不到，却多了一条按句子长度伸缩的查询。
 *   非 ASCII 的名字由 span 那条路负责（见文件头），不是由这个正则负责。
 *
 * ★ 前置断言 `(?<![\w@])` 用来把**邮箱地址**挡在外面：
 *   `someone@example.com` 原来会解析出一个 `@example` 的提及 —— ideas 那边表现为
 *   "贴了个邮箱，结果凭空给一个叫 example 的陌生人发了 INVITE"。
 *   注意 `\w` 在无 `u` 标志下只等于 `[A-Za-z0-9_]`，所以中文后面紧跟的 `@zhangsan`
 *   照常识别（`好@zhangsan` 里的 `好` 不是 `\w`）。
 */
const MENTION_TOKEN_RE = new RegExp(`(?<![\\w@])@([A-Za-z0-9_-]{1,${MAX_USERNAME_LEN}})`, "g");

/**
 * ★ 上限有两道，因为它们挡的是两件不同的事：
 *   · MAX_MENTION_CANDIDATES —— 一条评论最多**拿去查库**多少个不同令牌 / 多少个 span。
 *     挡的是数据库开销：一条塞 500 个 `@`（或报 500 个 span）的评论原来会变成
 *     一个 500 元素的 $in。两条路**各自**受这道上限约束，所以最坏情况是两次 20 元素的查询。
 *   · MAX_RESOLVED_MENTIONS  —— 一条评论最多**生成**多少条提及/通知。
 *     挡的是别人的收件箱：不封顶的话一条评论就能一次性给 500 个人各发一条通知，
 *     而发一条评论只受 20/分钟 的 branch:comment 限流约束 —— 换算下来是 10000 条/分钟。
 *     这道上限作用在**合并之后**（两条路加起来最多 10 个），否则报 span 就成了绕过口。
 *   超出的部分按**正文里的出现位置**丢弃（靠前的生效），不是随机丢：用户重读自己那条
 *   评论时，前面几个变成链接、后面几个是纯文本，规律看得出来。
 */
const MAX_MENTION_CANDIDATES = 20;
const MAX_RESOLVED_MENTIONS = 10;

/**
 * ★ ASCII 自动解析这条路的大小写不敏感靠 **collation**，不靠"再存一个小写字段"：
 *   原实现把令牌 `toLowerCase()` 之后拿去做**精确**匹配（`username: { $in: [...] }`），
 *   于是库里凡是带大写字母的用户名一个都 @ 不到 —— 而且不报错，就是"提及没反应"。
 *
 *   两条修法里选 collation 的理由：新增 `usernameLower` 派生字段意味着**存量用户那一项
 *   是 undefined**，在 backfill 跑完之前所有老账号都 @ 不到（把一个显性 bug 换成一个
 *   静默、且依赖运维步骤的 bug，正是铁律八要避免的）。collation 只作用于查询，
 *   对存量数据零前提。
 *   代价是默认的 `username_1` 唯一索引（simple collation）吃不上这个查询，所以在
 *   models/User.js 上另建了一条同 collation 的 `username_ci` 索引配套。
 *
 * ★ 值从 utils/username.js 取：索引定义、@提及查询、找人搜索的精确档三处必须**同一个对象**，
 *   差一个字段 MongoDB 就用不上索引，而且不报错、只是变慢。
 */
const MENTION_COLLATION = CI_COLLATION;

/** 24 位十六进制 = ObjectId 的字面形状。 */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * span 核对时的「大小写不敏感」。
 *
 * ★ 刻意**只折 ASCII**，不用 `String.prototype.toLowerCase()`：
 *   ① 口径要与 CI_COLLATION（locale "en", strength 2）对得上 —— 那是 ASCII 档的比较；
 *   ② `toLowerCase()` 会做 Unicode 大小写折叠，而**折叠可能改变字符串长度**
 *      （`'İ'.toLowerCase()` 是两个码位）。长度一变，"这一段正好是那个名字"这条
 *      校验就从长度上先错了，表现是某些名字永远核对不过、且一个错都不报。
 *   中文/emoji 不受影响（它们没有大小写），所以对昵称这条主路来说是逐字比较。
 */
function asciiFold(s) {
  return String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function ciEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;
  return asciiFold(a) === asciiFold(b);
}

/**
 * @typedef {Object} ResolvedMention
 * @property {string} token       原样带 `@` 的令牌，**保留用户键入时的字面**（如 `"@JohnDoe"`、`"@我是王桑"`）。
 *                                老客户端就是拿它在正文里做子串匹配来加链接的，所以不能归一。
 * @property {*}      userId      解析到的用户 _id（**身份的唯一依据**）
 * @property {string} username    库里的规范用户名（可能与 token 大小写不同）
 * @property {string} displayName 展示名。★ 仅供**当次**回包渲染，**不要落库**：它可变，
 *                                存下来就会在对方改名后对不上（同 renameMyVideos 那个坑）。
 * @property {number} offset      正文里那个 `@` 的下标（UTF-16 码元，即 JS 字符串下标）
 * @property {number} length      名字的长度（不含 `@`）。于是这一段是 [offset, offset+1+length)
 */

/**
 * 扫出正文里所有 ASCII 令牌，按出现顺序去重（`@Bob` 与 `@bob` 是同一个人）。
 * @returns {{token: string, offset: number}[]}
 */
function scanAsciiTokens(text) {
  const hits = [];
  const seenKeys = new Set();
  let match;
  MENTION_TOKEN_RE.lastIndex = 0; // 正则带 /g，是模块级共享的，用前必须复位
  while ((match = MENTION_TOKEN_RE.exec(text)) !== null) {
    const token = match[1];
    const key = asciiFold(token);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    hits.push({ token, offset: match.index });
    if (hits.length >= MAX_MENTION_CANDIDATES) break;
  }
  return hits;
}

/**
 * 解析文本里的 ASCII `@username` 并解析成真实用户。**ideas 那三个调用点用的就是这个**，
 * 签名与返回键一个字都没变（新增的 offset/length 只是 mentions 元素上多两个属性）。
 *
 * ★ 只返回**解析成功**的那些。解析不到的 `@nobody` 既不入 mentions 也不通知任何人，
 *   调用方据此让它保持纯文本 —— 用户由此能亲眼看出"这个 @ 没生效"。
 *   （反例是乐观加链接：点进去 404，而那时早已发不出去第二遍了。）
 *
 * @param {string} text
 * @returns {Promise<{userIds: any[], mentionedUsernames: string[], mentions: ResolvedMention[]}>}
 */
async function parseMentions(text) {
  const empty = { userIds: [], mentionedUsernames: [], mentions: [] };
  if (!text) return empty;

  const str = String(text);
  const hits = scanAsciiTokens(str);
  if (!hits.length) return empty;

  const users = await User.find({ username: { $in: hits.map((h) => h.token) } })
    .select("_id username displayName")
    .collation(MENTION_COLLATION)
    .lean();

  const byKey = new Map(users.map((u) => [asciiFold(u.username || ""), u]));

  const mentions = [];
  for (const hit of hits) {
    const u = byKey.get(asciiFold(hit.token));
    if (!u) continue;
    mentions.push({
      token: `@${hit.token}`,
      userId: u._id,
      username: u.username || "",
      displayName: u.displayName || "",
      offset: hit.offset,
      length: hit.token.length,
    });
    if (mentions.length >= MAX_RESOLVED_MENTIONS) break;
  }

  return toResult(mentions);
}

/**
 * 核对客户端报上来的 span，返回**核对通过**的那些。
 *
 * ★ 这是 span 这条路的**全部安全性所在**，四道检查缺一不可：
 *   ① userId 形状合法且**这个人真的存在**（不存在 = 客户端在编）；
 *   ② `text[offset]` 必须是 `@`（span 没有指着一个提及）；
 *   ③ `text.slice(offset+1, offset+1+length)` 必须**等于该用户当前的 displayName
 *      或 username**（ASCII 大小写不敏感）。这一条保证「客户端声称 @ 了某人」与
 *      「正文里真的写着那个人的名字」一致 —— 少了它，任何人都能对任意 userId 发通知，
 *      正文里连一个 @ 都不用有；
 *   ④ 同一个 userId 只留第一次（同一条评论里 @ 同一个人两次不该发两条通知）。
 *   不通过的**只丢这一条**，不整条评论 400：一个 @ 没生效不该把用户写好的一段话打回去。
 *
 * ★ 为什么允许匹配 username 而不只是 displayName：显示名可以是空串（默认值），
 *   那种账号在 App 里显示的就是 username，补全面板报上来的自然也是它。
 *   只认 displayName 会让"从没设过昵称的人"永远 @ 不到，而且一个错都不报。
 *
 * @param {string} text
 * @param {{userId: string, offset: number, length: number}[]} spans
 * @returns {Promise<ResolvedMention[]>}
 */
async function resolveMentionSpans(text, spans) {
  if (!text || !Array.isArray(spans) || !spans.length) return [];
  const str = String(text);

  // 先做**不查库**的那几道（形状、边界、'@' 位、去重），把查询量压到 20 以内
  const wanted = [];
  const seenIds = new Set();
  for (const raw of spans) {
    const userId = String(raw?.userId || "");
    const offset = Number(raw?.offset);
    const length = Number(raw?.length);
    if (!OBJECT_ID_RE.test(userId)) continue;
    if (!Number.isInteger(offset) || offset < 0) continue;
    if (!Number.isInteger(length) || length < 1) continue;
    if (offset + 1 + length > str.length) continue;
    if (str[offset] !== "@") continue;
    if (seenIds.has(userId)) continue;
    seenIds.add(userId);
    wanted.push({ userId, offset, length });
    if (wanted.length >= MAX_MENTION_CANDIDATES) break;
  }
  if (!wanted.length) return [];

  const users = await User.find({ _id: { $in: wanted.map((w) => w.userId) } })
    .select("_id username displayName")
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const out = [];
  for (const w of wanted) {
    const u = byId.get(w.userId);
    if (!u) continue; // 这个人不存在 / 已注销
    const typed = str.slice(w.offset + 1, w.offset + 1 + w.length);
    if (!ciEqual(typed, u.displayName) && !ciEqual(typed, u.username)) continue;
    out.push({
      // token 存的是**当时打出来的字面**（不是当前 displayName）：它是这条 span
      // 日后能被重新核对的唯一依据，也是老客户端做子串匹配用的那个串。
      token: `@${typed}`,
      userId: u._id,
      username: u.username || "",
      displayName: u.displayName || "",
      offset: w.offset,
      length: w.length,
    });
  }
  return out;
}

/**
 * 合并两条路的结果：按正文位置排序 → 同一个 userId 只留一次 → 丢掉重叠的 → 封顶。
 *
 * ★ **重叠必须丢**，这不是洁癖：渲染端要把每个 span 换成 `@` + 当前 displayName，
 *   多个 span 是**从后往前**替换的（从前往后会把后面的 offset 冲掉）。两段重叠时
 *   这个算法没有正确解 —— 第二次替换会切在第一次的结果中间，出来是一段乱码。
 *   靠前、更长的那个赢（`@王桑` 胜过 `@王`）。
 * ★ 排序基准是**正文位置**而不是"客户端报的顺序"：封顶丢弃时用户能看出规律
 *   （前面几个是链接、后面几个是纯文本）。
 */
function mergeMentions(...lists) {
  const all = lists.flat();
  all.sort((a, b) => a.offset - b.offset || b.length - a.length);

  const out = [];
  const seenIds = new Set();
  for (const m of all) {
    const uid = String(m.userId);
    if (seenIds.has(uid)) continue;
    const prev = out[out.length - 1];
    // 已保留的 span 两两不重叠且按 offset 递增 ⇒ 只需与最后一个比
    if (prev && m.offset < prev.offset + 1 + prev.length) continue;
    seenIds.add(uid);
    out.push(m);
    if (out.length >= MAX_RESOLVED_MENTIONS) break;
  }
  return out;
}

function toResult(mentions) {
  return {
    // ⚠ 语义收窄过一次：`mentionedUsernames` 现在是**解析成功**的规范用户名，
    //   不再是"文本里出现过的所有令牌（小写）"。仓内的调用方都只解构 userIds，
    //   保留这个键纯粹是为了不给外部调用方留个 undefined。
    userIds: mentions.map((m) => m.userId),
    mentionedUsernames: mentions.map((m) => m.username),
    mentions,
  };
}

/**
 * 分支视频这一侧的入口：客户端报的 span + ASCII 自动解析，合并去重后返回。
 *
 * ★ 单开一个入口而不是给 parseMentions 加第二个参数：ideas 那三个调用点连"有 span
 *   这回事"都不该知道，签名不动就不可能被这次改动带坏（跑全量测试确认）。
 * ★ 两条查询并行发：它们查的是不同的键（username vs _id），没有先后依赖。
 *
 * @param {string} text
 * @param {{userId: string, offset: number, length: number}[]} [spans] 客户端补全面板报上来的
 */
async function parseMentionsWithSpans(text, spans) {
  if (!text) return { userIds: [], mentionedUsernames: [], mentions: [] };
  const [byText, bySpan] = await Promise.all([parseMentions(text), resolveMentionSpans(text, spans)]);
  return toResult(mergeMentions(bySpan, byText.mentions));
}

module.exports = {
  parseMentions,
  parseMentionsWithSpans,
  resolveMentionSpans,
  MAX_MENTION_CANDIDATES,
  MAX_RESOLVED_MENTIONS,
  MENTION_COLLATION,
  // 导出只为让用例能钉住"令牌上限 == 注册侧上限"这条约束。
  // ⚠ 它带 /g 且是模块级共享的，外部用之前必须自己复位 lastIndex。
  MENTION_TOKEN_RE,
};
