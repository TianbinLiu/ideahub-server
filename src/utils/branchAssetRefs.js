// 「这条作品占了哪些云端资产地址」—— 删除时回收的**唯一枚举**。
//
// ★★ 它与 `branchVideo.controller.transferSegment` 是**一对**：那边是逐字段重建的"写"，
//   这边是逐字段枚举的"删"。给 segment 加一个带地址的新字段时**两处都要改** ——
//   只改写侧的表现是：那个字段的资产永远回收不到，而且零报错（用量月底才看得出来，
//   且看不出是哪来的）。两处的注释互相点名，就是为了让改一处的人被提醒到。
//
// ⚠⚠ **刻意不含 `deck`**（这是本文件最重要的一条）：随作品发布的卡组快照里，每张卡的
//   `cover` / `views[].url` 是**按 URL 复制**进别人库里的（installDeck 的 $setOnInsert
//   逐字段抄地址，不重新上传）。把它们算进回收范围，等于"作者删掉自己的作品 →
//   所有装过这套卡组的人，卡面全变裂图"，而且零报错。卡组快照的资产归属另说，
//   别顺手加进来。

/** 一条 segment 上所有可能是云端地址的字段。与 transferSegment 逐字段对齐 */
function urlsOfSegment(seg) {
  if (!seg || typeof seg !== "object") return [];
  return [seg.firstFrame, seg.lastFrame, seg.videoUrl];
}

/**
 * 这条作品**自己**占用的资产地址（封面 + 各段首尾帧与成片 + 分支树里的段）。
 * @returns {string[]} 去重后的非空字符串
 */
function assetUrlsOfVideo(doc) {
  if (!doc) return [];
  const out = [doc.cover];
  const segs = Array.isArray(doc.segments) ? doc.segments : [];
  for (const s of segs) out.push(...urlsOfSegment(s));
  // 分支树：每个节点自己挂一段（互动作品的分支段**不在**顶层 segments 里，漏了就等于
  // 互动作品的分支画面全都回收不到 —— 而互动作品恰恰是段数最多的那种）。
  // ⚠ `branchTree.nodes` 在模型里是 **Map**（`{ type: Map, of: branchNodeSchema }`）：
  //   `.lean()` 出来是普通对象，不 lean 时是真 Map，两种都要吃得下。
  //   按数组判（`Array.isArray`）会**永远拿到空**，且零报错。
  const rawNodes = doc.branchTree && doc.branchTree.nodes;
  const nodes = rawNodes instanceof Map ? [...rawNodes.values()] : rawNodes && typeof rawNodes === "object" ? Object.values(rawNodes) : [];
  for (const n of nodes) out.push(...urlsOfSegment(n && n.segment));
  return [...new Set(out.map((v) => String(v || "").trim()).filter(Boolean))];
}

module.exports = { assetUrlsOfVideo, urlsOfSegment };
