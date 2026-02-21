const router = require("express").Router();
const { searchUsers } = require("../controllers/users.controller");

// GET /api/users/search?q=username&limit=8
router.get("/search", searchUsers);

module.exports = router;
