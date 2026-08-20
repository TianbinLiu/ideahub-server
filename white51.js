// 【正控一发】**全白素材**上，序数指认到底稳不稳？
//
// ══ 为什么这一发比前面九发都重要 ═══════════════════════════════════════
// 前九发全在验"失败长什么样"，用的都是那段**带赭红主角**的群舞：
//   · 主角在正中 → 三种提示词写法全错（换掉的都是主角）
//   · 主角被裁到边缘 → #46 第 5、6 发全中
// 而**没有主角**的那一格（公园：5 个一模一样的米白人偶）在 r2v 上**从来没试过** ——
// 之前那个 12/12 是"模型能不能自己认出并自证描述"的视觉调用，与"出片时听不听"是两件事。
//
// 这一格恰好就是产品要的第 ① 条（白模化 = 全白人偶）的产物形态。
//
// ══ 预注册判读（出片前写死）═══════════════════════════════════════════
//   · 点名那个被换 → **全白路径稳**：白模化本身就是"稳定产出"的解；
//     带主角的素材靠"提示 + 建议重走白模化"绕开（那句提示已经上线）。
//   · 换了别人     → 序数**本身**不稳，问题不在主角。整条挂卡设计要换
//     （例如先出一张标了号的预览图让用户确认，而不是让他对着"从左数第几个"想象）。
//   · 换了两个以上 → 同上，且更糟。
//
// ★ 目标特意挑**最难的一档**：不在两端（端点不用数数，扫到头就是）、也不是最居中的。
require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean) });
const fs = require("fs");
require("./src/config/cloudinary");
const cloudinary = require("cloudinary").v2;
const { buildOutFrameUrl } = require("./src/utils/templateVideoAsset");
const { callArk } = require("./src/services/arkGateway.service");
const b = require("./src/services/blockoutize.service");

const PUB = "ideahub/template-videos/6993983fe974359db8d23ad4-1786925279582"; // 公园：5 个一模一样的米白人偶
const START = 0;
const DUR = 4.7;
const VISION = "doubao-seed-2-1-turbo-260628";
const R2V = "doubao-seedance-2-5-260628";
const CARD = "阿岚";
const CARD_URL =
  "https://res.cloudinary.com/dp1dxt0ac/image/upload/v1786947429/ideahub/tmp-drifttest/nng86dxush4imqitxqkh.webp";
const OUT = process.env.TMPDIR || ".";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clipUrl = () =>
  `https://res.cloudinary.com/${cloudinary.config().cloud_name}/video/upload/so_${START},du_${DUR}/${PUB}.mp4`;

const send = async (body, timeoutMs) => {
  const r = await callArk({ path: "/chat/completions", body, timeoutMs: timeoutMs || 150000 });
  return { ok: r.status >= 200 && r.status < 300, accepted: true, status: r.status, text: r.text };
};

/** 与 App 的 blockoutPrompt.descIn 逐字同源（34 字上限、超长先丢颜色那一节） */
const APPLY_DESC_MAX = 34;
const descIn = (s) => {
  const clean = String(s || "").replace(/[、]/g, "，").replace(/[（）()=＝；;@＠\n\r]/g, "").trim();
  if (clean.length <= APPLY_DESC_MAX) return clean;
  const parts = clean.split("，");
  while (parts.length > 1 && parts.join("，").length > APPLY_DESC_MAX) parts.shift();
  const left = parts.join("，");
  return left.length <= APPLY_DESC_MAX ? left : left.slice(0, APPLY_DESC_MAX);
};

(async () => {
  // ── 生产函数：认人 + 量框 + 三项属性 + 唯一性自证 ────────────────────
  const around = [DUR / 2, 1, 2, 3, 4].filter((t) => t >= START && t <= START + DUR);
  const m = await b.measureRosterBoxes({
    publicId: PUB,
    durSec: 3600,
    model: VISION,
    send,
    timeoutMs: 150000,
    atSecs: around,
  });
  if (!m.roles.length) return console.log(`[w] 试了 ${m.tries} 帧都没认出人：${m.why}`);
  const rows = m.roles.map((r, i) => ({ ...m.boxes[i], label: r.label, desc: r.desc, mark: m.markDescs[i] || "" }));
  rows.forEach((r, i) =>
    console.log(`[w] ${i + 1}. cx=${String(r.cx).padStart(4)} ${r.mark ? "✓" : "✗未验过"}  ${r.mark || r.desc}`),
  );
  console.log(`[w] 用了第 ${m.atSec}s 那一帧（试了 ${m.tries} 帧）；自证 ${m.verified}/${rows.length}`);

  const M = rows.length;
  // ★ 这一发的前提：**没有颜色异类**。有的话就不是"全白素材"，读数不成立
  const colorOf = (r) => (r.mark || r.desc).split(/[、]/)[0] || "";
  const colors = rows.map(colorOf);
  const tally = new Map();
  for (const c of colors) tally.set(c, (tally.get(c) ?? 0) + 1);
  const modalN = Math.max(...tally.values());
  if (modalN !== M) {
    console.log(`[w] ⚠ 这段素材的人偶**不同色**（${colors.join("/")}）—— 它不是"全白"那一格，这一发不发`);
    return;
  }
  let mid = 0;
  rows.forEach((r, i) => {
    if (Math.abs(r.cx - 500) < Math.abs(rows[mid].cx - 500)) mid = i;
  });
  const target = rows.findIndex((r, i) => i !== 0 && i !== M - 1 && i !== mid && r.mark);
  if (target < 0) return console.log("[w] 没有满足条件的目标（不在两端、不最居中、描述验过）—— 不发");

  const slots = rows.map((r) => r.label);
  const desc = descIn(rows[target].mark);
  const free = slots.filter((_, i) => i !== target);
  const prompt = [
    "以参考视频复刻原视频的人物站位、动作、节奏卡点、运动轨迹、队形与运镜。",
    `按画面里从左到右的位置替换人偶（括号里是这个人偶在画面里的样子）：${slots[target]}（${desc}）=${CARD}。`,
    `${free.map((s) => `${s}的人偶`).join("、")}保持人偶原样，不要替换成任何人。`,
    "动作、起止时间、落点与强拍定格都要与参考视频一致。",
    `${CARD}=@图片1。参考图只用来锁这个角色的长相、发色与服装，不要照抄其构图与背景。`,
  ].join("");
  console.log(`\n[w] 构图：${M} 人，主色全是「${colors[0]}」（没有颜色异类 ✓）；最居中的是第 ${mid + 1}`);
  console.log(`[w] ✅ 目标＝${slots[target]}（cx=${rows[target].cx}，不在两端、不最居中）`);
  console.log(`[w] 提示词（${prompt.length} 字）：${prompt}`);
  console.log(`[w] 判读：${slots[target]}被换=**全白路径稳** / 换了别人=序数本身不稳，挂卡设计要换\n`);
  if (process.env.GO !== "1") return console.log("[w] 空跑（GO=1 才真发，约 ¥8.8）");

  const u = clipUrl();
  for (let i = 0; i < 8; i += 1) {
    const r = await fetch(u);
    const buf = Buffer.from(await r.arrayBuffer());
    const j = buf.indexOf(Buffer.from("mvhd"));
    const secs = j > 0 && buf.readUInt32BE(j + 16) ? buf.readUInt32BE(j + 20) / buf.readUInt32BE(j + 16) : 0;
    console.log(`[w] 预热 try${i} status=${r.status} bytes=${buf.length} 时长=${secs}`);
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
        { type: "image_url", role: "reference_image", image_url: { url: CARD_URL } },
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
  if (!cj.id) return console.log("[w] 受理失败 status=" + created.status + " " + (created.text || "").slice(0, 300));
  console.log("[w] 受理 id=" + cj.id);

  let vid = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(10000);
    const st = await callArk({ path: `/contents/generations/tasks/${cj.id}`, method: "GET", timeoutMs: 30000 });
    const sj = JSON.parse(st.text || "{}");
    if (i % 3 === 0) console.log(`[w] ${Math.round((Date.now() - t0) / 1000)}s ${sj.status}`);
    if (sj.status === "succeeded") { vid = sj.content?.video_url; console.log("[w] 用量 " + JSON.stringify(sj.usage || {})); break; }
    if (sj.status === "failed" || sj.status === "cancelled") return console.log("[w] 失败 " + JSON.stringify(sj.error || sj).slice(0, 300));
  }
  if (!vid) return console.log("[w] 超时没出片（任务 id=" + cj.id + "，24h 内可用 recover 脚本取回）");

  // ★ 先下到本地再传：Cloudinary 的 remote fetch 超时过一次，而那时钱已经花了
  const local = `${OUT}/white51.mp4`;
  const rr = await fetch(vid);
  fs.writeFileSync(local, Buffer.from(await rr.arrayBuffer()));
  const up = await cloudinary.uploader.upload(local, { folder: "ideahub/tmp-drifttest", resource_type: "video", timeout: 300000 });
  console.log("[w] 成片 publicId=" + up.public_id + " dur=" + up.duration);
  for (const s of [0.3, 1.2, 2.0, 3.0, 4.2]) {
    const f = await b.fetchFrameDataUrl(buildOutFrameUrl(up.public_id, s, undefined, 1024));
    if (f.ok) {
      fs.writeFileSync(`${OUT}/w51-${String(s).replace(".", "_")}.jpg`, Buffer.from(f.dataUrl.split(",")[1], "base64"));
      console.log(`[w] 抽出 ${s}s`);
    }
  }
})().catch((e) => console.log("[w] ERR " + (e && e.message)));
