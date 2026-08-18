// 【#51 决胜一发】多维描述能不能压过「主角效应」？
//
// ══ 这一发要回答的问题 ═══════════════════════════════════════════════
// #46 打了六发，留下的确凿事实只有一条：**素材里有一个读起来像主角的人时，
// 点名「从左数第 N 个」会被压过去** —— 第 3、4 发点名一个白模，被换掉的都是那个
// 居中的红色人偶。而 5、6 发换了裁剪（红色被推到边缘、人从 7 个减到 3 个）之后序数就灵了。
// ⇒ 序数一个人扛不住。#51 的赌注是：**再给一个互不相关的锚点**（这个人偶的颜色、
//   动作、和具体景物的位置关系）能把它掰回来。
//
// ★★ 六发**全部**用的是光秃秃的序数，多维描述在 r2v 这一头**一次都没试过** ——
//   前面那 12/12 是「模型能不能自己认出并自证描述」（几分钱的视觉调用），
//   与「r2v 出片时听不听这句话」完全是两件事，别把前者的成绩当后者的结论。
//
// ══ 构图：逐字复现第 3 发那个**失败**的场景 ════════════════════════════
//   同一段素材、同一段时间、**不裁剪**（7 个人、红色居中）、点名一个白模。
//   唯一的自变量就是"绑定里多了一个括号描述"。
//
// ══ 预注册的判读（先写死，免得出片后挑一个自己喜欢的解释）═══════════════
//   · 被换的是**点名那个白模**   → 多维描述**压过了主角效应**，#51 的路走得通
//   · 被换的还是**那个红色的**   → 描述在 r2v 这一头没用，得换别的做法
//                                （下一步该试的是"负面点名"：明说红色那个不要动）
//   · 换了别的白模 / 换了两个以上 → 描述有干扰但不精准，记下来另论
//
// 跑法：先空跑（只花几分钱的视觉调用，把描述和最终提示词打出来），确认构图与
//   第 3 发一致、目标那条描述**验过**之后，再 `GO=1` 真发那一下（¥8.8）。
// ★ 两份 env：Cloudinary 那几位在 server/.env，而 `ARK_API_KEY` 只在 App worktree 的
//   .env.local 里（它是 dev 代理用的那把）。dotenv 先到先得，所以 server/.env 排前面。
require("dotenv").config({
  path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean),
});
const fs = require("fs");
const cloudinary = require("cloudinary").v2;
const { buildOutFrameUrl } = require("./src/utils/templateVideoAsset");
const { callArk } = require("./src/services/arkGateway.service");
const b = require("./src/services/blockoutize.service");

const PUB = "ideahub/template-videos/6993983fe974359db8d23ad4-1786941475509"; // 群舞（7 人：6 白 + 1 红）
const START = 7.5;
const DUR = 5;
const VISION = "doubao-seed-2-1-turbo-260628";
const R2V = "doubao-seedance-2-5-260628";
const CARD = "阿岚";
const CARD_URL =
  "https://res.cloudinary.com/dp1dxt0ac/image/upload/v1786947429/ideahub/tmp-drifttest/nng86dxush4imqitxqkh.webp";
const OUT_DIR = process.env.TMPDIR || ".";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cloud = () => cloudinary.config().cloud_name;
/** ★ 不裁剪 —— 这一发的整个意义就是复现"红色居中、7 个人"那个失败构图 */
const clipUrl = () => `https://res.cloudinary.com/${cloud()}/video/upload/so_${START},du_${DUR}/${PUB}.mp4`;

/** 把 callArk 包成 blockoutize 那几个函数要的 `send(body, timeoutMs)` 形状 */
const send = async (body, timeoutMs) => {
  const r = await callArk({ path: "/chat/completions", body, timeoutMs: timeoutMs || 150000 });
  return { ok: r.status >= 200 && r.status < 300, accepted: true, status: r.status, text: r.text };
};

(async () => {
  const at = START + DUR / 2;
  const g = await b.fetchFrameDataUrl(buildOutFrameUrl(PUB, at, undefined, 1024));
  if (!g.ok) throw new Error("抽帧失败 " + g.reason);

  // ── ①② 直接跑**生产函数**（认人 + 量框 + 三项属性 + 唯一性自证）──────────
  //   ★★ 不自己拼一发调用：这一发要测的是"用户真会拿到的那份描述"。自己拼的话，
  //     视觉调用本来就有抖动（这一帧刚好撞上三道闸之一就整份丢弃），而生产代码
  //     **本来就会换一帧再试** —— 绕开那圈重试等于测了一个用户永远遇不到的路径。
  //   ★ 候选帧全落在这一段（clip）之内：描述必须描述的是**被送去 r2v 的那 5 秒**。
  const around = [at, at - 1, at + 1, START + 0.5, START + DUR - 0.5].filter((t) => t >= START && t <= START + DUR);
  const m = await b.measureRosterBoxes({
    publicId: PUB,
    durSec: 3600, // 只用来 clamp，这里给个大数（候选帧由 atSecs 直接给）
    model: VISION,
    send,
    timeoutMs: 150000,
    atSecs: around,
  });
  if (!m.roles.length) return console.log(`[51] 试了 ${m.tries} 帧都没认出人：${m.why}`);
  const rows = m.roles.map((r, i) => ({ ...m.boxes[i], desc: r.desc, label: r.label }));
  // ★ 「验过了吗」= 描述里有没有分句（没验过的只剩颜色一个词，见 measureRosterBoxes 的取舍）。
  //   这不是第二处判据，是**读产物**：产物本身就只有这两种形状。
  const okDesc = (r) => r.desc.includes("、");
  rows.forEach((r, i) =>
    console.log(`[51] ${i + 1}. cx=${String(r.cx).padStart(4)}  ${okDesc(r) ? "✓" : "✗未验过"}  ${r.desc}`),
  );
  console.log(`[51] 认人用了第 ${m.atSec}s 那一帧（试了 ${m.tries} 帧）；自证通过 ${m.verified}/${rows.length}`);

  const M = rows.length;
  // ★★ 「是不是红色那个」只能看**颜色那一段**（描述的第一节），不能拿整条去匹配：
  //   第一次空跑就栽在这儿 —— 两个白人偶的描述里都写着「在**红**人偶左/右后方」
  //   （它们拿那个红色的当地标，这本身是好事），结果仅有的两个合格目标被当成红色排除，
  //   脚本判定"没有可用目标"而没发。**没花钱，但差点因为一个筛选 bug 判这条路走不通**。
  const colorOf = (r) => r.desc.split(/[、]/)[0] || "";
  const redAt = rows.findIndex((r) => /红/.test(colorOf(r)));
  let mid = 0;
  rows.forEach((r, i) => {
    if (Math.abs(r.cx - 500) < Math.abs(rows[mid].cx - 500)) mid = i;
  });
  console.log(`[51] 构图：${M} 人；红色第 ${redAt + 1}；最居中的是第 ${mid + 1}（cx=${rows[mid].cx}）`);
  const v = { verified: rows.map(okDesc) };

  // ── ③ 挑目标：白色、**验过描述**、不居中、不是红色那个、**也不在两端** ──────
  //   ★★ 「不在两端」这一条是空跑时补上的：第一版挑中了「最左边」，而**边缘位置是
  //     整条序数里最好认的一档**（模型不用数数，扫到头就是）。拿它去测等于送分 ——
  //     换成功也分不清是描述起了作用还是"最左边"本来就灵。真正难的是**紧挨着那个
  //     红色主角的中间位**（第 3 / 第 5 个），第 3 发失败的也正是这一档。
  const target = rows.findIndex(
    (r, i) => i !== redAt && i !== mid && i !== 0 && i !== M - 1 && v.verified[i] && !/红/.test(colorOf(r)),
  );
  if (target < 0) {
    console.log("[51] 没有满足条件的目标（白色 + 验过 + 不居中 + 不在两端）——这一发不发，先看上面的自证结果");
    return;
  }
  // ★ 措辞直接用生产函数写在 roles 上的那一份（`ordinalSlots(M)` 的产物），不另生成一遍
  const slots = rows.map((r) => r.label);
  // ★ 绑定的形状与 App 的 blockoutApplySkeleton 逐字一致（含 18 字上限、顿号换逗号、
  //   括号里洗掉分隔符）—— 这一发测的必须是**用户真会拿到的那段话**，不是另写一份
  const descIn = (s) => {
    const clean = s.replace(/[、]/g, "，").replace(/[（）()=＝；;@＠\n\r]/g, "").trim();
    if (clean.length <= 18) return clean;
    const cut = clean.slice(0, 18);
    const at = cut.lastIndexOf("，");
    return at > 0 ? cut.slice(0, at) : cut;
  };
  // ★ `roles[].desc` 已经是 composeRosterDesc 的产物（生产代码在 measureRosterBoxes 里
  //   就合成好了），这里只做 App 那一步的清洗与截断 —— 再 compose 一次会拿到空串
  const desc = descIn(rows[target].desc);
  if (!desc) return console.log("[51] 目标那条描述是空的 —— 不发（这一发的自变量就是它）");
  const free = slots.filter((_, i) => i !== target);
  const prompt = [
    "以参考视频复刻原视频的人物站位、动作、节奏卡点、运动轨迹、队形与运镜。",
    `按画面里从左到右的位置替换白色人偶（括号里是这个人偶在画面里的样子）：${slots[target]}（${desc}）=${CARD}。`,
    `${free.map((s) => `${s}的人偶`).join("、")}保持白色人偶的样子，不要替换成任何人。`,
    "动作、起止时间、落点与强拍定格都要与参考视频一致。",
    `${CARD}=@图片1。参考图只用来锁这个角色的长相、发色与服装，不要照抄其构图与背景。`,
  ].join("");
  console.log(`\n[51] ✅ 目标＝${slots[target]}（cx=${rows[target].cx}，白色、验过、不居中、不是红色那个）`);
  console.log(`[51] 描述＝${desc}`);
  console.log(`[51] 提示词（${prompt.length} 字）：${prompt}\n`);
  console.log(
    `[51] 判读：${slots[target]}被换=**描述压过主角效应** / 第${redAt + 1}个（红）被换=描述在 r2v 这头没用 / 其它=另论`,
  );

  if (process.env.GO !== "1") return console.log("[51] 空跑（GO=1 才真发这一下，约 ¥8.8）");

  const u = clipUrl();
  // ★ Cloudinary 的派生片是**按需生成**的：第一次请求可能回一个还没生成完的短文件，
  //   而方舟只会说「duration must be >= 1.8」—— 一句误导人的话。所以先热到时长对为止
  for (let i = 0; i < 8; i += 1) {
    const r = await fetch(u);
    const buf = Buffer.from(await r.arrayBuffer());
    const j = buf.indexOf(Buffer.from("mvhd"));
    const secs = j > 0 && buf.readUInt32BE(j + 16) ? buf.readUInt32BE(j + 20) / buf.readUInt32BE(j + 16) : 0;
    console.log(`[51] 预热 try${i} status=${r.status} bytes=${buf.length} 时长=${secs}`);
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
  if (!cj.id) return console.log("[51] 受理失败 status=" + created.status + " " + (created.text || "").slice(0, 400));
  console.log("[51] 受理 id=" + cj.id);

  let vid = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(10000);
    const st = await callArk({ path: `/contents/generations/tasks/${cj.id}`, method: "GET", timeoutMs: 30000 });
    const sj = JSON.parse(st.text || "{}");
    if (i % 3 === 0) console.log(`[51] ${Math.round((Date.now() - t0) / 1000)}s ${sj.status}`);
    if (sj.status === "succeeded") {
      vid = sj.content?.video_url;
      console.log("[51] 用量 " + JSON.stringify(sj.usage || {}));
      break;
    }
    if (sj.status === "failed" || sj.status === "cancelled")
      return console.log("[51] 失败 " + JSON.stringify(sj.error || sj).slice(0, 400));
  }
  if (!vid) return console.log("[51] 超时没出片");

  const up = await cloudinary.uploader.upload(vid, { folder: "ideahub/tmp-drifttest", resource_type: "video" });
  console.log("[51] 成片 publicId=" + up.public_id + " dur=" + up.duration);
  for (const s of [0.3, 1.2, 2.0, 2.6, 4.4]) {
    const f = await b.fetchFrameDataUrl(buildOutFrameUrl(up.public_id, s, undefined, 1024));
    if (f.ok) {
      fs.writeFileSync(`${OUT_DIR}/d51-out-${String(s).replace(".", "_")}.jpg`, Buffer.from(f.dataUrl.split(",")[1], "base64"));
      console.log(`[51] 抽出 ${s}s`);
    }
  }
})().catch((e) => console.log("[51] ERR " + (e && e.message)));
