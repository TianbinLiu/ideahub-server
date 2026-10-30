// 视频任务登记与找回（模型见 models/ArkVideoTask 的 ★★）。调用方：
//   · ark.routes.billedForward 受理之后 recordVideoTask（落库失败只吼不打断响应：任务已受理、钱已扣）
//   · GET /api/ark/video-tasks → listVideoTasks（最近 24 小时，方舟产物的寿命；已退款的不列；只列方舟的行）
//   · minimax.routes 的 POST /v2/video 受理之后 recordMinimaxV2Task；GET /api/minimax/video-tasks → listMinimaxVideoTasks（2026-10-26）
//   · ark.routes.resolveDraftFinal → findOwnDraft（样片第二步：归属 + 样片的时长）
//   · src/index.js 启动时（0 号实例）→ migrateExpiry（TTL 从 createdAt 搬到每行自带的 expireAt）
const ArkVideoTask = require("../models/ArkVideoTask");

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 方舟产物 24 小时过期：列表只给还有救的 */
const LIST_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * 样片能转成片的窗口：方舟规定样片任务 ID 自 created_at 起 **7 天**有效；我们只放到 7 天差 1 小时 ——
 * 第二步提交后要排队，卡在最后几分钟提交的那一发可能排到过期，那就是一笔白跑的请求。
 */
const DRAFT_FINAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

/** 从任务请求体里抠出「给人认」的那几样：提示词前 300 字、申报时长 / 画幅 / 分辨率、是不是样片 */
function summarizeTaskBody(body) {
  const content = Array.isArray(body?.content) ? body.content : [];
  const prompt = content.map((c) => (c && c.type === "text" ? String(c.text || "") : "")).find(Boolean) || "";
  return {
    model: String(body?.model || "").slice(0, 80),
    durationSec: Number.isFinite(Number(body?.duration)) && Number(body?.duration) > 0 ? Number(body.duration) : undefined,
    ratio: String(body?.ratio || "").slice(0, 16),
    resolution: String(body?.resolution || "").slice(0, 16),
    prompt: prompt.slice(0, 300),
    draft: body?.draft === true,
  };
}

/**
 * 受理之后记一条。★ 只记 Seedance（按 model 名判），★ 任何失败只吼不抛（调用方那一拍任务已受理、钱已扣，
 * 5xx 会让客户端误以为没受理去重试 = 再花一次钱）。
 * @param {object} o
 * @param {{draftTaskId:string, durationSec:number, ratio?:string}|null} [o.draftFinal] 样片第二步的结论：
 *   那一发的请求体里没有时长 / 画幅（方舟规定沿用样片），所以这两样从结论里取，再记上是哪条样片转的
 * @param {number} [o.costTokens] 这一发实扣的 token（管理员免单传 0）
 * @returns {Promise<boolean>} 记没记上
 */
async function recordVideoTask({ userId, body, responseText, r2v, draftFinal = null, costTokens }) {
  if (!/seedance/i.test(String(body?.model || ""))) return false;
  let taskId = "";
  try {
    taskId = String(JSON.parse(responseText || "{}")?.id || "");
  } catch {
    return false;
  }
  if (!TASK_ID_RE.test(taskId)) return false;
  const summary = summarizeTaskBody(body);
  if (draftFinal) {
    summary.durationSec = draftFinal.durationSec;
    summary.ratio = String(draftFinal.ratio || "").slice(0, 16);
  }
  try {
    await ArkVideoTask.create({
      userId,
      taskId,
      ...summary,
      r2v: !!r2v,
      templateId: r2v?.templateId || undefined,
      draftOf: draftFinal?.draftTaskId || undefined,
      costTokens: Number.isFinite(Number(costTokens)) ? Number(costTokens) : undefined,
      // 样片要活到能转成片的最后一刻之后（见 models/ArkVideoTask 的 DRAFT_TTL_MS）
      expireAt: new Date(Date.now() + (summary.draft ? ArkVideoTask.DRAFT_TTL_MS : ArkVideoTask.TTL_MS)),
    });
    return true;
  } catch (e) {
    // 唯一索引撞了 = 同一个任务被记过（重放），不算事
    if (e && e.code === 11000) return true;
    console.error(`[ark] 视频任务登记落库失败 task=${taskId}:`, e.message);
    return false;
  }
}

/**
 * 某个账号最近 24 小时登记的某一家的视频任务（新的在前，最多 50 条），**去掉已经因为失败退了钱的**。
 * 两张列表（方舟 / MiniMax H3）共用这一份：窗口、条数、「退了钱的不列」三条规矩各写一遍的话迟早各改各的。
 * ★ 已经因为失败退了钱的那些不列（2026-10-07，services/taskRefund）：它们没有成片可取了，
 *   App 冷启动拿这张表补「待取回」凭据 —— 列出来就是一张永远取不回、还说着「钱已经花了」的卡。
 *   老 App 也靠这一条不去捞它们（它们不认 refund 字段）。查账失败不挡列表：退一步照旧全列。
 * @param {object} filter 除了 userId / 时间窗之外的条件（哪一家的行）
 * @param {"ark"|"minimax"} provider 去账本里查退款时按哪一家的任务号查（两家的任务号是两个命名空间）
 */
async function recentUnrefunded(userId, filter, provider) {
  const since = new Date(Date.now() - LIST_WINDOW_MS);
  let rows = await ArkVideoTask.find({ userId, ...filter, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(50).lean();
  try {
    const refunded = await require("./taskRefund.service").refundedTaskIds(provider, rows.map((r) => r.taskId));
    if (refunded.size) rows = rows.filter((r) => !refunded.has(r.taskId));
  } catch (e) {
    console.error(`[${provider}] 视频任务列表查退款失败（照旧全列）:`, e.message);
  }
  return rows;
}

/** 两张列表每一条共有的那几样（给人认「是哪一发」、给 App 按它铺回一段） */
function itemOf(r) {
  return {
    taskId: r.taskId,
    createdAt: r.createdAt,
    model: r.model || "",
    durationSec: r.durationSec,
    ratio: r.ratio || "",
    resolution: r.resolution || "",
    prompt: r.prompt || "",
  };
}

/**
 * 这个账号最近 24 小时提交过的**方舟**视频任务（GET /api/ark/video-tasks）。规矩见 recentUnrefunded。
 * ★ provider: null = 只要方舟的行（这一位不存在也算，老行就是这样）。MiniMax H3 的行另走 GET /api/minimax/video-tasks ——
 *   混进来的话老 App 会拿 H3 的任务号去问方舟（models/ArkVideoTask 的 ★★）
 */
async function listVideoTasks(userId) {
  const rows = await recentUnrefunded(userId, { provider: null }, "ark");
  return rows.map((r) => ({
    ...itemOf(r),
    r2v: !!r.r2v,
    // 2026-10-07 加的三位（老客户端不认，只是不显示）：这一发是不是样片 / 是哪条样片转的成片 / 实扣多少
    draft: !!r.draft,
    ...(r.draftOf ? { draftOf: r.draftOf } : {}),
    ...(Number.isFinite(r.costTokens) ? { costTokens: r.costTokens } : {}),
  }));
}

/**
 * MiniMax H3 受理之后记一条（2026-10-26，models/ArkVideoTask 的 ★★）。与 recordVideoTask 同一条纪律：**任何失败只吼不抛** ——
 * 调用方那一拍任务已受理、钱已扣，5xx 会让客户端误以为没受理去重试（= 再花一次钱）。
 * 请求体是路由重建过、白名单核过的那一份（schemas/minimaxV2），content 的形状与方舟一样（`{type:"text", text}` 那一条就是提示词），
 * 所以「给人认」的那几样照 summarizeTaskBody 抠（分辨率是上游的大写写法，原样记）。
 * @returns {Promise<boolean>} 记没记上
 */
async function recordMinimaxV2Task({ userId, body, taskId, costTokens }) {
  const id = String(taskId ?? "");
  if (!TASK_ID_RE.test(id)) return false;
  const { model, durationSec, ratio, resolution, prompt } = summarizeTaskBody(body);
  try {
    await ArkVideoTask.create({
      userId,
      taskId: id,
      provider: "minimax",
      api: "v2",
      model,
      durationSec,
      ratio,
      resolution,
      prompt,
      costTokens: Number.isFinite(Number(costTokens)) ? Number(costTokens) : undefined,
      expireAt: new Date(Date.now() + ArkVideoTask.TTL_MS),
    });
    return true;
  } catch (e) {
    if (e && e.code === 11000) return true;
    console.error(`[minimax-v2] 视频任务登记落库失败 task=${id}（App 重启之后取不回这一发）:`, e.message);
    return false;
  }
}

/**
 * 这个账号最近 24 小时提交过的 **MiniMax H3** 视频任务（GET /api/minimax/video-tasks）。规矩见 recentUnrefunded。
 * 每一条带 `api: "v2"`：取回走 GET /api/minimax/v2/video/:taskId（不计费）。App 认不得的 api 要跳过 ——
 * 真人档（v1）以后也会登记进来（P3），取件是另一条路。
 * ★ H3 那边一发任务 7 天内都查得到（过期的成片地址再查一次会换新的），列表仍只给 24 小时：与方舟那张表、App 的取回卡同一个承诺。
 * @param {object} o
 * @param {boolean} o.v2On 这台服务器此刻开着 V2 出片（config/minimax.minimaxV2Enabled）—— 没开的话一条都不列：
 *   列出来 App 就去问 GET /v2/video/:taskId，只会拿回 501，那是一张永远取不回的卡（任务绑站：切到中国站的服务器问不了国际站建的任务）
 */
async function listMinimaxVideoTasks(userId, { v2On }) {
  if (!v2On) return [];
  const rows = await recentUnrefunded(userId, { provider: "minimax", api: "v2" }, "minimax");
  return rows.map((r) => ({
    ...itemOf(r),
    api: "v2",
    ...(Number.isFinite(r.costTokens) ? { costTokens: r.costTokens } : {}),
  }));
}

/**
 * 样片第二步要的那一条：**本人**、经我们这里出的样片（draft:true）。查不到 = 不是你的 / 不是样片 / 已被回收。
 * ★ 归属只能这么查：所有人的任务都挂在同一把方舟 key 下，方舟那边认 id 不认人。
 */
async function findOwnDraft(taskId, userId) {
  if (!TASK_ID_RE.test(String(taskId || ""))) return null;
  return ArkVideoTask.findOne({ taskId: String(taskId), userId, draft: true }).select("taskId createdAt durationSec ratio model").lean();
}

/**
 * 这一发 H3 是不是**这个人**经我们这里建的（只看登记）。GET /api/minimax/v2/video/:taskId 在账上找不到 H3 那一行时问它
 * （2026-10-26 终审：原来没有账就一律放行 —— 删号级联把账与登记都删掉之后，那个人的 H3 任务在上游还查得到 7 天，
 *  挨个猜号的人就能拿到成片地址）。
 * ★ 登记只活 48 小时（ArkVideoTask.TTL_MS）：它补的是「落账失败、登记落上了」那一种，覆盖 App 取回的那 24 小时就够了。
 */
async function ownsMinimaxV2Task(taskId, userId) {
  if (!TASK_ID_RE.test(String(taskId || ""))) return false;
  return !!(await ArkVideoTask.exists({ taskId: String(taskId), userId, provider: "minimax", api: "v2" }));
}

/**
 * 一次性的迁移（启动时 0 号实例跑；幂等，多跑无害）：
 *   ① 删掉老的 `createdAt_1` TTL 索引 —— 不删的话它会在第 48 小时把样片行删掉（mongoose 只建缺的索引、从不删旧的）；
 *   ② 给老行（没有 expireAt）补上 createdAt + 48 小时 —— TTL 索引不认缺这一位的行，不补它们就永远不过期。
 * ★ 失败只吼不抛：它不是主链路（最坏情况是样片过了 48 小时转不了成片 —— 钉子拒单、一分钱不扣）。
 * @returns {Promise<{dropped:boolean, backfilled:number}>}
 */
async function migrateExpiry() {
  let dropped = false;
  let backfilled = 0;
  try {
    const indexes = await ArkVideoTask.collection.indexes().catch(() => []);
    const legacy = indexes.find(
      (i) => i && i.key && Object.keys(i.key).length === 1 && i.key.createdAt === 1 && i.expireAfterSeconds !== undefined,
    );
    if (legacy) {
      try {
        await ArkVideoTask.collection.dropIndex(legacy.name);
        dropped = true;
        console.log(`[ark] ArkVideoTask：已删掉老的 TTL 索引 ${legacy.name}（改成每行自带 expireAt）`);
      } catch (e) {
        // 另一个实例刚删掉了 —— 不算事（认错误码，不认 message 的措辞）
        if (e?.codeName !== "IndexNotFound" && e?.code !== 27) throw e;
      }
    }
    const r = await ArkVideoTask.collection.updateMany({ expireAt: { $exists: false } }, [
      { $set: { expireAt: { $add: [{ $ifNull: ["$createdAt", "$$NOW"] }, ArkVideoTask.TTL_MS] } } },
    ]);
    backfilled = r?.modifiedCount ?? 0;
  } catch (e) {
    console.error("[ark] ArkVideoTask 到期字段迁移失败（样片可能在 48 小时后被回收）:", (e && e.message) || e);
  }
  return { dropped, backfilled };
}

module.exports = {
  recordVideoTask,
  listVideoTasks,
  recordMinimaxV2Task,
  listMinimaxVideoTasks,
  summarizeTaskBody,
  findOwnDraft,
  ownsMinimaxV2Task,
  migrateExpiry,
  LIST_WINDOW_MS,
  DRAFT_FINAL_WINDOW_MS,
};
