// src/schemas/live2dModel.schemas.js
// Live2D 模型市场请求校验。上传是 multipart（zip + 文本字段），文本字段到手全是字符串，
// 所以 createBody 收的是「字符串形态」再自行转型；updateBody 是普通 JSON。
const { z } = require("../middleware/validate");
const { voiceSettingsSchema, voiceFieldSchema } = require("../utils/voiceSettings");

const tagsInput = z.union([z.array(z.string().trim().max(30)), z.string()]).optional();
const objectIdOrEmpty = z.string().trim().max(64).optional();

/** multipart 里的 "true"/"false"/"1"/"0" */
const boolString = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (typeof v === "boolean" ? v : ["true", "1", "on", "yes"].includes(String(v || "").toLowerCase())));

/** multipart 里 voice 是 JSON 字符串；空串/缺省 = 没设置 */
const voiceString = z
  .union([z.string(), z.object({}).passthrough(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === "") return null;
    let obj = v;
    if (typeof v === "string") {
      try {
        obj = JSON.parse(v);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "voice must be a JSON object" });
        return z.NEVER;
      }
    }
    if (obj === null) return null;
    const parsed = voiceSettingsSchema.safeParse(obj);
    if (!parsed.success) {
      // 里层自己写的人话（「只能混 1.0 音色」）要透出来，别一律糊成 "invalid voice settings"
      const custom = parsed.error.issues.find((i) => i.code === "custom" && i.message);
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: custom ? custom.message : "invalid voice settings" });
      return z.NEVER;
    }
    return parsed.data;
  });

/** multipart 里 mapping（companion.json 内容）是 JSON 字符串；空串/缺省 = 让服务器自动映射。形状与引用在控制器里按能力档案校验 */
const mappingString = z
  .union([z.string(), z.object({}).passthrough(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string") return v;
    try {
      const obj = JSON.parse(v);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
      return obj;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mapping must be a JSON object" });
      return z.NEVER;
    }
  });

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional().default(""),
  coverImageUrl: z.string().trim().max(2000).optional().default(""),
  tags: tagsInput,
  shared: boolString,
  personaId: objectIdOrEmpty,
  voice: voiceString,
  mapping: mappingString,
  // 包里有多个 model3.json 时指定入口（相对包根的 posix 路径，来自 /inspect 的 entries）
  entry: z.string().trim().max(300).optional().default(""),
  // 授权勾选：我是作者或已获授权
  selfMade: boolString,
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  coverImageUrl: z.string().trim().max(2000).optional(),
  tags: tagsInput,
  shared: z.boolean().optional(),
  personaId: z.string().trim().max(64).nullable().optional(),
  voice: voiceFieldSchema,
  // 对象 = 改成这份映射（按能力档案校验后重写 companion.json），null = 恢复自动映射，缺省 = 不动
  mapping: z.union([z.object({}).passthrough(), z.null()]).optional(),
  selfMade: z.boolean().optional(),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(40).optional().default(12),
  sort: z.enum(["new", "hot"]).optional().default("new"),
  q: z.string().trim().max(80).optional().default(""),
  tag: z.string().trim().max(30).optional().default(""),
  scope: z.enum(["all", "installed", "mine"]).optional().default("all"),
});

module.exports = { createBody, updateBody, listQuery };
