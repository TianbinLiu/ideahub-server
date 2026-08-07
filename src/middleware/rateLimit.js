// 进程内限流。
//
// ★ 边界声明（部署前必读）：这是【单进程】计数器。PM2 cluster / 多实例部署时，
//   每个进程各有一份 buckets，实际放行量 = 配置值 × 进程数。真正要挡住撞库，
//   得换 Redis 后端（见 docs/security-hardening.md 的"待办"）。此处的目标是
//   把"完全无节流"提升到"有成本"，不是密码学意义上的严格配额。
//
// 相比初版的三处改动：
//   1. 惰性清理过期桶 —— 初版的 Map 永不删除条目，每个来访 IP 一条永久驻留，
//      被慢速扫描打一遍就是几十万条常驻内存（内存泄漏即 DoS 面）。
//   2. 支持自定义 key —— 只按 IP 限流挡不住"一个 IP 池撞一个账号"，
//      登录接口需要按【账号】再限一道。
//   3. 返回 Retry-After 头 —— 正常客户端能据此退避，而不是盲目重试放大压力。

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
 * ★ 为什么不能只用 req.ip：接入 Cloudflare 代理后链路变成
 *       用户 → Cloudflare 边缘 → nginx → Node
 *   nginx 的 $proxy_add_x_forwarded_for 会把它自己看到的 $remote_addr
 *   （= Cloudflare 边缘 IP）追加到 X-Forwarded-For 末尾，于是 Node 收到的是
 *       X-Forwarded-For: "<真实用户IP>, <Cloudflare边缘IP>"
 *   而 app.js 的 trust proxy=1 只信任 1 跳，req.ip 取到的就是 Cloudflare 边缘 IP。
 *   后果：同一边缘节点后的【所有用户共用一个限流配额】—— 登录限流从
 *   「60 次/分/用户」退化成「60 次/分/全站」，正常用户会被互相挤下线。
 *   （已实测复现，不是推测。）
 *
 * CF-Connecting-IP 是 Cloudflare 单独设置的头，值恒为真实客户端 IP，不受跳数影响。
 *
 * 伪造风险：客户端可以自己伪造 CF-Connecting-IP 来绕过限流 —— 但前提是能【绕过
 * Cloudflare 直连源站】。Cloudflare 会覆盖客户端自带的这个头，所以经代理来的请求
 * 无法伪造。源站 IP 已从 DNS 移除，直连需要先猜到 IP。
 * 要彻底封死，应在 nginx 层用 real_ip 模块 + set_real_ip_from <Cloudflare IP 段>
 * 恢复真实 IP，并拒绝非 Cloudflare 来源的连接（需要 sudo，见 SECURITY_HARDENING.md）。
 * 在那之前，这里的取舍是：宁可让极少数能猜到源站 IP 的人绕过限流，
 * 也不能让全体正常用户共用一个配额。
 */
function clientIp(req) {
  // ★ 用可选链而不是直接下标：req.headers 缺失时直接下标会抛异常，
  //   而本中间件的 catch 是 fail-open —— 那意味着限流会【静默失效并放行】，
  //   这是限流器最不该有的失效方向。（单元测试构造的假 req 没有 headers，正好暴露了这点。）
  const cf = req?.headers?.["cf-connecting-ip"];
  // 长度上限 45 = IPv6 最长表示；顺带挡住超长头被当成 Map 的 key 撑内存
  if (typeof cf === "string" && cf.length > 0 && cf.length <= 45) return cf;
  return req?.ip ?? "anon";
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
  return (req, res, next) => {
    try {
      const now = Date.now();
      if (++sinceSweep >= SWEEP_EVERY) {
        sinceSweep = 0;
        sweep(now);
      }

      const dimension = keyFor ? keyFor(req) : null;
      if (keyFor && dimension == null) return next();
      const key = `${scope}:${dimension ?? clientIp(req)}`;

      let entry = buckets.get(key);
      if (!entry || now - entry.start > windowMs) {
        buckets.set(key, { count: 1, start: now, windowMs });
        return next();
      }

      if (entry.count >= max) {
        const retryAfter = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({
          ok: false,
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests, slow down",
          details: { retryAfter },
        });
      }

      entry.count += 1;
      return next();
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
