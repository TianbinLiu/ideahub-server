/**
 * @file blocks.routes.js —— 拉黑（UGC 域）
 *
 * GET    /api/blocks            我拉黑了谁
 * POST   /api/blocks/:userId    拉黑（幂等）
 * DELETE /api/blocks/:userId    解除（回 removed）
 *
 * ★ 与 /api/messages/blacklist 写的是**同一张表**（一个人只有一份拉黑名单），
 *   区别是这一套不带私信域的三道防滥用闸 —— 理由见 controllers/blocks.controller.js 的 ★★。
 */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { listBlocks, createBlock, removeBlock } = require("../controllers/blocks.controller");

const router = express.Router();

router.use(requireAuth);
router.get("/", listBlocks);
router.post("/:userId", createBlock);
router.delete("/:userId", removeBlock);

module.exports = router;
