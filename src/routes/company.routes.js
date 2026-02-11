const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { listCompanyInterests } = require("../controllers/interest.controller");

router.get("/interests", requireAuth, listCompanyInterests);

module.exports = router;
