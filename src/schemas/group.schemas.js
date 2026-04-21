const { z } = require("../middleware/validate");
const { WORLD_GROUP_SLUG } = require("../utils/groups");

const createGroupBody = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(2).max(40).optional(),
  description: z.string().trim().max(300).optional().default(""),
}).superRefine((value, ctx) => {
  if (String(value.slug || "").trim().toLowerCase() === WORLD_GROUP_SLUG) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["slug"],
      message: "world is reserved",
    });
  }
});

module.exports = { createGroupBody };