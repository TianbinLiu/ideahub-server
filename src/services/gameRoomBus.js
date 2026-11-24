/**
 * @file gameRoomBus.js - 工坊对局的**进程内**变化总线（SSE 推送的唯一广播口）
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节与 docs/api-contract.md
 *
 * ★★ 它只说「这间房变了」，**不带任何数据**：订阅者（services/gameRoomStream.service）收到后
 *   自己按**看的人**重新读一次快照。房间快照带 `canStart`、回合快照带 `likedByMe` / `votedByMe`，
 *   都是「看的人视角」—— 一份广播数据不可能对每个人有同一个答案。
 *
 * ★★ 单实例语义（重要，别理解错）：这是 `EventEmitter`，活在**一个 Node 进程里**。
 *   线上是 pm2 cluster（2 实例）+ nginx：A 实例上的写只会推给连在 A 实例上的订阅者；
 *   连在 B 实例上的客户端收不到这一帧，要靠它**自己的轮询**兜底（App 的轮询退路必须留着）。
 *   为什么不做跨实例广播：要跨进程就得引 Redis pub/sub（这次明确不新增依赖）；Redis 本来就用着，
 *   以后要补也不改这里的接口（publish / subscribe 的签名不变）。
 *   见 docs/api-contract.md「工坊对局：推送（SSE）」。
 *
 * ★ 监听数上限：8 座 × 每人 2 条连接 = 16/房间，64 留 4 倍余量给「同一人换设备时新旧连接
 *   短时间重叠」。超了 subscribe 返回 null（调用方按「这间房满了」处理并关连接）——
 *   不设上限的话，一个客户端反复重连就能把 listener 数组撑大（内存泄漏 + 每次 emit 都遍历一遍，
 *   同一间房的其他人跟着变慢）。
 */

const { EventEmitter } = require("events");

/** 每间房最多挂几个 listener（见文件头的 ★） */
const MAX_LISTENERS_PER_ROOM = 64;

const bus = new EventEmitter();
// ★ 与自己的上限同一个数：EventEmitter 的默认值是 10，超过只会打一行 MaxListenersExceededWarning，
//   那条日志会误导人以为泄漏；真正的闸在 subscribe（超了返回 null）。
bus.setMaxListeners(MAX_LISTENERS_PER_ROOM);

/**
 * 每个房间现在挂了几个 listener。
 * EventEmitter 不暴露计数，而清理与上限都要它 —— 计数的唯一一份就在这里，别在调用方再数一遍。
 */
const counts = new Map();

/**
 * 房号 → 频道键。只做「去空格 + 大写」，**不判形状**（形状判据只在 gameRoom.service.normalizeCode）。
 * 返回空串 = 这间房根本没名字，调用方按「没有订阅」处理。
 */
function keyOf(code) {
  return String(code ?? "").trim().toUpperCase();
}

/** 频道名只在这一处拼 / 拆（拼与拆各写一遍，迟早对不上） */
const CHANNEL_PREFIX = "game-room:";
function channelOf(key) {
  return `${CHANNEL_PREFIX}${key}`;
}

/**
 * 订阅一间房的变化。
 * @returns {Function|null} 退订函数（**幂等**：连接关闭与错误两条路都会调它）；超过上限返回 null
 */
function subscribe(code, listener) {
  const key = keyOf(code);
  if (!key || typeof listener !== "function") return null;
  const channel = channelOf(key);
  const count = counts.get(channel) || 0;
  if (count >= MAX_LISTENERS_PER_ROOM) return null;
  counts.set(channel, count + 1);
  bus.on(channel, listener);
  let done = false;
  return function unsubscribe() {
    if (done) return;
    done = true;
    bus.removeListener(channel, listener);
    const left = (counts.get(channel) || 1) - 1;
    if (left > 0) {
      counts.set(channel, left);
    } else {
      // 归零就整条频道清掉：万一有 listener 走了不经过 unsubscribe 的路（泄漏），
      // 这里也把它一起收走，不会永远留在 counts 里挡住后来的订阅者。
      counts.delete(channel);
      bus.removeAllListeners(channel);
    }
  };
}

/**
 * 广播「这间房变了」（事件名固定 `changed`；房号在频道名里）。
 * @returns {number} 本进程里被通知到的订阅者数（0 = 没人在听，调用方拿它做日志/测试）
 */
function publish(code) {
  const key = keyOf(code);
  if (!key) return 0;
  const channel = channelOf(key);
  const count = counts.get(channel) || 0;
  if (!count) return 0;
  bus.emit(channel, "changed");
  return count;
}

/** 这间房在这个进程里现在有几个订阅者（测试与排障用；业务代码只靠 publish 的返回值） */
function subscriberCount(code) {
  const key = keyOf(code);
  return key ? counts.get(channelOf(key)) || 0 : 0;
}

/** 全进程还剩几间房有订阅者（诊断用） */
function activeRoomCount() {
  return counts.size;
}

/**
 * 清空总线（**只给测试用**）。
 * ★ 同一个进程里连跑几十条用例，某条忘了关连接就会让下一条的计数带上一条的残留。
 */
function resetForTests() {
  bus.removeAllListeners();
  counts.clear();
}

module.exports = {
  MAX_LISTENERS_PER_ROOM,
  subscribe,
  publish,
  subscriberCount,
  activeRoomCount,
  resetForTests,
};
