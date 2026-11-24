/**
 * @file gameRound.service.js - 「工坊对局」的**回合引擎**（交片 / 展映 / 点赞 / 投票 / 结算 / 下一回合）
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节与 docs/api-contract.md
 *
 * 设计正本在 app 仓：`docs/workshop-game-design.md` §2.0 / §2.5、`docs/game-rules-engine.md`
 * §5-8、`src/studio/game/rules.ts`（`damageForRank` / `tallyRound` / `settleRound`）。
 * HTTP 轮询版（与 gameRoom.service 同一套）：客户端每 2~5 秒读一次 `GET .../rounds/current`。
 *
 * | 方法 | 干什么 |
 * |---|---|
 * | `startRound`   | 建第 1 回合（**仅房主**，`playing`，还没有任何回合）→ `creating` |
 * | `submitEntry`  | 我这一回合的交片（**一人一条，重复交覆盖**；只在 `creating`） |
 * | `getCurrent`   | 当前回合快照（显映 / 投票屏轮询它；成员读一次续一次命） |
 * | `setPhase`     | 房主推进 `screening` / `voting`（`screening` 要全员已交片） |
 * | `likeEntry`    | 点赞（只在 `screening`；一人一条一次；不能给自己；**幂等**） |
 * | `voteEntry`    | 投票（只在 `voting`；不能给自己；`null` = 弃权；一人一次，**幂等**） |
 * | `settle`       | 两个榜 + 综合名次 + 扣血 + 淘汰 + 胜者（房主，或全员已投票时任何成员） |
 * | `getRoundEvent` / `chooseRoundEvent` | 第 2/4/6 回合结算后的三选一（服务端出题、跨端一致；只有 hp 由服务端落） |
 * | `nextRound`    | 回合 +1、回到 `creating`（**仅房主**；保留历史；只剩胜者名额时把房间落成 `over` + `GAME_OVER`） |
 *
 * ══ ★★ 数据放在房间文档的 `rounds[]`（models/GameRoom 文件头有完整取舍） ════════════════
 *   一桌最多 8 人、一回合最多 8 条作品，文档远小于 16MB；而点赞 / 投票的「一人一次」要**原子判定**，
 *   同一份文档里的条件更新就是那把锁。删房间（过期懒清理）= 回合数据一起没，没有第二张表要级联。
 *
 * ══ ★★ 为什么点赞 / 投票的状态存在**回合**上，而不是每条作品上 ═══════════════════════════
 *   判据是「这个人这一回合点过没有」（每人一条一次），存在作品上就要跨 8 条作品做一次 `$not/$elemMatch`
 *   的否定判断 —— 条件更新写不出来，只能先查后写（并发下同一个人点两次 = 两条）。存在回合上之后：
 *
 *     { "rounds": { $elemMatch: { round: n, phase: "screening", "likes.userId": { $ne: uid } } } }
 *
 *   把「回合对」「阶段对」「这个人还没点过」放进**同一个**原子更新的条件里，第二次请求匹配不上，
 *   然后走幂等分支把当前快照照原样回给客户端（双击 / 重试都不涨计数）。
 *   `votes` 同理；弃权也是一行（`targetUserId: null`），否则「全员已投票」永远凑不齐。
 *
 * ══ ★★ 扣血公式与 App 逐字一致（config/gameRound.damageForRank 一处实现） ════════════════
 *   `damage = max(5, floor(base × 人数 / 4 / 5) × 5)`，`base = [20,15,10]` 按「离最后一名多远」取、
 *   其余 5。App 的 `damageForRank` 同式；2 / 3 / 4 / 8 人的结果钉在 tests/gameRound.spec.js 里。
 *   名次用**竞赛排名**（并列同名次：2,2,1 → 1,1,3），综合名次 = 两个榜名次相加、综合相同看投票榜，
 *   再相同按票数、点赞数、userId 定序（App `tallyRound` 同一套）—— 扣血需要一个确定的最后一名，
 *   并列会让 -20 没有唯一解。
 *
 * ══ ★ 错误为什么是「返回对象」而不是抛 AppError ═════════════════════════════════════════
 *   与 gameRoom.service 同一条：失败自带 `status`（HTTP 码）与结构化字段（`phase` / `waitingOn` /
 *   `votesPending` / `winners`），路由只把 `{ok:false, status, ...rest}` 照原样回出去。
 */
const mongoose = require("mongoose");
const GameRoom = require("../models/GameRoom");
const User = require("../models/User");
const gameRoom = require("./gameRoom.service");
const roomConfig = require("../config/gameRoom");
const config = require("../config/gameRound");
// 回合间事件（第 2/4/6 回合结算后的三选一）：事件表 / 确定性抽选 / GAME_EVENTS_API 开关都在这里
const eventConfig = require("../config/gameEvent");

const { sameId } = gameRoom;

function fail(code, status, message, extra = {}) {
  return { ok: false, code, status, message, ...extra };
}

function atOf(now) {
  return new Date(now);
}

function oidOf(value) {
  return new mongoose.Types.ObjectId(String(value));
}

/** 这一回合里某个人的作品（没有回 null）。★ 按 userId 认，不按数组下标 */
function entryOf(round, userId) {
  return (round?.entries || []).find((entry) => sameId(entry.userId, userId)) || null;
}

function hasLiked(round, userId) {
  return (round?.likes || []).some((like) => sameId(like.userId, userId));
}

function hasVoted(round, userId) {
  return (round?.votes || []).some((vote) => sameId(vote.userId, userId));
}

/** 当前回合 = 数组最后一条（model 文件头：不另存指针，避免两份真相） */
function currentRoundOf(room) {
  const rounds = room?.rounds || [];
  return rounds.length ? rounds[rounds.length - 1] : null;
}

function memberOf(room, userId) {
  return (room?.members || []).find((member) => sameId(member.userId, userId)) || null;
}

/** 血量：老房间没有这一位时按 START_HP（与房间快照的兜底同一处口径） */
function hpOf(member) {
  return Number.isFinite(member?.hp) ? member.hp : config.START_HP;
}

function aliveMembersOf(room) {
  return (room?.members || []).filter((member) => hpOf(member) > 0);
}

/** 座位表：userId → 成员数组下标（座位 = 加入顺序，见 models/GameRoom 文件头）。快照与历史回合同一份 */
function seatIndexOf(room) {
  return new Map((room?.members || []).map((member, index) => [String(member.userId), index]));
}

/**
 * 一回合的投稿按**座位**排（房间快照与历史回合**同一串**）。
 * ★ 不在座上的（中途退房的人）排最后、同座按 userId 定序 —— 顺序必须是确定的，
 *   否则同一个回合在两屏之间会悄悄换顺序。
 */
function orderedEntriesOf(round, seatIndex) {
  return (round?.entries || []).slice().sort((a, b) => {
    const sa = seatIndex.has(String(a.userId)) ? seatIndex.get(String(a.userId)) : Number.MAX_SAFE_INTEGER;
    const sb = seatIndex.has(String(b.userId)) ? seatIndex.get(String(b.userId)) : Number.MAX_SAFE_INTEGER;
    return sa - sb || String(a.userId).localeCompare(String(b.userId));
  });
}

/**
 * 一回合的两个计数（`targetUserId → 收到几个`）。
 * ★ 弃权行（`targetUserId: null`）**不计给任何人** —— 投票留弃权行是为了凑齐「全员表态」，
 *   不是一张给某人的票。快照 / 结算 / 历史回合三处共用这一份（铁律六）。
 */
function countsOf(items) {
  const counts = new Map();
  for (const item of items || []) {
    if (item.targetUserId === null || item.targetUserId === undefined) continue;
    const key = String(item.targetUserId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * 这局结束了没有 + 胜者是谁（**唯一判据**，settle 与 next 都问它）。
 * ★ 4/8 人局剩 ≤2 人结束、2 人局剩 1 人结束 —— 理由见 config/gameRound.winnerTargetOf。
 * ★ 0 人存活（同归于尽）= 结束了但胜者为空；调用方（next）回 `GAME_OVER` + `winners: []`。
 */
function gameOverOf(room) {
  const alive = aliveMembersOf(room);
  const target = config.winnerTargetOf(room?.members?.length);
  if (alive.length > target) return { over: false, winners: [] };
  const winners = alive
    .slice()
    .sort((a, b) => hpOf(b) - hpOf(a) || String(a.userId).localeCompare(String(b.userId)))
    .map((member) => String(member.userId));
  return { over: true, winners };
}

async function namesOf(ids) {
  const uniq = [...new Set(ids.map((id) => String(id)))];
  if (!uniq.length) return new Map();
  const users = await User.find({ _id: { $in: uniq } }).select("_id username").lean();
  return new Map(users.map((user) => [String(user._id), user.username || null]));
}

/**
 * 当前回合快照（**唯一的对外形状**）。
 * ★ 点赞 / 投票只给**计数**与「我点没点 / 投没投」：谁投给谁是投票的秘密（契约写明不暴露）。
 * ★ `likesPending` / `votesPending` 是**还差几个人**（数字，不是名单）：App 的 `roundViewOf.pending`
 *   也是数字；名单会暴露「谁还没投」，虽然不算秘密，但界面只需要一句话。
 */
async function snapshotOf(room, round, { viewerId = null } = {}) {
  const alive = aliveMembersOf(room);
  const seatIndex = seatIndexOf(room);
  const entries = orderedEntriesOf(round, seatIndex);
  const names = await namesOf(entries.map((entry) => entry.userId));
  const likes = round?.likes || [];
  const votes = round?.votes || [];
  const likeCounts = countsOf(likes);
  const voteCounts = countsOf(votes);
  return {
    round: round?.round ?? null,
    phase: round?.phase ?? null,
    entries: entries.map((entry) => {
      const key = String(entry.userId);
      return {
        // ★ 举报 `game-entry` 的 targetId（App 拿它递 POST /api/branch/reports）。
        //   老房间的存量投稿没有这一格 → 如实回 null（重交一次就有），不要现编一个：
        //   编出来的 id 在库里不存在，举报会 404 TARGET_NOT_FOUND，比"这格是空的"更难查。
        entryId: entry.entryId ? String(entry.entryId) : null,
        userId: key,
        name: names.get(key) || null,
        prompt: entry.prompt,
        cardNames: (entry.cardNames || []).slice(),
        videoUrl: entry.videoUrl ?? null,
        posterUrl: entry.posterUrl ?? null,
        placeholder: Boolean(entry.placeholder),
        likes: likeCounts.get(key) || 0,
        likedByMe: Boolean(viewerId && likes.some((like) => sameId(like.userId, viewerId) && sameId(like.targetUserId, entry.userId))),
        votes: voteCounts.get(key) || 0,
        votedByMe: Boolean(viewerId && votes.some((vote) => sameId(vote.userId, viewerId) && vote.targetUserId && sameId(vote.targetUserId, entry.userId))),
      };
    }),
    allSubmitted: alive.every((member) => Boolean(entryOf(round, member.userId))),
    likesPending: alive.filter((member) => !hasLiked(round, member.userId)).length,
    votesPending: alive.filter((member) => !hasVoted(round, member.userId)).length,
  };
}

/**
 * 结算回包：把落库的 userId 现拼成 name（与房间快照同一条「只存 id」纪律）。
 * `names` 可选：历史回合一次读多份榜单时由调用方先查好（否则每个回合都要再查一次 User）。
 */
async function settlementOf(settlement, names = null) {
  if (!settlement) return null;
  const ranking = settlement.ranking || [];
  const nameMap = names || (await namesOf(ranking.map((row) => row.userId)));
  return {
    ranking: ranking.map((row) => ({
      userId: String(row.userId),
      name: nameMap.get(String(row.userId)) || null,
      likes: row.likes,
      votes: row.votes,
      likeRank: row.likeRank,
      voteRank: row.voteRank,
      composite: row.composite,
      damage: row.damage,
      hp: row.hp,
      eliminated: Boolean(row.eliminated),
    })),
    ...(settlement.winners?.length ? { winners: settlement.winners.map((id) => String(id)) } : {}),
  };
}

async function snapshotByRoom(room, viewerId) {
  return { ok: true, ...(await snapshotOf(room, currentRoundOf(room), { viewerId })) };
}

/** 收片字段的白名单解析（**唯一一处**：交片端点与未来「AI 陪玩代交」都走它） */
function entryInputOf(body = {}) {
  const promptRaw = body.prompt;
  if (typeof promptRaw !== "string") return fail("BAD_PROMPT", 400, "prompt must be a string");
  const prompt = promptRaw.trim();
  if (!prompt) return fail("BAD_PROMPT", 400, "prompt must not be empty");
  // 按码点数（与 App 的 promptLimitOf 同一个计数口径：生僻字 / 表情不该因为 UTF-16 记两个字就提前顶满）
  if (Array.from(prompt).length > config.PROMPT_MAX) {
    return fail("PROMPT_TOO_LONG", 400, `prompt must be at most ${config.PROMPT_MAX} characters`, { limit: config.PROMPT_MAX });
  }

  const cardsRaw = body.cardNames;
  let cardNames = [];
  if (cardsRaw !== undefined && cardsRaw !== null) {
    if (!Array.isArray(cardsRaw)) return fail("BAD_CARD_NAMES", 400, "cardNames must be an array of strings");
    if (cardsRaw.length > config.CARD_NAMES_MAX) {
      return fail("BAD_CARD_NAMES", 400, `cardNames must have at most ${config.CARD_NAMES_MAX} items`, {
        limit: config.CARD_NAMES_MAX,
      });
    }
    cardNames = cardsRaw.map((name) => {
      if (typeof name !== "string") return null;
      return name.trim();
    });
    if (cardNames.some((name) => name === null || name === "" || Array.from(name).length > config.CARD_NAME_MAX)) {
      return fail("BAD_CARD_NAMES", 400, `cardNames items must be 1~${config.CARD_NAME_MAX} characters`);
    }
  }

  const optionalText = (field, value, max) => {
    if (value === undefined || value === null || value === "") return { ok: true, value: null };
    if (typeof value !== "string") return fail("BAD_ENTRY_FIELD", 400, `${field} must be a string`, { field });
    const text = value.trim();
    if (!text) return { ok: true, value: null };
    if (Array.from(text).length > max) return fail("BAD_ENTRY_FIELD", 400, `${field} is too long`, { field, limit: max });
    return { ok: true, value: text };
  };

  const video = optionalText("videoUrl", body.videoUrl, config.URL_MAX);
  if (!video.ok) return video;
  const poster = optionalText("posterUrl", body.posterUrl, config.URL_MAX);
  if (!poster.ok) return poster;
  const tier = optionalText("modelTier", body.modelTier, config.MODEL_TIER_MAX);
  if (!tier.ok) return tier;

  let placeholder = false;
  if (body.placeholder !== undefined && body.placeholder !== null) {
    if (typeof body.placeholder !== "boolean") {
      return fail("BAD_ENTRY_FIELD", 400, "placeholder must be true or false", { field: "placeholder" });
    }
    placeholder = body.placeholder;
  }

  return {
    ok: true,
    value: {
      prompt,
      cardNames,
      videoUrl: video.value,
      posterUrl: poster.value,
      placeholder,
      modelTier: tier.value,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 开回合 / 交片 / 快照
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/game/rooms/:code/rounds/start —— **仅房主**
 *
 * 错误：403 `NOT_HOST` / 409 `ROOM_NOT_PLAYING`（房间还没开局）/ 409 `ROUND_ALREADY_STARTED`
 *      （已经有回合了：这是「开第 1 回合」，后面走 `/rounds/next`）。
 * ★ 原子条件 `rounds: { $size: 0 }`：两个人同时点「开始回合」只会建出一条。
 */
async function startRound({ userId, code, now = Date.now() }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const hostId = gameRoom.hostIdOf(room);
  if (!sameId(hostId, userId)) return fail("NOT_HOST", 403, "only the host can start the round", { hostId: hostId ? String(hostId) : null });
  if (!memberOf(room, userId)) return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  if (room.status !== "playing") {
    return fail("ROOM_NOT_PLAYING", 409, "the room has not started yet", { roomStatus: room.status });
  }
  if (currentRoundOf(room)) {
    return fail("ROUND_ALREADY_STARTED", 409, "a round already exists (use /rounds/next after settling)", {
      round: currentRoundOf(room).round,
    });
  }
  const at = atOf(now);
  const updated = await GameRoom.findOneAndUpdate(
    { _id: room._id, status: "playing", rounds: { $size: 0 } },
    {
      $push: {
        rounds: { round: 1, phase: "creating", startedAt: at, phaseChangedAt: at, entries: [], likes: [], votes: [], settlement: null },
      },
      $set: { lastSeenAt: at },
    },
    { returnDocument: "after" },
  );
  if (!updated) return fail("ROUND_ALREADY_STARTED", 409, "a round already exists (use /rounds/next after settling)");
  return snapshotByRoom(updated, userId);
}

/**
 * POST /api/game/rooms/:code/rounds/entries
 *
 * 一人一条，**重复提交覆盖**（`submittedAt` 刷新）。只在 `phase: "creating"`。
 * ★ 每条投稿有一个**稳定的** `entryId`（首次交片生成、覆盖不换）：举报 `game-entry` 认它，
 *   见下面 submitEntry 里的 ★★ 与 models/GameRoom.js 的 roundEntrySchema。
 * 错误：409 `NOT_IN_ROOM` / 409 `PLAYER_ELIMINATED` / 404 `ROUND_NOT_FOUND` / 409 `WRONG_PHASE` /
 *      400 `BAD_PROMPT` / `PROMPT_TOO_LONG` / `BAD_CARD_NAMES` / `BAD_ENTRY_FIELD`。
 *
 * ★★ 原子 upsert 的写法（同一用户并发交两次不会出现两条）：
 *   ① 先按「这一回合里已经有我的条目」做**替换**（arrayFilters，匹配不到时不写）；
 *   ② 没替换成就做**追加**，但条件里带 `entries.userId: { $ne: me }`；
 *   ③ 两个都没中 = 同一用户的另一发刚好在这两步之间插进来 → 回头再替换一次。
 *   两轮之后仍然没中，说明阶段被推进了，重新读一次按真实原因回话。
 */
async function submitEntry({ userId, code, body, now = Date.now() }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const member = memberOf(room, userId);
  if (!member) return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  if (hpOf(member) <= 0) return fail("PLAYER_ELIMINATED", 409, "eliminated players cannot submit entries");
  const round = currentRoundOf(room);
  if (!round) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  if (round.phase !== "creating") {
    return fail("WRONG_PHASE", 409, `entries are only accepted in creating (current phase: ${round.phase})`, {
      phase: round.phase,
      expected: "creating",
    });
  }
  const parsed = entryInputOf(body);
  if (!parsed.ok) return parsed;
  const n = round.round;
  /**
   * ★★ `entryId`：**首次交片生成、覆盖提交保持不变**（2026-11-24，举报 `game-entry` 的靶子，
   *   见 models/GameRoom.js 的 roundEntrySchema）。App 的举报键认的是这个 id，换一次
   *   就等于"同一条投稿被报两次、管理端打开两条"，而且零报错。
   *   这里**不读请求体**里的 entryId（entryInputOf 只挑白名单字段）：id 由服务端说了算。
   */
  const existing = entryOf(round, userId);
  const entryId = existing && existing.entryId ? existing.entryId : new mongoose.Types.ObjectId();
  const at = atOf(now);
  const doc = { entryId, userId: oidOf(userId), ...parsed.value, submittedAt: at };

  /**
   * 老房间的存量投稿（上线前交的片）没有 entryId：**先补上**，再走下面的覆盖写。
   * ★ 这次更新只写 entryId 一格，且条件要求"那一格还不存在" —— 并发两个请求同时补时，
   *   后到的那一个在同一个文档上重判，不会再写一遍（也不会把先到的 id 换掉）。
   */
  if (existing && !existing.entryId) {
    await GameRoom.updateOne(
      {
        _id: room._id,
        rounds: { $elemMatch: { round: n, "entries.userId": userId, "entries.entryId": { $exists: false } } },
      },
      { $set: { "rounds.$[r].entries.$[e].entryId": entryId } },
      { arrayFilters: [{ "r.round": n }, { "e.userId": oidOf(userId) }] },
    );
  }

  /**
   * 覆盖那一格写成**逐字段 $set**（并且**永远不写 entryId**），不是整条 `entries.$[e] = doc`。
   * ★ 整条替换会把 entryId 一起写成本次生成的那个 —— 而下面"替换扑空 → 追加扑空"的
   *   竞态分支里，本次的 existing 可能是空的（另一发刚把这条插进去），于是同一用户并发交两次
   *   会把已经发出去的 id 换掉。id 只在"新增"那一格里带（`doc.entryId`），覆盖这条路一个字都不碰它。
   */
  const replaceSet = {
    "rounds.$[r].entries.$[e].prompt": doc.prompt,
    "rounds.$[r].entries.$[e].cardNames": doc.cardNames,
    "rounds.$[r].entries.$[e].videoUrl": doc.videoUrl,
    "rounds.$[r].entries.$[e].posterUrl": doc.posterUrl,
    "rounds.$[r].entries.$[e].placeholder": doc.placeholder,
    "rounds.$[r].entries.$[e].modelTier": doc.modelTier,
    "rounds.$[r].entries.$[e].submittedAt": doc.submittedAt,
  };

  let updated = null;
  for (let attempt = 0; attempt < 2 && !updated; attempt += 1) {
    updated = await GameRoom.findOneAndUpdate(
      {
        _id: room._id,
        "members.userId": userId,
        rounds: { $elemMatch: { round: n, phase: "creating", "entries.userId": userId } },
      },
      { $set: { ...replaceSet, lastSeenAt: at } },
      { arrayFilters: [{ "r.round": n }, { "e.userId": oidOf(userId) }], returnDocument: "after" },
    );
    if (updated) break;
    updated = await GameRoom.findOneAndUpdate(
      {
        _id: room._id,
        "members.userId": userId,
        rounds: { $elemMatch: { round: n, phase: "creating", "entries.userId": { $ne: userId } } },
      },
      { $push: { "rounds.$[r].entries": doc }, $set: { lastSeenAt: at } },
      { arrayFilters: [{ "r.round": n }], returnDocument: "after" },
    );
  }
  if (!updated) {
    const fresh = await GameRoom.findById(room._id);
    if (!fresh) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
    const freshRound = currentRoundOf(fresh);
    if (!freshRound) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
    if (freshRound.phase !== "creating") {
      return fail("WRONG_PHASE", 409, `entries are only accepted in creating (current phase: ${freshRound.phase})`, {
        phase: freshRound.phase,
        expected: "creating",
      });
    }
    return fail("ENTRY_CONFLICT", 409, "could not write the entry, please retry");
  }
  return snapshotByRoom(updated, userId);
}

/**
 * GET /api/game/rooms/:code/rounds/current —— 当前回合快照（成员轮询它）
 * 错误：404 `ROOM_NOT_FOUND` / 409 `NOT_IN_ROOM` / 404 `ROUND_NOT_FOUND`（房间还没开始回合）。
 * ★ 只有成员读才续命（与房间快照同一条：路人看不该让一间没人管的房活着）。
 */
async function getCurrent({ userId, code, now = Date.now() }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  if (!memberOf(room, userId)) return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  await gameRoom.touch(room, now);
  const round = currentRoundOf(room);
  if (!round) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  return { ok: true, ...(await snapshotOf(room, round, { viewerId: userId })) };
}

/**
 * GET /api/game/rooms/:code/rounds/history —— 一局的历史回合 + 战绩（2026-11-24）
 *
 * 回包：`{ ok, room: { code, state, winners, finishedAt },
 *   rounds: [{ round, settled, entries: [{ entryId, userId, name, prompt, cardNames, videoUrl,
 *   posterUrl, placeholder, modelTier, likes, votes }], settlement? }],
 *   summary: { roundsPlayed, perPlayer: [{ userId, name, hp, wins, likesTotal, votesTotal, bestRound? }] } }`
 *
 * ★ 与 `rounds/current` 的分工：那边只回答「现在这一回合」（展映 / 投票屏轮询），这边回答
 *   「这一局从头到尾发生了什么」—— 战绩屏与每回合影片回放一次读全，不给客户端留拼装的口子。
 * ★ 返回**全部**回合（不是只返回已结算的）：正在打的那一回合也要能看（`settled: false`、没有
 *   `settlement`）。`settled` 的判据是 `settlement` 落没落库（settle 在同一次原子更新里写
 *   phase 与 settlement，两者等价）。**按 round 升序**（库里本来就是追加顺序，这里仍显式排序：
 *   对外形状不该依赖存储顺序）。
 * ★ 不翻页：一局最多 8 回合（App 单机口径），整份回包只有几十 KB。
 * ★ 权限：**只有房间成员能读**（403 `NOT_IN_ROOM`）。读接口用 403，回合写接口那条 409
 *   `NOT_IN_ROOM` 说的是「状态冲突」（先解决「你在这个房里吗」才能继续），两件事不要混。
 *   成员读一次也给房间续一次命（与 `rounds/current` 同一条：开着战绩屏的人也是在看着这间房）。
 * ★ 房间已过期被懒清理 → 404 `ROOM_NOT_FOUND`（回合数据内嵌在房间文档里，房间没了历史就没了）。
 *   ⚠ 把历史另存一份到独立集合（跨房间的持久战绩 / 回放）**本轮不做**，契约里写在「还没做」。
 *
 * 战绩口径（summary，与 App 战绩屏逐条同口径；改这里必须同步 docs/api-contract.md）：
 * · `roundsPlayed` = **已结算**回合数（正在打的那一回合不算；总量看 `rounds.length`）；
 * · `perPlayer` = **当前还在房里的人**，顺序与房间快照 `members[]`（座位）一致；`hp` 是成员
 *   当前血量（老房间缺这一位按 START_HP，与快照同一兜底）；
 * · `wins` = 该玩家在**已结算回合**里综合名次第一的次数（结算榜 `ranking[0]`：settle 已经按
 *   composite → voteRank → votes → likes → userId 排成不并列的一列）；
 * · `likesTotal` / `votesTotal` = **全部回合**（含正在打的）里以该玩家为对象的计数之和；
 *   弃权（`targetUserId: null`）不计给任何人；
 * · `bestRound` = 该玩家综合名次最好的一回合（结算榜位置最靠前；并列取较早的回合）。
 *   **一次结算都没进过榜的人没有这一格**（不是 null：「没打过」与「没记录」是两件事）。
 * ★ 中途退房的人：历史回合的 entries / settlement 里照样有他（那是落库的事实），但 `perPlayer`
 *   只列当前成员 —— 成员退房时房间文档里不会留他的 hp 快照，硬拼一行只能编一个数。
 */
async function getHistory({ userId, code, now = Date.now() }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  if (!memberOf(room, userId)) {
    return fail("NOT_IN_ROOM", 403, "only players in this room can read its round history", { roomCode: room.code });
  }
  await gameRoom.touch(room, now);

  const seatIndex = seatIndexOf(room);
  const rounds = (room.rounds || []).slice().sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0));

  // 名字一次查全（投稿的人 + 结算榜上的人 + 现在的成员）：一局最多 8 × 8 条，别逐回合查 User 表
  const ids = (room.members || []).map((member) => String(member.userId));
  for (const round of rounds) {
    for (const entry of round.entries || []) ids.push(String(entry.userId));
    for (const row of round.settlement?.ranking || []) ids.push(String(row.userId));
  }
  const names = await namesOf(ids);

  const likesTotal = new Map();
  const votesTotal = new Map();
  const wins = new Map();
  /** userId → { index, round }：结算榜里最好的名次位置与那一回合的号码（并列取较早的回合） */
  const bestRank = new Map();
  let roundsPlayed = 0;
  const roundPayloads = [];

  for (const round of rounds) {
    const likeCounts = countsOf(round.likes);
    const voteCounts = countsOf(round.votes);
    for (const [key, count] of likeCounts) likesTotal.set(key, (likesTotal.get(key) || 0) + count);
    for (const [key, count] of voteCounts) votesTotal.set(key, (votesTotal.get(key) || 0) + count);

    const settled = Boolean(round.settlement);
    let settlement = null;
    if (settled) {
      roundsPlayed += 1;
      settlement = await settlementOf(round.settlement, names);
      (round.settlement.ranking || []).forEach((row, index) => {
        const key = String(row.userId);
        if (index === 0) wins.set(key, (wins.get(key) || 0) + 1);
        const best = bestRank.get(key);
        if (!best || index < best.index || (index === best.index && round.round < best.round)) {
          bestRank.set(key, { index, round: round.round });
        }
      });
    }

    roundPayloads.push({
      round: round.round,
      settled,
      entries: orderedEntriesOf(round, seatIndex).map((entry) => {
        const key = String(entry.userId);
        return {
          // 老房间的存量投稿没有 entryId → 如实 null（与回合快照同一口径；重交一次就有）
          entryId: entry.entryId ? String(entry.entryId) : null,
          userId: key,
          name: names.get(key) || null,
          prompt: entry.prompt,
          cardNames: (entry.cardNames || []).slice(),
          videoUrl: entry.videoUrl ?? null,
          posterUrl: entry.posterUrl ?? null,
          placeholder: Boolean(entry.placeholder),
          modelTier: entry.modelTier ?? null,
          likes: likeCounts.get(key) || 0,
          votes: voteCounts.get(key) || 0,
        };
      }),
      // `settlement` 只在已结算的回合出现（形状里它是可选的，App 判 `settled` 即可）
      ...(settlement ? { settlement } : {}),
    });
  }

  const over = room.status === "over";
  return {
    ok: true,
    room: {
      code: room.code,
      state: gameRoom.stateOf(room),
      // 与房间快照同一套：没结束 winners / finishedAt 是 null；结束时空数组 = 平局
      winners: over ? (room.winners || []).map((id) => String(id)) : null,
      finishedAt: over ? gameRoom.isoOf(room.finishedAt) : null,
    },
    rounds: roundPayloads,
    summary: {
      roundsPlayed,
      perPlayer: (room.members || []).map((member) => {
        const key = String(member.userId);
        const best = bestRank.get(key);
        return {
          userId: key,
          name: names.get(key) || null,
          hp: hpOf(member),
          wins: wins.get(key) || 0,
          likesTotal: likesTotal.get(key) || 0,
          votesTotal: votesTotal.get(key) || 0,
          ...(best ? { bestRound: best.round } : {}),
        };
      }),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 阶段推进 / 点赞 / 投票
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/game/rooms/:code/rounds/phase —— **仅房主**，`{ phase: "screening" | "voting" }`
 *
 * · creating → screening：**全员已交片**（还差谁回 `waitingOn`），否则 409 `NOT_ALL_SUBMITTED`；
 * · screening → voting：不要求全员已点赞（房主可以提前进；客户端点赞是「看了才点」，
 *   等所有人把 8 条都看完再让房主点一下，屏幕前的人只会以为卡住了）；
 * · 同阶段重复调用 = 幂等回快照（双击不报错）。
 * 错误：403 `NOT_HOST` / 409 `NOT_IN_ROOM` / 404 `ROUND_NOT_FOUND` / 400 `BAD_PHASE` / 409 `WRONG_PHASE`。
 */
async function setPhase({ userId, code, phase, now = Date.now() }) {
  const nextPhase = String(phase ?? "").trim();
  if (nextPhase !== "screening" && nextPhase !== "voting") {
    return fail("BAD_PHASE", 400, "phase must be screening or voting", { phases: ["screening", "voting"] });
  }
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  if (!memberOf(room, userId)) return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  const hostId = gameRoom.hostIdOf(room);
  if (!sameId(hostId, userId)) {
    return fail("NOT_HOST", 403, "only the host can advance the phase", { hostId: hostId ? String(hostId) : null });
  }
  const round = currentRoundOf(room);
  if (!round) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  if (round.phase === nextPhase) return { ok: true, ...(await snapshotOf(room, round, { viewerId: userId })) };
  const at = atOf(now);

  if (nextPhase === "screening") {
    if (round.phase !== "creating") {
      return fail("WRONG_PHASE", 409, `cannot enter screening from ${round.phase}`, { phase: round.phase, expected: "creating" });
    }
    const alive = aliveMembersOf(room);
    const waitingOn = alive.filter((member) => !entryOf(round, member.userId)).map((member) => String(member.userId));
    if (waitingOn.length) {
      return fail("NOT_ALL_SUBMITTED", 409, "some players have not submitted their entry yet", {
        waitingOn,
        count: waitingOn.length,
        need: alive.length,
      });
    }
    const updated = await GameRoom.findOneAndUpdate(
      { _id: room._id, rounds: { $elemMatch: { round: round.round, phase: "creating" } } },
      { $set: { "rounds.$[r].phase": "screening", "rounds.$[r].phaseChangedAt": at, lastSeenAt: at } },
      { arrayFilters: [{ "r.round": round.round }], returnDocument: "after" },
    );
    if (!updated) return phaseConflict(room._id, userId, round.round, nextPhase);
    return snapshotByRoom(updated, userId);
  }

  if (round.phase !== "screening") {
    return fail("WRONG_PHASE", 409, `cannot enter voting from ${round.phase}`, { phase: round.phase, expected: "screening" });
  }
  const updated = await GameRoom.findOneAndUpdate(
    { _id: room._id, rounds: { $elemMatch: { round: round.round, phase: "screening" } } },
    { $set: { "rounds.$[r].phase": "voting", "rounds.$[r].phaseChangedAt": at, lastSeenAt: at } },
    { arrayFilters: [{ "r.round": round.round }], returnDocument: "after" },
  );
  if (!updated) return phaseConflict(room._id, userId, round.round, nextPhase);
  return snapshotByRoom(updated, userId);
}

/** 阶段更新的并发失败：重读一次，已经到目标阶段就幂等回快照，否则按真实阶段回 WRONG_PHASE */
async function phaseConflict(roomId, userId, roundNo, target) {
  const fresh = await GameRoom.findById(roomId);
  if (!fresh) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const round = currentRoundOf(fresh);
  if (round && round.round === roundNo && round.phase === target) {
    return { ok: true, ...(await snapshotOf(fresh, round, { viewerId: userId })) };
  }
  return fail("WRONG_PHASE", 409, "the phase changed concurrently, please refresh", {
    phase: round?.phase ?? null,
    expected: target,
  });
}

/**
 * POST /api/game/rooms/:code/rounds/like —— `{ targetUserId }`
 *
 * 只在 `screening`；**不能给自己**（400 `CANNOT_LIKE_SELF`）；一人一条一次、**不能取消**；
 * 重复 / 并发点赞是**幂等**的（回当前快照，计数不涨）。
 * 错误：409 `NOT_IN_ROOM` / 409 `PLAYER_ELIMINATED` / 404 `ROUND_NOT_FOUND` / 409 `WRONG_PHASE` /
 *      400 `BAD_TARGET` / 404 `TARGET_NOT_IN_ROOM` / 400 `CANNOT_LIKE_SELF`。
 */
async function likeEntry({ userId, code, targetId, now = Date.now() }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const member = memberOf(room, userId);
  if (!member) return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  if (hpOf(member) <= 0) return fail("PLAYER_ELIMINATED", 409, "eliminated players cannot like entries");
  const round = currentRoundOf(room);
  if (!round) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  if (round.phase !== "screening") {
    return fail("WRONG_PHASE", 409, `likes are only accepted in screening (current phase: ${round.phase})`, {
      phase: round.phase,
      expected: "screening",
    });
  }
  const target = String(targetId ?? "").trim();
  if (!mongoose.isValidObjectId(target)) return fail("BAD_TARGET", 400, "targetUserId must be a valid account id");
  if (sameId(target, userId)) return fail("CANNOT_LIKE_SELF", 400, "you cannot like your own entry");
  const targetMember = memberOf(room, target);
  if (!targetMember || hpOf(targetMember) <= 0) {
    return fail("TARGET_NOT_IN_ROOM", 404, "that player is not in this round", { roomCode: room.code });
  }
  if (hasLiked(round, userId)) return { ok: true, ...(await snapshotOf(room, round, { viewerId: userId })) };

  const at = atOf(now);
  const updated = await GameRoom.findOneAndUpdate(
    {
      _id: room._id,
      "members.userId": userId,
      rounds: { $elemMatch: { round: round.round, phase: "screening", "likes.userId": { $ne: userId } } },
    },
    {
      $push: { "rounds.$[r].likes": { userId: oidOf(userId), targetUserId: oidOf(target), at } },
      $set: { lastSeenAt: at },
    },
    { arrayFilters: [{ "r.round": round.round }], returnDocument: "after" },
  );
  if (updated) return snapshotByRoom(updated, userId);

  // 没中：可能是并发下的第二发（同一个人），也可能是阶段刚被推进。重读按真实原因回话。
  const fresh = await GameRoom.findById(room._id);
  if (!fresh) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const freshRound = currentRoundOf(fresh);
  if (!freshRound) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  if (freshRound.phase !== "screening") {
    return fail("WRONG_PHASE", 409, `likes are only accepted in screening (current phase: ${freshRound.phase})`, {
      phase: freshRound.phase,
      expected: "screening",
    });
  }
  if (hasLiked(freshRound, userId)) return { ok: true, ...(await snapshotOf(fresh, freshRound, { viewerId: userId })) };
  return fail("LIKE_CONFLICT", 409, "could not write the like, please retry");
}

/**
 * POST /api/game/rooms/:code/rounds/vote —— `{ targetUserId: string | null }`（null = 弃权）
 *
 * 只在 `voting`；**不能给自己**（400 `CANNOT_VOTE_SELF`）；一人一次，投过 / 弃过都算表过态，
 * 再投**幂等**回快照（第一票作数，不静默改票）。
 * 错误：409 `NOT_IN_ROOM` / 409 `PLAYER_ELIMINATED` / 404 `ROUND_NOT_FOUND` / 409 `WRONG_PHASE` /
 *      400 `BAD_TARGET` / 404 `TARGET_NOT_IN_ROOM` / 400 `CANNOT_VOTE_SELF`。
 */
async function voteEntry({ userId, code, body, now = Date.now() }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const member = memberOf(room, userId);
  if (!member) return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  if (hpOf(member) <= 0) return fail("PLAYER_ELIMINATED", 409, "eliminated players cannot vote");
  const round = currentRoundOf(room);
  if (!round) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  if (round.phase !== "voting") {
    return fail("WRONG_PHASE", 409, `votes are only accepted in voting (current phase: ${round.phase})`, {
      phase: round.phase,
      expected: "voting",
    });
  }
  if (!Object.prototype.hasOwnProperty.call(body || {}, "targetUserId")) {
    return fail("BAD_TARGET", 400, "targetUserId is required (send null to abstain)");
  }
  const raw = body.targetUserId;
  let target = null;
  if (raw !== null && raw !== undefined) {
    target = String(raw).trim();
    if (!mongoose.isValidObjectId(target)) return fail("BAD_TARGET", 400, "targetUserId must be a valid account id or null");
    if (sameId(target, userId)) return fail("CANNOT_VOTE_SELF", 400, "you cannot vote for your own entry");
    const targetMember = memberOf(room, target);
    if (!targetMember || hpOf(targetMember) <= 0) {
      return fail("TARGET_NOT_IN_ROOM", 404, "that player is not in this round", { roomCode: room.code });
    }
  }
  if (hasVoted(round, userId)) return { ok: true, ...(await snapshotOf(room, round, { viewerId: userId })) };

  const at = atOf(now);
  const updated = await GameRoom.findOneAndUpdate(
    {
      _id: room._id,
      "members.userId": userId,
      rounds: { $elemMatch: { round: round.round, phase: "voting", "votes.userId": { $ne: userId } } },
    },
    {
      $push: { "rounds.$[r].votes": { userId: oidOf(userId), targetUserId: target ? oidOf(target) : null, at } },
      $set: { lastSeenAt: at },
    },
    { arrayFilters: [{ "r.round": round.round }], returnDocument: "after" },
  );
  if (updated) return snapshotByRoom(updated, userId);

  const fresh = await GameRoom.findById(room._id);
  if (!fresh) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const freshRound = currentRoundOf(fresh);
  if (!freshRound) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  if (freshRound.phase !== "voting") {
    return fail("WRONG_PHASE", 409, `votes are only accepted in voting (current phase: ${freshRound.phase})`, {
      phase: freshRound.phase,
      expected: "voting",
    });
  }
  if (hasVoted(freshRound, userId)) return { ok: true, ...(await snapshotOf(fresh, freshRound, { viewerId: userId })) };
  return fail("VOTE_CONFLICT", 409, "could not write the vote, please retry");
}

// ─────────────────────────────────────────────────────────────────────
// 结算 / 下一回合
// ─────────────────────────────────────────────────────────────────────

/** 竞赛排名（2,2,1 → 1,1,3）：比自己的计数严格更大的有几个，名次 = 几 + 1。与 App tallyRound 同式 */
function competitionRank(counts, index) {
  return 1 + counts.filter((count) => count > counts[index]).length;
}

/**
 * POST /api/game/rooms/:code/rounds/settle
 *
 * 权限：**房主**随时（他在替整桌按「结算」）；**其他成员**只有在全员已投票（投过或弃权）时才能触发
 * （这就是「自动生效」：最后一个人投完，谁点结算都能落地）。
 * 错误：409 `NOT_IN_ROOM` / 404 `ROUND_NOT_FOUND` / 409 `WRONG_PHASE` / 403 `NOT_HOST`（未投完且非房主）/
 *      409 `NO_ENTRIES`。
 * ★ 幂等：已经 `settled` 就回**落库的同一份**结算（重复点击、自动触发与房主手点撞在一起都不重复扣血）。
 */
async function settle({ userId, code, now = Date.now() }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  if (!memberOf(room, userId)) return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  const round = currentRoundOf(room);
  if (!round) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  if (round.phase === "settled") {
    return { ok: true, round: round.round, phase: "settled", settlement: await settlementOf(round.settlement) };
  }
  if (round.phase !== "voting") {
    return fail("WRONG_PHASE", 409, `settle is only allowed in voting (current phase: ${round.phase})`, {
      phase: round.phase,
      expected: "voting",
    });
  }
  const hostId = gameRoom.hostIdOf(room);
  const isHost = sameId(hostId, userId);
  const alive = aliveMembersOf(room);
  const votesPending = alive.filter((member) => !hasVoted(round, member.userId)).map((member) => String(member.userId));
  if (!isHost && votesPending.length) {
    return fail("NOT_HOST", 403, "only the host can settle before everyone has voted", {
      hostId: hostId ? String(hostId) : null,
      votesPending: votesPending.length,
    });
  }

  // ── 参与结算的名单 = 存活且这一回合有作品的（`screening` 的全员交片闸已经保证通常就是这个集合）
  const aliveIds = new Set(alive.map((member) => String(member.userId)));
  const entries = (round.entries || []).filter((entry) => aliveIds.has(String(entry.userId)));
  if (!entries.length) return fail("NO_ENTRIES", 409, "there are no entries to settle");
  const playerCount = entries.length;
  const likeCounts = countsOf(round.likes);
  const voteCounts = countsOf(round.votes);
  const rows = entries.map((entry) => {
    const key = String(entry.userId);
    return { userId: key, likes: likeCounts.get(key) || 0, votes: voteCounts.get(key) || 0 };
  });
  const likeSeries = rows.map((row) => row.likes);
  const voteSeries = rows.map((row) => row.votes);
  rows.forEach((row, index) => {
    row.likeRank = competitionRank(likeSeries, index);
    row.voteRank = competitionRank(voteSeries, index);
    row.composite = row.likeRank + row.voteRank;
  });
  // 综合名次（不并列）：名次和 → 投票榜 → 票数 → 点赞数 → userId（与 App tallyRound 完全同序）
  rows.sort(
    (a, b) =>
      a.composite - b.composite ||
      a.voteRank - b.voteRank ||
      b.votes - a.votes ||
      b.likes - a.likes ||
      a.userId.localeCompare(b.userId),
  );
  const memberByUserId = new Map(alive.map((member) => [String(member.userId), member]));
  const ranking = rows.map((row, index) => {
    const rankFromLast = playerCount - 1 - index;
    const damage = config.damageForRank(playerCount, rankFromLast);
    const hpBefore = hpOf(memberByUserId.get(row.userId));
    const hp = Math.max(0, hpBefore - damage);
    return {
      userId: oidOf(row.userId),
      likes: row.likes,
      votes: row.votes,
      likeRank: row.likeRank,
      voteRank: row.voteRank,
      composite: row.composite,
      damage,
      hp,
      eliminated: hp === 0,
    };
  });
  const winners = (() => {
    const survivors = ranking.filter((row) => !row.eliminated);
    // 胜者名额按**开局人数**算（2 人局 1 名、4/8 人局 2 名；见 config.winnerTargetOf）。
    // ★ 顺序与 gameOverOf 一致（血多的在前，同血按 userId）：settle 回的 winners 与下一次 next
    //   的 GAME_OVER.winners 必须是同一串，否则客户端列表会在两屏之间悄悄换顺序。
    survivors.sort((a, b) => b.hp - a.hp || String(a.userId).localeCompare(String(b.userId)));
    return survivors.length > 0 && survivors.length <= config.winnerTargetOf(room.members.length)
      ? survivors.map((row) => row.userId)
      : [];
  })();
  const at = atOf(now);
  const settlementDoc = { ranking, winners, settledAt: at };

  // ★ 先写**绝对值**的 hp（不是 $inc）：两个结算请求撞在一起时，谁写都是同一个结果；
  //   再抢占 `voting → settled` 那一下作为「只结算一次」的闸。顺序反过来（先抢后写）也能跑，
  //   但抢到之后进程崩在写血之前，房间会停在「已结算但血没扣」—— 这里选择「血先落、标记后落」。
  await GameRoom.bulkWrite(
    ranking.map((row) => ({
      updateOne: {
        filter: { _id: room._id, "members.userId": row.userId },
        update: { $set: { "members.$.hp": row.hp } },
      },
    })),
    { ordered: false },
  );
  const updated = await GameRoom.findOneAndUpdate(
    { _id: room._id, rounds: { $elemMatch: { round: round.round, phase: "voting" } } },
    {
      $set: {
        "rounds.$[r].phase": "settled",
        "rounds.$[r].phaseChangedAt": at,
        "rounds.$[r].settledAt": at,
        "rounds.$[r].settlement": settlementDoc,
        lastSeenAt: at,
      },
    },
    { arrayFilters: [{ "r.round": round.round }], returnDocument: "after" },
  );
  if (!updated) {
    const fresh = await GameRoom.findById(room._id);
    if (!fresh) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
    const freshRound = currentRoundOf(fresh);
    if (freshRound?.phase === "settled") {
      return { ok: true, round: freshRound.round, phase: "settled", settlement: await settlementOf(freshRound.settlement) };
    }
    return fail("SETTLE_CONFLICT", 409, "the round changed concurrently, please refresh");
  }
  return { ok: true, round: round.round, phase: "settled", settlement: await settlementOf(settlementDoc) };
}

/**
 * POST /api/game/rooms/:code/rounds/next —— **仅房主**
 *
 * 回合 +1、`phase: "creating"`；上一回合的 entries / likes / votes / settlement **原样留着**（历史），
 * 新的这一回合三个数组从空开始（「清掉上一回合的 like/vote 状态」= 当前回合读的是新回合）。
 * 已到胜者名额（或全灭）→ 409 `GAME_OVER` + `winners`（数组，可能为空 = 平局）。
 * 错误：403 `NOT_HOST` / 409 `NOT_IN_ROOM` / 404 `ROUND_NOT_FOUND` / 409 `ROUND_NOT_SETTLED` / 409 `GAME_OVER`。
 */
async function nextRound({ userId, code, now = Date.now() }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  if (!memberOf(room, userId)) return fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code });
  const hostId = gameRoom.hostIdOf(room);
  if (!sameId(hostId, userId)) {
    return fail("NOT_HOST", 403, "only the host can start the next round", { hostId: hostId ? String(hostId) : null });
  }
  const round = currentRoundOf(room);
  if (!round) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  if (round.phase !== "settled") {
    return fail("ROUND_NOT_SETTLED", 409, "settle the current round before starting the next one", { phase: round.phase });
  }
  const over = gameOverOf(room);
  if (over.over) {
    // ★ 结束不只是「这次 next 的回包」：把 over / winners / finishedAt 落库，别人读快照也看得见。
    await markRoomOver(room, over.winners, now);
    return fail("GAME_OVER", 409, "the game is over", { winners: over.winners });
  }
  const at = atOf(now);
  const nextNo = round.round + 1;
  const updated = await GameRoom.findOneAndUpdate(
    {
      _id: room._id,
      status: "playing",
      rounds: { $elemMatch: { round: round.round, phase: "settled" } },
      // ★ 下一回合的号码必须还不存在：只看「第 n 回合已结算」的话，两个房主请求会同时匹配上，
      //   各 push 一条第 n+1 回合（一个是空的、一个带着内容，后面全乱）。`rounds.round: {$ne}` 是
      //   数组字段的「没有任何一条是这个号码」，与上面的 $elemMatch 一起构成这次 push 的并发闸。
      "rounds.round": { $ne: nextNo },
    },
    {
      $push: {
        rounds: {
          round: nextNo,
          phase: "creating",
          startedAt: at,
          phaseChangedAt: at,
          entries: [],
          likes: [],
          votes: [],
          settlement: null,
        },
      },
      $set: { lastSeenAt: at },
    },
    { returnDocument: "after" },
  );
  if (!updated) {
    const fresh = await GameRoom.findById(room._id);
    if (!fresh) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
    const freshOver = gameOverOf(fresh);
    if (freshOver.over) {
      await markRoomOver(fresh, freshOver.winners, now);
      return fail("GAME_OVER", 409, "the game is over", { winners: freshOver.winners });
    }
    return fail("ROUND_NOT_SETTLED", 409, "the round changed concurrently, please refresh");
  }
  return snapshotByRoom(updated, userId);
}

// ─────────────────────────────────────────────────────────────────────
// 回合间事件（第 2/4/6 回合结算之后、下一回合创建之前）
// ─────────────────────────────────────────────────────────────────────

/** 我在这一回合事件里的选择（没有回 null）。★ 一人一行、**第一选作数**（与 App 同一条） */
function eventPickOf(round, userId) {
  return (round?.eventPicks || []).find((pick) => sameId(pick.userId, userId)) || null;
}

/**
 * 事件视角的两个数：`myChoice` 与 `allChosen`（**唯一实现**，GET 与 POST 共用）。
 * ★ `allChosen` 只看**存活**的人：被淘汰的人在结算那一刻就已经不在这一局里了（App 也不再弹事件），
 *   把他算进来会让「全员选完」永远凑不齐 —— 整桌卡在事件屏，而服务端没有任何超时机制。
 */
function eventChoiceStateOf(room, round, viewerId) {
  const picks = round?.eventPicks || [];
  const chosen = new Set(picks.map((pick) => String(pick.userId)));
  const alive = aliveMembersOf(room);
  const mine = eventPickOf(round, viewerId);
  return {
    myChoice: mine ? mine.optionId : null,
    allChosen: alive.length > 0 && alive.every((member) => chosen.has(String(member.userId))),
  };
}

/**
 * 事件的对外形状。
 * ★ `effects` 拆成两半（契约在 config/gameEvent 文件头）：`server` 是服务端**会**执行的键（今天只有
 *   `hp`，选完就已经落库了，App 不要再应用一次）；`client` 与 App `rules.EventEffect` 同形，原样应用。
 * ★ 选项顺序照事件表（App 的 `optionsForPlayer` 会按玩家档位 / 连胜再筛一遍；服务端不知道金币与档位，
 *   只下发全量三/四个选项 + 花费，扣钱与可选项判定仍在 App 本地）。
 */
function eventPayloadOf(room, round, event, viewerId) {
  return {
    round: round.round,
    eventId: event.id,
    title: event.title,
    options: event.options.map((option) => ({
      id: option.id,
      cost: option.cost,
      label: option.label,
      effects: {
        server: { ...option.effects.server },
        client: option.effects.client.map((effect) => ({ ...effect })),
      },
    })),
    ...eventChoiceStateOf(room, round, viewerId),
  };
}

/**
 * GET / POST 共用的前置闸（**唯一实现**）：房间在 → 我是成员且还活着 → 这一回合已结算 →
 * 这局还没结束 → 这一回合确实是事件回合。
 * ★ 顺序是刻意的：先回答「你能不能玩」（404 / 409 NOT_IN_ROOM / PLAYER_ELIMINATED），再回答
 *   「现在能不能读」（ROUND_NOT_SETTLED），最后才是「这一回合有没有事件」（NO_EVENT）。
 */
async function eventContextOf({ code, userId, now }) {
  const room = await gameRoom.loadRoom(code, now);
  if (!room) return { error: fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)") };
  const member = memberOf(room, userId);
  if (!member) return { error: fail("NOT_IN_ROOM", 409, "you are not in this room", { roomCode: room.code }) };
  if (hpOf(member) <= 0) return { error: fail("PLAYER_ELIMINATED", 409, "eliminated players do not get events") };
  const round = currentRoundOf(room);
  if (!round) return { error: fail("ROUND_NOT_FOUND", 404, "this room has no active round") };
  // ★ 「settled 之后、下一回合 creating 之前」= 当前回合（数组最后一条）就是 settled。
  //   已经 next 过的房间最后一条是 creating，天然不满足；不用再比回合号。
  if (round.phase !== "settled") {
    return {
      error: fail("ROUND_NOT_SETTLED", 409, "events are only available after the round is settled", {
        phase: round.phase,
        round: round.round,
      }),
    };
  }
  const over = gameOverOf(room);
  // 结束的一局没有事件：这一回合的血已经定下胜者，再让人回血 / 升档会把结算结果改掉。
  if (over.over) return { error: fail("GAME_OVER", 409, "the game is over", { winners: over.winners }) };
  const event = eventConfig.eventFor(room.code, round.round);
  if (!event) {
    return {
      error: fail("NO_EVENT", 404, "this round has no event", {
        round: round.round,
        eventRounds: eventConfig.EVENT_AFTER_ROUNDS.slice(),
      }),
    };
  }
  return { room, member, round, event };
}

/**
 * GET /api/game/rooms/:code/rounds/events —— 当前待选事件
 *
 * 回包：`{ ok, round, eventId, title, options:[{ id, cost, label, effects:{ server, client } }],
 *   myChoice, allChosen }`
 * 错误：404 `ROOM_NOT_FOUND` / 409 `NOT_IN_ROOM` / 409 `PLAYER_ELIMINATED` / 404 `ROUND_NOT_FOUND` /
 *      409 `ROUND_NOT_SETTLED`（还没结算，或已经 next 到下一回合）/ 409 `GAME_OVER` / 404 `NO_EVENT`
 *      （这一回合不是事件回合，带 `eventRounds`）/ 503 `GAME_EVENTS_OFF`（路由闸）。
 * ★ 只在**成员**读时续命（只刷 `lastSeenAt`）；事件 / 选择状态一概不写（轮询路径不产生新状态）。
 */
async function getRoundEvent({ userId, code, now = Date.now() }) {
  const ctx = await eventContextOf({ code, userId, now });
  if (ctx.error) return ctx.error;
  await gameRoom.touch(ctx.room, now);
  return { ok: true, ...eventPayloadOf(ctx.room, ctx.round, ctx.event, userId) };
}

/**
 * POST /api/game/rooms/:code/rounds/events/choice —— `{ optionId }`
 *
 * 回包：`{ ok, myChoice, allChosen }`（`optionId: "skip"` = App 的跳过出口，也记一个表态）
 * 错误：同 GET 的前置闸，加上 400 `BAD_OPTION`（不是这个事件的选项）。
 *
 * ★★ **幂等 + hp 只落一次**：同一次原子更新里做三件事 ——
 *      ① 条件里带 `eventPicks.userId: {$ne: me}`（这个人这一回合还没选过）；
 *      ② `$push` 我的选择；
 *      ③ 如果这个选项有 hp 效果，`$set` 我的**绝对血量**（钳在 0~START_HP）。
 *    所以「双击 / 重试 / 两个设备同时点」只有一发能匹配上：选择只写一条、血只加一次。
 *    没匹配上的那一发重读一次，发现「我已经选过」就把第一次的结果原样回出去（**第一选作数**）。
 * ★ hp 写绝对值（不是 `$inc`）：与 settle 同一条取舍 —— 谁写都是同一个结果，重复写也不会叠加。
 * ★ 条件里还有 `"rounds.round": {$ne: 下一回合号}`：**下一回合已经建出来**时不能再往上一回合的事件里
 *   写选择（那已经是「翻篇」了；GET 那边由「当前回合必须 settled」挡住）。
 */
async function chooseRoundEvent({ userId, code, optionId, now = Date.now() }) {
  const ctx = await eventContextOf({ code, userId, now });
  if (ctx.error) return ctx.error;
  const { room, member, round, event } = ctx;

  const wanted = String(optionId ?? "").trim();
  if (!wanted) {
    return fail("BAD_OPTION", 400, "optionId is required", { options: event.options.map((option) => option.id) });
  }
  const option = eventConfig.optionOf(event, wanted);
  if (!option && wanted !== eventConfig.SKIP_PICK) {
    return fail("BAD_OPTION", 400, "optionId is not one of this event's options", {
      options: [...event.options.map((item) => item.id), eventConfig.SKIP_PICK],
    });
  }

  // 选过了 → 第一选作数，原样回第一次那一份（重复点击 / 并发第二发都走这里，不再写库）
  if (eventPickOf(round, userId)) {
    return { ok: true, ...eventChoiceStateOf(room, round, userId) };
  }

  const heal = Number(option?.effects?.server?.hp) || 0;
  const hpAfter = Math.min(config.START_HP, Math.max(0, hpOf(member) + heal));
  const at = atOf(now);
  const update = {
    $push: {
      "rounds.$[r].eventPicks": {
        userId: oidOf(userId),
        optionId: option ? option.id : eventConfig.SKIP_PICK,
        at,
      },
    },
    $set: { lastSeenAt: at },
  };
  const arrayFilters = [{ "r.round": round.round }];
  if (heal) {
    update.$set["members.$[m].hp"] = hpAfter;
    arrayFilters.push({ "m.userId": oidOf(userId) });
  }
  const updated = await GameRoom.findOneAndUpdate(
    {
      _id: room._id,
      "members.userId": userId,
      rounds: { $elemMatch: { round: round.round, phase: "settled", "eventPicks.userId": { $ne: userId } } },
      "rounds.round": { $ne: round.round + 1 },
    },
    update,
    { arrayFilters, returnDocument: "after" },
  );
  if (updated) {
    const updatedRound = currentRoundOf(updated);
    return { ok: true, ...eventChoiceStateOf(updated, updatedRound, userId) };
  }

  // 没匹配上：可能是并发下的第二发（我已经选过），也可能阶段刚被推进 / 这局刚结束。重读按真实原因回话。
  const fresh = await GameRoom.findById(room._id);
  if (!fresh) return fail("ROOM_NOT_FOUND", 404, "no room with this code (wrong code, or it has expired)");
  const freshRound = currentRoundOf(fresh);
  if (!freshRound) return fail("ROUND_NOT_FOUND", 404, "this room has no active round");
  if (freshRound.phase !== "settled") {
    return fail("ROUND_NOT_SETTLED", 409, "events are only available after the round is settled", {
      phase: freshRound.phase,
      round: freshRound.round,
    });
  }
  const freshOver = gameOverOf(fresh);
  if (freshOver.over) return fail("GAME_OVER", 409, "the game is over", { winners: freshOver.winners });
  if (eventPickOf(freshRound, userId)) {
    return { ok: true, ...eventChoiceStateOf(fresh, freshRound, userId) };
  }
  return fail("EVENT_CHOICE_CONFLICT", 409, "could not record the choice, please retry");
}

/**
 * 把「这局真的结束了」落库：`status: "over"` + `winners` + `finishedAt`。
 * ★ 为什么必须落库：只有**房主**能调 next，之前 winners 只活在那一次回包里，别的玩家读快照永远
 *   看不到「结束 / 平局」—— 这正是「结束状态要对外可见」要补的那一刀。
 * ★ 条件带 `status: "playing"`：两发 next 撞在一起只有一发落库；另一发读到 already over。
 *   winners 空数组照写（平局 / 同归于尽也是结束，`[]` 与「没结束」靠 status / state 区分）。
 */
async function markRoomOver(room, winners, now) {
  const at = atOf(now);
  await GameRoom.updateOne(
    { _id: room._id, status: "playing" },
    { $set: { status: "over", winners, finishedAt: at, lastSeenAt: at } },
  );
}

module.exports = {
  startRound,
  submitEntry,
  getCurrent,
  // 历史回合 + 战绩（只读；全量、按 round 升序，见 getHistory 文件头）
  getHistory,
  setPhase,
  likeEntry,
  voteEntry,
  settle,
  nextRound,
  // 回合间事件（第 2/4/6 回合结算之后）
  getRoundEvent,
  chooseRoundEvent,
  // 判据 / 形状（测试与路由不用自己再写一遍）
  currentRoundOf,
  gameOverOf,
  snapshotOf,
  entryInputOf,
};
