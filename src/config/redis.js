// Redis 连接（目前只服务于跨进程限流）。
//
// ★ 设计前提：Redis 是【可选依赖】，挂了不能把服务带下去。
//   限流是保护性功能，不是业务功能 —— 为了它让 API 全挂，是本末倒置。
//   所以这里所有失败都降级而非抛出，由调用方回退到进程内计数。
//
// 未配置 REDIS_URL 时整个模块处于禁用状态，行为与接入 Redis 之前完全一致
// （本地开发、CI、以及尚未装 Redis 的部署都不受影响）。

const REDIS_URL = process.env.REDIS_URL || "";

let client = null;
let ready = false;
/** 连接彻底放弃后不再反复尝试，避免每个请求都卡在连接超时上 */
let disabled = !REDIS_URL;

function log(...args) {
  console.warn("[redis]", ...args);
}

function init() {
  if (disabled || client) return;

  const { createClient } = require("redis");
  client = createClient({
    url: REDIS_URL,
    socket: {
      // ★ 连接超时必须短：限流在请求路径上，连不上时每个请求都等 5 秒的话，
      //   Redis 故障会直接演变成全站超时。
      connectTimeout: 500,
      reconnectStrategy(retries) {
        if (retries > 10) {
          log("重连超过 10 次，停止重试并降级为进程内计数");
          disabled = true;
          return false; // 停止重连
        }
        return Math.min(retries * 200, 3000);
      },
    },
  });

  client.on("ready", () => {
    ready = true;
    console.log("✅ Redis connected (rate limiting is now cluster-wide)");
  });
  client.on("error", (err) => {
    // 断线期间 node-redis 会持续抛 error 事件，只在状态翻转时打一条，避免刷屏
    if (ready) log("连接异常，降级为进程内计数:", err.message);
    ready = false;
  });
  client.on("end", () => {
    ready = false;
  });

  client.connect().catch((err) => {
    log("初次连接失败，降级为进程内计数:", err.message);
    ready = false;
  });
}

init();

/** Redis 当前是否可用。false 时调用方应回退到本地计数 */
function isReady() {
  return ready && !disabled;
}

/**
 * 原子地「计数 +1 并在首次写入时设置 TTL」。
 *
 * ★ 为什么用 Lua 而不是 INCR + EXPIRE 两条命令：
 *   两条命令之间进程若崩溃/断连，键会永远没有 TTL —— 那个用户就被【永久限流】了，
 *   且不会有任何报错。Lua 脚本在 Redis 端是单次原子执行，不存在这个中间态。
 *
 * @returns {Promise<{count:number, ttlMs:number}|null>} null = Redis 不可用，调用方自行降级
 */
const INCR_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

async function incr(key, windowMs) {
  if (!isReady()) return null;
  try {
    const res = await client.eval(INCR_SCRIPT, {
      keys: [key],
      arguments: [String(windowMs)],
    });
    const [count, ttl] = res;
    return { count: Number(count), ttlMs: Number(ttl) };
  } catch (err) {
    log("计数失败，本次降级为进程内计数:", err.message);
    return null;
  }
}

/** 供优雅退出调用 */
async function quit() {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    /* 退出路径上的失败无所谓 */
  }
}

module.exports = { isReady, incr, quit, REDIS_ENABLED: !disabled };
