// 本地端到端验证用：拿 mongodb-memory-server 起一套一次性数据库，再拉起整个服务端。
// 用途：真机 App（adb reverse 到 localhost:4000）连本机服务端跑全链路，不碰 Atlas
// （开发机的 Atlas 账号是只读的，写操作在真库上必然失败——见 memory/atlas-db-access-split）。
// 用法：node scripts/dev-memory-server.js   （Ctrl+C 结束，库随进程一起消失）
process.env.NODE_ENV = process.env.NODE_ENV || "development";

async function main() {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongod = await MongoMemoryServer.create();
  // 必须在 require 入口之前定死：dotenv 不覆盖已有环境变量，这里先写谁就用谁
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "dev-memory-secret";
  // 4000 在这台开发机的 Windows 保留端口段里（3954-4053，netsh excludedportrange），
  // bind 会直接被拒——默认给 4200
  process.env.PORT = process.env.PORT || "4200";
  console.log("[dev-memory] mongo:", process.env.MONGO_URI);
  require("../src/index.js");
}

main().catch((e) => {
  console.error("[dev-memory] 起不来:", e);
  process.exit(1);
});
