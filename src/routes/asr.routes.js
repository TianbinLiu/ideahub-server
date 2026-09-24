/**
 * @file asr.routes.js - 语音识别代理（火山 openspeech「大模型录音文件识别·极速版」）—— App「AI 客服」的语音输入
 * @category Route
 * @base_path /api/asr
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节 + app 仓 docs/api-contract.md「客服」章节
 *
 * API端点:
 * @endpoint POST / - 请求体是**音频二进制**（Content-Type: audio/wav | audio/mpeg | audio/ogg，也可用 ?format=wav 指定），
 *                    ≤ 6MB。返回 { ok, text, durationMs }。登录 + 20 次/分钟按账号限流。
 *
 * ★ 为什么收二进制而不是 JSON base64：全局 express.json 限 1MB，30 秒 24k WAV 就 1.4MB；
 *   base64 再涨三分之一。二进制 body 由本路由自己的 express.raw 解析，不动全局阈值。
 * ★ 为什么是"录音文件极速版"而不是流式识别：按住说话 → 松手 → 一次性识别，一个 HTTP 往返几百毫秒，
 *   不用为客服页维护 WebSocket；流式识别留给以后做"边说边出字"。
 * ★ 与 /api/tts 同一把 TTS_API_KEY（同一个 openspeech 应用），但「大模型录音文件识别」是**另一个商品**，
 *   控制台要单独开通；没开通时上游回 45000030 之类，这里翻成人话只进服务端日志。
 * ★ 与 TTS 同一条合规线：识别结果不落库、不留音频；用户说了什么只回给他自己。
 *
 * @uses {middleware/auth.js} - requireAuth
 * @uses {middleware/rateLimit.js} - userRateLimit
 * @registered_in src/app.js
 */
const express = require("express");
const crypto = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const billing = require("../services/billing.service");
const { priceOf, ASR_BYTES_PER_SECOND } = require("../config/tokens");
const { setWalletHeaders } = require("../services/arkGateway.service");

const ASR_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const RESOURCE_ID = "volc.bigasr.auc_turbo";
const MAX_BYTES = 6 * 1024 * 1024;
const MIN_BYTES = 1024;
const UPSTREAM_TIMEOUT_MS = Number(process.env.ASR_TIMEOUT_MS || 30_000);
const FORMAT_BY_TYPE = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
};
const FORMATS = ["wav", "mp3", "ogg"];

const router = express.Router();

router.post(
  "/",
  requireAuth,
  userRateLimit({ max: 20, scope: "asr" }),
  // 任何 Content-Type 都按二进制收：express.json 只吃 application/json，音频类型到这里 body 还是空的
  express.raw({ type: () => true, limit: MAX_BYTES }),
  async (req, res) => {
    const apiKey = process.env.TTS_API_KEY;
    if (!apiKey) return res.status(501).json({ ok: false, message: "ASR not configured", code: "ASR_NOT_CONFIGURED" });

    const ctype = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const format = FORMAT_BY_TYPE[ctype] || String(req.query.format || "").toLowerCase();
    if (!FORMATS.includes(format)) {
      return res.status(400).json({ ok: false, message: "unsupported audio format (wav/mp3/ogg)", code: "VALIDATION_ERROR" });
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.length < MIN_BYTES) return res.status(400).json({ ok: false, message: "audio too short", code: "VALIDATION_ERROR" });

    const body = {
      user: { uid: String(req.user._id) },
      audio: { data: buf.toString("base64"), format },
      request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
    };

    // ★★ 计费（方案 §14.6 / 9.1 的 R1.5）。**这条链路此前一分钱不扣**。
    //   时长要等上游识别完才知道，所以先按**字节数上界**预扣（ASR_BYTES_PER_SECOND 取的是
    //   每秒字节数的下界 ⇒ 秒数偏大 ⇒ 预扣偏多），拿到真实时长后多退少不补。
    //   反过来（预扣偏少）就是白送，而白送不会有任何报错。
    const estSeconds = buf.length / (ASR_BYTES_PER_SECOND[format] || 8000);
    const prepaid = priceOf("asr", { seconds: estSeconds });
    const charged = await billing.chargedCall({
      user: req.user,
      cost: prepaid,
      memo: `asr ${format}`,
      refundTag: "ark_refund",
      forward: () => recognize(),
    });
    if (!charged.ok) {
      setWalletHeaders(res, charged.wallet);
      return res.status(charged.status).json(charged.body);
    }
    setWalletHeaders(res, charged.wallet);
    const rec = charged.result;
    if (rec.unreachable) return res.status(502).json({ ok: false, message: "asr upstream unreachable", code: "ASR_UPSTREAM" });
    if (rec.silent) {
      // 静音退全款：上游没识别出任何内容，这次调用没有产物
      await billing.settleOverCharge({ user: req.user, prepaid, actual: 0, memo: `asr ${format} 静音` });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, text: "", durationMs: 0, silent: true });
    }
    if (rec.failedCode) {
      return res.status(502).json({ ok: false, message: "asr failed", code: rec.failedCode });
    }
    // 按上游给的真实时长结算，多退（少了不补：那会让一次调用扣两次）
    await billing.settleOverCharge({
      user: req.user,
      prepaid,
      actual: priceOf("asr", { seconds: rec.durationMs / 1000 }),
      memo: `asr ${format}`,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, text: rec.text, durationMs: rec.durationMs });

    async function recognize() {
      let up;
      try {
        up = await fetch(ASR_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": apiKey,
            "X-Api-Resource-Id": RESOURCE_ID,
            "X-Api-Request-Id": crypto.randomUUID(),
            "X-Api-Sequence": "-1",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      } catch (e) {
        console.error("[asr] upstream unreachable:", (e && e.message) || e);
        return { accepted: false, unreachable: true };
      }

      const statusCode = String(up.headers.get("x-api-status-code") || "");
      const statusMsg = String(up.headers.get("x-api-message") || "");
      const raw = await up.text().catch(() => "");
      let j = {};
      try {
        j = raw ? JSON.parse(raw) : {};
      } catch {
        j = {};
      }
      // 20000003 = 上游判定整段是静音（"no valid speech in audio"）：这不是故障，是用户按住了没说话 / 离麦太远，
      // 按"识别到空文本"回 200，让客户端提示"没听到声音"而不是"服务不可用"（真机实测第一次就撞上）
      if (up.ok && statusCode === "20000003") {
        // ★ accepted:true —— 上游**确实受理并跑完了**这段音频，只是里面没有人说话。
        //   记成未受理会走整笔退款，而算力已经花掉了；真正该做的是按真实时长（0）多退。
        return { accepted: true, silent: true };
      }
      const ok = up.ok && (!statusCode || statusCode === "20000000");
      if (!ok) {
        const code = statusCode || String(up.status);
        // 常见失败翻成人话——只进服务端日志：这些提示会点出账号开通了什么，不该回给客户端
        const hint =
          /45000030/.test(code) || /resource/i.test(statusMsg)
            ? "资源未开通：控制台要单独开通「大模型录音文件识别」（volc.bigasr.auc_turbo）"
            : /45000001/.test(code) || up.status === 401 || up.status === 403
              ? "鉴权失败：检查服务端 .env 的 TTS_API_KEY"
              : statusMsg || raw.slice(0, 200);
        console.error(`[asr] ${up.status} code=${code} ${hint}`);
        return { accepted: false, failedCode: code };
      }

      const text = String((j.result && j.result.text) || "").trim();
      const durationMs = j.audio_info && Number.isFinite(Number(j.audio_info.duration)) ? Math.round(Number(j.audio_info.duration)) : 0;
      return { accepted: true, text, durationMs };
    }
  },
);

module.exports = router;
