/*
 * test-core.js — 用 Node 验证 wloc.js 的核心改写逻辑
 * 运行：node test/test-core.js
 */
"use strict";

// 默认测源码；WLOC_DIST=1 时测混淆后的发布版
const core = require(process.env.WLOC_DIST === "1" ? "../dist/wloc.js" : "../scripts/wloc.js");
console.log("# 测试目标: " + (process.env.WLOC_DIST === "1" ? "dist/wloc.js (混淆版)" : "scripts/wloc.js (源码)"));

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed += 1; console.log("  PASS  " + name); }
  else { failed += 1; console.log("  FAIL  " + name); }
}

// ---- 构造一个仿真的 AppleWLoc protobuf ----
// Location: field1=lat(varint), field2=lon(varint), field3=accuracy, field4=altitude(保留字段)
function makeLocation(lat, lon, acc, altitude) {
  return core.concatBytes([
    core.makeVarintField(1, core.coordToInt(lat)),
    core.makeVarintField(2, core.coordToInt(lon)),
    core.makeVarintField(3, acc),
    core.makeVarintField(4, altitude)
  ]);
}
// WifiDevice: field1=BSSID(bytes, 应原样保留), field2=Location
function makeWifiDevice(lat, lon) {
  return core.concatBytes([
    core.makeLengthDelimitedField(1, core.bytesFromArray([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])),
    core.makeLengthDelimitedField(2, makeLocation(lat, lon, 50, 530))
  ]);
}
// CellTower: field1=mcc(varint, 保留), field5=Location
function makeCellTower(lat, lon) {
  return core.concatBytes([
    core.makeVarintField(1, 460),
    core.makeLengthDelimitedField(5, makeLocation(lat, lon, 1000, 10))
  ]);
}
// Root: field2=wifi x2, field22=cell, field24=cell, field3=其他根字段(保留)
function makeWLocPayload() {
  return core.concatBytes([
    core.makeVarintField(3, 12345), // 根级保留字段
    core.makeLengthDelimitedField(2, makeWifiDevice(31.2304, 121.4737)),
    core.makeLengthDelimitedField(2, makeWifiDevice(39.9042, 116.4074)),
    core.makeLengthDelimitedField(22, makeCellTower(31.2304, 121.4737)),
    core.makeLengthDelimitedField(24, makeCellTower(39.9042, 116.4074))
  ]);
}

function makeArpcResponse(payload) {
  return core.concatBytes([
    core.writeUInt16BE(1),
    core.writePascalString("zh_CN"),
    core.writePascalString("com.apple.locationd"),
    core.writePascalString("17.0.0"),
    core.writeUInt32BE(1),
    core.writeUInt32BE(payload.length),
    payload
  ]);
}

// ---- 从改写后的 payload 中提取所有 Location 坐标 ----
function extractAllLocations(payload) {
  const out = [];
  const root = core.parseFields(payload);
  for (const f of root) {
    if (f.fieldNumber === 2 && f.wireType === 2) {
      const wifi = core.parseFields(f.valueBytes);
      const loc = core.firstFieldByNumber(wifi, 2);
      if (loc) {
        const lf = core.parseFields(loc.valueBytes);
        out.push({
          kind: "wifi",
          lat: core.signedVarintFieldValue(core.firstFieldByNumber(lf, 1)) / 1e8,
          lon: core.signedVarintFieldValue(core.firstFieldByNumber(lf, 2)) / 1e8,
          acc: core.signedVarintFieldValue(core.firstFieldByNumber(lf, 3)),
          altitude: core.signedVarintFieldValue(core.firstFieldByNumber(lf, 4))
        });
      }
    }
    if ((f.fieldNumber === 22 || f.fieldNumber === 24) && f.wireType === 2) {
      const cell = core.parseFields(f.valueBytes);
      const loc = core.firstFieldByNumber(cell, 5);
      if (loc) {
        const lf = core.parseFields(loc.valueBytes);
        out.push({
          kind: "cell",
          lat: core.signedVarintFieldValue(core.firstFieldByNumber(lf, 1)) / 1e8,
          lon: core.signedVarintFieldValue(core.firstFieldByNumber(lf, 2)) / 1e8
        });
      }
    }
  }
  return out;
}

const TARGET = { latitude: 51.51042, longitude: -3.218306, horizontalAccuracy: 39 };

console.log("== 测试 1：ARPC 格式响应改写 ==");
{
  const payload = makeWLocPayload();
  const arpcResp = makeArpcResponse(payload);
  const result = core.spoofAppleResponse(arpcResp, TARGET);
  assert(result.kind === "arpc", "识别为 arpc 格式 (实际: " + result.kind + ")");
  assert(result.wifiCount === 2, "改写 2 个 WiFi 设备 (实际: " + result.wifiCount + ")");
  assert(result.cellCount === 2, "改写 2 个基站 (实际: " + result.cellCount + ")");

  // 回读：ARPC 信封元数据应保持
  const arpc = core.parseArpc(result.response);
  assert(arpc.locale === "zh_CN" && arpc.appIdentifier === "com.apple.locationd", "ARPC 元数据保留");

  const locs = extractAllLocations(arpc.payload);
  assert(locs.length === 4, "回读出 4 个位置 (实际: " + locs.length + ")");
  const allTarget = locs.every(l =>
    Math.abs(l.lat - TARGET.latitude) < 1e-6 && Math.abs(l.lon - TARGET.longitude) < 1e-6);
  assert(allTarget, "所有坐标已替换为目标值（含负经度）");
  const wifiLocs = locs.filter(l => l.kind === "wifi");
  assert(wifiLocs.every(l => l.acc === TARGET.horizontalAccuracy), "精度已替换为 " + TARGET.horizontalAccuracy);
  assert(wifiLocs.every(l => l.altitude === 530), "海拔等非目标字段原样保留");

  // 根级保留字段仍在
  const rootFields = core.parseFields(arpc.payload);
  const f3 = core.firstFieldByNumber(rootFields, 3);
  assert(f3 && core.signedVarintFieldValue(f3) === 12345, "根级其他字段原样保留");

  // BSSID 保留
  const wifi0 = core.parseFields(core.firstFieldByNumber(rootFields, 2).valueBytes);
  const bssid = core.firstFieldByNumber(wifi0, 1);
  assert(bssid && bssid.valueBytes[0] === 0xaa && bssid.valueBytes.length === 6, "WiFi BSSID 原样保留");
}

console.log("== 测试 2：synthetic 前缀格式改写 ==");
{
  const payload = makeWLocPayload();
  const synthetic = core.buildAppleWLocResponse(payload);
  const result = core.spoofAppleResponse(synthetic, TARGET);
  assert(result.kind === "synthetic", "识别为 synthetic 格式 (实际: " + result.kind + ")");
  const locs = extractAllLocations(result.response.slice(10));
  assert(locs.every(l => Math.abs(l.lat - TARGET.latitude) < 1e-6), "synthetic 坐标替换正确");
}

console.log("== 测试 3：marker 格式改写 ==");
{
  const payload = makeWLocPayload();
  const markerResp = core.concatBytes([
    core.bytesFromArray([0x11, 0x22]),       // 前置垃圾字节
    core.APPLE_WLOC_MARKER,
    core.writeUInt16BE(payload.length),
    payload
  ]);
  const result = core.spoofAppleResponse(markerResp, TARGET);
  assert(result.kind === "marker", "识别为 marker 格式 (实际: " + result.kind + ")");
  // 回读：前缀保留 + 长度更新
  assert(result.response[0] === 0x11 && result.response[1] === 0x22, "marker 前缀字节保留");
  const locs = extractAllLocations(result.response.slice(2 + 6 + 2));
  assert(locs.every(l => Math.abs(l.lon - TARGET.longitude) < 1e-6), "marker 坐标替换正确");
}

console.log("== 测试 4：int64 负数坐标往返编码 ==");
{
  const neg = core.makeVarintField(1, core.coordToInt(-122.00902));
  const f = core.parseFields(neg)[0];
  const back = core.signedVarintFieldValue(f) / 1e8;
  assert(Math.abs(back - (-122.00902)) < 1e-6, "负经度 -122.00902 往返一致 (实际: " + back + ")");
  const negBytes = neg.length;
  assert(negBytes === 11, "负 int64 使用 10 字节 varint 编码 (字段总长: " + negBytes + ")");
}

console.log("== 测试 5：配置归一化与边界 ==");
{
  const cfg = core.normalizeConfig({ latitude: "22.5", longitude: "113.9", debug: "true" });
  assert(cfg.latitude === 22.5 && cfg.longitude === 113.9 && cfg.debug === true, "字符串参数正确解析");
  let threw = false;
  try { core.normalizeConfig({ latitude: 91, longitude: 0 }); } catch (e) { threw = true; }
  assert(threw, "非法纬度(>90)抛错");
}

console.log("== 测试 6：授权判定 decideAuth（含到期时间） ==");
{
  const cfg = core.normalizeConfig({ authTtl: 21600 });
  const now = Date.now();
  assert(core.decideAuth(null, now, cfg) === "fetch", "无缓存 → fetch");
  assert(core.decideAuth({ allowed: true, ts: now - 1000 }, now, cfg) === "allow", "缓存新鲜且允许 → allow");
  assert(core.decideAuth({ allowed: false, ts: now - 1000 }, now, cfg) === "deny", "缓存新鲜但拒绝 → deny");
  assert(core.decideAuth({ allowed: true, ts: now - 21601 * 1000 }, now, cfg) === "fetch", "缓存过期 → fetch");
  assert(core.decideAuth({ allowed: true }, now, cfg) === "fetch", "缓存缺 ts → fetch");
  // 到期时间相关
  assert(core.decideAuth({ allowed: true, ts: now - 1000, expiresAt: now - 1000 }, now, cfg) === "deny",
    "本地已知到期（哪怕缓存新鲜）→ deny");
  assert(core.decideAuth({ allowed: true, ts: now - 21601 * 1000, expiresAt: now - 1000 }, now, cfg) === "deny",
    "缓存过期且已到期 → deny（不再请求服务器，防断网续命）");
  assert(core.decideAuth({ allowed: true, ts: now - 1000, expiresAt: now + 86400000 }, now, cfg) === "allow",
    "未到期且缓存新鲜 → allow");
  assert(core.decideAuth({ allowed: true, ts: now - 21601 * 1000, expiresAt: now + 86400000 }, now, cfg) === "fetch",
    "未到期但缓存过期 → fetch 重新校验");
}

console.log("\n结果: " + passed + " 通过, " + failed + " 失败");
process.exit(failed > 0 ? 1 : 0);
