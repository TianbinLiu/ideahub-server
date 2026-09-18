/**
 * @file DeletionLog.js - 用户主动删除过什么（只存 ID，不存内容）
 * @category Model
 * @collection deletionlogs
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 模型章节
 *
 * ★ 为什么要有（设计稿 §B1「备份」）：用户删除 = 立即硬删，但数据库备份不会单独擦除，保留期满后自然覆盖。
 *   万一从备份恢复，先按这张表**重放删除**，被用户删掉的东西就不会复活。所以这里只存「删了哪一行」，
 *   保存期要不短于备份保留期（先取 400 天，Atlas 快照保留期确认后按需调）。
 * ★ 到期自动过期的数据（保留期清扫）不记在这里：恢复后清扫会按同一条规则再删一次，天然幂等。
 *
 * @field targetType {String} chat_thread | chat_memory | …
 * @field targetId {ObjectId}
 * @field user {ObjectId} 谁的数据
 *
 * @index {createdAt:1} TTL 400 天
 * @index {targetType:1, targetId:1}
 * @used_in services/chatMemory.service.js
 */
const mongoose = require("mongoose");

const RETENTION_SECONDS = 400 * 24 * 60 * 60;

const deletionLogSchema = new mongoose.Schema(
  {
    targetType: { type: String, required: true, maxlength: 40 },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

deletionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
deletionLogSchema.index({ targetType: 1, targetId: 1 });

module.exports = mongoose.model("DeletionLog", deletionLogSchema);
