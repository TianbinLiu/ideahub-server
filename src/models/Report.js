// src/models/Report.js
// 用户举报：视频 / 评论 / 弹幕三种对象共用一张表。
//
// ★ 为什么三种对象共一张表而不是三张：举报的**处理流程**只有一条（待处理 → 下架 / 驳回），
//   管理员要的是"一个按时间排的待处理队列"。拆成三张表，那个队列就得三查一合再排序，
//   分页游标也没法统一 —— 而三者在这条流程里的差别只有"删的时候删哪张表"。
//
// ★ `targetId` 上**故意不写 ref**：mongoose 的 ref 只能指向一个 model，而这一列
//   同时装着 BranchVideo / BranchComment / BranchDanmaku 的 _id。写死任意一个都会让
//   populate 在另外两种类型上**静默返回 null**（不报错，只是对象凭空消失）。
//   解引用一律由 controller 按 targetType 分派（resolveTargets）。
//
// ★ 这里**不存被举报内容的快照**。两个理由：
//   ① 快照只能来自举报者的请求体 —— 那是外部输入，伪造一段脏话栽赃谁都做得到；
//   ② 管理员处理时要看的是**现在**的内容（作者可能已经自己删了/改了标题）。
//   所以正文由管理端**现查**，查不到就如实标 `target.exists = false`（铁律八）。
const mongoose = require("mongoose");

/**
 * 能举报的对象类型。★ 跨仓字符串：App 侧发什么这里就得认什么，
 * 新增取值必须同步 docs/api-contract.md「举报」与 App 的提交入口。
 */
const TARGET_TYPES = ["video", "comment", "danmaku"];

/**
 * 理由分类。★ 存的是**英文 key**，中文文案在客户端。
 *   存中文的话，以后改一版文案（"引战" → "辱骂引战"）就得写数据迁移，
 *   而 key 是身份、文案是显示 —— 与 @提及那边"身份存 userId、名字现查"同一条道理。
 * `other` 存在的意义是让 `detail` 有地方落：分类枚举永远盖不全，
 *   没有兜底项的话用户只能随便挑一个不对的，管理员看到的分类反而更脏。
 *
 * ★★ 这七个 id 与 app 仓 `src/api/admin.ts` 的 `REPORT_REASONS` **逐字相等**
 *   （契约见 docs/api-contract.md「举报」）。两仓不在一个 CI 里，对不上的表现是
 *   用户选了「人身攻击」而服务端 400，或者管理员看到一个认不出来的 key ——
 *   而那恰恰是他判断要不要下架的主要依据。
 *   ★ 加新取值时**服务端先上**：客户端那份是子集时只是少一项可选，反过来则是用户选了一个
 *   服务端不认的 key → 400，而他正要报的可能是最紧急的那一类。
 */
const REASONS = ["csae", "porn", "violence", "abuse", "spam", "infringe", "other"];

/**
 * 要**插队**的理由。
 *
 * ★★ `csae`（涉及未成年人的性剥削 / 性虐待）不是 `porn` 的一个子类，两者的处理不是一回事：
 *   porn 是"这条要下架"，csae 是"这条要下架、账号要封、证据要留存、还要依法报告主管机关"。
 *   分成两个 key 是为了让**队列**分得开 —— 合进 porn 的话它就躺在几十条刷屏举报中间，
 *   而这正是唯一一类"晚一天处理后果完全不同"的举报。
 * ★★ 这一项同时是 **Google Play 上架的硬要求**（UGC 儿童安全标准：应用内要有让人报告
 *   CSAE 的入口），并且对外承诺写在 ideahub-client 的 /child-safety 上
 *   （「这一类举报优先于其他所有举报进入人工复核」）—— 那句话靠下面的 priority 兑现，
 *   不是靠管理员自己留意。改这里之前先读那一页。
 */
const URGENT_REASONS = ["csae"];

/**
 * 管理员能做的处置，以及它各自落到哪个状态。
 *
 * ★★ 动作 → 状态的映射**只有这一张表**（铁律六）。写成 controller 里几个 if 的话，
 *   加一个动作就得记得同时改枚举、改映射、改客户端，漏一处不报错 ——
 *   只是某个动作静默落到了错误的状态上。
 * ★ `takedown`（下架：内容还在，但谁都看不到）与 `delete`（连内容一起删，不可撤销）
 *   是**两件事**，状态必须分得开：事后追责时"下架了"和"删没了"完全不同。
 *   两者都要调另一条线的下架服务（见 report.controller 的 loadTakedown），
 *   差别只是那个 `hard` 标志。
 */
const ACTION_STATUS = {
  takedown: "taken_down",
  delete: "deleted",
  dismiss: "dismissed",
};
const ACTIONS = Object.keys(ACTION_STATUS);

/**
 * 处理状态。★★ 这是**跨仓字符串**，新增取值必须两边同步（铁律九）。
 *   老客户端读到不认识的取值时，判据统一是 **`status !== "pending"` 即已处理**
 *   ——判否定，不判等值（与 `visibility !== "private"` 同源）。
 *   反过来写成 `status === "dismissed" || status === "taken_down"` 才算已处理的话，
 *   将来加一个 `duplicate` 之类的取值，老客户端会把它显示成"还没人管"，
 *   用户于是反复重新举报 —— 而这一个字的错误不会有任何报错。
 */
const STATUSES = ["pending", ...Object.values(ACTION_STATUS)];

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    targetType: { type: String, enum: TARGET_TYPES, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },

    reason: { type: String, enum: REASONS, required: true },

    /**
     * 队列插队位。**只由 reason 推导**（见下面的 pre("validate")），不接受调用方传值 ——
     * 能传的话，举报者就能把自己那条顶到队首，而队首正是最稀缺的资源。
     * ★★ 存量数据没有这个键，而**这次不写迁移是安全的，只因为三件事同时成立**
     *   （复核实测确认；把它当通则用会出事，所以逐条写下来）：
     *   ① `{priority:-1}` 降序下缺字段排在所有数字之后；
     *   ② 队列本来就是 createdAt 降序（新的在前），存量记录本来就在底部；
     *   ③ **`csae` 是一个全新的 key** —— 存量里一条都没有，所以"该插队却缺字段"的
     *      文档根本不存在。
     *   ⇒ 以后往 `URGENT_REASONS` 里加一个**已经在用的**理由（比如把 `porn` 也算紧急），
     *   ③ 立刻不成立：存量里那些 porn 举报缺 priority，会被排到**所有**普通举报之后，
     *   正好和意图相反。那种时候**必须写迁移**（`updateMany({priority:{$exists:false}}, ...)`）。
     */
    priority: { type: Number, default: 0 },
    /** 补充说明（可选）。500 字是契约值，客户端输入框上限必须与它相等 */
    detail: { type: String, trim: true, maxlength: 500, default: "" },

    status: { type: String, enum: STATUSES, default: "pending", required: true },

    /** 处理人 / 处理时间 / 处理备注：只在离开 pending 时一起写入，三者同生同灭 */
    handler: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    handledAt: { type: Date, default: null },
    handleNote: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { timestamps: true }
);

// ★★ 同一个人对同一个对象只能举报一次。
//   没有这条唯一索引，一个人写个循环就能把待处理队列刷成一万条同一个视频，
//   真正需要人看的那些被埋在下面 —— 而这不需要任何漏洞，只要一个合法账号。
//   controller 里那次 findOne 预检只是为了给出一句人话的 409；**并发下真正兜住的是这条索引**
//   （两个请求同时到达时预检会双双扑空），所以两处缺一不可。
// ★ priority 只由 reason 推导，写在 pre("validate") 而不是 controller 里：
//   落库入口将来可能不止一个（后台补录、迁移脚本），而"忘了一起写"零症状 ——
//   表现只是那条 csae 举报安安静静排在队尾。
// ⚠ 这个钩子只在**文档保存**时跑，`findByIdAndUpdate` 不触发它。现在无害：
//   reason 是**写一次就不再改**的（处置举报只 $set status/handler/handledAt/handleNote）。
//   哪天真要让管理员改分类，**必须同时补一个 pre("findOneAndUpdate")** ——
//   否则把一条 porn 改成 csae 之后它依旧排在队尾，而屏幕上写着"优先处理"。
reportSchema.pre("validate", function setPriority() {
  this.priority = URGENT_REASONS.includes(this.reason) ? 1 : 0;
});

reportSchema.index({ reporter: 1, targetType: 1, targetId: 1 }, { unique: true });

// 主查询：管理端「按状态取待处理队列，插队的在最前，其余最新的在前」。
// 复合顺序是 status 在前、再 priority、最后 createdAt —— 反过来（{createdAt:-1, status:1}）
// 等值筛选吃不上前缀，队列一长就变成全表扫。
// ★★ 索引的键序必须与 report.controller 的 sort **逐字一致，一列都不能少**。
//   2026-09-03 复核实测：第一版索引写成 `{status, priority, createdAt}`，而 sort 是
//   `{priority, createdAt, _id}` —— 多出来的 `_id` 让 explain 里仍然出现阻塞 SORT 阶段。
//   零报错，只是慢；而一旦堆到 MongoDB 的阻塞排序内存上限（版本相关，别在注释里写死一个数），
//   会**整条查询抛错**，
//   而那时屏幕上只会显示"举报列表没拉到"。
reportSchema.index({ status: 1, priority: -1, createdAt: -1, _id: -1 });

// 「全部」页：不筛状态、也不按 priority 插队（见 controller 的 sort 注释），单独一条。
reportSchema.index({ createdAt: -1, _id: -1 });

// 「这个对象一共被举报了多少次 / 还有几条没处理」：管理端最重要的信号
// （30 个人举报同一条 ≠ 1 个人举报 30 条），以及下架后把同对象的其余举报一并收尾。
reportSchema.index({ targetType: 1, targetId: 1, status: 1 });

module.exports = mongoose.model("Report", reportSchema);
// 枚举对外导出：schema 与 controller 校验必须同源，抄第二遍就会出现
// 「模型收得下、接口不认」或反过来（两种都不报错，只是某个取值悄悄消失）。
module.exports.TARGET_TYPES = TARGET_TYPES;
module.exports.REASONS = REASONS;
/**
 * 举报理由的人话（与 App `api/admin.ts` 的 REPORT_REASONS 标签逐条相同）。
 * ★ 用途只有一个：从举报队列下架时写进 `takedown.reason` 给**作者**看。此前写的是
 *   理由 key（"porn"），作者的作品页上就显示「已被平台下架 porn」（2026-09-05 App 巡检抓到）。
 *   加新理由时这张表要跟着补 —— 缺了那一项作者看到的又是 key。
 */
module.exports.REASON_LABELS = Object.freeze({
  csae: "涉及未成年人",
  porn: "色情低俗",
  violence: "血腥暴力",
  abuse: "人身攻击 / 辱骂",
  spam: "垃圾营销 / 刷屏",
  infringe: "侵权 / 冒用他人作品",
  other: "其他",
});
module.exports.URGENT_REASONS = URGENT_REASONS;
module.exports.STATUSES = STATUSES;
module.exports.ACTIONS = ACTIONS;
module.exports.ACTION_STATUS = ACTION_STATUS;
