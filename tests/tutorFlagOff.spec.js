/**
 * docs/06 §3.3：TUTOR_ENABLED 为假时整棵 tutor 树不 require、/api/tutor/* 404；docs/06 D1 / D3 的 rg 验法钉成 spec。
 * 不碰 Mongo（app 的装载不连库；/api/tutor 没挂时 404 走的是通用兜底）。
 * ★ 与 tutorFlagOn.spec 分成两个文件：jest 每个文件一套模块注册表，开关在 require 那一拍读，同一文件里翻不了第二次。
 */
const fs = require("fs");
const path = require("path");
const request = require("supertest");

const SRC = path.join(__dirname, "../src");
let app;
beforeAll(() => {
  delete process.env.TUTOR_ENABLED;
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  app = require("../src/app");
});

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const rel = (f) => path.relative(SRC, f).split(path.sep).join("/");

describe("TUTOR_ENABLED 关着", () => {
  it("/api/tutor/* 404，tutor 那棵树一个模块都没加载（deploy.sh 的装载自检 = 关开关即回滚）", async () => {
    const r = await request(app).get("/api/tutor/health");
    expect(r.status).toBe(404);
    const loaded = Object.keys(require.cache).filter((k) => /[\\/]src[\\/]tutor[\\/]|tutor\.(routes|controller|worker)\.js|tutor[A-Z][A-Za-z]*\.service\.js|tutor\.schemas\.js/.test(k));
    expect(loaded).toEqual([]);
  });
});

describe("docs/06 D1 / D3 的 rg 验法", () => {
  it("D1：tutor 代码只进 tutor* 文件；其余提到 tutor 的文件只有这份清单，每一条都有理由（新漏一处这里就红）", () => {
    // 清单里的每一项都是「必须碰既有文件」的接线点，不是逻辑外泄：加一条要在这里写清为什么
    const ALLOW = {
      "app.js": "挂载 + TUTOR_ENABLED 开关（唯一一处）",
      "index.js": "worker 只在实例 0 且开关开着时起",
      "config/tokens.js": "TUTOR_PRICES 价目（报价与结算一处，D5）",
      "config/preflight.js": "TUTOR_* 变量自检",
      "middleware/bigJson.js": "jsonGateWith：给 /api/tutor 单独上限时抽出来的工厂",
      "models/TokenLedger.js": "tutor_refund 流水原因（跨仓枚举服务端先上，D4）",
      "models/User.js": "tutorAdultDeclaredAt（D9）",
      "services/tokenWallet.service.js": "SPEND_REASONS 含 tutor_refund",
      "services/aiClient.js": "opts.model：教学 / 蒸馏两档模型的注释",
      "models/Persona.js": "kind / course / currentDoc / remixOf（S3，判否定）",
      "services/personaKind.js": "列表缺省过滤（S4，唯一实现）",
      "schemas/persona.schemas.js": "说明不收 kind（D4）",
    };
    const hits = walk(SRC)
      .filter((f) => f.endsWith(".js") && !/tutor/i.test(path.basename(f)) && !/[\\/]tutor[\\/]/.test(f))
      .filter((f) => /tutor/i.test(fs.readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(hits).toEqual(Object.keys(ALLOW).sort());
  });
  it("D3：服务端不带任何文档解析依赖（抽文本在浏览器端）", () => {
    const pkg = require("../package.json");
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const bad of ["pdf-parse", "mammoth", "officeparser", "pdfjs-dist", "pdf2json", "textract"]) expect(deps[bad]).toBeUndefined();
  });
});
