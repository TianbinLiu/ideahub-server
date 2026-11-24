/**
 * @file gameRoomBus.js - 工坊对局的变化总线（SSE 推送的唯一广播口；有 Redis 时跨实例）
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节与 docs/api-contract.md
 *
 * ★★ 它只说「这间房变了」，**不带任何数据**：订阅者（services/gameRoomStream.service）收到后
 *   自己按**看的人**重新读一次快照。房间快照带 `canStart`、回合快照带 `likedByMe` / `votedByMe`，
 *   都是「看的人视角」—— 一份广播数据不可能对每个人有同一个答案。
 *
 * ★★ 跨实例语义（2026-11-24 起，取代原来的「单实例」）：
 *   线上是 pm2 cluster（2 实例）+ nginx，nginx 不粘会话，A 实例上的写必须能推到连在 B 实例上的
 *   客户端。本文件用 **Redis pub/sub** 做这件事，对外仍然只有 `publish(code)` / `subscribe(code,
 *   listener)` 两个函数，调用方（gameRoomStream.service / routes）一行都不用改。
 *
 *   · 频道：`game-room:<CODE>`（与本地 EventEmitter 的事件名同一个字符串，拼 / 拆只在本文件）；
 *   · 订阅：每个实例启动时 `PSUBSCRIBE game-room:*` **一次**，收到后只在本进程内分发。
 *     ★ 为什么用通配模式而不是「每个房 SUBSCRIBE 一条」：Redis 没有通配频道，单频道模式就得在
 *       订阅者 0→1 时 SUBSCRIBE、归零时 UNSUBSCRIBE —— 每个实例都要为「这间房现在有没有人看」
 *       维护一份映射，还要处理「退订途中来了新订阅者」「重连后把当前房间列表重放一遍」这些
 *       竞态；换来的是省掉**别人房间**那几字节的消息。一桌最多 8 人、一次写才几十字节，
 *       这点噪音不值得换一套状态机。PSUBSCRIBE 一次之后，新房号自动覆盖，重连也由 node-redis
 *       自动重放（见下面「生命周期」），是这里最简单的正确做法。
 *   · 去重（二选一，本实现选「发布时本地立即分发 + 跳过自己的回环」）：
 *       ① `publish` 先在本进程 `emit`（延迟与改造前一样，订阅者立刻收到），再把消息发到 Redis；
 *       ② 消息体带 `{ instanceId, room: <CODE> }`，本实例的订阅连接收到自己发的消息时直接丢。
 *     为什么选这个而不是「只发 Redis、等自己的订阅回来再本地分发」：后者让本地推送多绕一趟
 *     Redis（正常几毫秒，Redis 抖动时是网络 RTT），而且 `publish()` 的返回值（本进程订阅者数）
 *     会变得不可靠。现在每个变化在**每个实例上恰好分发一次**：发布实例走本地那条，其它实例
 *     走 Redis 那条。
 *   · 降级：没有 `REDIS_URL` / 连不上 / 订阅断开重连中 → 只走本地 `emit`，行为与改造前完全一样
 *     （日志 warn **一次**，不刷屏）。此时 `/api/ark/health` 的 `gameRoomStreamShared` 为 false，
 *     App 必须靠轮询兜底（false = 只有本实例能收到）。Redis 恢复后 node-redis 自动重连 + 自动
 *     重放 PSUBSCRIBE，`gameRoomStreamShared` 自己变回 true；断线期间漏掉的变化不补（轮询兜底）。
 *
 * ★ 监听数上限：8 座 × 每人 2 条连接 = 16/房间，64 留 4 倍余量给「同一人换设备时新旧连接
 *   短时间重叠」。超了 subscribe 返回 null（调用方按「这间房满了」处理并关连接）——
 *   不设上限的话，一个客户端反复重连就能把 listener 数组撑大（内存泄漏 + 每次 emit 都遍历一遍，
 *   同一间房的其他人跟着变慢）。
 *
 * ★ 生命周期（订阅连接单例、退出时清理）：
 *   · 订阅连接与发布连接各一条（node-redis 的订阅连接进入 subscriber mode 后不能再发普通命令）；
 *   · 断线重连交给 node-redis 的 `reconnectStrategy`；它重连时会自动把已注册的 PSUBSCRIBE 重放
 *     一遍，所以这里**只在第一次 ready 时订阅一次**，不要在每次 ready 里重复 PSUBSCRIBE
 *     （重复注册同一个 pattern 的 listener 会让一条消息被分发多次）；
 *   · `close()` 退订 + quit（失败退回 destroy），由 src/index.js 的优雅退出调用；
 *   · 订阅者归零时**不退订**频道（保持简单；没人订阅时收到消息直接丢，见 handleMessage）。
 */

const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");

/** 每间房最多挂几个 listener（见文件头的 ★） */
const MAX_LISTENERS_PER_ROOM = 64;

/** 频道名前缀 / PSUBSCRIBE 模式（拼与拆都只在本文件，迟早对不上） */
const CHANNEL_PREFIX = "game-room:";
const PSUBSCRIBE_PATTERN = `${CHANNEL_PREFIX}*`;

/**
 * 房号 → 频道键。只做「去空格 + 大写」，**不判形状**（形状判据只在 gameRoom.service.normalizeCode）。
 * 返回空串 = 这间房根本没名字，调用方按「没有订阅」处理。
 */
function keyOf(code) {
  return String(code ?? "").trim().toUpperCase();
}

/** 频道名只在这一处拼；拆用 channelKeyOf（PSUBSCRIBE 回来的是完整频道名） */
function channelOf(key) {
  return `${CHANNEL_PREFIX}${key}`;
}

/** 从 PSUBSCRIBE 收到的完整频道名还原房号；不是本前缀的（理论上不会出现）返回空串 */
function channelKeyOf(channel) {
  const name = String(channel ?? "");
  return name.startsWith(CHANNEL_PREFIX) ? name.slice(CHANNEL_PREFIX.length) : "";
}

/**
 * 建一个独立的总线实例。
 *
 * ★ 为什么导出工厂而不只是一个单例：本文件的集成测试要用**两个各自持有订阅连接**的实例验证
 *   「A 发布 → B 收到」—— 同一个单例测不出跨实例。生产代码只 require 模块导出的那套单例函数
 *   （src/services/gameRoomStream.service 与 routes 用的就是它们），签名与改造前完全一致。
 *
 * @param {{redisUrl?:string, instanceId?:string, logger?:{warn:Function, log?:Function},
 *          connectTimeoutMs?:number, subscribeRetryMs?:number}} [options]
 *        redisUrl 缺省读 process.env.REDIS_URL（空 = 只用进程内广播）。
 */
function createRoomBus(options = {}) {
  const redisUrl = String(
    options.redisUrl === undefined ? process.env.REDIS_URL || "" : options.redisUrl || "",
  );
  // ★ 启动时随机：用来丢掉自己发布的回环。两个实例恰好同 id 的概率可以忽略（UUID）。
  const instanceId = options.instanceId || randomUUID();
  const logger = options.logger || console;
  const connectTimeoutMs = options.connectTimeoutMs || 1000;
  const subscribeRetryMs = options.subscribeRetryMs || 2000;

  const bus = new EventEmitter();
  // ★ 与自己的上限同一个数：EventEmitter 的默认值是 10，超过只会打一行 MaxListenersExceededWarning，
  //   那条日志会误导人以为泄漏；真正的闸在 subscribe（超了返回 null）。
  bus.setMaxListeners(MAX_LISTENERS_PER_ROOM);

  /**
   * 每个房间现在挂了几个 listener。
   * EventEmitter 不暴露计数，而清理与上限都要它 —— 计数的唯一一份就在这里，别在调用方再数一遍。
   */
  const counts = new Map();

  // ── Redis 状态（全部是「降级也要能跑」的路径：任何失败都只记一次日志，不抛） ──
  let subscriber = null;
  let publisher = null;
  let subscriberReady = false;
  let publisherReady = false;
  /** PSUBSCRIBE 是否成功过一次（之后的重连由 node-redis 自动重放，不用再发） */
  let subscribed = false;
  let subscribeInFlight = null;
  let subscribeRetryTimer = null;
  let warned = false;
  let connectedLogged = false;
  let closed = false;

  /** 降级日志只打一次：Redis 抖动时 node-redis 每次重连都会抛 error，照打会刷屏 */
  function degrade(message) {
    if (warned) return;
    warned = true;
    logger.warn?.(
      `[game-room-bus] ${message}；跨实例推送关闭，退回进程内广播` +
        `（只有本实例的订阅者能收到，App 靠轮询兜底）`,
    );
  }

  function logConnectedOnce() {
    if (connectedLogged) return;
    connectedLogged = true;
    logger.log?.(`[game-room-bus] Redis pub/sub 已连接，跨实例推送开启（instanceId=${instanceId}）`);
  }

  /** 跨实例通道此刻是否可用（false = 只有本实例能收到；/api/ark/health 的能力位读它） */
  function isShared() {
    return !closed && subscriberReady && publisherReady && subscribed;
  }

  /**
   * 收到别的实例发来的「这间房变了」。
   * ★ 自己的回环直接丢：发布时已经本地分发过（见文件头的去重说明）。
   * ★ 没人订阅时直接丢：不为「还没人看的房间」排队 / 缓存，重连后也不补 —— 客户端有轮询。
   */
  function handleMessage(message, channel) {
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return; // 不是我们发的消息（同前缀被别的程序占用）：忽略，不要因为一条脏消息把订阅搞崩
    }
    if (!payload || payload.instanceId === instanceId) return;
    const key = keyOf(payload.room || channelKeyOf(channel));
    if (!key) return;
    const name = channelOf(key);
    if (!counts.get(name)) return;
    bus.emit(name, "changed");
  }

  function scheduleSubscribeRetry() {
    if (subscribeRetryTimer || closed) return;
    subscribeRetryTimer = setTimeout(() => {
      subscribeRetryTimer = null;
      if (!closed && subscriberReady) ensureSubscribed().catch(() => {});
    }, subscribeRetryMs);
    // 别让它单独把进程留住（生产有 HTTP server，测试里靠 close 收尾）
    subscribeRetryTimer.unref?.();
  }

  /** 第一次 ready 时订阅一次；失败按 subscribeRetryMs 重试（重连成功后由 ready 事件再触发） */
  function ensureSubscribed() {
    if (!subscriber || closed || subscribed) return Promise.resolve();
    if (subscribeInFlight) return subscribeInFlight;
    subscribeInFlight = subscriber
      .pSubscribe(PSUBSCRIBE_PATTERN, handleMessage)
      .then(() => {
        subscribed = true;
        logConnectedOnce();
      })
      .catch((err) => {
        degrade(`订阅 ${PSUBSCRIBE_PATTERN} 失败（${err?.message || err}）`);
        scheduleSubscribeRetry();
      })
      .finally(() => {
        subscribeInFlight = null;
      });
    return subscribeInFlight;
  }

  function socketOptions() {
    return {
      connectTimeout: connectTimeoutMs,
      // ★ 不学 config/redis 的「重试 10 次就放弃」：那个客户端在**请求路径**上，Redis 挂了还一直
      //   重连会让每个请求都等连接超时；这里的订阅连接在后台，断了只影响跨实例推送（本来就有轮询
      //   兜底）。一直重试（上限 5 秒一次）才能在 Redis 恢复后自动接上，不用重启进程。
      reconnectStrategy: (retries) => Math.min(200 * (retries + 1), 5000),
    };
  }

  function initRedis() {
    if (!redisUrl) {
      degrade("没有配置 REDIS_URL");
      return;
    }
    let createClient;
    try {
      ({ createClient } = require("redis"));
    } catch (err) {
      degrade(`加载 redis 客户端失败（${err?.message || err}）`);
      return;
    }

    subscriber = createClient({ url: redisUrl, socket: socketOptions() });
    publisher = createClient({ url: redisUrl, socket: socketOptions() });

    subscriber.on("error", (err) => {
      subscriberReady = false;
      degrade(`订阅连接异常（${err?.message || err}）`);
    });
    subscriber.on("reconnecting", () => {
      subscriberReady = false;
    });
    subscriber.on("end", () => {
      subscriberReady = false;
    });
    subscriber.on("ready", () => {
      subscriberReady = true;
      // 重连时 node-redis 已经自动重放了 PSUBSCRIBE；subscribed 为 true 就直接跳过。
      ensureSubscribed().catch(() => {});
    });

    publisher.on("error", (err) => {
      publisherReady = false;
      degrade(`发布连接异常（${err?.message || err}）`);
    });
    publisher.on("reconnecting", () => {
      publisherReady = false;
    });
    publisher.on("end", () => {
      publisherReady = false;
    });
    publisher.on("ready", () => {
      publisherReady = true;
      logConnectedOnce();
    });

    // ★ 用 Promise.all 而不是分开 catch：两条连接都是「通了两条才算跨实例可用」，一条失败就降级。
    //   失败后不停止重连（reconnectStrategy 继续跑），恢复后 isShared() 自己变回 true。
    Promise.all([subscriber.connect(), publisher.connect()]).catch((err) => {
      degrade(`Redis 连接失败（${err?.message || err}）`);
    });
  }

  /**
   * 把「这间房变了」发给其它实例。
   * ★ fire-and-forget：publish 的签名是同步返回本进程人数，不能为了 Redis 改动调用方；
   *   发送失败只降级（下一次变化照样先本地分发），不抛。
   */
  function publishRemote(name, key) {
    if (!isShared() || !publisher) return;
    try {
      publisher
        .publish(name, JSON.stringify({ instanceId, room: key }))
        .catch((err) => degrade(`发布失败（${err?.message || err}）`));
    } catch (err) {
      degrade(`发布失败（${err?.message || err}）`);
    }
  }

  /**
   * 订阅一间房的变化。
   * @returns {Function|null} 退订函数（**幂等**：连接关闭与错误两条路都会调它）；超过上限返回 null
   */
  function subscribe(code, listener) {
    const key = keyOf(code);
    if (!key || typeof listener !== "function") return null;
    const name = channelOf(key);
    const count = counts.get(name) || 0;
    if (count >= MAX_LISTENERS_PER_ROOM) return null;
    counts.set(name, count + 1);
    bus.on(name, listener);
    let done = false;
    return function unsubscribe() {
      if (done) return;
      done = true;
      bus.removeListener(name, listener);
      const left = (counts.get(name) || 1) - 1;
      if (left > 0) {
        counts.set(name, left);
      } else {
        // 归零就整条频道清掉：万一有 listener 走了不经过 unsubscribe 的路（泄漏），
        // 这里也把它一起收走，不会永远留在 counts 里挡住后来的订阅者。
        // ★ 这里只清本地，不退订 Redis 频道（PSUBSCRIBE 是全局的，退订反而增加状态机）。
        counts.delete(name);
        bus.removeAllListeners(name);
      }
    };
  }

  /**
   * 广播「这间房变了」（事件名固定 `changed`；房号在频道名里）。
   *
   * 顺序：先本地 emit（与改造前完全一致），再发 Redis 给其它实例；自己的回环在 handleMessage
   * 里丢掉。所以**每个实例恰好分发一次**，publish 的返回值仍是「本进程里被通知到的订阅者数」。
   * ★ 本进程没人订阅也要发 Redis：订阅者可能在别的实例上。
   *
   * @returns {number} 本进程里被通知到的订阅者数（0 = 本进程没人在听；不代表全服没人）
   */
  function publish(code) {
    const key = keyOf(code);
    if (!key) return 0;
    const name = channelOf(key);
    const count = counts.get(name) || 0;
    if (count) bus.emit(name, "changed");
    publishRemote(name, key);
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
   * ★ 不清 Redis 订阅：订阅连接是进程级单例，清理 listener 与它是两件事。
   */
  function resetForTests() {
    bus.removeAllListeners();
    counts.clear();
  }

  /**
   * 等跨实例通道就绪（**测试用**；业务路径不依赖它，随时按 isShared() 判）。
   * @returns {Promise<boolean>} 在 timeoutMs 内就绪返回 true，否则 false
   */
  async function waitUntilShared(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (isShared()) return true;
      if (closed || Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * 退出时清理：退订 + 断开两条连接（幂等）。
   * ★ 先 pUnsubscribe 再 quit：让 Redis 立刻知道这个实例不再收了；quit 失败（连接已经断了 /
   *   对端不答）就 destroy，别让优雅退出卡在关闭一条已经没救的 socket 上。
   * ★ close 之后 isShared() 恒为 false，publish 仍可本地分发（幂等收尾时不再指望 Redis）。
   */
  /** 带超时的 await：退出一刻 Redis 可能正在重连，不能让 shutdown 卡在一条没救的 socket 上 */
  function withTimeout(promise, timeoutMs) {
    let timer;
    return Promise.race([
      Promise.resolve(promise).catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async function close() {
    if (closed) return;
    closed = true;
    subscribed = false;
    subscriberReady = false;
    publisherReady = false;
    if (subscribeRetryTimer) {
      clearTimeout(subscribeRetryTimer);
      subscribeRetryTimer = null;
    }
    if (subscriber?.isReady) {
      // 只对「已经连上」的连接发 PUNSUBSCRIBE；重连中的连接发什么都要等，下面直接 destroy。
      await withTimeout(subscriber.pUnsubscribe(PSUBSCRIBE_PATTERN), 500);
    }
    for (const client of [subscriber, publisher]) {
      if (!client) continue;
      if (client.isOpen) await withTimeout(client.quit(), 500);
      try {
        if (client.isOpen) client.destroy();
      } catch {
        // 退出路径上的失败无所谓
      }
    }
    subscriber = null;
    publisher = null;
  }

  initRedis();

  return {
    instanceId,
    isShared,
    waitUntilShared,
    subscribe,
    publish,
    subscriberCount,
    activeRoomCount,
    resetForTests,
    close,
  };
}

/**
 * 生产单例：启动时按 process.env.REDIS_URL 决定是否接 Redis。
 * ★ 必须等 dotenv 加载之后再 require 本模块（src/index.js 是最先 require("dotenv").config() 的，
 *   app/routes 在它之后才 require 到本文件），否则这里读到的是空字符串 —— 那就永远退化了。
 */
const defaultBus = createRoomBus();

module.exports = {
  MAX_LISTENERS_PER_ROOM,
  subscribe: defaultBus.subscribe,
  publish: defaultBus.publish,
  subscriberCount: defaultBus.subscriberCount,
  activeRoomCount: defaultBus.activeRoomCount,
  resetForTests: defaultBus.resetForTests,
  isShared: defaultBus.isShared,
  waitUntilShared: defaultBus.waitUntilShared,
  close: defaultBus.close,
  /** 单例的启动随机 id（日志 / 排障用） */
  instanceId: defaultBus.instanceId,
  /** 只给测试与「将来要在一个进程里跑多条独立连接」的场合；生产用上面的单例 */
  createRoomBus,
};
