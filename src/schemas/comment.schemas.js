const { z } = require("../middleware/validate");

const addCommentBody = z.object({
  content: z.string().trim().min(1).max(2000),
});

module.exports = { addCommentBody };
