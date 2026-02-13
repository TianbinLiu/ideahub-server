const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const healthRoutes = require("./routes/health.routes");
const ideaRoutes = require("./routes/ideas.routes");
const authRoutes = require("./routes/auth.routes");
const meRoutes = require("./routes/me.routes");
const { notFound, errorHandler } = require("./middleware/error");
const companyRoutes = require("./routes/company.routes");
const notificationsRoutes = require("./routes/notifications.routes");


const app = express();

app.use(cors());
app.use(express.json());
app.use(helmet());

app.use("/api", healthRoutes);
app.use("/api/ideas", ideaRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/me", meRoutes);
app.use("/api/company", companyRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/ai-jobs", require("./routes/aiJobs.routes"));
app.use("/api/admin", require("./routes/admin.routes"));



app.use(notFound);
app.use(errorHandler);

module.exports = app;
