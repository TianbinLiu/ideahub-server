const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const mongoose = require('mongoose');
const Comment = require('./src/models/Comment');

async function checkDatabase() {
  try {
    const uri = process.env.MONGO_URI;
    console.log('MONGO_URI:', uri ? 'Set' : 'NOT SET');
    
    if (!uri) {
      console.log('Reading from default localhost...');
    }
    
    await mongoose.connect(uri || 'mongodb://localhost:27017/ideahub');
    console.log('✅ Connected to MongoDB');
    
    // Get counts
    const commentCount = await Comment.countDocuments();
    console.log(`\n📊 Comment total: ${commentCount}`);
    
    const topLevelCount = await Comment.countDocuments({
      $or: [
        { parentCommentId: null },
        { parentCommentId: { $exists: false } }
      ]
    });
    console.log(`📊 Top-level comments: ${topLevelCount}`);
    
    const replyCount = await Comment.countDocuments({
      parentCommentId: { $exists: true, $ne: null }
    });
    console.log(`📊 Replies: ${replyCount}`);
    
    // Show recent comments
    const recent = await Comment.find().sort({createdAt: -1}).limit(3).populate('author', 'username');
    console.log('\n📋 3 most recent comments:');
    recent.forEach((c, i) => {
      console.log(`  ${i+1}. "${c.content.substring(0, 40)}..." - parentCommentId: ${c.parentCommentId || 'null'} - replyCount: ${c.replyCount}`);
    });
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkDatabase();
