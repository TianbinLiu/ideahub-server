const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const mongoose = require('mongoose');
const Comment = require('./src/models/Comment');

async function checkLatestReply() {
  try {
    const uri = process.env.MONGO_URI;
    await mongoose.connect(uri || 'mongodb://localhost:27017/ideahub');
    console.log('✅ Connected to MongoDB');
    
    // Get all comments sorted by creation time (newest first)
    const allComments = await Comment.find().sort({ createdAt: -1 }).limit(10);
    console.log('\n📋 最近10条评论（包括回复）:');
    
    allComments.forEach((c, i) => {
      console.log(`\n${i+1}. Content: "${c.content.substring(0, 30)}..."`);
      console.log(`   _id: ${c._id}`);
      console.log(`   parentCommentId: ${c.parentCommentId}`);
      console.log(`   parentCommentId type: ${typeof c.parentCommentId}`);
      console.log(`   parentCommentId exists: ${c.parentCommentId !== undefined}`);
      console.log(`   replyCount: ${c.replyCount}`);
      console.log(`   createdAt: ${c.createdAt}`);
    });
    
    // Check specifically for replies
    console.log('\n\n🔍 检查回复数据:');
    const replies = await Comment.find({ parentCommentId: { $exists: true, $ne: null } });
    console.log(`回复总数: ${replies.length}`);
    
    if (replies.length > 0) {
      console.log('\n最新的回复:');
      replies.sort((a, b) => b.createdAt - a.createdAt);
      replies.slice(0, 3).forEach(r => {
        console.log(`- Content: "${r.content.substring(0, 30)}..."`);
        console.log(`  parentCommentId: ${r.parentCommentId}`);
        console.log(`  createdAt: ${r.createdAt}`);
      });
    }
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err);
    process.exit(1);
  }
}

checkLatestReply();
