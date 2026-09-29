var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var session_exports = {};
__export(session_exports, {
  BIGRAM_PASS: () => import_quiz.BIGRAM_PASS,
  CONTEXT_MAX: () => import_context.CONTEXT_MAX,
  DISTILL_EVERY_EXCHANGES: () => import_distill.DISTILL_EVERY_EXCHANGES,
  DISTILL_IDLE_MS: () => import_distill.DISTILL_IDLE_MS,
  HOMEWORK_RE: () => import_policy.HOMEWORK_RE,
  NEAR_DAYS: () => import_policy.NEAR_DAYS,
  PAGE_REF_RE: () => import_context.PAGE_REF_RE,
  PASS_RATIO: () => import_progress.PASS_RATIO,
  REVIEW_ANCHORED_MAX: () => import_reviewCard.REVIEW_ANCHORED_MAX,
  REVIEW_INTERVALS_DAYS: () => import_progress.REVIEW_INTERVALS_DAYS,
  REVIEW_QUESTIONS_MAX: () => import_reviewCard.REVIEW_QUESTIONS_MAX,
  RUN_STAGE_STATUS: () => import_progress.RUN_STAGE_STATUS,
  advance: () => import_progress.advance,
  allPassed: () => import_progress.allPassed,
  answerNumbers: () => import_quiz.answerNumbers,
  bigramOverlap: () => import_quiz.bigramOverlap,
  currentStageId: () => import_progress.currentStageId,
  demoDistillOps: () => import_distill.demoDistillOps,
  demoReply: () => import_demoTeacher.demoReply,
  describeOpValue: () => import_distill.describeOpValue,
  distillDue: () => import_distill.distillDue,
  distillPrompt: () => import_distill.distillPrompt,
  distillWindow: () => import_distill.distillWindow,
  dueReviews: () => import_progress.dueReviews,
  gradeAnswer: () => import_quiz.gradeAnswer,
  gradeQuiz: () => import_quiz.gradeQuiz,
  initProgress: () => import_progress.initProgress,
  nextReviewAt: () => import_progress.nextReviewAt,
  pageRefs: () => import_context.pageRefs,
  policyGate: () => import_policy.policyGate,
  progressToDoc: () => import_progress.progressToDoc,
  reviewCard: () => import_reviewCard.reviewCard,
  reviewQuestions: () => import_reviewCard.reviewQuestions,
  runStatusOf: () => import_progress.runStatusOf,
  selectionContext: () => import_context.selectionContext,
  stageOrder: () => import_progress.stageOrder,
  stepCount: () => import_progress.stepCount
});
module.exports = __toCommonJS(session_exports);
var import_progress = require("./progress.js");
var import_quiz = require("./quiz.js");
var import_policy = require("./policy.js");
var import_context = require("./context.js");
var import_demoTeacher = require("./demoTeacher.js");
var import_reviewCard = require("./reviewCard.js");
var import_distill = require("./distill.js");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BIGRAM_PASS,
  CONTEXT_MAX,
  DISTILL_EVERY_EXCHANGES,
  DISTILL_IDLE_MS,
  HOMEWORK_RE,
  NEAR_DAYS,
  PAGE_REF_RE,
  PASS_RATIO,
  REVIEW_ANCHORED_MAX,
  REVIEW_INTERVALS_DAYS,
  REVIEW_QUESTIONS_MAX,
  RUN_STAGE_STATUS,
  advance,
  allPassed,
  answerNumbers,
  bigramOverlap,
  currentStageId,
  demoDistillOps,
  demoReply,
  describeOpValue,
  distillDue,
  distillPrompt,
  distillWindow,
  dueReviews,
  gradeAnswer,
  gradeQuiz,
  initProgress,
  nextReviewAt,
  pageRefs,
  policyGate,
  progressToDoc,
  reviewCard,
  reviewQuestions,
  runStatusOf,
  selectionContext,
  stageOrder,
  stepCount
});
