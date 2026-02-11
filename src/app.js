const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const healthRoutes = require("./routes/health.routes");
const ideaRoutes = require("./routes/ideas.routes");
const authRoutes = require("./routes/auth.routes");
const meRoutes = require("./routes/me.routes");
const { notFound, errorHandler } = require("./middleware/error");
const companyRoutes = require("./routes/company.routes");


const app = express();

app.use(cors());
app.use(express.json());
app.use(helmet());
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    ok: false,
    message:
      process.env.NODE_ENV === "production"
        ? "Server error"
        : err.message,
  });
});

if (typeof req.query.keyword !== "string") return;

app.use("/api", healthRoutes);
app.use("/api/ideas", ideaRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/me", meRoutes);
app.use("/api/company", companyRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
