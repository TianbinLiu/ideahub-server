//email.service.js

const { badRequest } = require("../utils/http");

/**
 * 通用发信（Resend）。所有邮件都从这里出去，供应商分支只写一遍。
 * ★ 失败抛 400（沿用 OTP 的约定）：验证码发不出去必须让用户看到；
 *   非关键邮件（如工单通知）的调用方自己 try/catch，不要因为邮件挂了拖垮主流程。
 */
async function sendEmail({ to, subject, html, text }) {
  const provider = process.env.EMAIL_PROVIDER || "dev";
  const recipients = (Array.isArray(to) ? to : [to]).map((s) => String(s || "").trim()).filter(Boolean);
  if (!recipients.length) badRequest("Email recipient required");

  if (provider === "dev") {
    console.log(`[DEV EMAIL] to=${recipients.join(",")} subject=${subject}\n${text || html}`);
    return { ok: true, provider: "dev" };
  }

  if (provider === "resend") {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) badRequest("Email provider not configured");

    // 使用 fetch 调 Resend API（避免引包也行）
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject,
        ...(html ? { html } : {}),
        ...(text ? { text } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[RESEND] send failed", res.status, body);
      badRequest("Failed to send email", { provider: "resend", status: res.status, text: body });
    }
    return { ok: true, provider: "resend" };
  }

  badRequest("Unsupported email provider");
}

async function sendEmailOtp({ to, code }) {
  const provider = process.env.EMAIL_PROVIDER || "dev";
  if (provider === "dev") {
    // 保留老日志格式：本地调试靠它肉眼读验证码
    console.log(`[DEV EMAIL OTP] to=${to} code=${code}`);
    return { ok: true, provider: "dev" };
  }
  return sendEmail({
    to,
    subject: "Your IdeaHub verification code",
    html: `<p>Your verification code is <b>${code}</b>. It expires soon.</p>`,
  });
}

module.exports = { sendEmail, sendEmailOtp };
