require("dotenv").config();
const app = require("./app");
const { connectDB } = require("./config/db");

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

start();
