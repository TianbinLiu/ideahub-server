const User = require("../models/User");

/**
 * Parse @mentions in text
 * Extracts @username patterns from text and resolves them to user IDs
 * @param {string} text - Text to parse for mentions
 * @returns {Promise<{userIds: string[], mentionedUsernames: string[]}>}
 */
async function parseMentions(text) {
  if (!text) return { userIds: [], mentionedUsernames: [] };
  
  // Match @username patterns (username: alphanumeric + underscore/hyphen)
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const mentionedUsernames = [];
  let match;
  
  while ((match = mentionRegex.exec(text)) !== null) {
    const username = match[1].toLowerCase().trim();
    if (username && !mentionedUsernames.includes(username)) {
      mentionedUsernames.push(username);
    }
  }
  
  if (mentionedUsernames.length === 0) return { userIds: [], mentionedUsernames: [] };
  
  // Find users by username
  const users = await User.find({ username: { $in: mentionedUsernames } }).select("_id username").lean();
  const userIds = users.map(u => u._id);
  
  return { userIds, mentionedUsernames };
}

module.exports = { parseMentions };
