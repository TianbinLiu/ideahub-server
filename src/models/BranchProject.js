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
     * ★★ 它**不是**这份工程自己的版本号：整套回炉的并发支点只有
     *   `BranchVideo.revision` 一个（两个文档两把锁又没有事务，任一半失败就分叉：
     *   工程描述的是上一版 → 下次回炉打开旧画布再提交，把线上内容**静默退回**）。
     *   这里只是个"我对得上哪一版"的标记，冲突判定一律在 updateVideo 里做。
     */
    videoRevision: { type: Number, default: 0 },
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
