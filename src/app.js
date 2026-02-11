const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/health.routes");
const ideaRoutes = require("./routes/ideas.routes");
const authRoutes = require("./routes/auth.routes");
const meRoutes = require("./routes/me.routes");
const { notFound, errorHandler } = require("./middleware/error");
const companyRoutes = require("./routes/company.routes");


const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", healthRoutes);
app.use("/api/ideas", ideaRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/me", meRoutes);
app.use("/api/company", companyRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
