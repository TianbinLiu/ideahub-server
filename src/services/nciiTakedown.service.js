/**
 * @file nciiTakedown.service.js - NCII 移除请求：内容定位、已知相同副本检索、到期提醒
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节 + 官网 /takedown 页
 *
 * ── 法条出处 ────────────────────────────────────────────────────────
 * TAKE IT DOWN Act §3(b)(1)(B)：收到有效请求后除了移除那一条，还要
 * **「make reasonable efforts to identify and remove any known identical copies」**。
 * 这个文件就是那句 "reasonable efforts" 的实现：**从请求人给的一个链接，展开成资产地址，
 * 再把全站引用了同一个资产地址的地方都找出来。**
 *
 * ★★ 为什么必须有这一层：我们的资产是**按地址复制**的。卡组发布时 `snapshotCardSchema`
 *    逐字段抄 URL，别人「装」走一套卡组时也只抄地址（不重新上传）；作品「回炉重做」
 *    会让新旧两版共享同一批地址。⇒ **删掉原作品，同一张图还留在别人的卡组、别人的作品里。**
 *    只删请求人给的那一条，法条那句话就没有被满足。
 *
 * ★★ 这里与 `utils/branchAssetRefs.js` 的取舍**刚好相反**，别顺手复用那边的规则：
 *    那份枚举**刻意不含 deck**（回收时删掉卡组快照的地址，会让装过这套卡组的人卡面全裂）。
 *    但在 NCII 这件事上，**卡组快照里的那张图正是必须被找出来的副本**。
 *    一个是「别误删还在用的」，一个是「别漏掉还在传播的」——同一份数据，两种方向。
 *
 * ★ 检索是**管理员触发**的（免登录的那个入口只负责收请求，不触发扫描）：
 *   作品那部分要遍历 `branchTree`（Map，键是动态的，**没法用点号路径查**），只能逐条算。
 *   我们的量级下这点扫描无所谓，但它不该挂在公开接口上。
 */
const mongoose = require("mongoose");
const { assetUrlsOfVideo } = require("../utils/branchAssetRefs");

/**
 * 全站「用户上传的图/视频可能落在哪」的**唯一登记表**。
 *
 * ★★ 漏登记一处的后果：那份副本永远搜不到，而**没有任何报错** ——
 *    我们会在完全不知情的情况下漏掉一份该删的内容。所以
 *    `tests/nciiTakedown.spec.js` 有一条测试**扫描 src/models/ 下所有字段名像媒体地址的字段**，
 *    发现没登记、也不在 NOT_USER_MEDIA 白名单里的，直接让测试变红。新增模型时按提示二选一。
 * ★ `fields` 用的是 **Mongo 点号路径**：数组与内嵌子文档天然支持（`segments.videoUrl`
 *   会匹配数组里任意一段）。Map（`branchTree.nodes`）不行 —— 那部分由 BranchVideo 的
 *   专用扫描兜底，见 findReferences。
 */
const MEDIA_SOURCES = [
  { model: "User", label: "用户头像", fields: ["avatarUrl"] },
  { model: "BranchVideo", label: "分支视频作品", fields: ["cover", "videoUrl", "assetUrls", "segments.firstFrame", "segments.lastFrame", "segments.videoUrl"] },
  { model: "BranchCard", label: "人物 / 道具卡", fields: ["cover", "modelUrl", "views.url"] },
  { model: "BranchDeck", label: "卡组（含发布快照）", fields: ["cover", "modelUrl", "cards.cover", "cards.modelUrl", "cards.views.url"] },
  { model: "BranchTemplate", label: "分支模板", fields: ["coverUrl", "url"] },
  { model: "WorkshopTemplate", label: "创意工坊模板", fields: ["previewImageUrl", "backgroundUrl"] },
  { model: "Idea", label: "创意", fields: ["coverImageUrl", "imageUrls"] },
  { model: "Comment", label: "评论", fields: ["imageUrls"] },
  { model: "ArenaComment", label: "擂台评论", fields: ["imageUrl"] },
  { model: "BountyComment", label: "赏金评论", fields: ["imageUrl"] },
  { model: "Bounty", label: "赏金任务", fields: ["coverImageUrl"] },
  { model: "BountySubmission", label: "赏金投稿", fields: ["screenshotUrl"] },
  { model: "LeaderboardPost", label: "榜单投稿", fields: ["imageUrls"] },
  { model: "Meme", label: "梗图素材", fields: ["imageUrl"] },
  { model: "Persona", label: "人格卡封面", fields: ["coverImageUrl"] },
  { model: "Live2dModel", label: "Live2D 模型封面", fields: ["coverImageUrl"] },
  { model: "Scenario", label: "情景模拟", fields: ["coverImageUrl", "avatar", "authorAvatar"] },
  { model: "ScenarioSession", label: "情景对话（头像快照）", fields: ["senderAvatar"] },
  { model: "MaterialRefVideo", label: "参考素材视频", fields: ["url"] },
  { model: "VideoCompose", label: "合成任务产物", fields: ["url"] },
  { model: "BlockoutJob", label: "白模任务产物", fields: ["coverUrl"] },
  { model: "ArkVideoTransfer", label: "资产转存记录", fields: ["url", "sourceUrl"] },
];

/**
 * 字段名看着像媒体地址、但**不是用户上传的内容**，所以不进检索。
 * 登记在这里是为了让上面那条测试能分辨「故意不收」与「忘了收」。
 */
const NOT_USER_MEDIA = {
  Idea: ["url"], // 用户填的外部链接（别人的网页），不是我们托管的资产
  Bounty: ["targetUrl"],
  Scenario: ["sourceUrl"],
  BranchTemplate: ["sourceUrl"],
  StandpointEvent: ["threadUrl"],
  User: ["modelJsonUrl", "uploadedModelJsonUrl"], // Live2D 模型工程文件，不是影像
  // subschema，不是 model；它的宿主 BranchCard / BranchDeck 已经把 views.url 登记了
  "cardView.schema": ["url"],
  // 移除请求**自己**的字段：`urls` 是请求人给我们的链接、`removed[].url` 是处置留痕。
  // 它们不是我们托管的影像 —— 把它们收进检索，结果会是「请求指向请求自己」。
  TakedownRequest: ["urls", "url"],
};

/**
 * 地址比对用的键：**主机 + 尾段文件名**（去掉协议、查询串与 Cloudinary 的变换段）。
 *
 * ★★ 主机不能丢（2026-09-25 评审）：只按尾段比的话，尾段是「尺寸档位」或「数字 id」的
 *   那些渠道会整片误伤 —— 微信/QQ 头像的尾段是 `/132`、`/100`，GitHub 头像是数字 id。
 *   受害者随手贴一个头像地址，就会把**全站同渠道的头像**都列成「已知相同副本」，
 *   而给管理员的邮件写的是「删除扫出来的每一处」。
 * ★ 同主机内仍然只按尾段比，这样 Cloudinary 改过尺寸的同一张图照样认得出。
 */
function assetKey(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  const noQuery = s.split("?")[0].split("#")[0];
  const m = /^[a-z]+:\/\/([^/]+)\//i.exec(noQuery);
  const host = m ? m[1].toLowerCase() : "";
  // Cloudinary: https://res.cloudinary.com/<cloud>/<type>/upload/<变换段>/v123/<public_id>.<ext>
  // 变换段（w_800,c_fill 之类）与版本号会变，同一张图因此有多个地址 —— 只按尾段比才认得出是同一张。
  const tail = noQuery.split("/").filter(Boolean).pop() || "";
  if (!tail) return "";
  return `${host}|${tail.toLowerCase()}`;
}

/** 把请求人给的一串链接拆成 { pageIds, assetUrls, keys } */
function parseTargets(urls) {
  const pageIds = new Set();
  const assetUrls = new Set();
  for (const raw of urls || []) {
    const s = String(raw || "").trim();
    if (!s) continue;
    // 站内页面链接：.../branch/videos/<24hex>、.../videos/<24hex>、?v=<24hex> 都认
    // ★ 认成页面链接就**不要**再把它当资产地址：页面链接的尾段是那个 24 位 id，
    //   混进 assetKey 的比对集里，会让「文件名恰好是作品 id」的资产被误判成副本。
    const id = /([a-f0-9]{24})/i.exec(s);
    if (id && /ideahubs?\.org|localhost|127\.0\.0\.1|^\//i.test(s)) pageIds.add(id[1].toLowerCase());
    else assetUrls.add(s);
  }
  return { pageIds: [...pageIds], assetUrls: [...assetUrls] };
}

/** 请求人给的是作品页链接时，把它展开成这条作品占用的全部资产地址 */
async function expandVideoAssets(pageIds) {
  if (!pageIds.length) return [];
  const BranchVideo = mongoose.model("BranchVideo");
  const ids = pageIds.filter((s) => mongoose.isValidObjectId(s));
  if (!ids.length) return [];
  const docs = await BranchVideo.find({ _id: { $in: ids } })
    .select("cover segments branchTree assetUrls")
    .lean();
  const out = new Set();
  for (const d of docs) {
    for (const u of assetUrlsOfVideo(d)) out.add(u);
    for (const u of d.assetUrls || []) out.add(u);
  }
  return [...out];
}

/**
 * 找出全站引用了这些资产地址的地方（= §3(b)(1)(B) 的「已知相同副本」）。
 * @param {string[]} urls 请求人给的链接（页面链接或资产地址都行）
 * @returns {Promise<{urls: string[], refs: Array<{model,label,id,field,url}>}>}
 */
async function findReferences(urls) {
  const { pageIds, assetUrls } = parseTargets(urls);
  const expanded = await expandVideoAssets(pageIds);
  const all = [...new Set([...assetUrls, ...expanded])].filter(Boolean);
  const keys = new Set(all.map(assetKey).filter(Boolean));
  const refs = [];
  const truncated = [];

  // 直接按 id 命中的作品也要列出来（请求人给的就是那条作品页）
  for (const id of pageIds) refs.push({ model: "BranchVideo", label: "分支视频作品", id, field: "_id", url: id });

  if (!all.length) return { urls: all, refs: dedupe(refs), truncated };

  // ★ 同一张图在库里可能有**好几个地址**：Cloudinary 的变换段与版本号都会进 URL
  //   （`.../upload/w_800,c_fill/v17.../abc.jpg`）。只按整串比，改过尺寸的那份就漏了。
  //   所以除了整串命中，再按「尾段文件名」正则兜一层。键数封顶，避免一次请求拼出几百个正则。
  // 正则只拿尾段那一半（主机在 JS 侧复核），否则要为每种写法拼一条正则
  const keyPatterns = [...keys]
    .slice(0, 20)
    .map((k) => new RegExp("/" + escapeRe(String(k).split("|").pop()) + "([?#]|$)", "i"));

  for (const src of MEDIA_SOURCES) {
    let Model;
    try {
      Model = mongoose.model(src.model);
    } catch {
      continue; // 模型还没被 require 进来（单测只挂了一部分）：跳过而不是整条检索炸掉
    }
    const or = [];
    for (const f of src.fields) {
      or.push({ [f]: { $in: all } });
      for (const re of keyPatterns) or.push({ [f]: { $regex: re } });
    }
    const LIMIT = 500;
    const rows = await Model.find({ $or: or })
      .select(src.fields.join(" "))
      .limit(LIMIT)
      .lean();
    // ★ 截断必须说出来（2026-09-25 评审）：`foundCount` 是我们履行 §3(b)(1)(B) 的证据，
    //   静默截断会让「只找到 500 条」读起来像「一共就这么多」。
    if (rows.length === LIMIT) {
      truncated.push(src.model);
      console.warn(`[takedown] ${src.model} 的副本检索命中数达到上限 ${LIMIT}，结果可能不完整`);
    }
    for (const row of rows) {
      for (const f of src.fields) {
        for (const v of valuesAt(row, f)) {
          const exact = all.includes(v);
          // ★ 分清「整串一模一样」与「只是文件名相同」：后者要人眼再确认一遍才敢删
          if (exact || keys.has(assetKey(v))) refs.push({ model: src.model, label: src.label, id: String(row._id), field: f, url: v, exact });
        }
      }
    }
  }

  // ★ 作品的 branchTree.nodes 是 Map，键是动态的 ⇒ 上面的点号路径查不到它。
  //   逐条算一遍（管理员触发，量级可接受；漏掉的话互动作品的分支画面就是搜不到的死角）。
  const BranchVideo = mongoose.model("BranchVideo");
  const cursor = BranchVideo.find({}).select("cover segments branchTree assetUrls").lean().cursor();
  for await (const doc of cursor) {
    for (const u of assetUrlsOfVideo(doc)) {
      const exact = all.includes(u);
      if (exact || keys.has(assetKey(u))) {
        refs.push({ model: "BranchVideo", label: "分支视频作品", id: String(doc._id), field: "assets", url: u, exact });
      }
    }
  }

  return { urls: all, refs: dedupe(refs), truncated };
}

function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function valuesAt(obj, path) {
  const parts = path.split(".");
  let cur = [obj];
  for (const p of parts) {
    const next = [];
    for (const c of cur) {
      if (c === null || c === undefined) continue;
      const v = Array.isArray(c) ? c.map((x) => x && x[p]) : c[p];
      if (Array.isArray(v)) next.push(...v);
      else next.push(v);
    }
    cur = next;
  }
  return cur.filter((v) => typeof v === "string" && v);
}

function dedupe(refs) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    const k = `${r.model}:${r.id}:${r.field}:${r.url}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}


// ── 通知与到期提醒 ────────────────────────────────────────────────

/** 真实邮箱（占位域名不算）。与 support.routes 的判据同源 */
function isRealEmail(addr) {
  const s = String(addr || "").trim();
  return /@/.test(s) && !/@no-email\.ideahub\.local$/i.test(s);
}

async function adminRecipients() {
  const configured = String(process.env.TAKEDOWN_NOTIFY_EMAIL || process.env.SUPPORT_NOTIFY_EMAIL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const User = mongoose.model("User");
  const { ADMIN_ROLE } = require("../utils/roles");
  const admins = await User.find({ role: ADMIN_ROLE }).select("email").lean();
  return admins.map((a) => a.email).filter(isRealEmail);
}

/** 进纯文本邮件的用户输入一律压成一行：不压的话可以伪造出看起来像模板自带的行
 *  （「本请求经复核为恶意，已自动驳回」）。support.routes 有同款处理。 */
function oneLine(s) {
  return String(s || "").replace(/[\r\n]+/g, " ").slice(0, 2000);
}

function requestEmailText(doc, { overdue = false, soon = false } = {}) {
  const due = new Date(doc.dueAt);
  return [
    overdue ? "⚠ 这条 NCII 移除请求已经超过 48 小时法定时限，请立刻处理。" : soon ? "⚠ 这条 NCII 移除请求距离 48 小时时限不足 12 小时。" : "收到一条 NCII（非自愿私密影像）移除请求。",
    "",
    `请求编号：${String(doc._id)}`,
    `收到时间：${new Date(doc.receivedAt).toISOString()}`,
    `法定时限：${due.toISOString()}（48 小时，TAKE IT DOWN Act §3(b)）`,
    `请求人签名：${oneLine(doc.signature)}（${doc.onBehalf === "authorized" ? "受本人授权的代理人" : "本人"}）`,
    `联系邮箱：${oneLine(doc.contactEmail)}${doc.contactPhone ? `    电话：${oneLine(doc.contactPhone)}` : ""}`,
    "",
    "内容位置：",
    ...(doc.urls || []).map((u) => `  · ${oneLine(u)}`),
    doc.locationNote ? `补充说明：${oneLine(doc.locationNote)}` : "",
    doc.statement ? `陈述：${oneLine(doc.statement)}` : "",
    "",
    "处理步骤：",
    `  1. POST /api/admin/takedown/${String(doc._id)}/scan  —— 查同一个资产地址的已知副本`,
    "  2. 下架 / 删除扫出来的每一处（含别人的卡组快照与回炉后的新版本）",
    `  3. PATCH /api/admin/takedown/${String(doc._id)}  { status: "removed", removed: [...] }`,
    "",
    "★ 48 小时是法定上限不是目标值；FTC 自 2026-05-19 执法，无小企业豁免。",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** 收到请求时立刻发信。★ 邮件是这条链路上**唯一必须送达**的通道（48 小时等不到有人打开后台） */
async function notifyAdmins(doc, opts = {}) {
  const { sendEmail } = require("./email.service");
  const to = await adminRecipients();
  if (!to.length) {
    // ★★ 这里必须**抛**，不能 return（2026-09-25 评审）：return 的话
    //   `sweepDueReminders` 的 try 顺利走完 → 把 `reminderStage` 记成「已提醒」——
    //   一封信都没发出去，而 48 小时法定时限从此没有任何东西会再提醒你。
    console.error("[takedown] 没有可用的管理员邮箱：这条 NCII 请求没人会被通知到", String(doc._id));
    throw new Error("takedown: no admin recipients configured");
  }
  await sendEmail({
    to,
    subject: `${opts.overdue ? "[逾期] " : opts.soon ? "[即将到期] " : ""}[启梦] NCII 移除请求 ${String(doc._id).slice(-6)} · 48 小时时限`,
    text: requestEmailText(doc, opts),
  });
}

/**
 * 把处理结果回给**请求人**。
 * ★★ 官网 /takedown 上白纸黑字写着「我们记录收到时间与处理时间，并用邮件回复你结果」——
 *   在这之前一个字都没有发出去过（2026-09-25 评审）。对一个正在等结果的人，
 *   「石沉大海」与「我们没处理」是分不开的两件事。
 * ★ need_info 那封要把管理员的备注带上，否则她不知道要补什么材料，而这条请求会一直停在那儿。
 */
async function notifyRequester(doc) {
  const { sendEmail } = require("./email.service");
  const to = String(doc.contactEmail || "").trim();
  if (!to) return;
  const id = String(doc._id).slice(-6);
  const head =
    doc.status === "removed"
      ? "我们已经移除了你指出的内容"
      : doc.status === "need_info"
        ? "我们需要你补充一点信息才能继续"
        : "关于你提交的移除请求";
  const body =
    doc.status === "removed"
      ? ["我们移除了你指出的内容，也检索了站内引用同一份文件的其它位置并一并处理。", "如果你还看到别的地方有同一份内容，直接回这封邮件告诉我们。"]
      : doc.status === "need_info"
        ? ["我们暂时无法确认要移除的具体内容。", doc.handleNote ? `需要补充：${oneLine(doc.handleNote)}` : "请把能直接打开那段内容的链接发给我们。", "回这封邮件补充即可，我们会接着处理。"]
        : ["经复核，我们没有对这次请求采取移除措施。", doc.handleNote ? `原因：${oneLine(doc.handleNote)}` : "", "如果你认为这是误判，回这封邮件告诉我们，我们会重新看一遍。"];
  try {
    await sendEmail({
      to,
      subject: `[启梦] 关于你的内容移除请求 ${id}`,
      text: [head, "", ...body.filter(Boolean), "", `请求编号：${id}`, `收到时间：${new Date(doc.receivedAt).toISOString()}`].join("\n"),
    });
  } catch (e) {
    // 发不出去不能让处置本身失败：内容已经移除了，这一步是告知
    console.error("[takedown] 回复请求人失败:", (e && e.message) || e);
  }
}

/**
 * 到期提醒清扫：剩余不足 12 小时提醒一次，超时再提醒一次。
 * ★ 只在 0 号实例跑（cluster 下否则每个实例各发一封）；由 index.js 启动。
 * ★ `reminderStage` 记到哪一档，避免每轮重发。
 */
async function sweepDueReminders() {
  const TakedownRequest = mongoose.model("TakedownRequest");
  const now = Date.now();
  const soonAt = new Date(now + 12 * 60 * 60 * 1000);
  // ★★ 去重要写进**查询条件**（2026-09-25 评审）：原来是取回 50 条再 `continue` 跳过已提醒的，
  //   而索引 {status, dueAt} 保证按 dueAt 升序 —— 最老的 50 条会稳定霸占整批，
  //   后面任何一条真实请求（哪怕已逾期）一封提醒都发不出去。而且**不需要攻击者**：
  //   免登录入口 10 次/小时/IP，攒够 50 条只是时间问题。
  const rows = await TakedownRequest.find({
    status: { $in: ["pending", "need_info"] }, // need_info 也在时限内，见下面 ★
    dueAt: { $lte: soonAt },
    $or: [
      { reminderStage: { $exists: false } },
      { reminderStage: "" },
      // 已经发过「即将到期」的，逾期时还要再发一次
      { reminderStage: "soon", dueAt: { $lte: new Date(now) } },
    ],
  })
    .sort({ dueAt: 1 })
    .limit(50);
  for (const doc of rows) {
    const overdue = new Date(doc.dueAt).getTime() < now;
    const stage = overdue ? "overdue" : "soon";
    if (doc.reminderStage === stage || (doc.reminderStage === "overdue" && stage === "soon")) continue;
    try {
      await notifyAdmins(doc, { overdue, soon: !overdue });
      doc.reminderStage = stage;
      await doc.save();
    } catch (e) {
      // 发不出去就不要记 stage：下一轮还要再试（记了就等于把提醒静默吞掉）
      console.error("[takedown] 到期提醒发送失败:", (e && e.message) || e);
    }
  }
}

module.exports = { MEDIA_SOURCES, NOT_USER_MEDIA, findReferences, assetKey, parseTargets, notifyAdmins, notifyRequester, sweepDueReminders };
