// 视频任务登记与找回（模型见 models/ArkVideoTask 的 ★★）。两处调用：
//   · ark.routes.billedForward 受理之后 recordVideoTask（落库失败只吼不打断响应：任务已受理、钱已扣）
//   · GET /api/ark/video-tasks → listVideoTasks（最近 24 小时，方舟产物的寿命）
const ArkVideoTask = require("../models/ArkVideoTask");

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 方舟产物 24 小时过期：列表只给还有救的 */
const LIST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 从任务请求体里抠出「给人认」的那几样：提示词前 300 字、申报时长 / 画幅 / 分辨率 */
function summarizeTaskBody(body) {
  const content = Array.isArray(body?.content) ? body.content : [];
  const prompt = content.map((c) => (c && c.type === "text" ? String(c.text || "") : "")).find(Boolean) || "";
  return {
    model: String(body?.model || "").slice(0, 80),
    durationSec: Number.isFinite(Number(body?.duration)) && Number(body?.duration) > 0 ? Number(body.duration) : undefined,
    ratio: String(body?.ratio || "").slice(0, 16),
    resolution: String(body?.resolution || "").slice(0, 16),
    prompt: prompt.slice(0, 300),
  };
}

/**
 * 受理之后记一条。★ 只记 Seedance（按 model 名判），★ 任何失败只吼不抛（调用方那一拍任务已受理、钱已扣，
 * 5xx 会让客户端误以为没受理去重试 = 再花一次钱）。
 * @returns {Promise<boolean>} 记没记上
 */
async function recordVideoTask({ userId, body, responseText, r2v }) {
  if (!/seedance/i.test(String(body?.model || ""))) return false;
  let taskId = "";
  try {
    taskId = String(JSON.parse(responseText || "{}")?.id || "");
  } catch {
    return false;
  }
  if (!TASK_ID_RE.test(taskId)) return false;
  try {
    await ArkVideoTask.create({
      userId,
      taskId,
      ...summarizeTaskBody(body),
      r2v: !!r2v,
      templateId: r2v?.templateId || undefined,
    });
    return true;
  } catch (e) {
    // 唯一索引撞了 = 同一个任务被记过（重放），不算事
    if (e && e.code === 11000) return true;
    console.error(`[ark] 视频任务登记落库失败 task=${taskId}:`, e.message);
    return false;
  }
}

/** 这个账号最近 24 小时提交过的视频任务（新的在前，最多 50 条） */
async function listVideoTasks(userId) {
  const since = new Date(Date.now() - LIST_WINDOW_MS);
  const rows = await ArkVideoTask.find({ userId, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(50).lean();
  return rows.map((r) => ({
    taskId: r.taskId,
    createdAt: r.createdAt,
    model: r.model || "",
    durationSec: r.durationSec,
    ratio: r.ratio || "",
    resolution: r.resolution || "",
    prompt: r.prompt || "",
    r2v: !!r.r2v,
  }));
}

module.exports = { recordVideoTask, listVideoTasks, summarizeTaskBody, LIST_WINDOW_MS };
