require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean), quiet: true });
require("./src/config/cloudinary");
const cloudinary = require("cloudinary").v2;
(async () => {
  const r = await cloudinary.api.resources({ type: "upload", resource_type: "image", max_results: 12, direction: "desc" });
  for (const x of (r.resources || []).slice(0, 12)) {
    console.log(`${x.created_at}  ${x.format.padEnd(5)} ${String(x.width)+"x"+x.height}  ${x.public_id}`);
  }
})().catch((e) => console.log("ERR " + e.message));
