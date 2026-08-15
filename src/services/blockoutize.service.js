// src/services/blockoutize.service.js
// 白模化（任意视频 → 带编号的白模视频）的四件"只能有一处"的东西：
//   ① Cloudinary 变换的**预热**（F9）
//   ①b **看几帧**（visionFrameTimes）—— 报价（App 镜像）与真正抽帧都只准问它
//   ② 两段提示词（"先看"的视觉清单 + "点名"的白模化）
//   ③ 方舟任务状态的**一次性核实**与产物转存
// 路由（routes/branchTemplate.js 的 /templates/blockoutize 与 …/finish）只负责编排与整句报错。
//
// ★★ 2026-08-16 拆成两阶段：这里**不再有轮询循环**（原来的 `pollTask` 已删）。
//   服务端在一条 HTTP 请求里等五分钟，等于把"钱已经付了"和"东西拿到了"绑在同一个
//   TCP 连接的命上 —— 详见 fetchTaskState 的文件内注释与 models/BlockoutJob.js 的文件头。
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

// ── ①b 看几帧（唯一实现）────────────────────────────────────────────
//
// ══ 为什么这一段单独存在（2026-08-15 真机实测）══════════════════════════
// 白模化的第一步是"先看"：抽几帧问一次 chat vision，列出画面里有哪些人，再按这份清单
// **点名**写进白模化提示词。此前帧数写死 3 帧（老常量 `VISION_FRAMES`）。
// 实测撞上的形状：一段 **4 秒**的素材，前半段 2 个人、后半段是围坐群戏人更多 ——
// 3 帧只认出 2 个人，于是登记的角色位是 1、2；而方舟出片时看到的人更多，**自己往下编到了 3**。
// 结果画面上有个 3 号，角色位列表里却没有第三格 —— 套用者看得见它却挂不上卡，
// 只会以为功能坏了，而全程**零报错**（没有任何一层知道"画面上的号比列表多"）。
//
// 于是帧数改成两种来源，规则都收在 `visionFrameTimes` 一处：
//   · 自动（默认）：每 1.5 秒一帧，下限 3、上限 8。一帧几百 token 很便宜，
//     换的是"人别漏"—— 4 秒看 3 帧太稀，越长的素材越稀。
//   · 自己挑：用户在编辑页拖时间轴逐帧标记（**给"画面里人数会变"的素材用**：
//     他看得见哪里入场哪里离场，就在变化前后各标一帧）。上限同样 8。
//
// ★★ 这个函数是「看几帧」的**唯一实现**（铁律六）：报价（App 侧 `economy.blockoutizeCost`
//   的前一半，靠跨仓镜像同一条公式）与真正抽帧都只准问它。两处各算各的表现是
//   "页面按 3 帧报价、服务端按 8 帧扣钱"，两个方向都不报错 —— 本仓头号事故形状。
// ★ 上限 `VISION_FRAMES_MAX` 同时是 zod schema 的数组上限（schemas 从这里 import），
//   别在那边再抄一个 8：CLAUDE.md 里「最多出几张卡的上限自己抄一份」就是这条坑。

/** 自动模式：每多少秒看一帧。1.5s 是"够密到看得见入场/离场 + 一帧几百 token 很便宜"的折中 */
const VISION_SEC_PER_FRAME = 1.5;
/** 帧数下限。短素材（4s）也至少看 3 帧 —— 少于这个数连"前中后"都盖不住 */
const VISION_FRAMES_MIN = 3;
/**
 * 帧数上限（自动与自选共用）。
 * ★ 8 是"再多也换不来更多人名、却每一帧都真花钱与时间"的止损点；
 *   它也是 schema 里 `frameTimes` 数组的上限（同一个常量，见文件头 ★）。
 */
const VISION_FRAMES_MAX = 8;
/**
 * 时刻的取整粒度（秒）。
 * ★ 为什么要取整：帧地址是 `so_<秒>`，不取整会拼出 `so_2.6666666666666665` 这种串 ——
 *   既拿不到 CDN 缓存复用，去重也永远去不掉（两个肉眼同一帧的时刻差在小数第 15 位）。
 *   0.5s 对"认出画面里有谁"绰绰有余（人不会在半秒里换一个）。
 */
const FRAME_QUANT_SEC = 0.5;

/** 取整到 FRAME_QUANT_SEC 的倍数。★ 0.5 的倍数在二进制里是精确值，不会攒出浮点毛刺 */
function quantSec(t) {
  return Math.round(t / FRAME_QUANT_SEC) * FRAME_QUANT_SEC;
}

/** 自动模式的帧数：clamp(ceil(durSec / 1.5), 3, 8)。★ 报价镜像照抄的就是这一行 */
function autoFrameCount(durSec) {
  const n = Math.ceil(durSec / VISION_SEC_PER_FRAME);
  return Math.min(VISION_FRAMES_MAX, Math.max(VISION_FRAMES_MIN, Number.isFinite(n) ? n : VISION_FRAMES_MIN));
}

/** 取整 → 夹进 [0, maxT] → 去重 → 升序。★ 自动与自选走同一条，免得两边的去重口径分家 */
function normalizeTimes(list, maxT) {
  const out = [];
  for (const t of list) {
    const v = Math.min(maxT, Math.max(0, quantSec(t)));
    if (!out.includes(v)) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 「这一段看哪几个时刻的帧」—— 返回**片段内的相对秒数**（调用方自己加 `startSec`
 * 换成原片上的绝对时刻）。
 *
 * @param {number} durSec 选中那一段的时长（秒）
 * @param {number[]} [picked] 用户在编辑页自己标的时刻（**相对片段起点**）。缺省 = 自动
 * @returns {number[]} 至少一个时刻，最多 `VISION_FRAMES_MAX` 个，升序去重
 *
 * ★★ `picked` **服务端自己再验一遍**（不信客户端报的数，与 `durSec` 不收客户端同一条理由）：
 *   越界的**丢掉并 console.warn**，不整条拒 —— 用户已经付过上传与框选的时间成本，
 *   少看一帧不影响认人，为一个坏数把他打回起点才是真的损失。
 * ★ 全被丢光（或传了个空数组）→ **退回自动**，绝不返回空：返回空的表现是
 *   "一帧都没抽 → 视觉认不出人 → 整条白模化在 roles 为空那里被拒"，
 *   而用户看到的理由会是"AI 没认出人"，与真正的原因（他标的时刻全越界）完全对不上。
 */
function visionFrameTimes(durSec, picked) {
  const dur = Number(durSec);
  if (!Number.isFinite(dur) || dur <= 0) {
    // 调用方本该先过四组数校验；真走到这里是上游漏了一道，响亮记一笔再退单帧（铁律八）
    console.warn(`[blockoutize] 片段时长不可用（${durSec}），看帧退回单帧 0s`);
    return [0];
  }
  // 最后一个还落在片段**内**的时刻（`[0, durSec)` 的右端是开的）
  const maxT = Math.max(0, quantSec(Math.max(0, dur - FRAME_QUANT_SEC)));

  if (Array.isArray(picked) && picked.length) {
    const kept = [];
    for (const raw of picked) {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v >= dur) {
        console.warn(`[blockoutize] 自选看帧时刻 ${raw} 不在 [0, ${dur}) 内，已丢弃`);
        continue;
      }
      kept.push(v);
    }
    const all = normalizeTimes(kept, maxT);
    if (all.length > VISION_FRAMES_MAX) {
      console.warn(`[blockoutize] 自选看帧 ${all.length} 个超过上限 ${VISION_FRAMES_MAX}，只看最靠前的 ${VISION_FRAMES_MAX} 个`);
    }
    const times = all.slice(0, VISION_FRAMES_MAX);
    if (times.length) return times;
    console.warn(`[blockoutize] 自选看帧时刻一个都不可用（共 ${picked.length} 个），退回自动取帧`);
  }

  const n = autoFrameCount(dur);
  // 在 [0, durSec) 上均匀取。去重只可能让它变少（不会超上限），所以这里不再警告
  return normalizeTimes(
    Array.from({ length: n }, (_, i) => (dur * i) / n),
    maxT,
  );
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
    // ★★ 编号必须把**取值范围**钉死，只说「依次编号」不够 —— 2026-08-15 真机实测：
    //   那样写模型印出来的是 **115 / 116** 这种运动员号码牌式的三位数，而我们登记的是 1/2，
    //   两边完全对不上。套用者在列表里点「1」挂卡，AI 到画面上根本找不到「1」，
    //   结果是钱花了、人没换对，且全程零报错（labelConfirmed 那道核对闸正是为这个存在，
    //   但闸只是兜底 —— 让编号一开始就对才是正事）。
    `每个人偶胸口用醒目的黑色阿拉伯数字编号，**从 1 开始按 1、2、3 的顺序依次编到 ${roles.length}**，`,
    "只用这些数字本身：不要用多位数、不要用 0 开头、不要画成运动员号码牌或队服号码的样式。",
    "同一个人偶全程编号不变，不同人偶的编号不许重复。",
    // ★★ 清单之外的人：**照样白模化，但不给编号**（2026-08-15 实测出来的坑）。
    //   我们只看几帧，画面里的人却会中途入场/离场 —— 那一发 4 秒素材看 3 帧只认出 2 个人，
    //   而方舟出片时看到更多人，**自己往下编了个 3 号**。于是画面上有 3 号，
    //   角色位列表里只有 1、2：套用者看得见它却挂不上卡，只会以为功能坏了，且全程零报错。
    // ★★ 宁可让它**没号**也不要一个列表里没有的号：没号的人偶就是一个"保持白模原样"的
    //   路人（与"挂不上卡的角色位"表现一致、也说得通），而多出来的号是一句我们自己
    //   兑现不了的承诺。帧数上调（visionFrameTimes）是让它少发生，这一句是让它发生了也不伤人。
    "如果画面里还出现了上面没有点名的其他人物（例如中途才入场的、被前景挡住又露出来的），",
    "同样把他们替换成一模一样的纯白色人偶，但**不要给他们任何编号**，胸口保持完全空白。",
    "所有人的动作、姿态、站位、前后层次、运镜、背景、道具与光影保持原样不变。",
  ].join("");
}

// ── ③ 核实任务状态与转存 ──────────────────────────────────────────────

/**
 * 问方舟一次：这个任务现在什么状况。**只问一次，绝不在服务端等**。
 *
 * ══ 为什么这里没有轮询循环了（两阶段拆分的要害）══════════════════════
 * 这个文件之前有一个 `pollTask`：在**建模板那一条 HTTP 请求里**每 5 秒问一次、最长等
 * 5 分钟。它把"钱已经付了"和"东西拿到了"绑在同一个 TCP 连接的命上 —— 手机切后台、
 * 弱网断线、App 进程被回收、nginx `proxy_read_timeout` 掐断，任何一条都会让用户
 * **丢掉这一发的结果，而钱已经花了**（方舟受理后失败不退，F11），我们这边的日志里
 * 却还是一次成功。所以轮询整段搬回客户端（走既有的
 * `GET /api/ark/contents/generations/tasks/:id` —— 不计费、已有限流桶），
 * 服务端只在**取回结果**那一步问这一次。
 *
 * ★★ 这一问是**必须**的，不是走过场：finish 绝不能信客户端一句「成功了」
 *   （与试炼闸 provenAt 同一条理由 —— 那边也是服务端两头自己看见才算数）。
 *   信了的话，随便一个 jobId + 一句"succeeded"就能让我们去转存一条根本不存在的产物，
 *   或者把一发失败的任务当成功建成模板。
 *
 * @returns {Promise<
 *   | { state:"succeeded", videoUrl:string }
 *   | { state:"running" }
 *   | { state:"failed", message:string }
 *   | { state:"unknown", message:string }>}
 *   · failed  = 方舟明说这一发没成 —— 终局，**不退费**，调用方要照实说；
 *   · unknown = 我们**没问清楚**（上游抖动/回包不是 JSON/说成功却没给地址）——
 *     不是终局：凭据要留着让用户过一会儿再取。把它当失败处理等于替方舟宣判，
 *     而那一句"这一发没了"是收不回来的。
 */
async function fetchTaskState(taskId) {
  const { status, text } = await callArk({
    method: "GET",
    path: `/contents/generations/tasks/${taskId}`,
    timeoutMs: T_POLL,
  });
  if (status !== 200) {
    console.warn(`[blockoutize] 核实任务 ${taskId} 上游 ${status}`);
    return {
      state: "unknown",
      message: `暂时问不到这一发的出片状态（AI 服务返回 ${status}），这一发的结果还留着，请过一会儿再来取一次。`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    return { state: "unknown", message: "暂时问不到这一发的出片状态（AI 服务的回复读不懂），这一发的结果还留着，请过一会儿再来取一次。" };
  }
  if (parsed?.status === "succeeded") {
    const videoUrl = parsed?.content?.video_url;
    if (!videoUrl) {
      // ★ 不当失败：报告成功却没给地址多半是上游一时的形状问题，而这一发的凭据
      //   还在有效期内 —— 留着让他再取一次，比当场宣判"钱没了"诚实。
      return { state: "unknown", message: "AI 报告出片成功，却没有给出视频地址。这一发的结果还留着，请过一会儿再来取一次。" };
    }
    return { state: "succeeded", videoUrl };
  }
  if (parsed?.status === "failed" || parsed?.status === "cancelled") {
    const why = String(parsed?.error?.message || "").slice(0, 300);
    return {
      state: "failed",
      message:
        `AI 中途拒绝了这段视频${why ? `（${why}）` : ""}。` +
        "视频里出现真人面孔时最容易发生这种情况——任务已经被受理并消耗了算力，**这一发的费用不退**。" +
        "建议换一段没有真人面孔的素材再试。",
    };
  }
  // queued / running / 其它进行中的状态
  return { state: "running" };
}

/**
 * 把方舟产物转存到我们自己的 Cloudinary。
 *
 * ★★ F12：方舟产物 URL 是 **TOS 签名地址、24 小时过期**。不转存的话，
 *   今天建的模板明天就是一条死链 —— 而且**零症状**：模板列表照常显示，
 *   直到有人套用它出片时方舟拉不到参考视频才 400。
 * ★ 落在与原始素材同一个 folder、同一种 public_id 形状（`<userId>-<ts>`），
 *   这样归属校验、r2v 反查、删除时的回收全都沿用现成的那一套。
 * ★★ `publicId` 由调用方（取件凭据 BlockoutJob.outPublicId）**在阶段一就定死**，
 *   这里不再现取 `Date.now()`：取回结果是可以重来的一步（转存失败/用户点两次），
 *   每次现取新 id 的话，重来一次就在云端多留一份 100MB 级的孤儿资产，**零症状**，
 *   只有月底的配额账单会告诉你。定死之后重来多少次都只覆盖同一份。
 */
async function transferToCloudinary(remoteUrl, publicId) {
  try {
    const receipt = await cloudinary.uploader.upload(remoteUrl, {
      folder: "ideahub/template-videos",
      public_id: publicId,
      resource_type: "video",
    });
    return { ok: true, receipt };
  } catch (e) {
    console.error("[blockoutize] 产物转存失败:", e?.error?.message || e.message);
    return {
      ok: false,
      // ★ 两阶段之后这条**不再是终局**：产物还在方舟那边（24h 内），凭据也还在，
      //   用户过一会儿再点一次「取回结果」就能接着走 —— 所以话要说成"可以再来取"，
      //   而不是一体式那时候的"费用无法退回，请重来一次"（那是让他再花一次钱）。
      message: "白模视频已经生成好了，但转存到我们的存储时失败了，模板还没建出来。这一发的结果还留着，请过一会儿再来取一次。",
    };
  }
}

module.exports = {
  PREWARM_TRIES,
  prewarm,
  fetchFrameDataUrl,
  VISION_SEC_PER_FRAME,
  VISION_FRAMES_MIN,
  VISION_FRAMES_MAX,
  FRAME_QUANT_SEC,
  visionFrameTimes,
  VISION_SYSTEM,
  visionPrompt,
  parseRoles,
  blockoutPrompt,
  fetchTaskState,
  transferToCloudinary,
};
