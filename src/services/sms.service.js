//sms.service.js
//
// 手机验证码的发送 + 校验，做成 provider 抽象（与 email.service.js 同一思路：没配就报错、配了才发）。
//
// 两种身份键路径的差异（重要）：
// - dev / 标准短信：验证码由【我们本地】生成与校验（复用 otp.service 的 createOtp/verifyOtp，
//   短信通道只负责把码投递出去）。
// - aliyun-pnvs（阿里云号码认证·短信认证）：验证码由【平台】生成、下发、校验，我们不掌握明文，
//   校验走平台的 CheckSmsVerifyCode。个人实名即可用、免签名/模板/报备，是本项目选定的通道。
//
// 因此对上层暴露两个函数：sendPhoneOtp / checkPhoneOtp，屏蔽两种模型的差异。
// SMS_PROVIDER：dev（默认，打日志不真发）| aliyun-pnvs | off。

const crypto = require("crypto");
const { badRequest } = require("../utils/http");
const { createOtp, verifyOtp } = require("./otp.service");

function smsProvider() {
  return String(process.env.SMS_PROVIDER || "dev").trim().toLowerCase();
}

/** 真实短信通道（会真发信/真扣费）是否已配置——供前端决定「手机登录」入口显隐。 */
function isRealSmsConfigured() {
  const p = smsProvider();
  if (p === "aliyun-pnvs") {
    // SendSmsVerifyCode 里 SignName / TemplateCode 都是必填，缺任一都发不出，故都要齐才算「已配」。
    return !!(
      process.env.ALIYUN_ACCESS_KEY_ID &&
      process.env.ALIYUN_ACCESS_KEY_SECRET &&
      process.env.ALIYUN_PNVS_SIGN_NAME &&
      process.env.ALIYUN_PNVS_TEMPLATE_CODE
    );
  }
  return false;
}

// ── 阿里云 RPC 风格 Signature Version 1.0（HMAC-SHA1）签名 ───────────────
// 号码认证服务 Dypnsapi 走的是经典 RPC 风格，签名算法与短信/ECS 等一致。手写实现、不引 SDK。

function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

function rpcSignature(params, accessKeySecret) {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
  return crypto.createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
}

async function callDypnsapi(action, actionParams) {
  const ak = process.env.ALIYUN_ACCESS_KEY_ID;
  const sk = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (!ak || !sk) badRequest("短信服务未配置");

  const params = {
    AccessKeyId: ak,
    Action: action,
    Format: "JSON",
    RegionId: process.env.ALIYUN_PNVS_REGION || "cn-hangzhou",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), // ISO8601 UTC，去毫秒
    Version: process.env.ALIYUN_PNVS_VERSION || "2017-05-25",
    ...actionParams,
  };
  params.Signature = rpcSignature(params, sk);

  const endpoint = process.env.ALIYUN_PNVS_ENDPOINT || "https://dypnsapi.aliyuncs.com/";
  const qs = Object.keys(params)
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");

  const res = await fetch(`${endpoint}?${qs}`, { method: "GET" });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("[PNVS] non-JSON response", res.status, text.slice(0, 300));
    badRequest("短信服务返回异常");
  }
  // 阿里云失败响应含 Code（非 "OK"）。这里冒泡成 badRequest，绝不把 AK/SK 或原始报文泄露给前端。
  if (!res.ok || (data && data.Code && data.Code !== "OK")) {
    console.error("[PNVS] api error", res.status, data && data.Code, data && data.Message);
    badRequest("短信发送失败，请稍后再试");
  }
  return data;
}

// ── 对上层的统一接口 ─────────────────────────────────────────────────

async function sendPhoneOtp({ phone, purpose }) {
  const provider = smsProvider();

  if (provider === "dev") {
    // 本地生成 + 打日志（不真发）。用于开发/联调；生产切到真实 provider。
    const { code } = await createOtp({ target: phone, purpose });
    console.log(`[DEV SMS OTP] phone=${phone} purpose=${purpose} code=${code}`);
    return { ok: true, provider: "dev" };
  }

  if (provider === "aliyun-pnvs") {
    // 平台【自动生成】并下发验证码：TemplateParam 里用 ##code## 占位符，平台生成后写模板并暂存，
    // 供后续 CheckSmsVerifyCode 服务端核验（我们全程不掌握明文验证码）。
    // SignName 与 TemplateCode 都是必填（用 PNVS 短信认证的系统赠送签名/模板号，见 env）。
    const SignName = process.env.ALIYUN_PNVS_SIGN_NAME;
    const TemplateCode = process.env.ALIYUN_PNVS_TEMPLATE_CODE;
    if (!SignName || !TemplateCode) badRequest("短信服务未配置");
    // TemplateParam 需与模板变量匹配；默认只放 ##code##，模板另有变量时用 env 覆盖整串。
    const TemplateParam = process.env.ALIYUN_PNVS_TEMPLATE_PARAM || JSON.stringify({ code: "##code##" });
    await callDypnsapi("SendSmsVerifyCode", {
      PhoneNumber: phone,
      SignName,
      TemplateCode,
      TemplateParam,
      ...(process.env.ALIYUN_PNVS_SCHEME_NAME ? { SchemeName: process.env.ALIYUN_PNVS_SCHEME_NAME } : {}),
    });
    return { ok: true, provider: "aliyun-pnvs" };
  }

  badRequest("短信服务未配置");
}

async function checkPhoneOtp({ phone, purpose, code }) {
  const provider = smsProvider();

  if (provider === "dev") {
    await verifyOtp({ target: phone, purpose, code }); // 失败会 throw badRequest
    return { ok: true };
  }

  if (provider === "aliyun-pnvs") {
    const data = await callDypnsapi("CheckSmsVerifyCode", {
      PhoneNumber: phone,
      VerifyCode: String(code),
      ...(process.env.ALIYUN_PNVS_SCHEME_NAME ? { SchemeName: process.env.ALIYUN_PNVS_SCHEME_NAME } : {}),
    });
    // 平台返回 Model.VerifyResult：PASS / UNKNOWN / 其它 = 未通过。
    const verify = data && data.Model && (data.Model.VerifyResult || data.Model.verifyResult);
    if (String(verify).toUpperCase() !== "PASS") {
      badRequest("验证码错误或已失效");
    }
    return { ok: true };
  }

  badRequest("短信服务未配置");
}

module.exports = {
  sendPhoneOtp,
  checkPhoneOtp,
  isRealSmsConfigured,
  smsProvider,
  // 导出纯工具供测试（对官方签名向量自测）：
  _rpcSignature: rpcSignature,
  _percentEncode: percentEncode,
};
