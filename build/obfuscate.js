/*
 * build/obfuscate.js — 把 scripts/ 下的源码混淆后输出到 dist/
 * 用法：pnpm install 之后执行  pnpm run build
 *
 * 混淆参数的选择原则：
 *  - 兼容代理工具的老 JavaScriptCore（iOS 12）：只产出 ES5 语法，不用 eval
 *  - 不改写属性名 / 对象键名：脚本要解析 JSON（allowed/expiresAt 等）、
 *    要遍历 DEFAULT_CONFIG 的键做配置合并，改键名会直接坏掉
 *  - 字符串进数组 + base64：藏住授权地址、正则、存储 key 等敏感字符串
 *  - 不做控制流平坦化 / 死代码注入：protobuf 解析是热路径，保命要紧
 */
"use strict";

const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const ROOT = path.join(__dirname, "..");
const FILES = ["wloc.js", "wloc-settings.js"];

const OPTIONS = {
  target: "browser",
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,        // $request/$response/$done/module 等全局名必须保留
  renameProperties: false,     // bodyBytes/allowed/expiresAt 等属性名必须保留
  transformObjectKeys: false,  // DEFAULT_CONFIG 键名参与配置合并逻辑，不能动
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: ["base64"],
  rotateStringArray: true,
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  numbersToExpressions: true,
  simplify: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,        // 开了一旦被格式化就自毁，不利于排错
  disableConsoleOutput: false, // debug 日志要用 console.log
  unicodeEscapeSequence: false
};

const HEADER = "/* wloc 发布版（混淆）。源码见 scripts/，请勿手改本文件；修改请改源码后运行 pnpm run build 重新生成。 */\n";

let failed = 0;
for (const name of FILES) {
  const srcPath = path.join(ROOT, "scripts", name);
  const outPath = path.join(ROOT, "dist", name);
  // 公开仓库可能不包含 scripts/ 源码（只发布 dist/），
  // Cloudflare 自动构建时跳过即可，不要让整个部署失败
  if (!fs.existsSync(srcPath)) {
    console.log("SKIP " + name + "（scripts/ 源码不在仓库中，沿用已提交的 dist/）");
    continue;
  }
  const source = fs.readFileSync(srcPath, "utf8");
  try {
    const result = JavaScriptObfuscator.obfuscate(source, OPTIONS);
    fs.writeFileSync(outPath, HEADER + result.getObfuscatedCode(), "utf8");
    const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log("OK  dist/" + name + "  (" + kb + " KB)");
  } catch (err) {
    failed += 1;
    console.error("FAIL " + name + ": " + err.message);
  }
}
process.exit(failed ? 1 : 0);
