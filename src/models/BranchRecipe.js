// src/models/BranchRecipe.js
// 已发布作品的「公开配方」（制作过程）—— 作者选择公开时，别人能在作品页看它是怎么做出来的，
// 并按它复制一条流水线到自己的草稿里接着做（App 的「查看制作过程」「按这个流程做同款」）。
//
// ★★ 它**不是** BranchProject（回炉用的画布原件）的另一个出口：
//   画布是"客户端定义形状、服务端只当 Mixed 存"的东西，里面有用户的原话、没选中的方案、圈选标注、
//   真人卡、上传的参考视频 —— **不能原样公开**。配方是客户端在公开那一拍出的一份**白名单投影**，
//   服务端用严格 schema（schemas/branchRecipe.schemas.js）再验一遍、只存验过的那份。
//   两张表一份给作者自己（回炉），一份给所有人（学与复制），字段不共用、权限不共用。
//
// ★★ 为什么是**独立集合**而不是 BranchVideo 上的一个字段（与 BranchProject 同一条理由）：
//   branchVideo.controller 的读路径（listVideos / getVideo / updateVideo 回写）一处投影都没有，
//   挂上去之后每页列表都要整份搬 12~50 条配方。作品文档上只留一个提示位（BranchVideo.recipe：
//   公开没有 + 描述的是第几版），正文在这里按需取。
//
// ★ 不加 TTL：配方跟着作品走。级联删除两处：purgeVideo（删作品）与 purgeUserCascade（删号）。
const mongoose = require("mongoose");

const branchRecipeSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    video: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true },
    /**
     * 这份配方描述的是作品的**哪一个** revision（与 BranchProject.videoRevision 同一个意思）。
     * ★ 回炉之后作品的 revision 涨了，而配方还是上一版的：那时它对别人**不可见**（GET 按这一格与作品当下的
     *   revision 比），直到作者的客户端把新一版的配方 PUT 上来。判据只有这一格，不另存 stale 布尔。
     */
    videoRevision: { type: Number, default: 0 },
    /** 作者的开关：false = 留着但不给别人看（作者自己照样读得到，随时能再打开） */
    public: { type: Boolean, default: true },
    /**
     * 上架到模板市场（「工作流模板」，2026-10-02 模板体系 P2）：工作流模板**就是**上了架的公开配方 ——
     * 主人拍板它必须挂在一条已发布作品上（示例视频 = 那条作品），所以不另开一张表，一位布尔就够。
     * ★ 只在 `public && 不过期` 时才许上架（patchRecipe 把关）；关公开时顺手下架。对别人可见的条件与配方本身相同
     *   （作品可读 + 公开 + 不过期），列表端点（listWorkflowTemplates）照 readableFilter 过一遍。
     */
    listed: { type: Boolean, default: false },
    listedAt: { type: Date },
    /** 服务端自己量的 `JSON.stringify(recipe)` 字节数 */
    bytes: { type: Number, default: 0 },
    /** 段数（列表 / 统计用，不必把正文取出来数） */
    nodeCount: { type: Number, default: 0 },
    /**
     * 配方正文。**存的是 zod 解析之后的那份**（未声明的键已经被剥掉），不是请求体原文 ——
     * 白名单之外的东西进不了库，也就出不去。形状见 schemas/branchRecipe.schemas.js。
     */
    recipe: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

// 一条作品最多一份配方（PUT 是 upsert，靠这条索引挡住并发重复插入）
branchRecipeSchema.index({ video: 1 }, { unique: true });
// 工作流模板货架：上了架的按上架时间倒序
branchRecipeSchema.index({ listed: 1, listedAt: -1 });
// 「这张段模板被哪些公开配方引用着」—— Mixed 正文里的路径照样能建多键索引；
// 被引用的模板作者只能下架不能删素材（branchTemplate.routes 的 recipeRefsOf）
branchRecipeSchema.index({ "recipe.nodes.tpl.id": 1 });

/**
 * 引用这张段模板的**公开**配方有几份（下架 / 删除段模板那两条路问的就是它）。
 * ★ 现算不缓存：量不大（一张模板被几十份配方引用已是极限），而缓存的引用计数漏减一次就是永远删不掉的素材。
 * ★ 只数公开着的：关了公开的配方对别人不可见，它引用的模板没必要为它留着。
 */
branchRecipeSchema.statics.refsOfTemplate = function (templateId) {
  return this.countDocuments({ public: true, "recipe.nodes.tpl.id": String(templateId) });
};

module.exports = mongoose.model("BranchRecipe", branchRecipeSchema);
