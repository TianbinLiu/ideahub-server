// 限流中间件。
//
// ★ 计数后端有两层：
//   1. Redis（配了 REDIS_URL 时）—— 跨进程共享，pm2 cluster 多实例下配额准确。
//   2. 进程内 Map —— Redis 未配置或不可用时的回退。
//
//   为什么必须有回退：限流是【保护性】功能，不是业务功能。Redis 挂了就让 API 全挂，
//   是拿可用性换一个本来就只是"提高攻击成本"的机制，本末倒置。
//   降级的代价是配额在多实例下被稀释（放行量 = 配置值 × 实例数），
//   这比整站不可用好得多。降级会打日志，便于发现。
//
// 演进记录（每条都对应踩过的坑）：
//   1. 惰性清理过期桶 —— 初版 Map 永不删除，每个来访 IP 一条永久驻留，
//      慢速扫描一遍就是几十万条常驻内存（内存泄漏本身就是 DoS 面）。
//   2. 双维度 key —— 只按 IP 挡不住"IP 池撞单账号"，登录需按账号再限一道。
//   3. 返回 Retry-After —— 正常客户端据此退避，而不是盲目重试放大压力。
//   4. 取 IP 改用 X-Real-IP —— 见 clientIp() 的说明，接 Cloudflare 后 req.ip 会取到边缘 IP。
//   5. Redis 后端 —— 为 pm2 cluster 铺路，见上。

const redis = require("../config/redis");

const buckets = new Map();

// 测试环境整体关闭：单元/集成测试会在几秒内跑出成百上千次请求，
// 限流一开，测的就不再是业务逻辑而是限流器本身（且失败信息极具误导性——
// 你会看到"创建悬赏返回 429"，完全看不出跟限流有关）。
// 限流器自身的行为由 tests/rateLimit.spec.js 单独覆盖。
const DISABLED = process.env.NODE_ENV === "test";

/** 每这么多次请求做一轮过期清理（惰性 GC，避免常驻 setInterval） */
const SWEEP_EVERY = 500;
let sinceSweep = 0;

function sweep(now) {
  for (const [key, entry] of buckets) {
    if (now - entry.start > entry.windowMs) buckets.delete(key);
  }
}

/**
 * 取真实客户端 IP。
 *
 * ★ 为什么不能用 req.ip：接入 Cloudflare 代理后链路是
 *       用户 → Cloudflare 边缘 → nginx → Node
 *   nginx 的 $proxy_add_x_forwarded_for 会把它看到的 $remote_addr 追加到
 *   X-Forwarded-For 末尾，而 app.js 的 trust proxy=1 只信任 1 跳，
 *   req.ip 于是取到上一跳而非真实用户。后果：同一 Cloudflare 边缘后的
 *   【所有用户共用一个限流桶】—— 登录限流从「按用户」退化成「按全站」。
 *   （已实测复现，不是推测。）
 *
 * ★ 为什么优先 X-Real-IP 而不是 CF-Connecting-IP：
 *   两者在「经 Cloudflare 来」的请求上等价，但对【直连源站】的请求不同 ——
 *     - CF-Connecting-IP 是 Cloudflare 加的头。直连源站时 Cloudflare 不在链路上，
 *       客户端可以自己塞一个假值，每次换一个就拿到一个全新的限流桶，
 *       等于限流可被无成本绕过。
 *     - X-Real-IP 由 nginx 以 `proxy_set_header X-Real-IP $remote_addr` 设置，
 *       【覆盖】客户端自带的同名值，伪造不了；且 nginx 已配 real_ip 模块
 *       （set_real_ip_from = Cloudflare 官方网段 + real_ip_header CF-Connecting-IP），
 *       $remote_addr 在两种链路下都已是真实客户端 IP：
 *         · 经 Cloudflare：real_ip 用 CF-Connecting-IP 把它换成了真实用户 IP
 *         · 直连源站：本来就是对方的真实 IP
 *   所以 X-Real-IP 是唯一一个「两种链路都正确、且不可伪造」的来源。
 *
 * 回退顺序：X-Real-IP（nginx 设，首选）→ CF-Connecting-IP（无 nginx 的部署形态）
 *          → req.ip（本地开发直连 Node）。
 */
function clientIp(req) {
  // 用可选链而不是直接下标：req.headers 缺失时直接下标会抛异常，
  // 而本中间件的 catch 是 fail-open —— 那意味着限流会【静默失效并放行】，
  // 这是限流器最不该有的失效方向。（单元测试构造的假 req 没有 headers，正好暴露过这点。）
  const h = req?.headers;
  // 长度上限 45 = IPv6 最长表示；顺带挡住超长头被当成 Map 的 key 撑内存
  const pick = (v) => (typeof v === "string" && v.length > 0 && v.length <= 45 ? v : null);
  return pick(h?.["x-real-ip"]) ?? pick(h?.["cf-connecting-ip"]) ?? req?.ip ?? "anon";
}

/**
 * @param {object}   [opts]
 * @param {number}   [opts.windowMs] 窗口长度，默认 60s
 * @param {number}   [opts.max]      窗口内最大请求数，默认 10
 * @param {string}   [opts.scope]    桶名前缀。不同接口必须给不同 scope，
 *                                   否则会共用同一个计数器互相干扰
 * @param {Function} [opts.keyFor]   (req) => string|null，返回附加维度（如账号名）。
 *                                   返回 null 表示这一维度不适用，跳过。
 */
function rateLimit({ windowMs = 60 * 1000, max = 10, scope = "default", keyFor = null } = {}) {
  if (DISABLED) return (req, res, next) => next();

  /** 超限时的统一响应 */
  function reject(res, retryAfterSec) {
    res.setHeader("Retry-After", String(retryAfterSec));
    return res.status(429).json({
      ok: false,
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests, slow down",
      details: { retryAfter: retryAfterSec },
    });
  }

  /** 进程内计数（Redis 不可用时的回退），返回 true=放行 */
  function allowLocally(key, res) {
    const now = Date.now();
    if (++sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      sweep(now);
    }
    let entry = buckets.get(key);
    if (!entry || now - entry.start > windowMs) {
      buckets.set(key, { count: 1, start: now, windowMs });
      return true;
    }
    if (entry.count >= max) {
      reject(res, Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)));
      return false;
    }
    entry.count += 1;
    return true;
  }

  return async (req, res, next) => {
    try {
      const dimension = keyFor ? keyFor(req) : null;
      if (keyFor && dimension == null) return next();
      const key = `rl:${scope}:${dimension ?? clientIp(req)}`;

      // Redis 优先；返回 null 表示不可用，静默回退到本地计数
      const hit = await redis.incr(key, windowMs);
      if (hit) {
        if (hit.count > max) {
          return reject(res, Math.max(1, Math.ceil(hit.ttlMs / 1000)));
        }
        return next();
      }

      if (allowLocally(key, res)) return next();
    } catch {
      // fail-open：限流器自身出错不该把正常业务打挂
      return next();
    }
  };
}

/**
 * 登录类接口的双维度限流：IP 一道 + 账号一道。
 *
 * ★ 两个维度的松紧【必须】不一样，这是本文件最容易改错的地方：
 *   - 按账号要【严】：同一个账号 15 分钟内被试 10 次密码，正常用户不可能，
 *     撞库则必然触发。这一道才是真正挡住撞库的。
 *   - 按 IP 要【松】：运营商 CGNAT、校园网、办公室出口后面是成千上万真实用户，
 *     共用一个公网 IP。按 IP 卡死等于"一个网吧有人失败几次，整栋楼都登不上"。
 *     这一道只用来削掉最粗暴的单机洪水。
 *   把 IP 那道调紧看起来"更安全"，实际是拿可用性换一个撞库者随便换 IP 就能绕开的限制。
 */
function loginRateLimit(accountField) {
  const byIp = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.LOGIN_RATE_IP_MAX || 60),
    scope: `${accountField}:ip`,
  });
  const byAccount = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_ACCOUNT_MAX || 10),
    scope: `${accountField}:acct`,
    keyFor: (req) => {
      const v = req.body?.[accountField];
      return typeof v === "string" && v ? v.toLowerCase().slice(0, 128) : null;
    },
  });
  return [byIp, byAccount];
}

/**
 * AI 端点限流：按【用户】而不是按 IP 计。
 *
 * 这类端点每次调用都要花真金白银（LLM token），且响应慢（占着连接）。
 * 不限流的话，一个账号写个循环就能把当月预算刷光 —— 这不是"被攻击"，
 * 是"账单被放大"，而且攻击者不需要任何漏洞，只要一个合法账号。
 *
 * 默认 20 次/分钟：正常用户手速远达不到，脚本刷会立刻撞墙。
 * 更贵的端点（一次请求触发多轮 LLM）应显式调小 max。
 */
function aiRateLimit({ max = 20, windowMs = 60 * 1000, scope = "ai" } = {}) {
  return rateLimit({
    windowMs,
    max,
    scope,
    keyFor: (req) => (req.user?._id ? String(req.user._id) : null),
  });
}

module.exports = { rateLimit, loginRateLimit, aiRateLimit };
