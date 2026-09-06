// src/models/ArkVideoTask.js
// 方舟视频任务的**服务端登记**：一条 = 「这个账号在什么时候提交过哪一发出片」。
//
// ★★ 为什么要有它（2026-09-06 主人真机）：客户端的取回凭据只落在 localStorage，App 被系统回收 / 重装 /
//   出包重启时它还在 —— 但「取回成功那一拍就销毁凭据、成片只落在内存里」这条路一旦被再一次重启打断，
//   那一发就谁都找不回来了：钱在受理那一刻已经扣了、方舟侧好好存着 24 小时、App 里一颗按钮都没有。
//   服务端记一条，App 冷启动就能 GET /api/ark/video-tasks 把本机不认识的任务补成凭据，再走同一条「取回」。
// ★ 与 BranchTemplateTrial 不是一回事：那条是「试炼过没过」的闸，任务一出结果就删；这条是给人找回用的，
//   48 小时 TTL 兜底回收（方舟产物本身 24 小时过期，多留一天是让「已过期」那句话还有的说）。
// ★ 只记 Seedance：Seed3D 走同一个任务端点，但产物是 zip，取回那条路不认它。
const mongoose = require("mongoose");

const arkVideoTaskSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** 方舟任务 id（cgt-…）。已过 ark.routes 的 TASK_ID_RE 收口 */
    taskId: { type: String, required: true, trim: true, maxlength: 64 },
    model: { type: String, default: "", maxlength: 80 },
    /** 申报时长 / 画幅 / 分辨率：客户端补凭据时按它们铺段（realDurationSec 由取回时的截帧实测） */
    durationSec: { type: Number, default: undefined },
    ratio: { type: String, default: "", maxlength: 16 },
    resolution: { type: String, default: "", maxlength: 16 },
    /** 提示词前 300 字：取回后新开的那一段拿它当剧情 / 标题，让人认得出是哪一发 */
    prompt: { type: String, default: "", maxlength: 300 },
    r2v: { type: Boolean, default: false },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "BranchTemplate", default: undefined },
  },
  { timestamps: true, versionKey: false }
);

arkVideoTaskSchema.index({ taskId: 1 }, { unique: true });
arkVideoTaskSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 60 * 60 });

module.exports = mongoose.model("ArkVideoTask", arkVideoTaskSchema);
