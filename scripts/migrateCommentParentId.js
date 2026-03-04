/**
 * 迁移脚本：为所有未设置 parentCommentId 的评论设置为 null
 * 运行命令：node scripts/migrateCommentParentId.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Comment = require("../src/models/Comment");

async function migrate() {
  try {
    // 连接数据库
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/ideahub");
    console.log("✅ 已连接到数据库");

    // 查找所有没有 parentCommentId 字段的评论
    const result = await Comment.updateMany(
      { parentCommentId: { $exists: false } },
      { $set: { parentCommentId: null, replyCount: 0 } }
    );

    console.log(`✅ 迁移完成！更新了 ${result.modifiedCount} 条评论`);
    
    // 验证
    const topLevelCount = await Comment.countDocuments({ parentCommentId: null });
    const replyCount = await Comment.countDocuments({ parentCommentId: { $ne: null } });
    console.log(`📊 顶级评论: ${topLevelCount} 条`);
    console.log(`📊 回复评论: ${replyCount} 条`);

  } catch (error) {
    console.error("❌ 迁移失败:", error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log("👋 数据库连接已关闭");
  }
}

migrate();
