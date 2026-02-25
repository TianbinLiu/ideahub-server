const { z } = require("../middleware/validate");

const tagsSchema = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((val) => val ?? []);

const createIdeaBody = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().max(300).optional().default(""),
  content: z.string().optional().default(""),
  tags: tagsSchema,
  visibility: z.enum(["public", "private", "unlisted"]).optional().default("public"),
  isMonetizable: z.coerce.boolean().optional().default(false),
  licenseType: z.string().optional().default("default"),
  isFeedback: z.coerce.boolean().optional().default(false),
});

const updateIdeaBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().max(300).optional(),
  content: z.string().optional(),
  tags: tagsSchema.optional(),
  visibility: z.enum(["public", "private", "unlisted"]).optional(),
  isMonetizable: z.coerce.boolean().optional(),
  licenseType: z.string().optional(),
});

module.exports = { createIdeaBody, updateIdeaBody };
