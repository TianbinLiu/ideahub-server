// src/services/blockoutize.service.js
// 白模化（任意视频 → 带编号的白模视频）的三件"只能有一处"的东西：
//   ① Cloudinary 变换的**预热**（F9）
//   ② 两段提示词（"先看"的视觉清单 + "点名"的白模化）
//   ③ 方舟任务的轮询与产物转存
// 路由（routes/branchTemplate.js 的 /templates/blockoutize）只负责编排与整句报错。
//
// ★ 提示词写在这里而不是路由里：白模化提示词是**产品的一部分**（F4 的成败全压在
//   "包括…在内"那半句上），散在调用点各写一遍的话，改一处漏一处的表现是
//   "有的模板主角没被白模化"，而那要真花一次钱才看得见。
const { cloudinary } = require("../config/cloudinary");
const { callArk, T_POLL } = require("./arkGateway.service");

// ── ① 预热（F9）─────────────────────────────────────────────────────
//
// ★★ 2026-08-15 实测：Cloudinary 的变换是**懒生成**的 —— 第一次请求可能拿到一份
//   **不完整**的资产（连发两次，字节数不一样）。不预热就把这条 URL 交给方舟，
//   方舟拉到半截视频，产出是一段莫名其妙的片子，而**钱照扣**（受理后失败不退）。
//   所以：连发到"两次读到的字节数一样且非零"才算生成完，否则整句拒。
const PREWARM_TRIES = 6;
// ★ 测试环境把**等待**去掉（判断逻辑一个字不动：仍要"连续两次读到相同且非零的字节数"）。
//   与 middleware/rateLimit 的 DISABLED 同一条理由：一组用例里等上十几秒，
//   测的就成了 setTimeout 而不是这条规则；而把重试逻辑本身改掉才是真的把闸门测没了。
const PREWARM_GAP_MS = process.env.NODE_ENV === "test" ? 0 : 1500;

/**
 * 读一次投递地址的**总字节数**。
 *
 * ★ 先 HEAD：变换产物是 100MB 级，为了数个数就把它整个下载两遍，是在给自己的出网账单打洞。
 * ★ HEAD 拿不到 `content-length` 时退到 `Range: bytes=0-0` 的 GET，从 `content-range`
 *   的分母读总长 —— **这一步是必要的兜底而不是保险**：正在生成中的派生资产完全可能
 *   以 chunked 回，那时 HEAD 一个长度都没有。只认 HEAD 的话，整条白模化会在
 *   "云端还没准备好" 上永远失败，而它看起来像是 Cloudinary 的问题。
 *   ranged GET 只取 1 个字节，成本可以忽略，同时照样触发懒生成。
 */
async function probeBytes(url, timeoutMs = 30_000) {
  let res;
  try {
    res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: String((e && e.name) || e) };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const len = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(len) && len > 0) return { ok: true, bytes: len };

  let ranged;
  try {
    ranged = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: String((e && e.name) || e) };
  }
  if (!ranged.ok) return { ok: false, reason: `HTTP ${ranged.status}` };
  // Content-Range: bytes 0-0/12345 —— 分母才是总长
  const total = Number(String(ranged.headers.get("content-range") || "").split("/")[1] || 0);
  return { ok: true, bytes: Number.isFinite(total) ? total : 0 };
}

/**
 * 预热一条变换地址，直到字节数稳定。
 * @returns {Promise<{ ok: true, bytes: number } | { ok: false, message: string }>}
 *   message 是**能直接显示给用户的整句中文**（铁律八：没人监听错误码）。
 */
async function prewarm(url, label = "这一段视频") {
  let last = -1;
  let lastReason = "";
  for (let i = 0; i < PREWARM_TRIES; i += 1) {
    const r = await probeBytes(url);
    if (r.ok && r.bytes > 0) {
      if (r.bytes === last) return { ok: true, bytes: r.bytes };
      last = r.bytes;
    } else {
      lastReason = r.ok ? "字节数为 0" : r.reason;
      last = -1; // 失败一次就重新数"连续两次相同"
    }
    if (i < PREWARM_TRIES - 1) await new Promise((r2) => setTimeout(r2, PREWARM_GAP_MS));
  }
  return {
    ok: false,
    message: `云端还没把${label}准备好（${lastReason || "两次读到的大小一直在变"}），本次没有开始生成、也没有扣费，请稍后重试。`,
  };
}

/** 抓一帧成 dataURL（给 chat vision 用）。
 *  ★ 为什么不把 Cloudinary 的图片地址直接丢给方舟：App 侧那条**实测通过**的路
 *    （2026-08-07）就是 base64 dataURL；改用远端 URL 是没验过的第二条路，
 *    而它失败时用户已经在等一条要花钱的链路了。顺带这一取也就完成了帧的预热。 */
async function fetchFrameDataUrl(url, timeoutMs = 30_000) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: String((e && e.name) || e) };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return { ok: false, reason: "空图" };
  const mime = res.headers.get("content-type") || "image/jpeg";
  return { ok: true, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
}

// ── ② 提示词（唯一实现）─────────────────────────────────────────────

/** "先看"：让视觉逐个列出画面里的人物与外观特征。
 *  ★ 要的是**结构化清单**而不是一段散文：下一步要把每个人的特征逐条点名塞进
 *    白模化提示词，散文没法可靠地切开。 */
const VISION_SYSTEM =
  "你是影视分镜助理。只描述你在画面里**真实看到**的人物，不要推测、不要补充剧情、不要评价。";

function visionPrompt(note) {
  return [
    "看这几帧（同一段视频的不同时刻）。列出画面里出现的**每一个人物角色**，包括位于画面正中央、体型最大、看起来像主角的那一个。",
    "每个人物给一条，格式严格为：`序号|位置|外观特征`。",
    "位置写他在画面里的大致位置（如「画面正中央」「左侧靠前」）；",
    "外观特征写发色、发型、服装颜色与款式、明显道具，控制在 30 字内。",
    "只输出这些行，不要标题、不要解释、不要 Markdown 代码块。",
    "如果画面里一个人都没有，只输出一行：NONE",
    note ? `作者补充：${String(note).slice(0, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 把视觉的回答解析成角色位清单。
 * @returns {{ label: string, desc: string, labelConfirmed: false }[]}
 *   空数组 = 没认出人（调用方整句拒，不建空壳模板）
 *
 * ★ 编号在**我们这边**顺序编（1..N），因为提示词里要求"依次编号"。
 *   ⚠⚠ F5 实测：方舟给出的编号清晰稳定、跨帧不串号，但**不连续**（实出 1/2/4/5）——
 *   也就是说这份 label 是**我们的猜测**，不保证与成片上人偶胸口的数字逐一对应。
 *   猜错了不会有任何报错：套用者按"3 号位"挂卡，模型老老实实换了画面上的 3 号，
 *   而作者以为那是画面里的第三个人 —— 张三被换到别人身上，钱照扣。
 * ★★ 所以每条都**带着 `labelConfirmed: false` 出生**（不是调用方补的默认值 ——
 *   补默认值这件事一旦散在调用点，漏一处就是"一个从没核对过的模板被当成核对过的"）。
 *   真值只能由作者对着成片改（PATCH /api/branch/templates/:id/roles），
 *   未确认的模板不许发布（判据 models/BranchTemplate.rolesNeedConfirm 一处）。
 */
function parseRoles(text) {
  const out = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^NONE$/i.test(line)) continue;
    // 容错：模型可能吐 "1|正中央|白发黑袍" 或 "1. 正中央｜白发黑袍"
    const parts = line.split(/[|｜]/).map((s) => s.trim());
    if (parts.length < 2) continue;
    const n = parts[0].replace(/[^\d]/g, "");
    if (!n) continue;
    const desc = parts.slice(1).filter(Boolean).join("，").slice(0, 300);
    if (!desc) continue;
    // ★ labelConfirmed 在这里写死 false（见函数头 ★★）：这份编号是猜的，作者没点头之前
    //   它只能算草稿。想改成 true 只有一条路 —— 作者的 PATCH /roles。
    out.push({ label: String(out.length + 1), desc, labelConfirmed: false });
    if (out.length >= 12) break; // 12 个以上不是我们做得了的场景，也不是编辑页摆得下的
  }
  return out;
}

/**
 * "点名"：白模化提示词。
 *
 * ★★ 「包括…在内」那半句是 F4 的**全部要害**，不许简化掉：
 *   2026-08-15 两发对照实测 —— 泛指「所有人物角色」时，配角全被换成白模，
 *   **主角原封不动**（edit 子任务的立身之本就是"保住主体、复刻其余"，泛指等于逆着它的本能走）；
 *   把主角的外观特征逐个点名写进去，主角才被完全白模化。
 * ★ 「不要出现水印」这类话**故意不写**：两发实测都保留了 B 站台标 ——
 *   edit 是逐帧复刻，贴在画面上的台标对它而言与场景里的一块招牌没有区别。
 *   写上去只会让读代码的人以为水印已经处理过了（真解是让用户在编辑页裁掉）。
 */
function blockoutPrompt(roles) {
  const named = roles.map((r) => r.desc).join("、");
  return [
    `把这段视频里的每一个人物，包括${named}在内，全部替换成完全相同的纯白色人偶模特：`,
    "没有头发、没有五官、没有表情、没有服装与花纹，全身光滑无纹理的哑光白色塑料，关节处可见球形关节。",
    "任何一个人物都不许保留原有的发型、发色、面部或衣服。",
    "每个人偶胸口用醒目的黑色阿拉伯数字依次编号，同一个人偶全程编号不变。",
    "所有人的动作、姿态、站位、前后层次、运镜、背景、道具与光影保持原样不变。",
  ].join("");
}

// ── ③ 轮询与转存 ────────────────────────────────────────────────────

/** 轮询上限。★ 不是"越大越好"：这条请求整段占着一个连接，
 *  超过它就该整句告诉用户"这次没成"，而不是让 App 对着转圈无限等。
 *  ⚠⚠ 跨组件：nginx 的 `proxy_read_timeout` 必须 > POLL_MAX_MS，否则网关会先掐断，
 *  用户看到 504 而**钱已经花掉了**（受理后失败不退），我们这边的日志里却是一次成功。
 *  见 ALIYUN_HK_DEPLOYMENT_RUNBOOK.md 的 nginx 小节。 */
const IS_TEST = process.env.NODE_ENV === "test";
const POLL_INTERVAL_MS = IS_TEST ? 0 : 5_000;
const POLL_MAX_MS = IS_TEST ? 200 : 5 * 60 * 1000;

/**
 * 轮询一个方舟任务到出结果。
 * @returns {Promise<{ ok:true, videoUrl:string } | { ok:false, message:string, billed:boolean }>}
 *   billed=true 表示**已经受理、算力已消耗、方舟已计费** —— 这种失败**不退款**
 *   （含 F11 的真人人脸：创建时不拒，受理后才失败）。调用方必须照实说出来。
 */
async function pollTask(taskId, { intervalMs = POLL_INTERVAL_MS, maxMs = POLL_MAX_MS } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const { status, text } = await callArk({
      method: "GET",
      path: `/contents/generations/tasks/${taskId}`,
      timeoutMs: T_POLL,
    });
    if (status !== 200) {
      // 轮询本身抖一下不算失败（任务还在跑），继续等到超时
      console.warn(`[blockoutize] 轮询 ${taskId} 上游 ${status}`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text || "{}");
    } catch {
      continue;
    }
    if (parsed?.status === "succeeded") {
      const videoUrl = parsed?.content?.video_url;
      if (!videoUrl) {
        return { ok: false, billed: true, message: "AI 报告出片成功，却没有给出视频地址，这一发的费用已经产生、无法退回。请重试一次。" };
      }
      return { ok: true, videoUrl };
    }
    if (parsed?.status === "failed" || parsed?.status === "cancelled") {
      const why = String(parsed?.error?.message || "").slice(0, 300);
      return {
        ok: false,
        billed: true,
        message:
          `AI 中途拒绝了这段视频${why ? `（${why}）` : ""}。` +
          "视频里出现真人面孔时最容易发生这种情况——任务已经被受理并消耗了算力，**这一发的费用不退**。" +
          "建议换一段没有真人面孔的素材再试。",
      };
    }
  }
  return {
    ok: false,
    billed: true,
    message: `AI 出片超过 ${Math.round(maxMs / 1000)} 秒还没有结果，本次的费用已经产生、无法退回。请稍后到「我的模板」里看一下，或换一段更短的素材重试。`,
  };
}

/**
 * 把方舟产物转存到我们自己的 Cloudinary。
 *
 * ★★ F12：方舟产物 URL 是 **TOS 签名地址、24 小时过期**。不转存的话，
 *   今天建的模板明天就是一条死链 —— 而且**零症状**：模板列表照常显示，
 *   直到有人套用它出片时方舟拉不到参考视频才 400。
 * ★ 落在与原始素材同一个 folder、同一种 public_id 形状（`<userId>-<ts>`），
 *   这样归属校验、r2v 反查、删除时的回收全都沿用现成的那一套。
 */
async function transferToCloudinary(remoteUrl, userId) {
  try {
    const receipt = await cloudinary.uploader.upload(remoteUrl, {
      folder: "ideahub/template-videos",
      public_id: `${userId}-${Date.now()}`,
      resource_type: "video",
    });
    return { ok: true, receipt };
  } catch (e) {
    console.error("[blockoutize] 产物转存失败:", e?.error?.message || e.message);
    return {
      ok: false,
      message:
        "白模视频已经生成，但转存到我们的存储时失败了，模板没有创建（AI 给的地址 24 小时后就失效，留一个明天就打不开的模板反而更糟）。" +
        "这一发的费用已经产生、无法退回，请稍后重试。",
    };
  }
}

module.exports = {
  PREWARM_TRIES,
  POLL_MAX_MS,
  prewarm,
  fetchFrameDataUrl,
  VISION_SYSTEM,
  visionPrompt,
  parseRoles,
  blockoutPrompt,
  pollTask,
  transferToCloudinary,
};
