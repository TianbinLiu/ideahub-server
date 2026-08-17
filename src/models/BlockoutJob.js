// src/models/BlockoutJob.js
// 白模化的**取件凭据**：一条 = 「本账号的某一发白模化，方舟已经受理、结果还没取回」。
//
// ══ 为什么要有这张表（两阶段拆分的全部理由）════════════════════════════
// V2 第一版的 `POST /api/branch/templates/blockoutize` 是**一条同步长请求**：服务端在
// 同一条请求里做完九步（含最长 5 分钟的轮询）才返回。而这条链路的钱是**在中途花掉的**
// （看帧一笔 + r2v 受理一笔，受理后失败不退，F11）——于是：
//   · 手机切后台 / 息屏          → 连接被系统收走
//   · 弱网断线 / 切基站          → socket 断
//   · App 进程被系统回收         → 请求方没了
//   · nginx proxy_read_timeout   → 网关先掐断，用户看到 504
// 任何一条发生，用户**丢掉的是这一发的结果，而钱已经花了**，且我们这边的日志里
// 还是一次"成功"。一条要等五分钟的请求本身就是脆的：它把"钱已经付了"和"东西拿到了"
// 绑在同一个 TCP 连接的命上。
//
// 拆成两阶段之后，「结果」变成一件**可以再来取**的东西 —— 这张表就是那张取件单：
//   阶段一（POST …/blockoutize）      做到「r2v 被方舟受理」为止，落一条本记录；钱在这里花掉
//   客户端自己轮询                     走既有的 GET /api/ark/contents/generations/tasks/:id（不计费）
//   阶段二（POST …/blockoutize/finish）凭 jobId 取回：**服务端自己向方舟核实**，转存、建模板
//   掉线了怎么办                       GET …/blockoutize/pending 把还没取回的凭据列出来
//
// ★★ 没有 pending 列表这条路，两阶段就白拆了：App 进程被回收之后 jobId 也跟着没了，
//   用户手里就什么都不剩 —— 与拆之前一样丢结果，只是多了一张他看不见的取件单。
const mongoose = require("mongoose");

/**
 * 凭据的存活时限 —— **这个数只有这一处**（TTL 索引、`expiresAt`、剩余时间、过期文案都读它）。
 *
 * ★★ 24 小时不是"保守一点"，是**产物的物理寿命**：方舟产物 URL 是 TOS 签名地址、
 *   **24h 过期**（F12）。过了这个点，taskId 还查得到、`video_url` 还在回包里，
 *   但那条地址已经拉不下来 —— 凭据再留着也取不回任何东西。
 * ★ 别照抄 BranchTemplateTrial 的 48h：那张表追的是"任务出没出成"，与产物寿命无关。
 *   写成 48h 的表现是用户在第 30 小时兴冲冲回来点「取回结果」，撞上一句拉不到产物的
 *   502，而钱早在一天前就花掉了 —— 我们等于给了他一个假的承诺。
 */
const TTL_MS = 24 * 60 * 60 * 1000;
/** 同一个数的"人话"形态。★ 给用户看的每一句里那个「24 小时」都从这里取 ——
 *  写死在文案里的话，哪天 TTL 改了，闸门是新的、说给用户听的还是旧的，而两边都不报错。 */
const TTL_HOURS = Math.round(TTL_MS / 3_600_000);

/**
 * 过期凭据在库里多留一会儿的**墓碑期**（只为了还能把话说清楚）。
 *
 * ★★ 为什么不让 TTL 正好踩在 `expiresAt` 上：那样第 25 小时回来的用户看到的是一个
 *   **空列表** —— 他不会知道自己那一发去哪了，只会以为"系统把我的东西弄丢了"，
 *   而实际情况是"产物过期了、这笔钱没了"。这正是本仓最不能接受的那种静默（铁律八）。
 *   留 72 小时墓碑，列表里那条会**整句**说出来。
 * ★ 到期与否始终由 `expiresAt` 判（`stateOf` 一处），与墓碑期无关 ——
 *   墓碑期只决定"这句话还能说多久"，不决定"还能不能取"。
 */
const TOMBSTONE_MS = 72 * 60 * 60 * 1000;

/**
 * 一次 finish 最多允许"正在取回"多久 —— 超过就允许别人重新认领。
 *
 * ★★ 为什么必须有这个数：finish 会把凭据原子改成 `claimed` 再干活（转存 100MB 级视频
 *   要好几秒到几十秒），这样并发的第二发 finish 不会同时建出第二个模板。但如果那个
 *   进程当场挂了（pm2 重启 / OOM），凭据就永远卡在 claimed —— **在这剩下的 23 小时里
 *   谁都取不回来**，而两阶段的全部意义就是"取得回来"。所以卡死的认领必须能被抢走。
 * ★ 5 分钟：转存一段 30s/720p 的视频实测是秒级，5 分钟远超正常值；再长就等于
 *   把"进程挂了"和"正在慢慢传"混为一谈。
 */
const CLAIM_STALE_MS = 5 * 60 * 1000;

/** 角色位草案（视觉那一步的产出）。★ 原样带着 `labelConfirmed:false` 走完两段 ——
 *  中途把它丢掉、由 finish 再补一次默认值，就等于把「出生即未核对」这条不变量拆成两处
 *  （parseRoles 的文件头 ★★ 说的就是这件事）。 */
const roleDraftSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 8 },
    desc: { type: String, default: "", trim: true, maxlength: 300 },
    labelConfirmed: { type: Boolean, default: false },
  },
  { _id: false }
);

/** 来源四组数：与 BranchTemplate.sourceSchema 同一份内容 —— finish 建模板时**原样搬过去**。
 *  ★★ 为什么非存不可：finish 绝不能让客户端把这些数**再报一遍**。durSec 是 r2v 的计价
 *    输入时长、crop 决定画面，重报就等于给了它"先按 4 秒的价开炼、取件时改成 30 秒"的机会。
 *    凭据里存的这一份是阶段一**真正拼进变换 URL 的那一份**。 */
const jobSourceSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, trim: true, maxlength: 300 },
    startSec: { type: Number, required: true, min: 0 },
    durSec: { type: Number, required: true, min: 1 },
    crop: {
      x: { type: Number, required: true, min: 0 },
      y: { type: Number, required: true, min: 0 },
      w: { type: Number, required: true, min: 1 },
      h: { type: Number, required: true, min: 1 },
    },
  },
  { _id: false }
);

const blockoutJobSchema = new mongoose.Schema(
  {
    /** 归属。★★ finish 与 pending 列表**只认这一项**：别人拿到 jobId 也取不走
     *  （身份判定一律走 ownerId，绝不拿名字或客户端自述，CLAUDE.md「拿名字当身份」坑）。 */
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** 方舟任务 id（cgt-…）。finish 拿它**自己向方舟核实**，不信客户端一句「成功了」 */
    taskId: { type: String, required: true, trim: true, maxlength: 64 },
    /**
     * pending  —— 还没取回，可以取
     * claimed  —— 某一发 finish 正在取（并发的第二发不许同时建模板；卡死超过
     *             CLAIM_STALE_MS 后可被重新认领，否则等于把凭据锁死）
     * done     —— 已经建成模板（templateId 指向它）。重复 finish 回同一个模板，不再建第二个
     * failed   —— 向方舟核实到这一发失败了（真人脸等）。**钱不退**，照实说
     * expired  —— 超过 24h。只是备忘：真正的判据永远是 expiresAt（见 stateOf）
     */
    status: { type: String, enum: ["pending", "claimed", "done", "failed", "expired"], default: "pending", index: true },
    /** 认领时刻（判"这个 claimed 是不是卡死了"用）。null = 没人在取 */
    claimedAt: { type: Date, default: null },
    /** 产物的物理死期 = 受理时刻 + TTL_MS。★ 存下来而不是每次由 createdAt 现算：
     *  TTL 索引要挂在一个真实字段上，客户端也要拿它显示倒计时，两处读同一个值才不会差半秒 */
    expiresAt: { type: Date, required: true },
    /** 取回后建出来的模板。done 之外一律 null */
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "BranchTemplate", default: null },
    /** failed 时那句**能直接显示给用户的整句中文**（铁律八：全 app 没人监听错误码）。
     *  ★ 存下来的理由：用户可能几小时后才回来看 pending 列表，那时再去问方舟已经没有意义
     *    （任务记录本身也会过期），而"为什么没了"这件事必须还说得出口。 */
    failMessage: { type: String, default: "", trim: true, maxlength: 1000 },

    // ── 建模板需要的一切（finish 不许再让客户端重报一遍）──────────────
    source: { type: jobSourceSchema, required: true },
    roles: { type: [roleDraftSchema], required: true },
    /**
     * 这一发白模化产物里**一共有哪几个可寻址的位置**（逐字、按画面从左到右），
     * 就是阶段一 `roles.map(r => r.label)`。
     * 存在且非空 = 这一发是**序数方案**；缺失 = 编号方案（判否定，见 BranchTemplate.isOrdinalMark）。
     *
     * ★★ 为什么非在**阶段一**存不可（这是本字段存在的全部理由）：白模化提示词在阶段一
     *   就发出去了，模板却要到阶段二 finish 才建出来，而凭据 TTL 是 24 小时 ——
     *   **发版正好夹在两阶段之间**时，只有"凭据里记着当初发的是哪一套"才能保证
     *   finish 出来的模板与那段视频真正的样子一致。让 finish 去"推断"的话，
     *   推断结果与实际发出去的提示词可能不一致，而**零报错**：套用侧照着错的那套
     *   写提示词，画面上根本没有那种记号，钱花完拿到一段没换人的片子。
     * ★ 在途的老 job 天然没有这一位 → finish 出编号方案模板 → **正确**
     *   （它的视频上印的确实是数字）。所以 `default: undefined`，绝不给空数组默认值。
     */
    markSlots: { type: [String], default: undefined },
    /**
     * 这一发视觉认出的**全部** M 个人的措辞表（`ordinalSlots(M)`）。
     * **纯服务端内部**，一个字都不出响应 —— 客户端要的是 `markSlots`（可挂卡的那几个）。
     *
     * ★★ 它与 `markSlots` 的区别就是**截断**：视觉认出 12 个人时，markSlots 只有活下来的
     *   9 条，而画面上站着 12 个一模一样的白人偶（被截掉的照样人偶化，见 parseRoles 的 ★★）。
     *   量框那一步（routes 的 ⑧b）必须按**这一份**去问"一共有几个"、按它对齐下标 ——
     *   拿 markSlots 去问就是对着 12 个人偶说"一共有 9 个"，模型老实吐 9 行、数目"对得上"、
     *   三道闸全过，然后框与角色位**整份错位**：套用者拖谁都换成别人，零报错、r2v 钱照扣。
     * ★ 为什么必须在**阶段一**存：M 是"当初那一发视觉看到了什么"的事实，finish 时
     *   手上只有产物，再也数不出来（而且产物里的人数本来就可能与原片不同）。
     * ★ `default: undefined` + 判存在性：这个字段上线之前落的**在途凭据**没有它 →
     *   finish 时就**不量框**（拖拽层不开、点列表照常用），而不是拿 markSlots 凑合 ——
     *   凑合正是上面那条错位。
     */
    visionSlots: { type: [String], default: undefined },
    /**
     * 这一发**实际喂进视觉模型的帧数**（"看帧那一笔"花在几帧上）。
     *
     * ★ 存它不是为了 finish（建模板一点用不上），是为了**受理回执能重放**：阶段一重试
     *   撞上既有凭据时走的是同一个 startedPayload，现算不出来 —— 不存的话那条路回出来
     *   的帧数是空的，而 App 拿它对账报价，于是"第一次对得上、重试对不上"，两边都不报错。
     * ★ 默认 0 = 这个字段上线**之前**落的存量凭据。回执里按存在性出（0 不出）：
     *   回 0 会被读成"一帧都没看"，那是句假话。
     */
    visionFrames: { type: Number, default: 0, min: 0 },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    intro: { type: String, default: "", trim: true, maxlength: 2000 },
    coverUrl: { type: String, default: "", trim: true, maxlength: 2000 },
    videoTier: { type: String, default: "", trim: true, maxlength: 40 },
    aspect: { type: String, enum: ["portrait", "landscape"], default: undefined },
    /**
     * 产物转存时要用的 Cloudinary public_id —— **阶段一就定死**。
     *
     * ★★ 为什么不在转存那一刻现取 `Date.now()`：finish 是**可以重来**的（转存失败、
     *   进程挂了、用户手抖点两次）。每次现取一个新 id 的话，重来一次就在云端多留一份
     *   100MB 级的孤儿资产，**零症状**、只有月底配额账单会告诉你。定死之后重来一次是
     *   覆盖同一个 public_id，重复多少次都只有一份。
     * ★ 形状仍是 `<userId>-<毫秒>`：归属判据（utils/templateVideoAsset 的 ownBaseRe）
     *   与删模板时的回收都靠这个形状，换成别的形状会让产物变成删不掉的孤儿。
     */
    outPublicId: { type: String, required: true, trim: true, maxlength: 300 },
  },
  { timestamps: true, versionKey: false }
);

// 一个方舟任务只许有一张取件单（阶段一重试撞上它 = 回既有那张，不是建第二张）
blockoutJobSchema.index({ taskId: 1 }, { unique: true });
// pending 列表：本账号按新旧排
blockoutJobSchema.index({ ownerId: 1, createdAt: -1 });
// 「这段素材是不是已经有一发在路上」（阶段一开炼前问一次，免得同一段素材被扣两次钱）
blockoutJobSchema.index({ "source.publicId": 1 });
// TTL：expiresAt 之后再留一段墓碑期才清（理由见 TOMBSTONE_MS 的 ★★）。
// Mongo 的清理线程约每分钟跑一次，延迟删除是正常的。
blockoutJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: Math.round(TOMBSTONE_MS / 1000) });

/** 「另一发正在取」这句话的**唯一措辞**：stateOf 与路由里那条并发兜底共用。
 *  ★ 各写一遍的话，同一件事在列表里和点击后会说成两种话，而两边看着都对。 */
const WORKING_HINT = "正在取回这一发的结果，请过几秒再试。";

/** 剩余时间的人话。★ 与 remainingSec 一起出，避免每个调用点各写一遍"除以 3600" */
function remainingText(sec) {
  if (sec <= 0) return "已过期";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `还剩约 ${h} 小时 ${m} 分`;
  if (m > 0) return `还剩约 ${m} 分钟`;
  return "只剩不到 1 分钟";
}

/**
 * 「这张取件单现在是什么状况」—— **这条判据的唯一实现**（铁律六）。
 * 消费方：finish 端点的分发、pending 列表的每一行。两处分家的表现是
 * "列表里说还能取、点进去说已经过期"（或者反过来），而两边各自看着都没错。
 *
 * @param {{status?:string, expiresAt?:Date, claimedAt?:Date|null, failMessage?:string}|null} job 文档或 lean 对象都行
 * @param {Date} [now]
 * @returns {{ state:"done"|"failed"|"expired"|"working"|"pending", canFinish:boolean,
 *            remainingSec:number, remainingText:string, message:string }}
 *   message 一律是**能直接显示给用户的整句中文**。
 *
 * ★★ 判定顺序有讲究：**先看终局（done/failed），再看过期，最后才看有没有人在取**。
 *   把过期排在 done 前面的话，一个昨天已经取回并建成模板的凭据今天会被说成"产物已过期、
 *   费用无法挽回" —— 模板明明就在他的列表里，我们却告诉他钱没了。
 * ★ 过期只看 `expiresAt`，**不看 status === "expired"**（那一位只是备忘）：
 *   两个来源判同一件事，迟早出现"库里写着 pending、其实早就过期"的半边天。
 */
blockoutJobSchema.statics.stateOf = function stateOf(job, now = new Date()) {
  const ms = job?.expiresAt ? new Date(job.expiresAt).getTime() - now.getTime() : 0;
  const remainingSec = Math.max(0, Math.floor(ms / 1000));
  const base = { remainingSec, remainingText: remainingText(remainingSec) };

  if (job?.status === "done") {
    return { ...base, state: "done", canFinish: false, message: "这一发已经取回，模板建好了。" };
  }
  if (job?.status === "failed") {
    return {
      ...base,
      state: "failed",
      canFinish: false,
      message:
        job.failMessage ||
        "这一发 AI 中途没能出片，没有模板建出来。任务已经被受理并消耗了算力，**这一发的费用不退**，需要重新做一次。",
    };
  }
  if (remainingSec <= 0) {
    return {
      ...base,
      state: "expired",
      canFinish: false,
      // ★★ 这句话必须说满：只说"已过期"会让用户以为再开一发就好了（然后发现又扣了一次钱）。
      //   产物过期不是我们的保留策略，是方舟那条 TOS 签名地址的物理寿命（24h，F12）。
      message:
        `这一发的白模产物已经过期了——AI 给的产物地址只保 ${TTL_HOURS} 小时，现在已经拉不下来，没法再建成模板。` +
        "这一发的费用在开炼时就已经产生、**无法挽回**，要做的话得重新走一次（会重新计费）。",
    };
  }
  if (job?.status === "claimed" && job.claimedAt && now.getTime() - new Date(job.claimedAt).getTime() < CLAIM_STALE_MS) {
    return { ...base, state: "working", canFinish: false, message: WORKING_HINT };
  }
  return {
    ...base,
    state: "pending",
    canFinish: true,
    message: `这一发还没取回结果。等 AI 出片之后回来点「取回结果」就会建成模板；产物 ${TTL_HOURS} 小时后过期（${base.remainingText}），过期后这一发的费用无法挽回。`,
  };
};

blockoutJobSchema.statics.WORKING_HINT = WORKING_HINT;
blockoutJobSchema.statics.TTL_MS = TTL_MS;
blockoutJobSchema.statics.TTL_HOURS = TTL_HOURS;
blockoutJobSchema.statics.CLAIM_STALE_MS = CLAIM_STALE_MS;
blockoutJobSchema.statics.TOMBSTONE_MS = TOMBSTONE_MS;

module.exports = mongoose.model("BlockoutJob", blockoutJobSchema);
