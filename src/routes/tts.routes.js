/**
 * 豆包语音合成（openspeech）代理 —— 工坊 NPC 的嗓子。
 *
 * 为什么必须放服务端：这段逻辑原来是 app 仓 vite.config.ts 里的一个 dev 中间件，
 * 只有 `npm run dev` 时存在。打成 APK 后 /api/tts 根本没人应答，真机上工坊 NPC
 * 就是**全程哑巴**（浏览器内置合成器在安卓 WebView 里 getVoices() 常年返回空数组，
 * 退回去也没声）。密钥更不能塞进前端包——APK 解一下就拿到了。
 *
 * **与方舟是两套完全不同的东西**：不同域名（openspeech.bytedance.com vs
 * ark.cn-beijing.volces.com）、不同鉴权、不同控制台。ARK_API_KEY 在这里一点用都没有，
 * 必须另外开通、另配 TTS_API_KEY。
 *
 * 走 V3 SSE（api/v3/tts/unidirectional/sse），协议 2026-08-09 实测确认过，不是照文档猜：
 *   请求头 X-Api-Key + X-Api-Resource-Id
 *   响应是 text/event-stream，每帧两行——
 *     event: 352                    ← TTSResponse（音频）；153 = SessionFailed
 *     data: {"code":0,"message":"","data":"<base64 mp3 分片>","sentence":…}
 *   所有帧的 data 按序 base64 解码首尾相接就是完整 mp3。一条 25 字台词回 18 帧 ≈49KB。
 *
 * ★ 为什么不是 V1：V1 要的是**旧版控制台**的 appid + access_token
 *   （Authorization: Bearer;<token>），而新版控制台只发一个 API Key。手上是新版 key，
 *   V1 那条路根本走不通。V3 顺带还解锁了 2.0 音色与 context_texts 语音指令。
 *
 * ★ resource id 决定**用哪代模型、也决定计费商品**，两代要在控制台各自开通：
 *     seed-tts-2.0 → 只能调 2.0 音色（*_uranus_*）
 *     seed-tts-1.0 → 只能调 1.0 音色（*_moon_* / *_mars_*）
 *   本账号实测 1.0 **未开通**（45000030），2.0 可用。音色清单（app 仓 studio/voices.ts）只收 2.0。
 *
 * 没配密钥就 501，前端据此把云端合成整段关掉、退回浏览器合成器（见 app 的 studio/speech.ts）。
 */
const express = require("express");
const crypto = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");

const router = express.Router();

const TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse";
const DEFAULT_VOICE = "zh_female_gaolengyujie_uranus_bigtts";
/** 官方限制文本 ≤1024 字节（UTF-8），且建议 <300 字符 */
const MAX_TEXT = 300;
/** 上游卡住时不能让连接一直挂着——工坊每句台词都会调一次，堆几十条就把连接池吃干净 */
const UPSTREAM_TIMEOUT_MS = 20_000;

const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
/** 音色 id 只允许官方那套字符集，直接拼进上游 body 的东西一律先收口 */
const safeId = (v) => (typeof v === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(v) ? v : null);

/**
 * GET /api/tts/health —— 只回"这台服务器配没配密钥"，不泄露密钥本身。
 * 前端拿它决定要不要走云端合成（原来是 app 构建期的 __TTS_REAL__ 常量，
 * 端点搬到服务端之后，构建期已经无从得知服务端的配置了）。
 */
router.get("/health", (_req, res) => {
  res.json({ ok: true, tts: Boolean(process.env.TTS_API_KEY) });
});

/**
 * POST /api/tts —— 合成一句台词，回 audio/mpeg。
 *
 * ★ 必须 requireAuth + 限流：每次调用都是按字符计费的真金白银。裸奔的话，
 *   任何人写个循环就能把当月 TTS 预算刷光——不需要任何漏洞，只要知道这个 URL。
 *   30 次/分钟：一段对话最多十来句，正常用户碰不到；脚本刷立刻撞墙。
 */
router.post("/", requireAuth, aiRateLimit({ max: 30, scope: "tts" }), async (req, res) => {
  const apiKey = process.env.TTS_API_KEY;
  if (!apiKey) return res.status(501).json({ message: "tts not configured" });

  const { text, voice, emotion, instruct, mix, rate, pitch, expressive } = req.body || {};
  const line = String(text ?? "").slice(0, MAX_TEXT);
  if (!line.trim()) return res.status(400).json({ message: "text required" });

  // ★ 混音只吃 **1.0** 音色，speaker 要固定写成 custom_mix_bigtts，真正的音色放进
  //   mix_speaker。2.0 的 uranus 混不进去（55000000）。反直觉的一点：本账号 1.0
  //   **单音色**调不动（45000030），混音却调得动。
  const recipe = Array.isArray(mix)
    ? mix.map((m) => ({ id: safeId(m && m.id), w: Number(m && m.w) || 0 })).filter((m) => m.id && m.w > 0).slice(0, 4)
    : [];
  const mixed = recipe.length > 0;
  const speaker = mixed ? "custom_mix_bigtts" : safeId(voice) || DEFAULT_VOICE;
  const is20 = !mixed && /uranus/.test(speaker);
  const sum = mixed ? recipe.reduce((a, m) => a + m.w, 0) || 1 : 1;

  const speechRate = num(rate, -50, 100);
  const pitchShift = num(pitch, -12, 12);
  const wantsTags = Boolean(expressive) && !mixed;

  const body = {
    user: { uid: String(req.user._id) },
    req_params: {
      text: line,
      speaker,
      ...(wantsTags ? { model: "seed-tts-2.0-expressive" } : {}),
      ...(mixed
        ? { mix_speaker: { speakers: recipe.map((m) => ({ source_speaker: m.id, mix_factor: +(m.w / sum).toFixed(3) })) } }
        : {}),
      audio_params: {
        format: "mp3",
        sample_rate: 24000,
        ...(speechRate ? { speech_rate: speechRate } : {}),
        // 不主动设 bit_rate 的话 mp3 会掉到 8k，音质损耗很明显（官方注解）
        bit_rate: 64000,
        ...(safeId(emotion) ? { emotion: safeId(emotion), emotion_scale: 4 } : {}),
      },
      // ★ additions 的类型是 **jsonstring**（不是 object），传成对象会被整个忽略
      additions: JSON.stringify({
        ...(pitchShift ? { post_process: { pitch: pitchShift } } : {}),
        // ★ 合规标识：**不用 aigc_watermark**。它的官方描述是"在合成结尾增加音频节奏标识"
        //   ——实测就是台词念完后那一串"滴滴"声（多出约 0.6 秒、5KB），每说一句响一次，
        //   NPC 对话里完全没法听。改走《AI 生成合成内容标识办法》允许的另一条路：
        //     · 隐式标识 → aigc_metadata 写进音频文件头（第 5 条要求的）
        //     · 显式标识 → 第 4 条允许"在交互场景界面添加显著的提示标识"代替音频内的
        //       提示音，所以由对话气泡上的「AI 合成语音」角标承担
        aigc_metadata: { enable: true, content_producer: "ideahub", produce_id: "npc-voice" },
        // 台词里可以直接写 <cot text=心理活动>这一句</cot>，描述不会被念出来。
        // ★ use_tag_parser 是 <cot> 生效的前提：不开就走 standard 模型，标签会被
        //   **当成正文念出来**（实测同句台词不开 164KB、开了 59KB，多出的三倍就是在念标签）
        ...(wantsTags ? { use_tag_parser: true } : {}),
        // 括号里的旁白（"（从口袋里抽出一叠卡）"）不该念出来
        max_length_to_filter_parenthesis: 100,
        ...(is20 && typeof instruct === "string" && instruct ? { context_texts: [instruct.slice(0, 200)] } : {}),
      }),
    },
  };

  let up;
  try {
    up = await fetch(TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": is20 ? "seed-tts-2.0" : "seed-tts-1.0",
        "X-Api-Connect-Id": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    return res.status(504).json({ message: `tts upstream ${String(e && e.name) || "error"}` });
  }

  const sse = await up.text();
  const parts = [];
  let errCode = 0;
  let errMsg = "";
  for (const raw of sse.split("\n")) {
    if (!raw.startsWith("data:")) continue;
    let j;
    try {
      j = JSON.parse(raw.slice(5).trim());
    } catch {
      continue;
    }
    // ★ 20000000 是**结束帧**（message "OK"），不是错误。每次成功合成的最后一帧都是它，
    //   当成错误记下来的话，一旦真出问题、日志里报的就是这个无辜的码——线上自检时踩过。
    if (j.code && j.code !== 0 && j.code !== 20000000) {
      errCode = j.code;
      errMsg = j.message || "";
    }
    if (typeof j.data === "string" && j.data) parts.push(Buffer.from(j.data, "base64"));
  }

  if (!parts.length) {
    // 把最常见的失败翻成人话——原始 message 全是英文且指向不明。
    // 只进服务端日志：这些提示会点出账号开通了什么，不该回给客户端。
    const hint =
      errCode === 55000000
        ? "音色与 resource id 对不上——混音只支持 1.0 音色，2.0（uranus）混不了"
        : errCode === 45000030
          ? `资源未开通：控制台要单独开通${is20 ? "「豆包语音合成模型2.0」" : "「大模型语音合成」(1.0)"}`
          : /quota/i.test(errMsg)
            ? "额度用完了，去控制台看试用/正式版用量"
            : errCode === 45000001 || up.status === 401 || up.status === 403
              ? "鉴权失败：检查服务端 .env 的 TTS_API_KEY"
              : errMsg;
    console.error(`[tts] ${up.status} code=${errCode || "?"} ${hint}`);
    return res.status(502).json({ message: "tts failed", code: errCode || up.status });
  }

  const mp3 = Buffer.concat(parts);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", String(mp3.length));
  // 台词是动态生成的，缓存没有意义，而且带用户上下文
  res.setHeader("Cache-Control", "no-store");
  res.end(mp3);
});

module.exports = router;
