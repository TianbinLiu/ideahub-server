require('dotenv').config();
const mongoose = require('mongoose');
const Comment = require('./src/models/Comment');

async function checkReplies() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ideahub');
    console.log('Connected to DB');
    
    // Check all comments with parentCommentId
    const repliesCount = await Comment.countDocuments({
      parentCommentId: { $exists: true, $ne: null }
    });
    console.log('\n回复总数:', repliesCount);
    
    if (repliesCount > 0) {
      const latestReply = await Comment.findOne({
        parentCommentId: { $exists: true, $ne: null }
      }).sort({ createdAt: -1 }).populate('author', '_id username');
      console.log('\n最新回复:', JSON.stringify(latestReply, null, 2));
    }
    
    // Check top-level comments
    const topLevelCount = await Comment.countDocuments({
      $or: [
        { parentCommentId: null },
        { parentCommentId: { $exists: false } }
      ]
    });
    console.log('\n顶级评论总数:', topLevelCount);
    
    // Check a sample top-level comment
    const sample = await Comment.findOne({
      $or: [
        { parentCommentId: null },
        { parentCommentId: { $exists: false } }
      ]
    }).sort({ createdAt: -1 }).populate('author', '_id username');
    
    if (sample) {
      console.log('\n最新顶级评论:', {
        _id: sample._id,
        content: sample.content,
        replyCount: sample.replyCount,
        parentCommentId: sample.parentCommentId,
        createdAt: sample.createdAt
      });
      
      // Check replies for this comment
      const replies = await Comment.find({
        parentCommentId: sample._id
      }).populate('author', '_id username');
      console.log(`\n此评论的回复数: ${replies.length}`, replies.map(r => ({
        _id: r._id,
        content: r.content,
        parentCommentId: r.parentCommentId
      })));
    }
    
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

checkReplies();
