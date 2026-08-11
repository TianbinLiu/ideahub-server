// src/utils/username.js
// 用户名的**长度上限**与**大小写不敏感口径**：全仓唯一的出处（铁律六）。
//
// 为什么要单独立一个文件：这两个值原来各写各的，而且已经对不上了 ——
//   · utils/mentionParser.js 的 MENTION_TOKEN_RE 把令牌截到 32 字符；
//   · models/User.js 与注册接口对 username 的长度**一个字都没管**。
// 于是长度 33 以上的用户名是一个**合法的既有状态**，而它在两条产品线上
// （官网的 ideas 评论、app 的分支视频评论）都**永远 @ 不到**：
// 用户打完 @ 全名，前 32 个字符被切出来当令牌，查库对不上任何人，
// 于是那个 @ 保持纯文本 —— 没有报错，只是"打了没反应"。
//
// 两条修法里选"把注册侧收进 32"而不是"把解析侧放宽"：
//   放宽解析侧要放宽到多少？username 没有上限，就没有任何一个数字是"够用的"，
//   只是把同一个 bug 挪到更靠后的位置。收在注册侧才真的让两个数字相等。

const { badRequest } = require("./http");

/**
 * 用户名最大长度。**必须**与 mentionParser 的 MENTION_TOKEN_RE 上限相等 ——
 * 令牌切得比用户名短，那个用户名就 @ 不到；切得比用户名长也没意义。
 */
const MAX_USERNAME_LEN = 32;

/**
 * @提及 / 找人时"大小写不敏感"的统一口径。
 *
 * ★ 与 models/User.js 上的 username_ci / displayName_ci 索引**逐字相等**：
 *   MongoDB 只在查询 collation 与索引 collation 完全一致时才用得上那条索引，
 *   对不上不报错，只是默默退化成全表扫（users 表迟早会大到让每次查询都拖一下）。
 *   所以三处（这里、索引定义、查询）都从这一个常量取值，不要再手抄字面量。
 */
const CI_COLLATION = { locale: "en", strength: 2 };

/**
 * 注册侧的用户名长度校验。
 *
 * ★ 刻意**不做**成 models/User.js 上的 `maxlength`：mongoose 的 `save()` 默认校验
 *   **整份文档**（不只是改动过的字段），而本仓有几处 `user.save()` 是拿
 *   `findById().select(...)` 出来的部分文档改密码 / 改 tokenVersion 的
 *   （auth.controller 的 setPassword / changePassword / logoutAllSessions）。
 *   给 username 挂 maxlength 会让**存量的超长用户名账号连密码都改不了**，
 *   报的还是一个和密码毫无关系的校验错 —— 拿一个"打了 @ 没反应"换一个"改不了密码"，
 *   后者严重得多。
 *
 * ⚠ 存量的超长用户名行怎么办：**保持原样，不改名、不下线**。它们照常登录、
 *   照常被搜到（找人搜索走的是子串匹配，不受这个上限影响）、照常发内容；
 *   唯一的差别是仍然 @ 不到，且这是一个**不再增长的有限集合**（注册侧从此挡住了）。
 *   真要收尾得走一次带用户沟通的改名迁移（用户名是公开身份，静默改名比 @ 不到更糟），
 *   那是产品决定，不是这里能顺手做掉的事。
 *
 * @param {unknown} username
 * @returns {string} 归一（trim）后的用户名
 * @throws {AppError} 长度不合法时 400 VALIDATION_ERROR
 */
function normalizeNewUsername(username) {
  const name = String(username ?? "").trim();
  if (!name) badRequest("username is required");
  if (name.length > MAX_USERNAME_LEN) {
    badRequest(`username must be at most ${MAX_USERNAME_LEN} characters`);
  }
  return name;
}

module.exports = { MAX_USERNAME_LEN, CI_COLLATION, normalizeNewUsername };
