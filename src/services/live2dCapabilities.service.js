/**
 * @file live2dCapabilities.service.js - 第三方 Live2D 模型「会什么」的提取 + 我们协议层的映射（companion.json）
 * @category Service
 *
 * 背景：运行时（App / 官网的 companionModel.ts）对模型的要求是写死的协议 —— 动作组叫 nod/shake/wave…、
 * 表情靠固定参数、触摸区叫 Head/Body/…。用户上传的模型哪怕带 20 个动作，只要名字不一样就一个都用不上。
 * 这里做两件事：
 *   1. extractCapabilities：从 model3.json（+ cdi3）读出模型真的有哪些 动作组 / 表情 / 命中区 / 参数 / 物理，
 *      存进 Live2dModel.capabilities，市场卡片据此显示「会动 / 会表情 / 可触摸 / 有物理」角标。
 *   2. suggestMapping / validateMapping：把模型自己的名字对到我们的槽位上（companion.json）。
 *      自动映射认三套名字：我们官方 mascot 的组名、nizima 模型规范（Idle / Start / Tap@区 / Flick@区、
 *      表情 Normal/Smile/Angry/Sad/Surprised/Blushing）、常见英文关键词；对不上的留 null，向导里让用户手点。
 *      运行时对 null 的处理是「静默不演」，所以任何映射都不会让模型报错，只会少几个动作。
 *
 * ★ 自动映射只有这一处实现：客户端向导拿 /api/live2d-models/inspect 的结果显示，不自己再猜一遍。
 * ★ 槽位名必须与 companion.service.js 的 FACES / ACTIONS 和两端 protocol.ts 的 TOUCH_AREAS 一致（那边是源头，这里是镜像）。
 * ★ 参数 id 只能从 cdi3（DisplayInfo）读到；服务器不解析 moc3。没有 cdi3 时 params 为空、paramsKnown=false，
 *   映射里的参数引用不校验（Cubism 对不存在的参数本来就忽略）。
 */
const fs = require("fs/promises");
const path = require("path");
const { z } = require("../middleware/validate");
const { badRequest } = require("../utils/http");
const { FACES, ACTIONS } = require("./companion.service");

/** 触摸区（镜像 protocol.ts 的 TOUCH_AREAS，顺序 = 命中优先级） */
const TOUCH_AREAS = ["Head", "Hair", "HandL", "HandR", "ArmL", "ArmR", "Body", "Skirt", "Legs"];
/** 运行时会用到的参数槽 → 标准 Cubism 参数 id（官方 mascot 与 Cubism 模板模型都用这套） */
const PARAM_SLOTS = {
  mouthOpen: "ParamMouthOpenY",
  mouthForm: "ParamMouthForm",
  eyeL: "ParamEyeLOpen",
  eyeR: "ParamEyeROpen",
  eyeBallX: "ParamEyeBallX",
  eyeBallY: "ParamEyeBallY",
  angleX: "ParamAngleX",
  angleY: "ParamAngleY",
  angleZ: "ParamAngleZ",
  bodyX: "ParamBodyAngleX",
  breath: "ParamBreath",
  cheek: "ParamCheek",
};
/** 没有这几个参数的模型不能转头 / 眨眼 / 说话，向导把它们列为「必须」 */
const REQUIRED_PARAM_SLOTS = ["mouthOpen", "eyeL", "eyeR", "angleX", "angleY"];
/** 动作槽（ACTIONS 去掉 none）→ 官方 mascot 的动作组名（protocol.ts ACTION_MOTIONS 的镜像） */
const ACTION_SLOTS = ACTIONS.filter((a) => a !== "none");
const OFFICIAL_ACTION_GROUPS = {
  acknowledge: "nod",
  disagree: "shake",
  think: "think",
  explain: "nod",
  excited: "excited",
  wave: "wave",
  shy: "shy",
  surprised: "surprised",
  comfort: "nod",
  playful: "excited",
};
/** 动作组名里的关键词（小写、去分隔符后做包含匹配） */
const ACTION_KEYWORDS = {
  acknowledge: ["nod", "agree", "yes", "ok"],
  disagree: ["shake", "deny", "no"],
  think: ["think", "ponder", "hmm", "wonder"],
  explain: ["explain", "talk", "speak", "point"],
  excited: ["excited", "excite", "cheer", "jump", "joy", "yay"],
  wave: ["wave", "hello", "greet", "hi", "bye"],
  shy: ["shy", "blush", "embarrass"],
  surprised: ["surprise", "shock", "wow", "startle"],
  comfort: ["comfort", "hug", "pat", "gentle", "soothe"],
  playful: ["playful", "play", "tease", "wink", "fun", "naughty"],
};
/** 表情槽 → 表情名别名（nizima 规范名 + 常见英文名，小写比较） */
const FACE_ALIASES = {
  normal: ["normal", "neutral", "default", "idle", "f00", "none"],
  happy: ["smile", "happy", "joy", "glad", "f01"],
  laughing: ["laugh", "laughing", "lol", "grin", "haha"],
  angry: ["angry", "anger", "mad", "rage", "f02"],
  sad: ["sad", "sorrow", "down", "upset", "f03"],
  crying: ["cry", "crying", "tears", "sob"],
  shy: ["blushing", "blush", "shy", "embarrassed", "embarrass"],
  tease: ["tease", "smug", "wink", "naughty", "mischief"],
  cuddle: ["cuddle", "love", "heart", "affection", "sleepy", "relax"],
};
/** 触摸区 → 命中区名别名（HitAreas[].Name，小写去分隔符比较） */
const TOUCH_ALIASES = {
  Head: ["head", "face", "hitareahead"],
  Hair: ["hair", "hitareahair"],
  HandL: ["handl", "lhand", "lefthand", "handleft"],
  HandR: ["handr", "rhand", "righthand", "handright", "hand"],
  ArmL: ["arml", "larm", "leftarm", "armleft"],
  ArmR: ["armr", "rarm", "rightarm", "armright", "arm"],
  Body: ["body", "torso", "chest", "hitareabody"],
  Skirt: ["skirt", "dress", "bottom"],
  Legs: ["legs", "leg", "feet", "foot", "knee"],
};
/** 触摸区 → 动作组候选（nizima：Tap@区 / Flick@区；Cubism 示例：TapBody / FlickHead） */
const TOUCH_MOTION_CANDIDATES = (area) => {
  const base = [`tap@${area}`, `tap${area}`, `flick@${area}`, `flick${area}`, `touch@${area}`, `touch${area}`];
  if (area === "Body") base.push("tap", "flick", "tapbody", "flickbody");
  if (area === "Head") base.push("tapface", "flickhead", "flick@face", "tap@face");
  return base;
};

const MAX_TEXTURE_SIDE = 4096;

/** 大小写 / 下划线无关的比较键：ParamAngleX 与 PARAM_ANGLE_X 同键 */
function loose(id) {
  return String(id || "").toLowerCase().replace(/[^a-z0-9@]/g, "");
}
function stripExpExt(name) {
  return String(name || "").trim().replace(/\.exp3\.json$/i, "").replace(/\.exp3$/i, "");
}
function resolveInside(baseDir, ref) {
  const target = path.resolve(baseDir, String(ref));
  if (path.relative(baseDir, target).startsWith("..")) return null;
  return target;
}

/**
 * 读 PNG / WebP / JPEG 文件头拿宽高（只读前 64KB）。解析不出来返回 null —— 这是"尽力而为"，别因为奇怪的文件头拒收。
 */
async function readImageSize(absPath) {
  let fh;
  try {
    fh = await fs.open(absPath, "r");
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return imageSizeFromBuffer(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function imageSizeFromBuffer(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * 从已解析的 model3.json 提取能力档案。
 * @param {object} json model3.json 内容
 * @param {string} entryAbs model3.json 的绝对路径（贴图 / cdi3 相对它解析）
 * @returns {Promise<{ capabilities: object, warnings: string[] }>}
 */
async function extractCapabilities(json, entryAbs) {
  const warnings = [];
  const refs = json && typeof json.FileReferences === "object" && json.FileReferences ? json.FileReferences : {};
  const baseDir = path.dirname(entryAbs);

  const motions = refs.Motions && typeof refs.Motions === "object" && !Array.isArray(refs.Motions) ? refs.Motions : {};
  const motionGroups = Object.keys(motions).filter((g) => Array.isArray(motions[g]) && motions[g].length > 0).slice(0, 200);
  const motionCount = motionGroups.reduce((n, g) => n + motions[g].length, 0);

  const expressions = Array.isArray(refs.Expressions)
    ? Array.from(new Set(refs.Expressions.map((e) => stripExpExt(e && e.Name)).filter(Boolean))).slice(0, 200)
    : [];
  const hitAreas = Array.isArray(json.HitAreas)
    ? Array.from(new Set(json.HitAreas.map((h) => String((h && h.Name) || "").trim()).filter(Boolean))).slice(0, 100)
    : [];

  // 参数：cdi3 是唯一可靠来源；Groups（EyeBlink / LipSync）里的 id 顺手也算证据
  const params = [];
  let paramsKnown = false;
  if (typeof refs.DisplayInfo === "string" && refs.DisplayInfo) {
    const cdiPath = resolveInside(baseDir, refs.DisplayInfo);
    if (cdiPath) {
      try {
        const cdi = JSON.parse(await fs.readFile(cdiPath, "utf8"));
        for (const p of Array.isArray(cdi.Parameters) ? cdi.Parameters : []) {
          const id = String((p && p.Id) || "").trim();
          if (id && !params.includes(id)) params.push(id);
        }
        paramsKnown = params.length > 0;
      } catch {
        warnings.push("cdi3 (DisplayInfo) could not be parsed; parameter ids are unknown");
      }
    }
  }
  for (const g of Array.isArray(json.Groups) ? json.Groups : []) {
    for (const id of Array.isArray(g && g.Ids) ? g.Ids : []) {
      const s = String(id || "").trim();
      if (s && !params.includes(s)) params.push(s);
    }
  }

  const textures = Array.isArray(refs.Textures) ? refs.Textures.filter((t) => typeof t === "string") : [];
  let maxSide = 0;
  for (const tex of textures) {
    const texPath = resolveInside(baseDir, tex);
    if (!texPath) continue;
    const size = await readImageSize(texPath);
    if (size) maxSide = Math.max(maxSide, size.width, size.height);
  }
  if (maxSide > MAX_TEXTURE_SIDE) warnings.push(`texture larger than ${MAX_TEXTURE_SIDE}px (${maxSide}); mobile GPUs may fail to load it`);
  if (textures.length > 4) warnings.push(`${textures.length} textures; more than 4 slows down mobile loading`);
  if (!motionGroups.some((g) => /idle/i.test(g))) warnings.push("no Idle motion group; the runtime will only breathe");

  const hasPhysics = typeof refs.Physics === "string" && refs.Physics.length > 0;
  const hasPose = typeof refs.Pose === "string" && refs.Pose.length > 0;
  const badges = [];
  if (motionCount > 0) badges.push("motions");
  if (expressions.length > 0) badges.push("expressions");
  if (hitAreas.length > 0) badges.push("touch");
  if (hasPhysics) badges.push("physics");

  return {
    capabilities: {
      motionGroups,
      motionCount,
      expressions,
      hitAreas,
      params: params.slice(0, 2000),
      paramsKnown,
      hasPhysics,
      hasPose,
      textures: { count: textures.length, maxSide },
      badges,
    },
    warnings,
  };
}

/** 在候选名里找与 wanted（loose 键）相等的那个原名；找不到 → "" */
function findLoose(names, wanted) {
  const key = loose(wanted);
  return names.find((n) => loose(n) === key) || "";
}
/**
 * 按关键词找候选（loose 比较：大小写 / 下划线无关）：先找完全相等的，再找名字里包含关键词的；找不到 → ""。
 * exactOnly = true 时只做相等匹配（触摸区的 Tap@Head 之类是约定好的全名，"tap" 做包含匹配会把 Tap@Head 误判成 Body 的）。
 */
function findByKeywords(names, keywords, { exactOnly = false } = {}) {
  const keys = keywords.map(loose);
  for (const kw of keys) {
    const hit = names.find((n) => loose(n) === kw);
    if (hit) return hit;
  }
  if (exactOnly) return "";
  for (const kw of keys) {
    const hit = names.find((n) => loose(n).includes(kw));
    if (hit) return hit;
  }
  return "";
}

/**
 * 按能力档案给出一份自动映射；对不上的槽位为 null。
 * @param {object} caps extractCapabilities 的 capabilities（可为 null：老数据没提取过 → 全部默认）
 */
function suggestMapping(caps) {
  const c = caps && typeof caps === "object" ? caps : {};
  const groups = Array.isArray(c.motionGroups) ? c.motionGroups : [];
  const exps = Array.isArray(c.expressions) ? c.expressions : [];
  const hits = Array.isArray(c.hitAreas) ? c.hitAreas : [];
  const params = Array.isArray(c.params) ? c.params : [];

  const idle = findLoose(groups, "Idle") || findByKeywords(groups, ["idle"]) || null;
  const start = findLoose(groups, "Start") || findByKeywords(groups, ["start", "intro", "appear"]) || null;

  const actions = {};
  for (const slot of ACTION_SLOTS) {
    actions[slot] = findLoose(groups, OFFICIAL_ACTION_GROUPS[slot]) || findByKeywords(groups, ACTION_KEYWORDS[slot]) || null;
  }

  const faces = {};
  for (const face of FACES) {
    const hit = findByKeywords(exps, FACE_ALIASES[face]);
    faces[face] = hit ? { expression: hit } : null;
  }

  const touch = {};
  for (const area of TOUCH_AREAS) {
    const areaHits = hits.filter((h) => TOUCH_ALIASES[area].includes(loose(h)));
    const motion = findByKeywords(groups, TOUCH_MOTION_CANDIDATES(area), { exactOnly: true }) || null;
    touch[area] = areaHits.length || motion ? { hitAreas: areaHits, motion } : null;
  }

  const paramMap = {};
  for (const [slot, standardId] of Object.entries(PARAM_SLOTS)) {
    if (!params.length) {
      paramMap[slot] = standardId; // 没有 cdi3：假定标准 id（Cubism 对不存在的参数忽略，无害）
      continue;
    }
    paramMap[slot] = findLoose(params, standardId) || null;
  }

  return { version: 1, idle, start, actions, faces, touch, params: paramMap, fit: { heightRatio: 1.2, xBias: 0.5 } };
}

/** 向导用的完成度：必须项 / 推荐项各有几项对上了 */
function completenessOf(mapping, caps) {
  const m = mapping || {};
  const paramsKnown = !!(caps && caps.paramsKnown);
  const required = REQUIRED_PARAM_SLOTS.map((slot) => ({ slot, ok: paramsKnown ? !!(m.params && m.params[slot]) : null }));
  const recommended = [
    { slot: "idle", ok: !!m.idle },
    ...ACTION_SLOTS.map((a) => ({ slot: `action:${a}`, ok: !!(m.actions && m.actions[a]) })),
    ...FACES.map((f) => ({ slot: `face:${f}`, ok: !!(m.faces && m.faces[f]) })),
    ...TOUCH_AREAS.map((t) => ({ slot: `touch:${t}`, ok: !!(m.touch && m.touch[t]) })),
  ];
  return { required, recommended, recommendedDone: recommended.filter((r) => r.ok).length, recommendedTotal: recommended.length };
}

const nameStr = z.string().trim().min(1).max(120);
const faceEntry = z
  .object({
    expression: nameStr.optional(),
    params: z.record(z.string().trim().min(1).max(64), z.number().min(-100).max(100)).optional(),
  })
  .nullable();
const touchEntry = z
  .object({
    hitAreas: z.array(nameStr).max(8).optional().default([]),
    motion: nameStr.nullable().optional().default(null),
  })
  .nullable();
const mappingSchema = z.object({
  version: z.literal(1).optional().default(1),
  idle: nameStr.nullable().optional().default(null),
  start: nameStr.nullable().optional().default(null),
  actions: z.record(z.string().max(40), nameStr.nullable()).optional().default({}),
  faces: z.record(z.string().max(40), faceEntry).optional().default({}),
  touch: z.record(z.string().max(40), touchEntry).optional().default({}),
  params: z.record(z.string().max(40), z.string().trim().min(1).max(64).nullable()).optional().default({}),
  fit: z
    .object({
      heightRatio: z.number().min(0.3).max(3).optional().default(1.2),
      xBias: z.number().min(0).max(1).optional().default(0.5),
    })
    .optional()
    .default({ heightRatio: 1.2, xBias: 0.5 }),
});

/**
 * 校验用户提交的映射：形状（zod）+ 槽位名只能是我们认识的 + 引用的动作组 / 表情 / 命中区必须真的在包里。
 * 参数 id 只在 paramsKnown 时校验，且只给 warning（Cubism 对不存在的参数忽略）。
 * 不合法 → 400；合法 → 归一化后的映射（所有槽位都有键、对不上的为 null）。
 */
function validateMapping(raw, caps) {
  const parsed = mappingSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    badRequest(`companion mapping is invalid: ${first ? `${first.path.join(".")} ${first.message}` : "bad shape"}`);
  }
  const m = parsed.data;
  const c = caps && typeof caps === "object" ? caps : {};
  const groups = new Set((c.motionGroups || []).map(String));
  const exps = new Set((c.expressions || []).map(String));
  const hits = new Set((c.hitAreas || []).map(String));
  const params = new Set((c.params || []).map(String));
  const warnings = [];
  const needGroup = (name, where) => {
    if (name && groups.size && !groups.has(name)) badRequest(`companion mapping: ${where} refers to motion group "${name}" which is not in the bundle`);
  };
  const unknown = (keys, allowed, where) => {
    const bad = keys.filter((k) => !allowed.includes(k));
    if (bad.length) badRequest(`companion mapping: unknown ${where} slot "${bad[0]}"`);
  };
  unknown(Object.keys(m.actions), ACTION_SLOTS, "action");
  unknown(Object.keys(m.faces), FACES, "face");
  unknown(Object.keys(m.touch), TOUCH_AREAS, "touch");
  unknown(Object.keys(m.params), Object.keys(PARAM_SLOTS), "param");

  needGroup(m.idle, "idle");
  needGroup(m.start, "start");
  const actions = {};
  for (const slot of ACTION_SLOTS) {
    const g = m.actions[slot] || null;
    needGroup(g, `actions.${slot}`);
    actions[slot] = g;
  }
  const faces = {};
  for (const face of FACES) {
    const entry = m.faces[face] || null;
    if (entry && entry.expression && exps.size && !exps.has(entry.expression)) {
      badRequest(`companion mapping: faces.${face} refers to expression "${entry.expression}" which is not in the bundle`);
    }
    if (entry && !entry.expression && !(entry.params && Object.keys(entry.params).length)) {
      faces[face] = null;
      continue;
    }
    faces[face] = entry ? { ...(entry.expression ? { expression: entry.expression } : {}), ...(entry.params ? { params: entry.params } : {}) } : null;
  }
  const touch = {};
  for (const area of TOUCH_AREAS) {
    const entry = m.touch[area] || null;
    if (entry) {
      for (const h of entry.hitAreas) {
        if (hits.size && !hits.has(h)) badRequest(`companion mapping: touch.${area} refers to hit area "${h}" which is not in the bundle`);
      }
      needGroup(entry.motion, `touch.${area}`);
    }
    touch[area] = entry && (entry.hitAreas.length || entry.motion) ? { hitAreas: entry.hitAreas, motion: entry.motion } : null;
  }
  const paramMap = {};
  for (const slot of Object.keys(PARAM_SLOTS)) {
    const id = Object.prototype.hasOwnProperty.call(m.params, slot) ? m.params[slot] : PARAM_SLOTS[slot];
    if (id && c.paramsKnown && params.size && !params.has(id)) warnings.push(`params.${slot}: "${id}" is not listed in cdi3; the runtime will ignore it`);
    paramMap[slot] = id || null;
  }
  return {
    mapping: { version: 1, idle: m.idle, start: m.start, actions, faces, touch, params: paramMap, fit: m.fit },
    warnings,
  };
}

module.exports = {
  TOUCH_AREAS,
  PARAM_SLOTS,
  REQUIRED_PARAM_SLOTS,
  ACTION_SLOTS,
  MAX_TEXTURE_SIDE,
  imageSizeFromBuffer,
  readImageSize,
  extractCapabilities,
  suggestMapping,
  validateMapping,
  completenessOf,
};
