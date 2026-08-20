// 【第十二发】**我们管线生成的**颜色点名提示词，在五连败的那段素材上到底行不行？
//
// ══ 与前面各发的关系 ═══════════════════════════════════════════════════
// 第十一发（用户手打，同段素材）：红色按颜色点名 + 全员挂满 → 全对。它同时改了两件事。
// 这一发用**产品真会生成的**那段话（blockoutApplySkeleton，颜色唯一 → `红色人偶=X`，
// 白的照旧序数+括号），并且按产品的**现实用法**：部分挂卡 —— 红色挂 + 一个白的挂，
// 其余四个白的写「保持人偶原样」。
// 相对第二发（红色不挂、白的按序数挂 → 换错）唯一的结构性变化就是：**红色挂上了、按颜色点名**。
//
// ══ 预注册判读（出片前写死）════════════════════════════════════════════
//   · 红→星璃（白发女孩）且 从左数第2个→阿岚（棕发男） → **产品配置成立**，收口可推
//   · 红→阿岚（拿了白位的卡）                         → 绑定串线，回到老failure
//   · 红换对、白位没换                                 → 部分成立，白位那半要再查
//   · 没挂的白位也被换                                 → 「保持原样」仍然兜不住，考虑强制挂满
require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean) });
const fs = require("fs");
require("./src/config/cloudinary");
const cloudinary = require("cloudinary").v2;
const { buildOutFrameUrl } = require("./src/utils/templateVideoAsset");
const { callArk } = require("./src/services/arkGateway.service");
const b = require("./src/services/blockoutize.service");
// ★ 真·产品代码：App 的骨架函数（esbuild 打好的那份，与仓库当前源码一致）
const P = require(process.env.BP_BUNDLE);

const PUB = "ideahub/template-videos/6993983fe974359db8d23ad4-1786941475509"; // 群舞：6 白 + 1 红
const START = 7.5;
const DUR = 5;
const VISION = "doubao-seed-2-1-turbo-260628";
const R2V = "doubao-seedance-2-5-260628";
const CARD_A = { name: "星璃", url: "https://res.cloudinary.com/dp1dxt0ac/image/upload/v1787030525/ideahub/tmp-drifttest/card-b-xingli.jpg" }; // 白发蓝披风女孩 → 挂给红色
const CARD_B = { name: "阿岚", url: "https://res.cloudinary.com/dp1dxt0ac/image/upload/v1786947429/ideahub/tmp-drifttest/nng86dxush4imqitxqkh.webp" }; // 棕发深蓝大衣男 → 挂给一个白的
const OUT = process.env.TMPDIR || ".";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clipUrl = () =>
  `https://res.cloudinary.com/${cloudinary.config().cloud_name}/video/upload/so_${START},du_${DUR}/${PUB}.mp4`;
const send = async (body, timeoutMs) => {
  const r = await callArk({ path: "/chat/completions", body, timeoutMs: timeoutMs || 150000 });
  return { ok: r.status >= 200 && r.status < 300, accepted: true, status: r.status, text: r.text };
};

(async () => {
  const at = START + DUR / 2;
  const around = [at, at - 1, at + 1, START + 0.5, START + DUR - 0.5];
  const m = await b.measureRosterBoxes({ publicId: PUB, durSec: 3600, model: VISION, send, timeoutMs: 150000, atSecs: around });
  if (!m.roles.length) return console.log(`[x] 试了 ${m.tries} 帧没认出人：${m.why}`);
  const rows = m.roles.map((r, i) => ({ ...m.boxes[i], label: r.label, mark: m.markDescs[i] || "" }));
  rows.forEach((r, i) => console.log(`[x] ${i + 1}. cx=${String(r.cx).padStart(4)}  ${r.mark || "(没验过)"}`));

  const colorOf = (s) => (s.mark.split(/[、]/)[0] || "");
  const redAt = rows.findIndex((r) => /红/.test(colorOf(r)));
  if (redAt < 0) return console.log("[x] 这一帧没认出红色那位 —— 不发");
  // 白位目标：挑一个**验过描述**、且不是红色旁边第一个的中间白位（贴近第二发的目标条件）
  const whiteAt = rows.findIndex((r, i) => i !== redAt && i !== 0 && i !== rows.length - 1 && r.mark);
  if (whiteAt < 0) return console.log("[x] 没有可用的白位目标 —— 不发");

  // ── 用**产品骨架**生成正文（部分挂卡：红=星璃、白位=阿岚，其余保持原样）──
  const spec = { scheme: "ordinal", slots: rows.map((r) => r.label) };
  const cast = rows.map((r, i) => ({
    label: r.label,
    desc: "x",
    mark: r.mark,
    card: i === redAt ? { id: "a", name: CARD_A.name } : i === whiteAt ? { id: "b", name: CARD_B.name } : null,
  }));
  const body = P.blockoutApplySkeleton(cast, "", spec);
  const prompt =
    body +
    `${CARD_A.name}=@图片1、${CARD_B.name}=@图片2。参考图只用来锁这两个角色的长相、发色与服装，不要照抄其构图与背景。`;
  console.log(`\n[x] 红=第 ${redAt + 1} 位（挂 ${CARD_A.name}·白发女孩）  白位=第 ${whiteAt + 1} 位「${rows[whiteAt].label}」（挂 ${CARD_B.name}·棕发男）`);
  console.log(`[x] 提示词（${prompt.length} 字）：${prompt}\n`);
  const okKey = body.includes("红色人偶=" + CARD_A.name);
  console.log(`[x] 产品骨架${okKey ? "确实按颜色点名了红色那位 ✓" : "❌ 没有按颜色点名（构图或描述不满足，别发）"}`);
  if (!okKey) return;
  console.log(
    `[x] 判读：红→${CARD_A.name}且${rows[whiteAt].label}→${CARD_B.name}=产品配置成立 / 红→${CARD_B.name}=绑定串线 / 没挂的白位被换=保持原样兜不住`,
  );
  if (process.env.GO !== "1") return console.log("[x] 空跑（GO=1 才真发，约 ¥8.8）");

  const u = clipUrl();
  for (let i = 0; i < 8; i += 1) {
    const r = await fetch(u);
    const buf = Buffer.from(await r.arrayBuffer());
    const j = buf.indexOf(Buffer.from("mvhd"));
    const secs = j > 0 && buf.readUInt32BE(j + 16) ? buf.readUInt32BE(j + 20) / buf.readUInt32BE(j + 16) : 0;
    console.log(`[x] 预热 try${i} status=${r.status} bytes=${buf.length} 时长=${secs}`);
    if (r.status === 200 && secs >= 1.8) break;
    await sleep(8000);
  }

  const t0 = Date.now();
  const created = await callArk({
    path: "/contents/generations/tasks",
    body: {
      model: R2V,
      content: [
        { type: "text", text: prompt },
        { type: "video_url", role: "reference_video", video_url: { url: u } },
        { type: "image_url", role: "reference_image", image_url: { url: CARD_A.url } },
        { type: "image_url", role: "reference_image", image_url: { url: CARD_B.url } },
      ],
      omni_reference_task_type: "edit",
      duration: -1,
      ratio: "adaptive",
      resolution: "720p",
      watermark: false,
    },
    timeoutMs: 150000,
  });
  const cj = JSON.parse(created.text || "{}");
  if (!cj.id) return console.log("[x] 受理失败 status=" + created.status + " " + (created.text || "").slice(0, 300));
  console.log("[x] 受理 id=" + cj.id);

  let vid = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(10000);
    const st = await callArk({ path: `/contents/generations/tasks/${cj.id}`, method: "GET", timeoutMs: 30000 });
    const sj = JSON.parse(st.text || "{}");
    if (i % 3 === 0) console.log(`[x] ${Math.round((Date.now() - t0) / 1000)}s ${sj.status}`);
    if (sj.status === "succeeded") { vid = sj.content?.video_url; console.log("[x] 用量 " + JSON.stringify(sj.usage || {})); break; }
    if (sj.status === "failed" || sj.status === "cancelled") return console.log("[x] 失败 " + JSON.stringify(sj.error || sj).slice(0, 300));
  }
  if (!vid) return console.log("[x] 超时没出片（id=" + cj.id + "，24h 内可 recover）");

  const local = `${OUT}/white52.mp4`;
  const rr = await fetch(vid);
  fs.writeFileSync(local, Buffer.from(await rr.arrayBuffer()));
  const up = await cloudinary.uploader.upload(local, { folder: "ideahub/tmp-drifttest", resource_type: "video", timeout: 300000 });
  console.log("[x] 成片 publicId=" + up.public_id + " dur=" + up.duration);
  for (const s of [0.3, 1.2, 2.0, 2.6, 4.4]) {
    const f = await b.fetchFrameDataUrl(buildOutFrameUrl(up.public_id, s, undefined, 1024));
    if (f.ok) {
      fs.writeFileSync(`${OUT}/x52-${String(s).replace(".", "_")}.jpg`, Buffer.from(f.dataUrl.split(",")[1], "base64"));
      console.log(`[x] 抽出 ${s}s`);
    }
  }
})().catch((e) => console.log("[x] ERR " + (e && e.message)));
