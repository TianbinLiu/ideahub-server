// src/utils/mentionParser.js
// @提及解析：**全仓唯一一处**（铁律六）。三条产品线共用：
//   · ideas：Comment.mentions / Idea.invitedUsers（ideas.controller / ideaInteractions.controller）
//   · 分支视频：BranchComment.mentions + BRANCH_MENTION 通知（branchVideo.controller）
// 所以下面每一条修正都是**跨产品线生效**的，改之前先想清楚 ideas 那边会怎样。
//
// ★ 身份令牌是 **@username，不是 @displayName**，这是全项目的既定约定：
//   `username` 在 User 上是 unique 的，`displayName` 既不唯一、默认是空串、还能随时改。
//   身份绝不能挂在可变且不唯一的字段上 —— app 仓 data/videos.ts 的 renameMyVideos
//   就是为了收拾"拿显示名当身份"留下的烂摊子（改个昵称，自己发的作品就不认自己了）。

const User = require("../models/User");
// 用户名的长度上限与 ci 口径都只有一个出处（铁律六）：utils/username.js。
// ★ 这里的 {1,MAX_USERNAME_LEN} 和注册侧的长度校验**必须是同一个数** ——
//   令牌切得比允许的用户名短，那些账号就永远 @ 不到，而且"打了 @ 没反应"，一个错都不报。
const { MAX_USERNAME_LEN, CI_COLLATION } = require("./username");

/**
 * ★ 令牌字符集**刻意只收 ASCII**（与原实现一致），这是一次有意识的取舍，不是漏改：
 *
 *   本仓的注册接口对 username 没有字符集校验，所以库里理论上**可以**存在中文用户名。
 *   但把字符类放宽到 `\p{L}` 会立刻踩另一个更糟的坑：中日韩文本没有词边界，
 *   `@张三你好啊，今天更新了吗` 会被贪婪吃成一个 12 字的令牌，匹配不到任何人；
 *   而想正确切出"张三"就需要分词，没有任何非任意的切法（试前缀 = 一句话 N 次查库）。
 *   于是放宽的净效果是：中文用户名**仍然**解析不到，却多了一条按句子长度伸缩的查询。
 *
 *   非 ASCII 用户名要能被 @ 到，正确的修法在**注册侧**（给 username 加 handle 策略、
 *   把中文名留给 displayName），不在解析侧。在那之前，`@中文名` 原样保持纯文本 ——
 *   而调用方会把"哪些提及真的解析上了"回给客户端，用户**看得见**它没生效（不是静默失败）。
 *
 * ★ 前置断言 `(?<![\w@])` 是新加的，用来把**邮箱地址**挡在外面：
 *   `someone@example.com` 原来会解析出一个 `@example` 的提及 —— ideas 那边表现为
 *   "贴了个邮箱，结果凭空给一个叫 example 的陌生人发了 INVITE"。
 *   注意 `\w` 在无 `u` 标志下只等于 `[A-Za-z0-9_]`，所以中文后面紧跟的 `@zhangsan`
 *   照常识别（`好@zhangsan` 里的 `好` 不是 `\w`）。
 */
const MENTION_TOKEN_RE = new RegExp(`(?<![\\w@])@([A-Za-z0-9_-]{1,${MAX_USERNAME_LEN}})`, "g");

/**
 * ★ 上限有两道，因为它们挡的是两件不同的事：
 *   · MAX_MENTION_CANDIDATES —— 一条评论最多**拿去查库**多少个不同令牌。
 *     挡的是数据库开销：一条塞 500 个 `@` 的评论原来会变成一个 500 元素的 $in。
 *   · MAX_RESOLVED_MENTIONS  —— 一条评论最多**生成**多少条提及/通知。
 *     挡的是别人的收件箱：不封顶的话一条评论就能一次性给 500 个人各发一条通知，
 *     而发一条评论只受 20/分钟 的 branch:comment 限流约束 —— 换算下来是 10000 条/分钟。
 *   超出的部分按**出现顺序**丢弃（前 N 个生效），不是随机丢：用户重读自己那条评论时，
 *   前面几个变成链接、后面几个是纯文本，规律看得出来。
 */
const MAX_MENTION_CANDIDATES = 20;
const MAX_RESOLVED_MENTIONS = 10;

/**
 * ★ 大小写不敏感靠 **collation**，不靠"再存一个小写字段"：
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

/**
 * @typedef {Object} ResolvedMention
 * @property {string} token       原样带 `@` 的令牌，**保留用户键入时的大小写**（如 `"@JohnDoe"`）。
 *                                客户端就是拿它在正文里做子串匹配来加链接的，所以这里
 *                                不能归一成小写 —— 归一了就在正文里找不到自己。
 * @property {*}      userId      解析到的用户 _id（身份的唯一依据）
 * @property {string} username    库里的规范用户名（可能与 token 大小写不同）
 * @property {string} displayName 展示名。★ 仅供**当次**回包渲染，**不要落库**：它可变，
 *                                存下来就会在对方改名后对不上（同 renameMyVideos 那个坑）。
 */

/**
 * 解析文本里的 @提及并解析成真实用户。
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

  // 按出现顺序去重。去重的键是小写形式：同一条评论里 `@Bob` 和 `@bob` 是同一个人，
  // 查两遍、通知两条都不对。
  const candidates = [];
  const seenKeys = new Set();
  let match;
  MENTION_TOKEN_RE.lastIndex = 0; // 正则带 /g，是模块级共享的，用前必须复位
  while ((match = MENTION_TOKEN_RE.exec(String(text))) !== null) {
    const token = match[1];
    const key = token.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    candidates.push(token);
    if (candidates.length >= MAX_MENTION_CANDIDATES) break;
  }
  if (!candidates.length) return empty;

  const users = await User.find({ username: { $in: candidates } })
    .select("_id username displayName")
    .collation(MENTION_COLLATION)
    .lean();

  const byKey = new Map(users.map((u) => [String(u.username || "").toLowerCase(), u]));

  const mentions = [];
  for (const token of candidates) {
    const u = byKey.get(token.toLowerCase());
    if (!u) continue;
    mentions.push({
      token: `@${token}`,
      userId: u._id,
      username: u.username || "",
      displayName: u.displayName || "",
    });
    if (mentions.length >= MAX_RESOLVED_MENTIONS) break;
  }

  return {
    // ⚠ 语义收窄过一次：`mentionedUsernames` 现在是**解析成功**的规范用户名，
    //   不再是"文本里出现过的所有令牌（小写）"。仓内两个调用方都只解构 userIds，
    //   保留这个键纯粹是为了不给外部调用方留个 undefined。
    userIds: mentions.map((m) => m.userId),
    mentionedUsernames: mentions.map((m) => m.username),
    mentions,
  };
}

module.exports = {
  parseMentions,
  MAX_MENTION_CANDIDATES,
  MAX_RESOLVED_MENTIONS,
  MENTION_COLLATION,
  // 导出只为让用例能钉住"令牌上限 == 注册侧上限"这条约束。
  // ⚠ 它带 /g 且是模块级共享的，外部用之前必须自己复位 lastIndex。
  MENTION_TOKEN_RE,
};
