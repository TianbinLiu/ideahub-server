// 公开数字 UID 的唯一出处。
//
// ★ 为什么是**随机** 9 位数而不是顺序号：顺序号（B 站那种）暴露注册先后、
//   可被「德国坦克问题」估算总用户量、还能从 1 遍历到 N 爬全站名单。
//   「无法从 id 推断信息」这个目标只有随机能达成 —— uid 只是把已有的随机性
//   包装成整齐的数字，不是引入一个新的信息通道。
// ★ 9 位（100000000..999999999，9 亿个）对本应用规模绰绰有余；生成时查一次库
//   把碰撞概率压到只剩并发窗口，唯一索引兜底（撞上 11000 重试）。
// ★ 生成只在这里与 User 模型的 pre-save 钩子（一处实现）：任何一条建号路径 ——
//   邮箱注册 / 手机号 / Google / GitHub / QQ / 微信 / 将来新增 —— 都自动带上，
//   不需要每个 controller 记得调（"新 provider 没搬全"那族坑的根治法）。

const crypto = require("crypto");

const UID_MIN = 100_000_000;
const UID_SPAN = 900_000_000; // [1e8, 1e9)

function randomUidCandidate() {
  return UID_MIN + crypto.randomInt(UID_SPAN);
}

/**
 * 生成一个未被占用的 uid。
 * @param {(uid: number) => Promise<boolean>} isTaken 查库判占用（由调用方注入，避免循环依赖 User 模型）
 */
async function generateUid(isTaken) {
  for (let i = 0; i < 8; i++) {
    const uid = randomUidCandidate();
    if (!(await isTaken(uid))) return uid;
  }
  // 9 亿空间连撞 8 次 ≈ 不可能；真到这儿说明库或注入的判定坏了，宁可失败也别塞重号
  throw new Error("生成 UID 失败，请重试");
}

module.exports = { generateUid, UID_MIN, UID_SPAN };
