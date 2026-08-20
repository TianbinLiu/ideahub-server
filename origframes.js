require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean), quiet: true });
const fs = require("fs");
require("./src/config/cloudinary");
const { buildOutFrameUrl } = require("./src/utils/templateVideoAsset");
const b = require("./src/services/blockoutize.service");
const PUB = "ideahub/template-videos/6993983fe974359db8d23ad4-1786941475509";
const OUT = process.env.TMPDIR || ".";
(async () => {
  for (const s of [0.5, 2, 4, 6, 10, 12, 14]) {
    const f = await b.fetchFrameDataUrl(buildOutFrameUrl(PUB, s, undefined, 1024));
    if (f.ok) { fs.writeFileSync(`${OUT}/o55-${String(s).replace(".", "_")}.jpg`, Buffer.from(f.dataUrl.split(",")[1], "base64")); console.log("[x] " + s); }
    else console.log("[x] " + s + " fail");
  }
})().catch((e) => console.log("ERR " + e.message));
