// src/models/Live2dModel.js
// Live2D 模型市场的一条「数字人套装」：模型包（zip 解压后落在 uploads/live2d-market/ 下）+ 作者推荐的
// 人格（引用人格市场的 Persona）+ 作者推荐的嗓子（voice）。上传表单强制走这三个板块（模型 / 人格 / 音频），
// 用户「使用」它之后可以在自己的 CompanionSetting 里单独覆盖人格与嗓子。
//
// 文件放本地磁盘而不是 Cloudinary：一个模型是一组相对路径互相引用的文件（model3.json → moc3 / 贴图 / exp3…），
// 必须整目录同源托管；/uploads 的静态服务已经带了 CSP sandbox + 扩展名白名单（见 live2dBundle.service.js）。
// 删除模型时连目录一起删（siteComponents 那条老路没有删除，这里必须有 —— 市场是会被反复上传的）。
const mongoose = require("mongoose");
const { voiceSettingsSchema } = require("./CompanionSetting");

const live2dModelSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", trim: true, maxlength: 1000 },
    // 封面（Cloudinary URL，与人格封面同一条上传路），空串 = 前端用占位图
    coverImageUrl: { type: String, default: "" },
    tags: { type: [String], default: [] },
    // 解压目录（相对 uploads/ 的 posix 路径）与入口 model3.json（同样相对 uploads/）。
    // 只存相对路径：对外 URL 按请求的 host 现拼（本地/线上域名不同，存绝对 URL 会在迁移时全坏）
    bundleDir: { type: String, required: true },
    modelJsonPath: { type: String, required: true },
    bundleName: { type: String, default: "", maxlength: 200 },
    bundleBytes: { type: Number, default: 0 },
    fileCount: { type: Number, default: 0 },
    // 推荐人格：引用而非快照（作者改风格全网生效；被删/取消分享 → 读取时当没有）
    persona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", default: null },
    voice: { type: voiceSettingsSchema, default: null },
    shared: { type: Boolean, default: false, index: true },
    stats: {
      viewCount: { type: Number, default: 0 },
      downloadCount: { type: Number, default: 0 },
      likeCount: { type: Number, default: 0 },
      _id: false,
    },
  },
  { timestamps: true }
);

live2dModelSchema.index({ shared: 1, createdAt: -1 });
live2dModelSchema.index({ shared: 1, "stats.downloadCount": -1 });

module.exports = mongoose.model("Live2dModel", live2dModelSchema);
