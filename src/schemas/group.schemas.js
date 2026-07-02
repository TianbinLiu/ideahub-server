const { z } = require("../middleware/validate");
const { WORLD_GROUP_SLUG } = require("../utils/groups");

const createGroupBody = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(2).max(40).optional(),
  description: z.string().trim().max(300).optional().default(""),
  visibility: z.enum(["public", "private", "unlisted"]).optional().default("public"),
  joinCode: z.string().trim().min(4).max(40).optional(),
}).superRefine((value, ctx) => {
  if (String(value.slug || "").trim().toLowerCase() === WORLD_GROUP_SLUG) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["slug"],
      message: "world is reserved",
    });
  }
});

const joinGroupBody = z.object({
  code: z.string().trim().max(80).optional(),
  inviteCode: z.string().trim().max(80).optional(),
  inviteToken: z.string().trim().max(160).optional(),
}).optional().default({});

const createGroupChatBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional().default(""),
});

const updateGroupMemberBody = z.object({
  role: z.enum(["member", "admin"]),
});

module.exports = { createGroupBody, joinGroupBody, createGroupChatBody, updateGroupMemberBody };