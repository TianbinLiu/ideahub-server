const mongoose = require("mongoose");

/**
 * 「这份云端资产该删而还没删干净」的**句柄**。
 *
 * ★★ 为什么要有这张表，而不是删库时 best-effort destroy 一下就算：
 *   删除是用户的**隐私诉求** —— 作品从库里没了，而成片、封面那几个 https 地址
 *   仍然人人可访问。Cloudinary 抖一下就永久漏一份 20MB 成片，而那之后
 *   **再也没有句柄能找到它**（作品正文已经删了，地址只存在于那份正文里）。
 *   先把句柄落进这张表、再删库、最后才去 destroy：任何一步失败，句柄都还在。
 *
 * ★ 为什么不照抄模板那条「先云端后库、失败 502」：模板只有**一件**硬资产，
 *   一条作品有 N 件（5 段 = 5 成片 + 10 帧 + 1 封面）。一件失败就 502 的话，
 *   前面几件已经删了，作品变成"还在但播不了"的半状态 —— 那正是模板那条注释
 *   自己都不肯接受的形态。而且"删不掉"比"晚几分钟删干净"糟得多。
 *
 * ★ 这张表是**只增只删**的工作队列，不是审计日志：destroy 成功即删行。
 *   留着的行就是"还欠着的"，数量本身就是监控指标。
 */
const pendingAssetPurgeSchema = new mongoose.Schema(
  {
    /** Cloudinary public_id（含 ideahub/<folder>/ 前缀，不含扩展名） */
    publicId: { type: String, required: true, trim: true, maxlength: 400 },
    /** image | video。★ 从 URL 路径段解出来的，**绝不写死**：workshop-media 里两种都有，
     *  写死的表现是"合并成片删得掉、封面删不掉"，而 Cloudinary 对不存在的资源回
     *  "not found" 不报错 —— 零症状。 */
    resourceType: { type: String, required: true, enum: ["image", "video"] },
    /** 谁的资产（只为排查，不参与判定：判定在落这一行之前就做完了） */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
    /** 从哪条记录来的（作品 id / 卡片 cardId），只为排查 */
    source: { type: String, default: "", trim: true, maxlength: 200 },
    /** 最近一次失败原因（成功就整行删掉了，所以有值 = 还欠着） */
    lastError: { type: String, default: "", trim: true, maxlength: 500 },
    attempts: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// 同一个 publicId 只欠一次（并发删同一条作品、重试都靠它幂等）
pendingAssetPurgeSchema.index({ publicId: 1 }, { unique: true });
// 清扫器按"最久没试过的"取
pendingAssetPurgeSchema.index({ updatedAt: 1 });

module.exports = mongoose.model("PendingAssetPurge", pendingAssetPurgeSchema);
