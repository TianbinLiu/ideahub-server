/**
 * @file tutor.routes.js - 老师人格（tutor）：作者用自己的教材铸一位 AI 老师，在阅读面 + 导学漫游里教自己（tutor 仓 docs/01–10）
 * @category Route
 * @base_path /api/tutor
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节 + docs/api-contract.md「老师人格（tutor）」+ tutor 仓 docs/04 §5
 *
 * ★ 只在 TUTOR_ENABLED=true 时被 app.js 挂上（为假时不 require：一个坏 import 就不会拦住启梦发布）。全部端点 requireAuth，
 *   不是本人的课一律 404。请求体上限由 app.js 的 jsonGateWith(TUTOR_TEXT_JSON_LIMIT) 放宽到 8mb（教材 pages / 导入 .md）。
 * ★ 钱（docs/05 §6.2）：tutor_turn 开流前 preAuthorize、第一个 token 前失败退（refundTag tutor_refund）；tutor_distill / tutor_extract 走 billing.chargedCall；
 *   模型判卷 quiz-grade 今天不单独计费（tutor 仓 docs/08 #4 待拍板）。价目只在 config/tokens.js 的 TUTOR_PRICES 一处。
 *
 * API端点:
 * @endpoint GET    /health                              - { ok, tutor, demo, demoAllowed }（不鉴权）
 * @endpoint GET    /config                              - { prices, demo, adultDeclared }
 * @endpoint POST   /declare-adult                       - 成人声明（v1 只做成人）
 * @endpoint GET    /courses · POST /courses · GET|PATCH /courses/:id
 * @endpoint GET|HEAD /courses/:id/materials?sha256=      - 去重探测
 * @endpoint GET    /courses/:id/rules · /quote          - 从政策派生的 🔒 规则 / 生成报价
 * @endpoint POST   /materials/sign · /confirm           - 教材直传票（Cloudinary raw）/ 验收（收浏览器抽好的 pages，按 sha 去重）
 * @endpoint PATCH  /materials/:sha                      - 事后改授权来源（文档头 license.source 取最差重算）
 * @endpoint GET    /materials/:sha/file · /text         - 原件（302 到 5 分钟签名地址）/ 块级文本
 * @endpoint GET    /usage-ledger?since=                 - 本人的模型用量账本（dogfood / 定价）
 * @endpoint POST   /personas/generate · GET /jobs/:id   - 生成作业（202 + 轮询；受理即扣整份报价）
 * @endpoint POST   /personas/:id/preview                - 试教（SSE，不落 Turn；同价）
 * @endpoint POST   /personas/:id/scan · /patches/:pid/accept - 新教材 → 阶段提议 → 作者点头追加成新版
 * @endpoint GET    /personas/:id/export?format&audience · /exports · POST /personas/import
 * @endpoint GET    /runs/:id · /turns?after · /review-card · /usage-export · /review-due · /review-quiz?stage · /revisions
 * @endpoint PATCH  /runs/:id/progress · POST /runs/:id/turns(SSE) · /quiz · /skip · /feedback · /distill · /revisions/:rid/review|revert
 * @endpoint POST   /referral                            - 引流位 ?from= 记一行（可选登录；只记不奖励）· GET /admin/metrics 三条度量（管理员）（M3）
 *
 * SSE（turns / preview）：token {t} · sentence {index,text} · done {seq,kind,text,flags,demo,preview,stage,progress,status,changed,distillQueued} · error {message}；
 *   每 15 秒一行 `: ping` 注释帧。与 companion 同一份 openSse 响应头。
 *
 * @uses {controllers/tutor.controller.js}
 * @uses {services/tutorStore.service.js} - 课程上下文（Mongo 版的课程工作区）
 * @uses {services/tutorAi.service.js} - 生成 / 直传 / 扫描
 * @uses {services/tutorSession.service.js} - 一轮 SSE / 自检
 * @uses {services/tutorDistill.service.js} - 蒸馏与修订
 * @uses {services/tutorDoc.service.js} - 导出 / 导入 / 使用记录
 * @uses {src/tutor/core/} - 与 tutor 仓同一份的纯函数核心（生成物，见其 README）
 * @registered_in src/app.js（TUTOR_ENABLED=true）
 */
const router = require("express").Router();
const { requireRole, requireAuth, optionalAuth } = require("../middleware/auth");
const { ADMIN_ROLE } = require("../utils/roles");
const { aiRateLimit, userRateLimit, rateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const S = require("../schemas/tutor.schemas");
const ctrl = require("../controllers/tutor.controller");
const { attachLedger } = require("../services/tutorLedger.service");

attachLedger(); // 用量账本：模块装上就订阅 AI 出口

router.get("/health", ctrl.health);
// 市场（docs/02 §7）：游客可逛、看详情（分享链落地不被登录墙挡）；登录了多两样：已下载态、拉黑过滤、scope=mine|installed
router.get("/market", optionalAuth, ctrl.market);
router.get("/market/:id", optionalAuth, ctrl.marketDetail);
router.get("/market/:id/ratings", optionalAuth, ctrl.ratings); // 评分列表 + 均分 / 分布 + 我的 + 能不能评（游客可看）
// M3 与启梦互通（tutor 仓 docs/06 §5.1「度量」）：各引流位带 ?from=，落到 /tutor 时客户端发一发 —— 游客也记（按 IP 指纹），只记不奖励；按 IP 限流，服务端再按天去重
router.post("/referral", optionalAuth, rateLimit({ max: 30, scope: "tutor:referral" }), validate({ body: S.referralBody }), ctrl.referral);
router.use(requireAuth);
router.get("/config", ctrl.config);
router.post("/declare-adult", validate({ body: S.emptyBody }), ctrl.declareAdult);

router.get("/courses", ctrl.listCourses);
router.post("/courses", userRateLimit({ max: 10, scope: "tutor:course" }), validate({ body: S.createCourseBody }), ctrl.createCourse);
router.get("/courses/:id", ctrl.getCourse);
router.patch("/courses/:id", validate({ body: S.patchCourseBody }), ctrl.patchCourse);
router.get("/courses/:id/materials", ctrl.materialsProbe);
router.head("/courses/:id/materials", ctrl.materialsProbe);
router.get("/courses/:id/rules", ctrl.rules);
router.get("/courses/:id/quote", ctrl.quote);

router.post("/materials/sign", userRateLimit({ max: 20, scope: "tutor:sign" }), validate({ body: S.signBody }), ctrl.sign);
// 每次都打一发 Cloudinary Admin API（免费档全局 500 次/小时），与成片 confirm 同一个量级
router.post("/materials/confirm", userRateLimit({ max: 10, scope: "tutor:confirm" }), validate({ body: S.confirmBody }), ctrl.confirm);
router.patch("/materials/:sha", validate({ body: S.licenseBody }), ctrl.materialLicense);
router.get("/materials/:sha/file", ctrl.materialFile);
router.get("/materials/:sha/text", ctrl.materialText);
router.get("/usage-ledger", ctrl.usageLedger);

router.post("/personas/generate", aiRateLimit({ max: 5, scope: "tutor:generate" }), validate({ body: S.generateBody }), ctrl.generate);
router.get("/jobs/:id", ctrl.getJob);
router.post("/personas/import", userRateLimit({ max: 10, scope: "tutor:import" }), validate({ body: S.importBody }), ctrl.importPersona);
router.post("/personas/:id/preview", aiRateLimit({ max: 20, scope: "tutor:turn" }), validate({ body: S.previewBody }), ctrl.preview);
router.post("/personas/:id/scan", aiRateLimit({ max: 5, scope: "tutor:scan" }), validate({ body: S.emptyBody }), ctrl.scan);
router.post("/personas/:id/patches/:pid/accept", validate({ body: S.acceptBody }), ctrl.accept);
router.get("/personas/:id/export", userRateLimit({ max: 20, scope: "tutor:export" }), ctrl.exportPersona);
router.get("/personas/:id/exports", ctrl.listExports);
// 发布 / 取消分享（docs/02 §6）：五道门在服务端一处，任一不过 422 + gate 指明哪一道
router.post("/personas/:id/publish", userRateLimit({ max: 10, scope: "tutor:publish" }), validate({ body: S.publishBody }), ctrl.publish);
router.delete("/personas/:id/publish", ctrl.unpublish);
// 「开始跟这位老师学」：从发布版复制出自己的一门课（幂等）
router.post("/runs", userRateLimit({ max: 20, scope: "tutor:start" }), validate({ body: S.startRunBody }), ctrl.startRun);
router.put("/market/:id/rating", userRateLimit({ max: 20, scope: "tutor:rate" }), validate({ body: S.ratingBody }), ctrl.rate); // 一人一票可改
router.delete("/market/:id/rating", ctrl.unrate);
router.post("/courses/:id/merge-release", userRateLimit({ max: 10, scope: "tutor:merge" }), validate({ body: S.emptyBody }), ctrl.mergeRelease); // 学习者合并作者的新版（docs/03 §6.3）
// 管理后台：教授认领（instructorClaim）的人工核实队列（tutor 仓 docs/06 §4.2）。requireRole 与通用举报队列同一把（utils/roles.ADMIN_ROLE）；
// 处置正文与 PATCH /api/admin/branch/reports/:id 同一份（reportResolve.service），这里只是单独一条车道 + 联系举报人那一步
router.get("/admin/claims", requireRole(ADMIN_ROLE), ctrl.claims);
router.post("/admin/claims/:id/contact", requireRole(ADMIN_ROLE), validate({ body: S.claimContactBody }), ctrl.claimContact);
router.post("/admin/claims/:id/verdict", requireRole(ADMIN_ROLE), validate({ body: S.claimVerdictBody }), ctrl.claimVerdict);
router.get("/admin/metrics", requireRole(ADMIN_ROLE), ctrl.metrics); // M3 三条度量（引流 / 跨产品激活 / 反哺 + fork 7 天），只读

router.get("/runs/:id", ctrl.getRun);
router.get("/runs/:id/turns", ctrl.getTurns);
router.get("/runs/:id/review-card", ctrl.getReviewCard);
router.get("/runs/:id/usage-export", ctrl.usageExport);
router.get("/runs/:id/review-due", ctrl.reviewDue);
router.get("/runs/:id/review-quiz", ctrl.reviewQuiz);
router.get("/runs/:id/revisions", ctrl.revisions);
router.patch("/runs/:id/progress", validate({ body: S.progressBody }), ctrl.progress);
router.post("/runs/:id/turns", aiRateLimit({ max: 20, scope: "tutor:turn" }), validate({ body: S.turnBody }), ctrl.turns);
router.post("/runs/:id/quiz", aiRateLimit({ max: 20, scope: "tutor:quiz" }), validate({ body: S.quizBody }), ctrl.quiz);
router.post("/runs/:id/skip", validate({ body: S.skipBody }), ctrl.skip);
router.post("/runs/:id/feedback", validate({ body: S.feedbackBody }), ctrl.feedback);
router.post("/runs/:id/distill", aiRateLimit({ max: 10, scope: "tutor:distill" }), validate({ body: S.emptyBody }), ctrl.distill);
router.post("/runs/:id/revisions/:rid/review", validate({ body: S.reviewBody }), ctrl.reviewRevision);
router.post("/runs/:id/revisions/:rid/revert", validate({ body: S.revertBody }), ctrl.revertRevision);

module.exports = router;
