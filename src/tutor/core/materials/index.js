// server 侧只要纯函数那几样：切块 / 块 hash / 找短引 / 锚点定位 / PPTX 幻灯 XML（浏览器抽文本、服务端不解析，docs/05 §4.2 D3）。
// tutor 仓的 index.js 还导出 extract / hash / manifest（本地文件系统那一套），服务端没有这些，所以这一份手写（port-core 不覆盖）。
"use strict";
module.exports = {
  ...require("./anchors.js"),
  ...require("./pptxXml.js"),
  ...require("./blocks.js"),
};
