"use strict";
/**
 * 对局 UGC 的**举报靶子**（2026-11-24）：`user`（玩家本人）与 `game-entry`（回合投稿）。
 *
 * 工坊对局里会产生两类用户内容，而它们在举报那边都没有可递的 id：
 *   · 玩家本人（昵称 / 头像 / 局内行为）—— users 里当然有 _id，但举报以前不认这个类型；
 *   · 一回合的一条投稿（提示词 + 生成的影片 + 卡名）—— `rounds[].entries[]` 以前**没有 id**
 *     （子文档 `_id: false`，重复提交是整条覆盖）。所以 2026-11-24 给投稿加了稳定
 *     `entryId`（models/GameRoom.js 的 roundEntrySchema），这个文件是它唯一的解引用处。
 *
 * ★★ 为什么单开一个 service 而不是写进 report.controller：
 *   「靶子存不存在」与「受理时该落哪些上下文」是**同一个判据的两半** —— 受理（createReport）
 *   要按 entryId 找投稿并抄 roomCode / round / offenderUserId / prompt / videoUrl；
 *   管理端列队（resolveTargets）要按同一批 id 现查同一批字段。两处各写一遍的话，
 *   一边认 targetId、一边认 userId，就会出现"管理员打开报的是另一条投稿"，
 *   而且两边都不报错。这里一处给两种调用方（单条解析 / 批量现查）。
 *
 * ★ 上下文**只从服务端自己的库里取**，不接受请求体里的任何一份：Report 模型刻意不存
 *   用户递来的快照（models/Report.js 的 ★），这里存的是"我们在受理那一刻看到的那条投稿"。
 *   管理端显示时仍然**优先现查**（`target`），`targetContext` 只在靶子已经没了时兜底
 *   （房间过期懒清理会把整份回合数据一起删掉，见 GameRoom 文件头）。
 */
const mongoose = require("mongoose");
const GameRoom = require("../models/GameRoom");
const User = require("../models/User");
const { sameId } = require("./gameRoom.service");

/** 管理端要看的用户字段（与 report.controller 的 USER_FIELDS 同口径） */
const USER_FIELDS = "_id username displayName avatarUrl";

/**
 * 走本文件这套判据的两种 targetType（2026-11-24）。
 * ★ 只有这两类：受理时**校验靶子存在**（404 TARGET_NOT_FOUND）并落 `targetContext`。
 *   其余四种刻意不校验（见下面 resolveGameReportTarget 的 ★）。
 */
const GAME_REPORT_TARGET_TYPES = ["user", "game-entry"];

/**
 * 冗余上下文里 `prompt` 的**截断**长度（码点）。
 * ★ 截断不是偷懒：投稿提示词本身就 ≤ 80 字（config/gameRound.PROMPT_MAX），这里留到 200
 *   是为了"以后提示词上限涨了也不会把一整篇抄进举报表"，正常投稿一个字都不会被切。
 *   完整正文由管理端按 targetId 现查；靶子没了时这 200 字就是唯一能看的现场。
 */
const PROMPT_SNAPSHOT_MAX = 200;

/** 按码点截断（与提示词校验同一个计数口径：生僻字 / 表情不该被 UTF-16 算成两个） */
function truncate(text, max) {
  const chars = Array.from(String(text === null || text === undefined ? "" : text));
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("");
}

/** 在一条房间文档里按 entryId 找投稿（找到返回 {room, round, entry}） */
function findEntryInRoom(room, entryId) {
  for (const round of room.rounds || []) {
    const entry = (round.entries || []).find((row) => row.entryId && sameId(row.entryId, entryId));
    if (entry) return { room, round, entry };
  }
  return null;
}

/**
 * 按 entryId 找一条**现在还在某个房间文档里**的回合投稿。
 * @returns {Promise<{room: object, round: object, entry: object}|null>} null = 找不到
 *   （id 非法 / 房间已过期被懒清理 / 从没有过这条投稿 —— 三种对举报来说都是"靶子不存在"）
 */
async function findGameEntry(entryId) {
  if (!mongoose.isValidObjectId(entryId)) return null;
  const oid = new mongoose.Types.ObjectId(String(entryId));
  // ★ 只按 entryId 查（`rounds.entries.entryId` 上有索引），不先猜房号：
  //   game-entry 的请求体里**没有**房号，也从客户端收（那是外部输入，见 report.routes 的 strip 注释）。
  const room = await GameRoom.findOne({ "rounds.entries.entryId": oid }).select("code rounds").lean();
  if (!room) return null;
  return findEntryInRoom(room, oid);
}

/**
 * `game-entry` 受理时要落的冗余上下文（与 Report.targetContext 的字段一一对应，
 * 契约见 docs/api-contract.md「举报 · 对局里的两类对象」）。
 */
function gameEntryContextOf({ room, round, entry }) {
  return {
    offenderUserId: entry.userId,
    roomCode: room.code || "",
    round: round.round,
    entryId: entry.entryId,
    prompt: truncate(entry.prompt, PROMPT_SNAPSHOT_MAX),
    videoUrl: entry.videoUrl || "",
  };
}

/**
 * **这两类**靶子的存在性 + 受理时要落的上下文。
 *
 * ★ 只给 `user` / `game-entry` 用。其它四种（video / comment / danmaku / persona）刻意**不**校验存在：
 *   那条端点的历史口径是"举报天然是'我刚才看到了这个东西'"，校验存在会把举报接口变成
 *   探测私密作品 / 可见性的旁路（controllers/report.controller.createReport 头上那段 ★★）。
 *   这两类为什么反过来必须校验：靶子是一枚裸 ObjectId，没有自己的可见性规则可抄；
 *   而"串号报警"在这里的代价是**多出一步落库**（game-entry 的冗余上下文），查不到就没得落。
 *
 * @returns {Promise<{context: object}|null>} null = 靶子不存在 → 调用方回 404 TARGET_NOT_FOUND
 */
async function resolveGameReportTarget(targetType, targetId) {
  if (targetType === "user") {
    const user = await User.findById(targetId).select("_id").lean();
    if (!user) return null;
    return { context: { offenderUserId: user._id } };
  }
  if (targetType === "game-entry") {
    const hit = await findGameEntry(targetId);
    if (!hit) return null;
    return { context: gameEntryContextOf(hit) };
  }
  // 内部不变量：controller 只在这两类上调它。写到别的类型上是调用方写错了，
  // 别静默当成"靶子不存在"（那会表现为一条莫名其妙的 404，而真正的 bug 没人查）。
  throw new Error(`resolveGameReportTarget: unsupported targetType ${String(targetType)}`);
}

/** 批量取用户名（管理端现查 game-entry 时把投稿人 id 拼成人话） */
async function usernamesOf(ids) {
  const uniq = [...new Set(ids.map((id) => String(id)))];
  if (!uniq.length) return new Map();
  const users = await User.find({ _id: { $in: uniq } }).select("_id username").lean();
  return new Map(users.map((user) => [String(user._id), user.username || null]));
}

/**
 * 管理端批量现查 `user` 靶子（一页 20 条只查一次，不逐条查）。
 * @param {any[]} ids 用户 _id（字符串或 ObjectId）
 * @returns {Promise<Map<string, object>>} key = String(_id)
 */
async function targetPayloadsOfUsers(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const users = await User.find({ _id: { $in: ids } })
    .select(`${USER_FIELDS} banned deactivatedAt createdAt`)
    .lean();
  for (const user of users) {
    out.set(String(user._id), {
      exists: true,
      userId: String(user._id),
      username: user.username || "",
      displayName: user.displayName || "",
      avatarUrl: user.avatarUrl || "",
      // 「这个人已经被处理过了没有」是复核最想先看到的一格。★ 判据照 User.model 的写法：
      //   看 `banned.at` 在不在，不是看有没有 banned 这个键（见那个字段头上的 ★）。
      banned: !!(user.banned && user.banned.at),
      deactivated: !!user.deactivatedAt,
      createdAt: user.createdAt,
    });
  }
  return out;
}

/**
 * 管理端批量现查 `game-entry` 靶子。
 * ★ 房间过期被懒清理之后这里自然查不到 → 调用方给 `{ exists: false }`，
 *   而举报行上的 `targetContext` 仍然答得出当时报的是哪条投稿（见文件头 ★）。
 * @param {any[]} ids 投稿 entryId
 * @returns {Promise<Map<string, object>>} key = String(entryId)
 */
async function targetPayloadsOfGameEntries(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const wanted = new Set(ids.map((id) => String(id)));
  const rooms = await GameRoom.find({ "rounds.entries.entryId": { $in: ids } }).select("code rounds").lean();

  const hits = [];
  for (const room of rooms) {
    for (const round of room.rounds || []) {
      for (const entry of round.entries || []) {
        if (!entry.entryId || !wanted.has(String(entry.entryId))) continue;
        hits.push({ room, round, entry });
      }
    }
  }
  const names = await usernamesOf(hits.map((hit) => hit.entry.userId));
  for (const { room, round, entry } of hits) {
    const userId = String(entry.userId);
    out.set(String(entry.entryId), {
      exists: true,
      entryId: String(entry.entryId),
      roomCode: room.code || "",
      round: round.round,
      userId,
      username: names.get(userId) || null,
      // 现查给**完整**正文（冗余上下文里那份是截断的，见 PROMPT_SNAPSHOT_MAX）
      prompt: entry.prompt || "",
      cardNames: (entry.cardNames || []).slice(),
      videoUrl: entry.videoUrl === undefined ? null : entry.videoUrl,
      posterUrl: entry.posterUrl === undefined ? null : entry.posterUrl,
      placeholder: Boolean(entry.placeholder),
      submittedAt: entry.submittedAt || null,
    });
  }
  return out;
}

module.exports = {
  PROMPT_SNAPSHOT_MAX,
  GAME_REPORT_TARGET_TYPES,
  findGameEntry,
  resolveGameReportTarget,
  targetPayloadsOfUsers,
  targetPayloadsOfGameEntries,
};
