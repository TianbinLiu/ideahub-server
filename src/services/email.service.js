const { badRequest } = require("../utils/http");

async function sendEmailOtp({ to, code }) {
  const provider = process.env.EMAIL_PROVIDER || "dev";

  if (provider === "dev") {
    console.log(`[DEV EMAIL OTP] to=${to} code=${code}`);
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
        to,
        subject: "Your IdeaHub verification code",
        html: `<p>Your verification code is <b>${code}</b>. It expires soon.</p>`,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      badRequest("Failed to send email", { provider: "resend", text });
    }
    return { ok: true, provider: "resend" };
  }

  badRequest("Unsupported email provider");
}

module.exports = { sendEmailOtp };
