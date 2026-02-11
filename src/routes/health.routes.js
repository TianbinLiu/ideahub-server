const router = require("express").Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, message: "IdeaHub server is running!", time: new Date().toISOString() });
});

module.exports = router;
