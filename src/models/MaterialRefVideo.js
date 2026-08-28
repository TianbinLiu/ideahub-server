// 用户素材参考视频（工作流「自定义 = 多图 + 参考视频」那条路的登记表）。
//
// ★★ 为什么必须登记：resolveR2v 只认"服务端知道的视频"（防拿任意 URL 白嫖视频输入
//   计费）。模板走 BranchTemplate，用户自传素材走这张表 —— 时长由**服务端**在登记时
//   从 Cloudinary Admin API 取回写死（客户端报的数一个不信），计价即读它。
// ★ 素材**私有**：只有上传者本人能拿它出片（resolveR2v 校 ownerId）。它不是模板，
//   不进市场、没有发布/下架语义 —— 别把它并进 BranchTemplate（那会撞 refVideo.url
//   唯一索引，还让试炼闸对着私人素材计数，2026-08 分支二注释里点过同一坑）。
const mongoose = require("mongoose");

const materialRefVideoSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** Cloudinary public_id（`ideahub/template-videos/<userId>-<ts>` —— 与模板直传共用
     *  同一条上传票据与归属判据 ownTemplateVideoPublicId，别另开一套） */
    publicId: { type: String, required: true, unique: true },
    /** 服务端规范化的 secure_url —— resolveR2v 的等值匹配键 */
    url: { type: String, required: true, unique: true },
    /** 服务端从 Cloudinary 取回的时长（秒）。计价输入，客户端不可写 */
    durationSec: { type: Number, required: true },
    bytes: { type: Number },
    width: { type: Number },
    height: { type: Number },
  },
  { timestamps: true },
);

module.exports = mongoose.model("MaterialRefVideo", materialRefVideoSchema);
