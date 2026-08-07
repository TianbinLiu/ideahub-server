// 用户输入构造正则时的唯一转义收口。
//
// 为什么单独抽一个文件：仓里原本有 8 处各自手写的转义，其中两处
// （users.controller.js 的用户名搜索、ideas.controller.js 的 suggest）
// 把字符类写成了 `[.*+?^${}()|[\\]\\]` —— 多出来的那个反斜杠让字符类在 `]` 处
// 提前闭合，整个 replace 变成 no-op（实测：转义前后字符串完全相同）。
// 后果不是"少转义了几个字符"，而是**用户输入原样成为正则**：
//   ?q=(a+)+$  →  new RegExp("^(a+)+$")  →  单次 test 实测 41.7 秒 CPU，
// 且这个正则会被交给 mongod 执行，等于把 CPU 打满转嫁到数据库。
// 该端点只挂 optionalAuth，未登录即可打。
//
// 手写正则字面量太容易错且错了不报错，所以此处只留一份，全仓引用它。

/** 转义正则元字符，使 input 只能匹配它自己的字面量 */
function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把用户输入变成安全的搜索正则。
 * @param {string} input 用户输入
 * @param {object} [opts]
 * @param {boolean} [opts.anchored] 是否加 `^` 前缀锚定（前缀匹配比包含匹配能吃上索引）
 * @param {number} [opts.maxLength] 长度上限，默认 64——转义后正则不会爆炸，
 *   但超长输入仍会让 mongod 逐文档做无意义的长串比较，先截断更省。
 * @returns {RegExp}
 */
function searchRegex(input, { anchored = false, maxLength = 64 } = {}) {
  const escaped = escapeRegex(String(input).slice(0, maxLength));
  return new RegExp(anchored ? `^${escaped}` : escaped, "i");
}

module.exports = { escapeRegex, searchRegex };
