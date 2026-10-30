// 修订记录（docs/03 §7.4）：append-only。头文档 = fold(seed, 全部 accepted ops)，撤销 = 追加一条反向记录并把原记录标 reverted —— 历史不删。
// 与 tutor 仓 src/ops/revision.js 同一份规则、同样的导出名；唯一的区别是第一个参数：那边是 .tutor/revisions.jsonl 的路径，
// 这边是一个 store（{ read(): rec[], append(rec), write(recs) }，由 TutorRevision 表实现），因为服务端没有文件工作区。
// ★ 三个 IO 函数都是 async（Mongo），调用方要 await；tutor 仓那边是同步的 —— 这是移植时唯一要改调用点的地方。
"use strict";
const { sha256Hex } = require("../format/checksum.js");
const { applyOne, revertOne } = require("./apply.js");

const REVISION_KINDS = ["seed", "manual", "distill", "assess", "scan", "fork", "import", "revert"];

async function readRevisions(store) { return (await store.read()) || []; }

function appliedOpIds(revisions) {
  const ids = new Set();
  for (const r of revisions) {
    if (r.review === "reverted") continue;
    for (const op of r.ops || []) if (op.status === "applied" || op.status === "noop") ids.add(op.opId);
  }
  return ids;
}

/** @param {{ kind: string, ops: object[], summary: string, source?: object, by: "ai"|"user", review?: string }} rec */
async function appendRevision(store, rec) {
  if (!REVISION_KINDS.includes(rec.kind)) throw new Error(`修订记录 kind「${rec.kind}」不在 ${REVISION_KINDS.join("/")} 之内`);
  const created_at = new Date().toISOString();
  const pending = rec.ops.some((o) => o.status === "pending");
  const full = {
    id: sha256Hex(`${created_at}:${rec.kind}:${rec.ops.map((o) => o.opId).join(",")}`).slice(0, 16),
    kind: rec.kind,
    ops: rec.ops,
    summary: rec.summary,
    source: rec.source || {},
    by: rec.by,
    review: rec.review || (pending ? "pending" : "n/a"),
    created_at,
  };
  await store.append(full);
  return full;
}

/** 一句人话的摘要：「老师这节课学到了 N 件事」卡就是它（docs/03 §7.4）。 */
function summarize(results) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const parts = [];
  if (n("applied")) parts.push(`记下 ${n("applied")} 条`);
  if (n("pending")) parts.push(`${n("pending")} 条等作者点头`);
  if (n("rejected")) parts.push(`作者否了 ${n("rejected")} 条`);
  if (n("noop") + n("skipped")) parts.push(`${n("noop") + n("skipped")} 条已有、跳过`);
  return parts.length ? parts.join("，") : "这一批没有可记的";
}

/** 撤销一条修订里的全部已落 op。逐条撤销走 revertOps。 */
async function revertRevision(store, doc, revisionId) {
  const target = (await readRevisions(store)).find((r) => r.id === revisionId);
  if (!target) throw new Error(`没有 id 为 ${revisionId} 的修订记录`);
  if (target.review === "reverted") throw new Error(`修订 ${revisionId} 已经撤销过了`);
  return revertOps(store, doc, revisionId, target.ops.filter((o) => o.status === "applied").map((o) => o.opId));
}

/**
 * 逐条撤销（docs/02 4.6 / 4.7）：对选中的、已落的 op 做反向操作，原记录里那几条标 reverted（全撤光了整条记录标 reverted），
 * 再追加一条 kind=revert 的记录 —— 历史不删。回写旧记录是唯一要 write 整表的地方，其余一律 append。
 */
async function revertOps(store, doc, revisionId, opIds) {
  const revisions = await readRevisions(store);
  const target = revisions.find((r) => r.id === revisionId);
  if (!target) throw new Error(`没有 id 为 ${revisionId} 的修订记录`);
  const want = new Set(opIds || []);
  const picked = target.ops.filter((o) => want.has(o.opId));
  if (!picked.length) throw new Error("没有指到任何一条 op");
  const notApplied = picked.find((o) => o.status !== "applied");
  if (notApplied) throw new Error(`这条 op 现在是「${notApplied.status}」，只有已生效的才能撤销`);
  const next = JSON.parse(JSON.stringify(doc));
  const undone = [];
  const at = new Date().toISOString();
  for (const op of [...picked].reverse()) {
    revertOne(next, op);
    op.status = "reverted";
    op.reverted_at = at;
    undone.push({ ...op });
  }
  if (!target.ops.some((o) => o.status === "applied" || o.status === "pending")) target.review = "reverted";
  const rec = { id: sha256Hex(`${at}:revert:${revisionId}:${[...want].join(",")}`).slice(0, 16), kind: "revert", of: revisionId, ops: undone, summary: `撤销修订 ${revisionId} 里的 ${undone.length} 条`, source: {}, by: "user", review: "n/a", created_at: at };
  revisions.push(rec);
  await store.write(revisions);
  return { doc: next, revision: rec, target };
}

/**
 * 作者逐条点头（docs/02 4.5 / 4.7）：原记录里 pending 的 op，点头的落进文档、标 applied（或 noop）；否掉的标 rejected。
 * 一条都不剩 pending 时记录的 review 翻成 accepted / rejected。不追加新记录。版次 +1 由调用方做（点头一批 = 铸新版）。
 */
async function reviewRevision(store, doc, revisionId, { accept = [], reject = [] } = {}) {
  const revisions = await readRevisions(store);
  const target = revisions.find((r) => r.id === revisionId);
  if (!target) throw new Error(`没有 id 为 ${revisionId} 的修订记录`);
  const acc = new Set(accept);
  const rej = new Set(reject);
  const next = JSON.parse(JSON.stringify(doc));
  const at = new Date().toISOString();
  const applied = [];
  const rejected = [];
  for (const op of target.ops) {
    if (op.status !== "pending" || !(acc.has(op.opId) || rej.has(op.opId))) continue;
    if (acc.has(op.opId)) {
      const r = applyOne(next, op);
      op.status = r.noop ? "noop" : "applied";
      if (r.prev !== undefined) op.prev = r.prev;
      if (r.created) op.created = r.created;
      op.reviewed_at = at;
      applied.push(op);
    } else { op.status = "rejected"; op.reviewed_at = at; rejected.push(op); }
  }
  if (!applied.length && !rejected.length) throw new Error("没有指到任何一条待点头的 op");
  if (!target.ops.some((o) => o.status === "pending")) target.review = target.ops.some((o) => o.status === "applied" || o.status === "noop") ? "accepted" : "rejected";
  await store.write(revisions);
  return { doc: next, target, applied, rejected };
}

/** 全部修订里还在等作者点头的 op（审阅页顶上那一组） */
function pendingOps(revisions) {
  const out = [];
  for (const r of revisions) if (r.review !== "reverted") for (const op of r.ops || []) if (op.status === "pending") out.push({ ...op, revisionId: r.id, created_at: r.created_at });
  return out;
}

/** 内存版 store（测试与单机用）：与 TutorRevision 表实现同一个三件套形状 */
function memoryRevisionStore(initial = []) {
  let recs = initial.map((r) => JSON.parse(JSON.stringify(r)));
  return { read: async () => recs.map((r) => JSON.parse(JSON.stringify(r))), append: async (rec) => { recs.push(JSON.parse(JSON.stringify(rec))); }, write: async (all) => { recs = all.map((r) => JSON.parse(JSON.stringify(r))); } };
}

module.exports = { REVISION_KINDS, readRevisions, appliedOpIds, appendRevision, summarize, revertRevision, revertOps, reviewRevision, pendingOps, memoryRevisionStore };
