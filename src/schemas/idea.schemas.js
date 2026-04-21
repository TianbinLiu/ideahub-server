const { z } = require("../middleware/validate");

const tagsSchema = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((val) => val ?? []);

const externalSourceSchema = z
  .object({
    platform: z.string().trim().min(1).max(100).optional(),
    url: z.string().url().optional(),
    originalAuthor: z.string().trim().max(120).optional(),
    sourceCreatedAt: z.string().datetime().optional(),
  })
  .partial();

const createIdeaBody = z.object({
  ideaType: z.enum(["business", "feedback", "external", "daily", "dynamic"]).optional().default("daily"),
  title: z.string().trim().min(1).max(120),
  summary: z.string().max(300).optional().default(""),
  content: z.string().optional().default(""),
  imageUrls: z.array(z.string().url()).max(8).optional().default([]),
  tags: tagsSchema,
  groupSlug: z.string().trim().min(1).max(40).optional().default("world"),
  visibility: z.enum(["public", "private", "unlisted"]).optional().default("public"),
  isMonetizable: z.coerce.boolean().optional().default(false),
  isFeedback: z.coerce.boolean().optional().default(false),
  externalSource: externalSourceSchema.optional(),
});

const updateIdeaBody = z.object({
  ideaType: z.enum(["business", "feedback", "external", "daily", "dynamic"]).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().max(300).optional(),
  content: z.string().optional(),
  imageUrls: z.array(z.string().url()).max(8).optional(),
  tags: tagsSchema.optional(),
  groupSlug: z.string().trim().min(1).max(40).optional(),
  visibility: z.enum(["public", "private", "unlisted"]).optional(),
  isMonetizable: z.coerce.boolean().optional(),
  licenseType: z.string().optional(),
  externalSource: externalSourceSchema.optional(),
});

const recommendationFeedbackBody = z.object({
  reason: z.enum(["not_interested", "already_recommended"]),
});

module.exports = { createIdeaBody, updateIdeaBody, recommendationFeedbackBody };
