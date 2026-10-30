// src/models/ArkVideoTask.js
// 方舟视频任务的**服务端登记**：一条 = 「这个账号在什么时候提交过哪一发出片」。
//
// ★★ 为什么要有它（2026-09-06 主人真机）：客户端的取回凭据只落在 localStorage，App 被系统回收 / 重装 /
//   出包重启时它还在 —— 但「取回成功那一拍就销毁凭据、成片只落在内存里」这条路一旦被再一次重启打断，
//   那一发就谁都找不回来了：钱在受理那一刻已经扣了、方舟侧好好存着 24 小时、App 里一颗按钮都没有。
//   服务端记一条，App 冷启动就能 GET /api/ark/video-tasks 把本机不认识的任务补成凭据，再走同一条「取回」。
// ★★ 2026-10-07 起它还是电影级「样片」第二步的**归属与时长凭证**（ark.routes 的 resolveDraftFinal）：
//   所有人的任务都挂在同一把方舟 key 下，方舟认 id 不认人 —— 「这条样片是不是你的、当初定的几秒」只能问这里。
// ★ 与 BranchTemplateTrial 不是一回事：那条是「试炼过没过」的闸，任务一出结果就删；这条是给人找回用的。
// ★ 方舟那一半只记 Seedance：Seed3D 走同一个任务端点，但产物是 zip，取回那条路不认它。
// ★★ 2026-10-26 起也记 **MiniMax H3**（`provider: "minimax"` + `api: "v2"`，GET /api/minimax/video-tasks 列它们）：
//   出片按地区下发之后海外的普通出片全走 H3，没有这份登记的话，海外的每一发都退回到 2026-09-06 那次事故的形态
//   （受理时已扣钱、App 被杀两次就再也找不回来）。名字仍叫 ArkVideoTask —— 改集合名要迁数据，换来的只是名字好看。
//   ⚠ /api/ark/video-tasks 只列**没有 provider 的行**：老 App 会拿列出来的任务号去问方舟，H3 的号问过去只会是一张永远取不回的卡。
const mongoose = require("mongoose");

/** 普通任务留 48 小时（方舟产物 24 小时过期，多留一天是让「已过期」那句话还有的说） */
const TTL_MS = 48 * 60 * 60 * 1000;
/** 样片（draft:true）留 8 天：方舟规定样片 7 天内可以转成片，多留一天同上 */
const DRAFT_TTL_MS = 8 * 24 * 60 * 60 * 1000;

const arkVideoTaskSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** 上游任务 id：方舟 cgt-… / MiniMax H3 的数字串。已过各自路由的 TASK_ID_RE 收口。
     *  ★ 唯一索引只按 taskId（不带 provider）：两家的号长得不一样（cgt- 前缀 vs 纯数字），撞不上；
     *    真要改成 (provider, taskId) 得先删线上那条老索引（mongoose 只建缺的、从不删旧的）。 */
    taskId: { type: String, required: true, trim: true, maxlength: 64 },
    /**
     * 哪一家的任务（2026-10-26）。**没有这一位 = 方舟 Seedance**（判否定：这一位上线之前的每一行都是方舟的，不用回填）。
     * ★ mongoose 缺省 strict：schema 里没有这一位，create 传进来的 provider 会被悄悄丢掉 —— H3 的行就会混进
     *   /api/ark/video-tasks、被老 App 拿去问方舟。所以它必须写在这里。
     */
    provider: { type: String, enum: ["minimax"], default: undefined },
    /** MiniMax 的哪一版接口（同 GenTaskCharge.api）：今天只有 `"v2"`（H3）。真人档（v1）还没登记（P3） */
    api: { type: String, enum: ["v2"], default: undefined },
    model: { type: String, default: "", maxlength: 80 },
    /** 申报时长 / 画幅 / 分辨率：客户端补凭据时按它们铺段（realDurationSec 由取回时的截帧实测）。
     *  ★ 样片第二步的计价时长读的也是样片那一条的 durationSec（钉子要求样片显式写整数时长） */
    durationSec: { type: Number, default: undefined },
    ratio: { type: String, default: "", maxlength: 16 },
    resolution: { type: String, default: "", maxlength: 16 },
    /** 提示词前 300 字：取回后新开的那一段拿它当剧情 / 标题，让人认得出是哪一发 */
    prompt: { type: String, default: "", maxlength: 300 },
    r2v: { type: Boolean, default: false },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "BranchTemplate", default: undefined },
    /** 这一发是电影级样片的第一步（draft:true，480p）。只有它能被拿去转成片 */
    draft: { type: Boolean, default: false },
    /** 这一发是哪条样片转出来的成片（样片第二步才有） */
    draftOf: { type: String, default: undefined, maxlength: 64 },
    /** 这一发实扣多少 token（管理员免单记 0）。给对账与「这一发值多少」的那句话用 */
    costTokens: { type: Number, default: undefined },
    /**
     * 这一条什么时候被回收（TTL 索引，按行定）。★ 为什么不再用 createdAt 上的 TTL：
     * 一条 TTL 索引只能给所有行同一个寿命，而样片要活 8 天、普通任务 48 小时就够 ——
     * 只能每行自带到期时间。老行（2026-10-07 之前落的）没有这一位，由 arkVideoTask.service 的 migrateExpiry 回填。
     */
    expireAt: { type: Date, default: () => new Date(Date.now() + TTL_MS) },
  },
  { timestamps: true, versionKey: false }
);

arkVideoTaskSchema.index({ taskId: 1 }, { unique: true });
// ★ 改 TTL 的形状：mongoose 只建缺的索引、从不改 / 删已有的 —— 线上那条 createdAt_1（48 小时 TTL）还在，
//   它会在第 48 小时把样片行删掉（样片就此转不了成片）。所以 migrateExpiry 会在启动时把它删掉（0 号实例跑一次）。
arkVideoTaskSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const ArkVideoTask = mongoose.model("ArkVideoTask", arkVideoTaskSchema);
ArkVideoTask.TTL_MS = TTL_MS;
ArkVideoTask.DRAFT_TTL_MS = DRAFT_TTL_MS;
module.exports = ArkVideoTask;
