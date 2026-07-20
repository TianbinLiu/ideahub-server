// scripts/seedChatScenarioTemplates.js
// 播种 3 个【默认聊天场景模板】（sceneKind='chat'，shared=true），给「情景模拟 → 场景模板平台」
// Phase 1 一个开箱可玩的起步库：
//   ① 办公上司 1v1（wechat / workplace）
//   ② 应聘 HR 私信（qq / jobhunt）
//   ③ 同事群聊（wechat / social）
//
//   npm run seed:chat-scenarios
//
// 作者账号：SEED_AUTHOR_EMAIL 环境变量指定；不设则取最早创建的 admin。
// 幂等：按 (title, sceneKind:'chat') 查重，已存在就跳过【不覆盖】——
//   模板上线后管理员可能在站内改过内容，重跑脚本不应吃掉这些修改。
require("dotenv").config();
const mongoose = require("mongoose");

// 参与者/消息的 id 只需在【单个 scenario 内】稳定唯一，用可读的短 id 便于排查数据。
const TEMPLATES = [
  {
    title: "周五晚上，上司微信叫你周末加班",
    summary: "深夜被上司微信召唤周末加班，练习如何得体地拒绝而不影响转正。",
    platform: "wechat",
    sceneKind: "chat",
    category: "workplace",
    tags: ["职场", "加班", "沟通"],
    topic:
      "周五晚上十点，上司在微信上找你，希望你周末来公司加班赶项目进度。你想婉拒（家里已有安排），又不想影响季度末的转正评估。",
    participants: [
      {
        id: "p_boss",
        name: "王经理",
        avatar: "👔",
        role: "上司",
        isSelf: false,
        goal: "希望你周末来加班赶项目进度；先客气、被拒后逐步施压，暗示会影响转正评估",
      },
      {
        id: "p_me",
        name: "小李",
        avatar: "🧑‍💻",
        role: "员工（我）",
        isSelf: true,
        goal: "婉拒周末加班，同时不显得不配合、不影响转正",
      },
    ],
    messages: [
      { id: "m1", senderId: "p_boss", text: "小李，在吗？" },
      { id: "m2", senderId: "p_boss", text: "周末项目要赶个进度，你来公司帮忙盯一下吧" },
      { id: "m3", senderId: "p_me", text: "王经理，这周末我家里已经有安排了……" },
      { id: "m4", senderId: "p_boss", text: "就这一次，客户周一就要看东西，大家都指望你呢" },
    ],
  },
  {
    title: "HR 压价的 offer 谈判",
    summary: "终面刚过，HR 发来低于期望 20% 的 offer 还在催你确认，练习跟 HR 谈薪。",
    platform: "qq",
    sceneKind: "chat",
    category: "jobhunt",
    tags: ["求职", "谈薪", "offer"],
    topic:
      "你刚通过终面，HR 在 QQ 上发来 offer，但薪资比你的期望低了 20%，还在用「岗位竞争激烈」催你今天确认。你想争取期望薪资或换取其它条件。",
    participants: [
      {
        id: "p_hr",
        name: "陈HR",
        avatar: "🧑‍💼",
        role: "招聘HR",
        isSelf: false,
        goal: "以低于候选人期望 20% 的薪资尽快让对方接 offer；强调平台与成长空间，制造稀缺感催促确认",
      },
      {
        id: "p_me",
        name: "求职的我",
        avatar: "🎓",
        role: "求职者（我）",
        isSelf: true,
        goal: "争取期望薪资，或换取调薪承诺/签字费等其它条件，不被话术带节奏",
      },
    ],
    messages: [
      { id: "m1", senderId: "p_hr", text: "你好，恭喜通过终面！我们想尽快跟你确认入职意向~" },
      { id: "m2", senderId: "p_me", text: "谢谢！请问薪资方面是怎么定的呢？" },
      { id: "m3", senderId: "p_hr", text: "综合评估后定在 12k。虽然比你期望的低一点，但我们平台成长空间很大" },
      { id: "m4", senderId: "p_hr", text: "这个岗位竞争很激烈哦，今天能确认吗？" },
    ],
  },
  {
    title: "同事群里的聚餐接龙，就差你了",
    summary: "组长在群里张罗聚餐接龙并@了你，练习在群聊里礼貌推掉又不显得不合群。",
    platform: "wechat",
    sceneKind: "chat",
    category: "social",
    tags: ["同事", "聚餐", "社交"],
    topic:
      "周五下班前，组长在同事群里张罗晚上聚餐接龙，同事纷纷响应，全群就差你没报名，组长还@了你。你这周很累想推掉，又不想显得不合群。",
    participants: [
      {
        id: "p_zhang",
        name: "张姐",
        avatar: "👩‍💼",
        role: "组长",
        isSelf: false,
        goal: "张罗周五聚餐并希望全员参加；热情但强势，被推辞会继续劝",
      },
      {
        id: "p_liu",
        name: "刘哥",
        avatar: "🧔",
        role: "老同事",
        isSelf: false,
        goal: "起哄附和张姐，爱开玩笑，喜欢拱火让你参加",
      },
      {
        id: "p_zhou",
        name: "小周",
        avatar: "🧑‍🎓",
        role: "新同事",
        isSelf: false,
        goal: "随大流，偶尔帮你说话",
      },
      {
        id: "p_me",
        name: "我",
        avatar: "🧑‍💻",
        role: "同事（我）",
        isSelf: true,
        goal: "这周很累不想参加聚餐，想礼貌推掉又不显得不合群",
      },
    ],
    messages: [
      { id: "m1", senderId: "p_zhang", text: "周五晚上老地方聚餐啊，都别请假！接龙走起" },
      { id: "m2", senderId: "p_liu", text: "1. 刘哥 ✋ 必须到" },
      { id: "m3", senderId: "p_zhou", text: "2. 小周" },
      { id: "m4", senderId: "p_zhang", text: "@我 就差你啦，别又说有事哈" },
    ],
  },
];

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("[seedChatScenarioTemplates] MONGO_URI 未设置");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const User = require("../src/models/User");
  const Scenario = require("../src/models/Scenario");

  // 作者：SEED_AUTHOR_EMAIL 指定的账号；不设则取最早创建的 admin（系统账号语义）
  const email = (process.env.SEED_AUTHOR_EMAIL || "").trim();
  const author = email
    ? await User.findOne({ email })
    : await User.findOne({ role: "admin" }).sort({ createdAt: 1 });
  if (!author) {
    console.error(
      email
        ? `[seedChatScenarioTemplates] 找不到 SEED_AUTHOR_EMAIL 对应的用户：${email}`
        : "[seedChatScenarioTemplates] 库里没有 admin 用户；请设置 SEED_AUTHOR_EMAIL 或先跑 scripts/seedAdmin.js"
    );
    process.exit(1);
  }
  console.log(`[seedChatScenarioTemplates] 作者账号：${author.username} (${author.email || author._id})`);

  let created = 0;
  let skipped = 0;
  for (const tpl of TEMPLATES) {
    const existing = await Scenario.findOne({ title: tpl.title, sceneKind: "chat" }).select("_id").lean();
    if (existing) {
      skipped += 1;
      console.log(`  跳过（已存在）：${tpl.title}`);
      continue;
    }
    await Scenario.create({ ...tpl, author: author._id, shared: true });
    created += 1;
    console.log(`  已创建：${tpl.title}`);
  }

  console.log(`[seedChatScenarioTemplates] 完成：新建 ${created}，跳过 ${skipped}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
