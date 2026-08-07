// 出网防护（SSRF）：服务端拿"用户给的 URL"去发请求前的统一校验。
//
// 威胁模型：任一登录用户提交一个 URL，服务端替他去取，并把结果回显。
// 若不校验目标 IP，攻击者就获得了一台"位于我们内网、能读任意内部服务"的代理：
//   - http://169.254.169.254/...      云厂商元数据服务 → 实例角色临时凭证
//   - http://127.0.0.1:<port>/        本机上的 mongod / redis / 管理后台
//   - http://10.x / 172.16-31.x / 192.168.x  同 VPC 的其它主机
// 即便响应体不回显，"连得上 vs 连不上"的差异本身也是内网端口扫描器。
//
// 只校验 URL 字符串是【不够】的，两个原因：
//   1. 域名可以解析到内网 IP（攻击者自己的域名 A 记录写 127.0.0.1，白名单也拦不住）；
//   2. 允许跟随重定向时，第一跳合法、第二跳跳内网 —— 所以重定向必须逐跳校验。
// 因此这里的做法是：解析 DNS → 校验每一个候选 IP → 手动逐跳跟随重定向。

const dns = require("dns").promises;
const net = require("net");
const AppError = require("./AppError");

/** 私有 / 保留 / 特殊用途 IPv4 段，全部拒绝 */
function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                        // 0.0.0.0/8 本网络
  if (a === 10) return true;                       // 10/8 私有
  if (a === 127) return true;                      // 127/8 回环
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true;         // 169.254/16 链路本地（云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 私有
  if (a === 192 && b === 0) return true;           // 192.0.0/24 + 192.0.2/24
  if (a === 192 && b === 168) return true;         // 192.168/16 私有
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a >= 224) return true;                       // 224/4 组播 + 240/4 保留 + 255.255.255.255
  return false;
}

/**
 * 把 IPv6 展开成 16 字节。
 * ★ 必须按字节判断，不能按字符串前缀判断：WHATWG URL 会把地址规范化，
 *   `http://[::ffff:127.0.0.1]/` 的 hostname 实际是 `[::ffff:7f00:1]` ——
 *   点分形式的正则在这里一个都匹配不上（实测漏过）。
 * @returns {number[]|null}
 */
function expandIPv6(input) {
  let s = input.toLowerCase().replace(/^\[|\]$/g, "");
  if (s.includes("%")) s = s.slice(0, s.indexOf("%")); // 去掉 zone id

  // 尾部可以是点分 IPv4（::ffff:127.0.0.1），先转成两组十六进制
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const o = tail[1].split(".").map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hex = `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    s = s.slice(0, -tail[1].length) + hex;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let groups;
  if (rest === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...rest];
  }
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

function isPrivateIPv6(ip) {
  const b = expandIPv6(ip);
  if (!b) return true; // 解析不了就当不安全

  // ::（未指定）与 ::1（回环）
  if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return true;
  // fe80::/10 链路本地
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
  // fc00::/7 唯一本地地址
  if ((b[0] & 0xfe) === 0xfc) return true;
  // ::ffff:0:0/96 IPv4 映射 —— 展开后交给 IPv4 规则判断
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIPv4(b.slice(12).join("."));
  }
  // 64:ff9b::/96 NAT64 —— 同样承载一个 IPv4 目标
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return isPrivateIPv4(b.slice(12).join("."));
  }
  return false;
}

function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // 解析不出的一律拒绝
}

function reject(message) {
  throw new AppError({ code: "BLOCKED_URL", status: 400, message });
}

/**
 * 校验单个 URL 是否可安全出网。通过则返回 { parsed, addresses }。
 * @param {string} rawUrl
 */
async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    reject("Invalid URL format");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    reject("Only HTTP/HTTPS URLs are allowed");
  }
  // 带认证信息的 URL（http://user:pass@host）常被用来混淆真实主机名
  if (parsed.username || parsed.password) {
    reject("URLs with embedded credentials are not allowed");
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");

  // 主机名本身就是 IP 字面量时无需 DNS
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) reject("Target address is not permitted");
    return { parsed, addresses: [host] };
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    reject("Could not resolve host");
  }
  if (!records.length) reject("Could not resolve host");

  // ★ 全部候选地址都必须合法。只查第一条会被 DNS rebinding / 多 A 记录绕过。
  //   （严格说来这仍有 TOCTOU：校验用的解析结果与 axios 实际连接时的解析结果
  //    可能不同。彻底消除要在 socket 层校验对端 IP —— 见下方 lookup 钉住。）
  for (const r of records) {
    if (isBlockedAddress(r.address)) reject("Target address is not permitted");
  }

  return { parsed, addresses: records.map((r) => r.address) };
}

/**
 * 供 axios/http 使用的 lookup 钩子：把解析结果钉死到已校验过的地址上，
 * 消除"校验时解析到公网、连接时解析到内网"的 TOCTOU 窗口（DNS rebinding）。
 */
function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const addr = addresses[0];
    const family = net.isIP(addr);
    if (!addr || !family) return cb(new Error("No validated address for host"));
    if (typeof options === "object" && options?.all) {
      return cb(null, addresses.map((a) => ({ address: a, family: net.isIP(a) })));
    }
    return cb(null, addr, family);
  };
}

/**
 * 安全的 GET：逐跳校验重定向目标，返回最终的 axios response。
 * @param {import("axios").AxiosInstance|Function} axios
 * @param {string} url
 * @param {object} [opts] 透传给 axios 的配置（headers/timeout/responseType 等）
 * @param {number} [opts.maxHops] 最多跟随几跳重定向，默认 3
 */
async function safeGet(axios, url, opts = {}) {
  const { maxHops = 3, ...axiosOpts } = opts;
  let current = url;

  for (let hop = 0; hop <= maxHops; hop++) {
    const { addresses } = await assertPublicUrl(current);
    const res = await axios.get(current, {
      timeout: 15000,
      maxContentLength: 10 * 1024 * 1024,
      maxBodyLength: 10 * 1024 * 1024,
      ...axiosOpts,
      // ★ 自己跟随重定向，因此这里必须是 0：交给 axios 跟随就等于跳过了逐跳校验
      maxRedirects: 0,
      lookup: pinnedLookup(addresses),
      validateStatus: () => true,
    });

    if (res.status >= 300 && res.status < 400 && res.headers?.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return res;
  }
  reject("Too many redirects");
}

module.exports = { assertPublicUrl, safeGet, isBlockedAddress, pinnedLookup };
