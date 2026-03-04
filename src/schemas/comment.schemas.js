const { z } = require("../middleware/validate");

const addCommentBody = z.object({
  content: z.string().trim().min(1).max(2000),
  parentCommentId: z.string().optional().nullable(), // Support for nested replies
});

module.exports = { addCommentBody };
