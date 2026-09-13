/*
 * test-settings.js — 模拟代理环境测试 wloc-settings.js 的选点页接口兼容性
 * 运行：node test/test-settings.js
 *
 * 覆盖：保存(lon/lat/acc) → 查询 → 清除 → 参数别名 → 缺参报错 → CORS 头
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT = fs.readFileSync(
  path.join(__dirname, "..", process.env.WLOC_DIST === "1" ? "dist" : "scripts", "wloc-settings.js"),
  "utf8"
);

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed += 1; console.log("  PASS  " + name); }
  else { failed += 1; console.log("  FAIL  " + name); }
}

// 模拟一次代理调用：返回 { store, doneArg }
function run(url, store) {
  store = store || {};
  let doneArg = null;
  const sandbox = {
    console,
    $request: { url, method: "GET" },
    $done: (arg) => { doneArg = arg; },
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { if (v === null) delete store[k]; else store[k] = v; return true; }
    },
    $notification: { post: () => {} }
  };
  vm.runInNewContext(SCRIPT, sandbox, { filename: "wloc-settings.js" });
  return { store, doneArg };
}

function respBody(doneArg) {
  return JSON.parse(doneArg.response.body);
}
function respHeaders(doneArg) {
  return doneArg.response.headers;
}

console.log("# 测试目标: " + (process.env.WLOC_DIST === "1" ? "dist (混淆版)" : "scripts (源码)"));

console.log("== 1. 保存坐标（Yu9191 选点页格式） ==");
let shared = {};
{
  const { store, doneArg } = run("https://gs-loc.apple.com/wloc-settings/save?lon=113.934231&lat=22.531888&acc=25", shared);
  const body = respBody(doneArg);
  assert(body.success === true, "保存返回 success:true");
  assert(body.longitude === 113.934231 && body.latitude === 22.531888, "回显坐标正确");
  assert(respHeaders(doneArg)["Access-Control-Allow-Origin"] === "*", "响应带 CORS 头（选点页跨域必需）");
  const record = JSON.parse(store.wloc_settings);
  assert(record.latitude === 22.531888 && record.longitude === 113.934231, "存储坐标正确");
  assert(record.accuracy === 25 && record.horizontalAccuracy === 25, "accuracy/horizontalAccuracy 双格式都写入");
}

console.log("== 2. 查询已存坐标 ==");
{
  const { doneArg } = run("https://gs-loc.apple.com/wloc-settings/save?action=query", shared);
  const body = respBody(doneArg);
  assert(body.success === true && body.latitude === 22.531888 && body.longitude === 113.934231,
    "查询返回已存坐标");
  assert(body.accuracy === 25 && typeof body.updatedAt === "string", "查询返回精度和更新时间");
}

console.log("== 3. 清除坐标 ==");
{
  const { store, doneArg } = run("https://gs-loc.apple.com/wloc-settings/save?action=clear", shared);
  const body = respBody(doneArg);
  assert(body.success === true, "清除返回 success:true");
  assert(!("wloc_settings" in store), "存储已删除");
  const q = respBody(run("https://gs-loc.apple.com/wloc-settings/save?action=query", shared).doneArg);
  assert(q.success === false && q.error === "无已保存的坐标", "清除后查询 → 无已保存的坐标");
}

console.log("== 4. 参数别名与旧式 clear ==");
{
  const { doneArg } = run("https://gs-loc.apple.com/wloc-settings/save?longitude=121.47&latitude=31.23&accuracy=50", {});
  const body = respBody(doneArg);
  assert(body.success === true && body.accuracy === 50, "longitude/latitude/accuracy 别名可用");
  const c = respBody(run("https://gs-loc.apple.com/wloc-settings/save?clear=1", {}).doneArg);
  assert(c.success === true, "旧式 ?clear=1 兼容");
}

console.log("== 5. 异常入参 ==");
{
  const { doneArg } = run("https://gs-loc.apple.com/wloc-settings/save", {});
  assert(respBody(doneArg).success === false, "缺少 lon/lat → success:false");
  const zero = respBody(run("https://gs-loc.apple.com/wloc-settings/save?lon=0&lat=0", {}).doneArg);
  assert(zero.success === false, "0,0 坐标拒绝");
  const bad = respBody(run("https://gs-loc.apple.com/wloc-settings/save?lon=200&lat=22.5", {}).doneArg);
  assert(bad.success === false, "经度超范围拒绝");
}

console.log("\n结果: " + passed + " 通过, " + failed + " 失败");
process.exit(failed ? 1 : 0);
