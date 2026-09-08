// src/models/BranchProject.js
// 已发布作品的「工坊工程」——发布/回炉那一刻的画布快照（瘦身后只含永久 URL 的 JSON）。
// 作者点「🛠 回炉重做」时把它取回工坊，改完再走 PATCH /api/branch/videos/:id 替换原作品。
//
// ★★ 为什么是**独立集合**，而不是挂在 BranchVideo 上的一个字段：
//   branchVideo.controller 的三条读路径 —— listVideos（`find(...).lean()`）、
//   getVideo（`findById(...).lean()`）、updateVideo 的回写（`findOneAndUpdate(...).lean()`）
//   —— **一处投影都没有**。挂上去之后即使 toVideoPayload 不序列化它，DB→Node 每页仍会
//   整份搬 12~50 条画布（listQuery 默认 12、上限 50）。补 `.select("-canvas")` 意味着
//   同一条规则要写三处，而漏掉哪一处都零报错、只是列表接口悄悄变慢十倍（铁律六）。
//   独立集合触碰**零个**读路径。
//
// ★★ 为什么**不加 TTL**：工程是用户资产，不是 VideoCompose 那种 48h 的任务行。
//   给它挂 TTL 的表现是「用户发布三个月后回来点回炉，按钮灰着说没有留存」——
//   而他什么都没删。级联删除走 purgeVideo（删作品）与 purgeUserCascade（删号）两处。
//
// ★★ 为什么 canvas 里**不许**出现 `data:` / `idb:` / 方舟临时地址（PUT 的 zod 与客户端断言
//   两道门，见 schemas/branchProject.schemas.js 的 NO_LOCAL）：
//   ① dataURL 是 MB 级的，一份 5 段画布塞满 base64 会直接顶到 Mongo 单文档 16MB 上限，
//      而它撞上限的表现是落库 500，用户看到的是「工程没能留存」；
//   ② `idb:` 是**发布那台设备**的 IndexedDB 键，换台设备取回来就是一批死指针，
//      而播放器对死指针是静默回退（不报错）；
//   ③ 方舟（volces/volccdn）地址约 24 小时过期，存下来等于存了一份定时失效的画布。
const mongoose = require("mongoose");

const branchProjectSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    video: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true },
    /**
     * 这份画布描述的是作品的**哪一个** revision。
     *
     * ★★ 它**不是**这份工程自己的版本号，但它是**唯一**说得出"这份画布画的是哪一版"
     *   的那一格 —— 而这件事和并发是两回事，必须分开看（2026-09-07 评审纠正）：
     *     · `BranchVideo.revision` 挡的是**并发**（两台设备同时提交，第二发 409）；
     *     · 这一格挡的是**陈旧**（画布是第 1 版、线上已经是第 2 版）。
     *   只有前者时，一份陈旧画布配上现读的 baseRevision 会被服务端正常接受，
     *   把线上内容**静默退回上一版**、全程 200 零报错。
     *   ⇒ 两条纪律，各在一处：
     *     ① `putProject` 校验 `videoRevision === BranchVideo.revision`，对不上 400 ——
     *        这一格**只能靠客户端 PUT 新画布往前走**，没有别的写路径；
     *     ② 客户端取回时比对 `videoRevision` 与作品当下的 revision，对不上整句拒。
     *   ⛔ 回炉成功时**绝不**把这一格顶成新版次（旧实现干过，见 controller 的 ⑧）：
     *      那等于替一份还没换的画布盖章说"我是新版"，把唯一的检出信号亲手抹掉。
     */
    videoRevision: { type: Number, default: 0 },
    /**
     * 「这份画布已经不描述作品当下那一版了」。回炉成功那一刻由服务端置真，
     * 客户端 PUT 新画布时置假（putProject 一处）。
     *
     * ★ 它与 `videoRevision` 是**同一件事的两种说法**，留着它是因为客户端要能一眼看出
     *   "这份工程过期了"而不必先去查作品的 revision（列表接口不回作品正文）。
     *   判据只有 `videoRevision` 一处（铁律六）—— 这一格是给 UI 用的提示位，
     *   **不作为拒绝依据**（拒绝在 putProject 与客户端取回两处按 videoRevision 判）。
     * ★ 判否定：老数据没有这个字段 = 不过期（缺失 = 老数据 = 否定）。
     */
    stale: { type: Boolean, default: false },
    title: { type: String, default: "", maxlength: 120 },
    /** 服务端**自己量**的 `JSON.stringify(canvas)` 字节数（不信客户端报的数）。配额按它算。 */
    bytes: { type: Number, default: 0 },
    /** 画布正文。形状由客户端定义（CanvasSnapshot），服务端只当 Mixed 存，不解释内容。 */
    canvas: { type: mongoose.Schema.Types.Mixed, required: true },
    /** 留存时有多少个图位/成片没能拿到永久地址（回炉打开时画虚线框、横幅如实报数）。 */
    lostCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// 一条作品最多一份工程（PUT 是 upsert，靠这条索引挡住并发重复插入）。
// ★ 不做版本历史：只留一份最新的 + 一个 revision 计数（见 spec §9.3）。
branchProjectSchema.index({ video: 1 }, { unique: true });
// 「我的工程列表」与配额统计（countDocuments / aggregate sum bytes）都按 owner 查
branchProjectSchema.index({ owner: 1, updatedAt: -1 });

module.exports = mongoose.model("BranchProject", branchProjectSchema);
