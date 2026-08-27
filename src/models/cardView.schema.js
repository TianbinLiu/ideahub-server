// src/models/cardView.schema.js
// 卡片的「多图参考」子文档（**不是** model，只是一份被两个 model 复用的 subschema）。
//
// ★ 为什么单独开一个文件：这个形状要同时出现在 BranchCard.views 与
//   BranchDeck.cards[].views（卡组发布时的快照）里。本仓库里「同一张卡的字段在
//   两个 model 各抄一遍」已经出过事 —— modelUrl / genPrompt 当年就是快照那份漏了声明，
//   表现是「卡片本身有建模，装走之后变成没有」，且全程零报错。抄两遍的写法要靠
//   人记得两边一起改，抄一份 subschema 则改一次就够（铁律六）。
//
// 语义见 schemas/branchAsset.schemas.js 里 cardView 那段（上限 3、只收 http(s) 的理由）。
const mongoose = require("mongoose");
const { CARD_VIEW_KINDS, CARD_VIEW_ROLES, CARD_VIEW_TAG_MAX } = require("../schemas/branchAsset.schemas");

// _id: false —— 这是纯数据，客户端按 url 认它；给每张图发一个 ObjectId 只会
// 让卡组快照白白变大，也会让「同一张图在两处是不是同一张」变得需要另做判断。
const cardViewSchema = new mongoose.Schema(
  {
    /** 只可能是 http(s)（入库前由 zod 拒掉 dataURL / idb:，理由见 schemas 那份注释） */
    url: { type: String, required: true, trim: true, maxlength: 2000 },
    /** face=面部特写 / body=全身 / detail=局部或道具场景细节。**跨仓冻结三值**，见 schemas 那份 ★★ */
    kind: { type: String, enum: CARD_VIEW_KINDS, default: "detail" },
    /**
     * 这张图在出片管线里干什么（受控词表）。**不设 default**：缺省 = 老数据 =
     * 由客户端按 kind 推（app 的 roleOf 一处实现）。在这里补默认值就是第二处推法。
     * ★ display = 只展示、永不进模型（方案产出的合成规格图/三视图 —— 方舟指南说
     *   多视图素材会被识别成多个主体、加剧 ID 漂移，拿它当人物参考是主动把画面变差）。
     */
    role: { type: String, enum: CARD_VIEW_ROLES },
    /** 界面上的花名（"无面部白模三视图"）。只给人看，**绝不进**参考图分配判断 */
    tag: { type: String, trim: true, maxlength: CARD_VIEW_TAG_MAX },
    /** 作者自己写的一句说明（"左手的义肢"），只给人看，不进提示词 */
    note: { type: String, default: "", trim: true, maxlength: 200 },
  },
  { _id: false }
);

module.exports = { cardViewSchema };
