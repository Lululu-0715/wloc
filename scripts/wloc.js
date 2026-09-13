/*
 * wloc.js — 代理改定位核心脚本
 * 支持：Surge / Shadowrocket / Loon / Stash / Quantumult X
 *
 * 原理：
 *   iPhone 用周围 Wi-Fi 热点 BSSID 和蜂窝基站信息请求 Apple 网络定位服务
 *   (gs-loc.apple.com/clls/wloc)，Apple 返回这些设备的坐标清单，iOS 据此
 *   推算本机位置。本脚本在响应回设备的路上拦截，把清单里的坐标全部替换为
 *   目标坐标，再按原协议格式封回，系统算出来的位置就是指定位置。
 *
 * 协议处理：
 *   拆 ARPC 封包 → 解 protobuf 字段 → 替换 Location 子消息(纬度1/经度2/精度3)
 *   → 重新打包 → 按原格式(ARPC / marker / synthetic / bare)封回。
 *
 * 兼容 iOS 12 JavaScriptCore：刻意不使用 BigInt 语法，int64 用高低位表示。
 * 参考：acheong08/ios-location-spoofer（原始研究）、bg4sgp 的 JS 移植思路。
 */
(function () {
  "use strict";

  /* ============================== 默认配置 ============================== */

  var DEFAULT_CONFIG = {
    enabled: true,
    latitude: 22.544577,      // 默认：深圳
    longitude: 113.94114,
    horizontalAccuracy: 25,   // 水平精度（米）
    failOpen: true,           // 出错时放行原始响应（不影响正常定位）
    debug: false,
    // ---- 授权控制（可选）：licenseKey 为空则完全不启用授权检查 ----
    licenseKey: "",           // 使用者的 key，由提供方分配
    authUrl: "https://wloc-1993.575613136.workers.dev/check", // 授权服务地址
    authTtl: 21600,           // 授权结果缓存秒数（默认 6 小时，期间不发请求）
    authGrace: 259200,        // 服务器不可达时的宽限秒数（默认 72 小时内沿用旧结果）
    strictAuth: false,        // true = 从未拿到授权结果时拒绝（默认放行）
    authNotify: true          // 被拒绝/到期时弹通知（每天最多一次）
  };

  // 持久化存储 key：在线选点 / 快捷指令写入的目标坐标
  var STORE_KEY = "wloc_settings";
  // 授权结果缓存 / 拒绝通知节流 / 设备指纹的存储 key
  var AUTH_STORE_KEY = "wloc_auth";
  var AUTH_NOTIFY_KEY = "wloc_auth_notify";
  var DEVICE_KEY = "wloc_device_id";

  // synthetic（伪造）响应前缀，对应原始 Go 实现 initialBytes = 0001000000010000
  var APPLE_WLOC_PREFIX = bytesFromArray([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
  // 真实 Apple 响应中 protobuf 载荷前的稳定标记，其后跟 uint16(BE) 长度
  var APPLE_WLOC_MARKER = bytesFromArray([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);

  // 根消息中蜂窝基站响应的字段号
  var CELL_RESPONSE_FIELDS = { 22: true, 24: true };
  // Location 子消息只改写 纬度(1)/经度(2)/精度(3)，其余字段原样透传。
  // 改动越少越不容易被 iOS 判定为非法响应而显示“定位不可用”。
  var LOC_FIELD_LAT = 1;
  var LOC_FIELD_LON = 2;
  var LOC_FIELD_ACC = 3;

  /* ============================== 字节工具 ============================== */

  function bytesFromArray(values) { return new Uint8Array(values); }

  function concatBytes(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i += 1) total += parts[i].length;
    var out = new Uint8Array(total), offset = 0;
    for (i = 0; i < parts.length; i += 1) { out.set(parts[i], offset); offset += parts[i].length; }
    return out;
  }

  function findBytes(bytes, marker) {
    if (!bytes || !marker || marker.length === 0) return -1;
    for (var i = 0; i <= bytes.length - marker.length; i += 1) {
      var ok = true;
      for (var j = 0; j < marker.length; j += 1) {
        if (bytes[i + j] !== marker[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  function binaryStringToBytes(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff;
    return out;
  }

  function bytesToBinaryString(bytes) {
    var chunkSize = 0x8000, chunks = [];
    for (var i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + chunkSize))));
    }
    return chunks.join("");
  }

  // 各平台响应体形态不一：Surge/Loon/小火箭/Stash 开 binary-body-mode 后给
  // bodyBytes(Uint8Array)；QX 视版本给 bodyBytes 或二进制字符串 body。
  function bodyToBytes(body) {
    if (body == null) return null;
    if (body instanceof Uint8Array) return body;
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof body === "string") return binaryStringToBytes(body);
    if (typeof body === "object" && typeof body.length === "number") return new Uint8Array(body);
    return null;
  }

  function messageBodyToBytes(message) {
    if (!message) return null;
    return bodyToBytes(message.bodyBytes) || bodyToBytes(message.body) ||
           bodyToBytes(message.rawBody) || bodyToBytes(message.binaryBody);
  }

  function readUInt16BE(bytes, offset) {
    if (offset + 2 > bytes.length) throw new Error("uint16 out of range");
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function readUInt32BE(bytes, offset) {
    if (offset + 4 > bytes.length) throw new Error("uint32 out of range");
    return ((bytes[offset] * 0x1000000) +
      ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0;
  }

  function writeUInt16BE(value) {
    return bytesFromArray([(value >> 8) & 0xff, value & 0xff]);
  }

  function writeUInt32BE(value) {
    return bytesFromArray([(value >>> 24) & 0xff, (value >>> 16) & 0xff,
      (value >>> 8) & 0xff, value & 0xff]);
  }

  function asciiBytes(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0x7f;
    return out;
  }

  /* ==================== int64（无 BigInt，高低位实现） ==================== */

  var UINT32_BASE = 4294967296;
  var MAX_SAFE_INTEGER = 9007199254740991;

  function uint64FromUnsignedNumber(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number < 0 || Math.floor(number) !== number || number > MAX_SAFE_INTEGER) {
      throw new Error("invalid unsigned varint value: " + value);
    }
    return { low: number >>> 0, high: Math.floor(number / UINT32_BASE) >>> 0 };
  }

  function uint64FromSignedNumber(value) {
    var number = Math.trunc(Number(value));
    if (!Number.isFinite(number) || Math.abs(number) > MAX_SAFE_INTEGER) {
      throw new Error("invalid signed int64 value: " + value);
    }
    if (number >= 0) return uint64FromUnsignedNumber(number);
    var magnitude = uint64FromUnsignedNumber(-number);
    var low = (~magnitude.low + 1) >>> 0;
    var carry = low === 0 ? 1 : 0;
    return { low: low, high: (~magnitude.high + carry) >>> 0 };
  }

  function uint64ToSafeNumber(words) {
    var value = (words.high >>> 0) * UINT32_BASE + (words.low >>> 0);
    if (value > MAX_SAFE_INTEGER) throw new Error("uint64 exceeds safe integer range");
    return value;
  }

  function uint64ToSignedNumber(words) {
    var low = words.low >>> 0, high = words.high >>> 0;
    if ((high & 0x80000000) === 0) return uint64ToSafeNumber({ low: low, high: high });
    var magnitudeLow = (~low + 1) >>> 0;
    var carry = magnitudeLow === 0 ? 1 : 0;
    var magnitudeHigh = (~high + carry) >>> 0;
    var magnitude = magnitudeHigh * UINT32_BASE + magnitudeLow;
    if (magnitude > MAX_SAFE_INTEGER) throw new Error("int64 exceeds safe integer range");
    return -magnitude;
  }

  function encodeVarintWords(words) {
    var low = words.low >>> 0, high = words.high >>> 0, out = [];
    while (high !== 0 || low >= 0x80) {
      out.push((low & 0x7f) | 0x80);
      low = ((low >>> 7) | (high << 25)) >>> 0;
      high = high >>> 7;
    }
    out.push(low & 0x7f);
    return bytesFromArray(out);
  }

  function encodeVarintUnsigned(value) { return encodeVarintWords(uint64FromUnsignedNumber(value)); }
  function encodeVarintSignedInt64(value) { return encodeVarintWords(uint64FromSignedNumber(value)); }

  function decodeVarint(bytes, offset) {
    var low = 0, high = 0, shift = 0, current = offset, count = 0;
    while (current < bytes.length && count < 10) {
      var b = bytes[current], payload = b & 0x7f;
      current += 1; count += 1;
      if (shift < 32) {
        low = (low | ((payload << shift) >>> 0)) >>> 0;
        if (shift > 25) high = (high | (payload >>> (32 - shift))) >>> 0;
      } else {
        if (shift === 63 && payload > 1) throw new Error("varint exceeds uint64 range");
        high = (high | ((payload << (shift - 32)) >>> 0)) >>> 0;
      }
      if ((b & 0x80) === 0) return { low: low, high: high, offset: current };
      shift += 7;
    }
    if (count >= 10) throw new Error("varint too long");
    throw new Error("unterminated varint");
  }

  /* ============================== protobuf ============================== */

  function makeKey(fieldNumber, wireType) {
    return encodeVarintUnsigned(fieldNumber * 8 + wireType);
  }

  function makeVarintField(fieldNumber, value) {
    return concatBytes([makeKey(fieldNumber, 0), encodeVarintSignedInt64(value)]);
  }

  function makeLengthDelimitedField(fieldNumber, payload) {
    return concatBytes([makeKey(fieldNumber, 2), encodeVarintUnsigned(payload.length), payload]);
  }

  function parseFields(bytes) {
    var fields = [], offset = 0;
    while (offset < bytes.length) {
      var keyStart = offset;
      var key = decodeVarint(bytes, offset);
      offset = key.offset;
      var keyValue = uint64ToSafeNumber(key);
      var fieldNumber = Math.floor(keyValue / 8);
      var wireType = keyValue & 0x7;
      if (fieldNumber === 0) throw new Error("protobuf field number 0");

      var valueStart = offset, valueEnd;
      if (wireType === 0) {
        valueEnd = decodeVarint(bytes, offset).offset;
      } else if (wireType === 1) {
        valueEnd = offset + 8;
      } else if (wireType === 2) {
        var lengthInfo = decodeVarint(bytes, offset);
        valueStart = lengthInfo.offset;
        valueEnd = valueStart + uint64ToSafeNumber(lengthInfo);
      } else if (wireType === 5) {
        valueEnd = offset + 4;
      } else {
        throw new Error("unsupported protobuf wire type: " + wireType);
      }
      if (valueEnd > bytes.length) throw new Error("protobuf field exceeds buffer");

      fields.push({
        fieldNumber: fieldNumber, wireType: wireType,
        raw: bytes.slice(keyStart, valueEnd),
        valueBytes: bytes.slice(valueStart, valueEnd)
      });
      offset = valueEnd;
    }
    return fields;
  }

  function tryParseFields(bytes) {
    try {
      if (!bytes || bytes.length === 0) return null;
      var fields = parseFields(bytes);
      return fields.length > 0 ? fields : null;
    } catch (e) { return null; }
  }

  function firstFieldByNumber(fields, fieldNumber) {
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].fieldNumber === fieldNumber) return fields[i];
    }
    return null;
  }

  function signedVarintFieldValue(field) {
    if (!field || field.wireType !== 0) return null;
    return uint64ToSignedNumber(decodeVarint(field.valueBytes, 0));
  }

  function coordToInt(value) {
    // 与 Go 的 int64(coord * 1e8) 行为一致
    return Math.trunc(Number(value) * 100000000);
  }

  function isCellResponseField(fieldNumber) { return CELL_RESPONSE_FIELDS[fieldNumber] === true; }

  /* ============================ 坐标改写逻辑 ============================ */

  // 最小改写：只替换已存在的 纬度(1)/经度(2)/精度(3)，不新增、不改动其他字段。
  // 若子消息本身没有经纬度，说明不是目标，原样放行。
  function patchLocation(locationPayload, config) {
    var fields = locationPayload.length ? parseFields(locationPayload) : [];
    var hasLat = false, hasLon = false, i;
    for (i = 0; i < fields.length; i += 1) {
      if (fields[i].fieldNumber === LOC_FIELD_LAT && fields[i].wireType === 0) hasLat = true;
      if (fields[i].fieldNumber === LOC_FIELD_LON && fields[i].wireType === 0) hasLon = true;
    }
    if (!hasLat || !hasLon) return locationPayload;

    var parts = [];
    for (i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === LOC_FIELD_LAT && field.wireType === 0) {
        parts.push(makeVarintField(LOC_FIELD_LAT, coordToInt(config.latitude)));
      } else if (field.fieldNumber === LOC_FIELD_LON && field.wireType === 0) {
        parts.push(makeVarintField(LOC_FIELD_LON, coordToInt(config.longitude)));
      } else if (field.fieldNumber === LOC_FIELD_ACC && field.wireType === 0) {
        parts.push(makeVarintField(LOC_FIELD_ACC, config.horizontalAccuracy));
      } else {
        parts.push(field.raw);
      }
    }
    return concatBytes(parts);
  }

  // WiFi 设备消息：field 2 = Location 子消息
  function patchWifiDevice(wifiPayload, config) {
    var fields = parseFields(wifiPayload), parts = [];
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === 2 && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(2, patchLocation(field.valueBytes, config)));
      } else {
        parts.push(field.raw);
      }
    }
    return concatBytes(parts);
  }

  // 蜂窝基站消息：field 5 = Location 子消息
  function patchCellTower(cellPayload, config) {
    var fields = parseFields(cellPayload), parts = [];
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === 5 && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(5, patchLocation(field.valueBytes, config)));
      } else {
        parts.push(field.raw);
      }
    }
    return concatBytes(parts);
  }

  // AppleWLoc 根消息：field 2 = WiFi 设备（可重复），field 22/24 = 蜂窝基站
  function patchAppleWLocPayload(payload, config) {
    var fields = parseFields(payload), parts = [];
    var wifiCount = 0, cellCount = 0;
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === 2 && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(2, patchWifiDevice(field.valueBytes, config)));
        wifiCount += 1;
      } else if (isCellResponseField(field.fieldNumber) && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(field.fieldNumber, patchCellTower(field.valueBytes, config)));
        cellCount += 1;
      } else {
        parts.push(field.raw); // 根级其余字段一律保留，避免破坏 iOS 校验
      }
    }
    return { payload: concatBytes(parts), wifiCount: wifiCount, cellCount: cellCount };
  }

  /* ============================ ARPC 封包格式 ============================ */

  function readPascalString(bytes, state) {
    var length = readUInt16BE(bytes, state.offset);
    state.offset += 2;
    if (state.offset + length > bytes.length) throw new Error("ARPC pascal string exceeds buffer");
    var chars = [];
    for (var i = 0; i < length; i += 1) chars.push(String.fromCharCode(bytes[state.offset + i]));
    state.offset += length;
    return chars.join("");
  }

  function writePascalString(value) {
    var bytes = asciiBytes(value);
    return concatBytes([writeUInt16BE(bytes.length), bytes]);
  }

  function parseArpc(bytes) {
    var state = { offset: 0 };
    var version = readUInt16BE(bytes, state.offset); state.offset += 2;
    var locale = readPascalString(bytes, state);
    var appIdentifier = readPascalString(bytes, state);
    var osVersion = readPascalString(bytes, state);
    var functionId = readUInt32BE(bytes, state.offset); state.offset += 4;
    var payloadLength = readUInt32BE(bytes, state.offset); state.offset += 4;
    if (state.offset + payloadLength > bytes.length) throw new Error("ARPC payload exceeds buffer");
    return {
      version: version, locale: locale, appIdentifier: appIdentifier, osVersion: osVersion,
      functionId: functionId, payload: bytes.slice(state.offset, state.offset + payloadLength)
    };
  }

  function serializeArpc(arpc) {
    return concatBytes([
      writeUInt16BE(arpc.version),
      writePascalString(arpc.locale),
      writePascalString(arpc.appIdentifier),
      writePascalString(arpc.osVersion),
      writeUInt32BE(arpc.functionId),
      writeUInt32BE(arpc.payload.length),
      arpc.payload
    ]);
  }

  function buildAppleWLocResponse(payload, prefix) {
    return concatBytes([prefix || APPLE_WLOC_PREFIX, writeUInt16BE(payload.length), payload]);
  }

  /* ===================== 响应拆包（四种封装格式） ===================== */

  function looksLikeAppleWLocPayload(bytes) {
    if (!bytes || bytes.length === 0) return false;
    var tag = bytes[0], fieldNumber = tag >> 3, wireType = tag & 0x7;
    return fieldNumber > 0 && (wireType === 0 || wireType === 2);
  }

  // "synthetic"：8 字节前缀 + uint16 长度 + payload（本工具自产响应的格式）
  function extractPrefixedAppleWLocPayload(responseBytes) {
    if (!responseBytes || responseBytes.length < 10) return null;
    if (responseBytes[0] !== 0x00 || responseBytes[1] !== 0x01) return null;
    if (responseBytes[6] !== 0x00 || responseBytes[7] !== 0x00) return null;
    var payloadLength = readUInt16BE(responseBytes, 8);
    var payloadOffset = 10;
    if (payloadLength <= 0 || payloadOffset + payloadLength > responseBytes.length) return null;
    var payload = responseBytes.slice(payloadOffset, payloadOffset + payloadLength);
    if (tryParseFields(payload) === null) return null;
    return {
      kind: "synthetic", payload: payload,
      prefix: responseBytes.slice(0, 8),
      suffix: responseBytes.slice(payloadOffset + payloadLength)
    };
  }

  function extractAppleWLocPayload(responseBytes) {
    if (!responseBytes || responseBytes.length < 2) throw new Error("response too short");

    // 1) synthetic 前缀格式
    var prefixed = extractPrefixedAppleWLocPayload(responseBytes);
    if (prefixed) return prefixed;

    // 2) ARPC 信封格式（Apple 真实响应）
    try {
      var arpc = parseArpc(responseBytes);
      if (arpc.payload.length > 0 && tryParseFields(arpc.payload) !== null) {
        return { kind: "arpc", payload: arpc.payload, arpc: arpc };
      }
    } catch (e) { /* 继续尝试兜底 */ }

    // 3) marker 搜索兜底：00 00 00 01 00 00 + uint16 长度 + payload
    var markerIdx = findBytes(responseBytes, APPLE_WLOC_MARKER);
    if (markerIdx >= 0) {
      var lenOffset = markerIdx + APPLE_WLOC_MARKER.length;
      if (lenOffset + 2 <= responseBytes.length) {
        var realLen = readUInt16BE(responseBytes, lenOffset);
        var realPayloadOffset = lenOffset + 2;
        if (realLen > 0 && realPayloadOffset + realLen <= responseBytes.length) {
          var candidate = responseBytes.slice(realPayloadOffset, realPayloadOffset + realLen);
          if (tryParseFields(candidate) !== null) {
            return {
              kind: "marker", payload: candidate,
              prefix: responseBytes.slice(0, markerIdx),
              markerAndLen: responseBytes.slice(markerIdx, realPayloadOffset),
              suffix: responseBytes.slice(realPayloadOffset + realLen)
            };
          }
        }
      }
    }

    // 4) 裸 protobuf（尽力而为）
    if (looksLikeAppleWLocPayload(responseBytes)) {
      return { kind: "bare", payload: responseBytes };
    }
    throw new Error("missing Apple WLoc response prefix");
  }

  // 原始字节扫描兜底：已知封装都解析失败时（例如 iOS beta 改了封装），
  // 逐字节找可改写的 WLOC protobuf，找到就改写并用标准 synthetic 封包返回。
  function scanPatchAppleWLoc(responseBytes, config) {
    if (!responseBytes || responseBytes.length < 8) {
      throw new Error("body too short for raw scan");
    }
    var offsets = [], i;
    var frameLimit = Math.min(96, Math.max(0, responseBytes.length - 10));
    for (i = 0; i <= frameLimit; i += 2) offsets.push(i);
    var rawLimit = Math.min(256, Math.max(0, responseBytes.length - 4));
    for (i = 0; i <= rawLimit; i += 1) {
      if (offsets.indexOf(i) < 0) offsets.push(i);
    }
    for (i = 0; i < offsets.length; i += 1) {
      var offset = offsets[i];
      try {
        var slice = responseBytes.slice(offset);
        if (!looksLikeAppleWLocPayload(slice)) continue;
        var patched = patchAppleWLocPayload(slice, config);
        if (patched.wifiCount > 0 || patched.cellCount > 0) {
          return {
            response: buildAppleWLocResponse(patched.payload),
            wifiCount: patched.wifiCount, cellCount: patched.cellCount,
            kind: "raw", offset: offset
          };
        }
      } catch (err) { /* 下一个 offset */ }
    }
    throw new Error("raw scan found no patchable WLoc payload");
  }

  function buildPatchedResponse(extraction, patched) {
    var response;
    if (extraction.kind === "arpc") {
      response = serializeArpc({
        version: extraction.arpc.version,
        locale: extraction.arpc.locale,
        appIdentifier: extraction.arpc.appIdentifier,
        osVersion: extraction.arpc.osVersion,
        functionId: extraction.arpc.functionId,
        payload: patched.payload
      });
    } else if (extraction.kind === "marker") {
      response = concatBytes([
        extraction.prefix,
        extraction.markerAndLen.slice(0, APPLE_WLOC_MARKER.length),
        writeUInt16BE(patched.payload.length),
        patched.payload,
        extraction.suffix
      ]);
    } else {
      response = buildAppleWLocResponse(patched.payload, extraction.prefix);
    }
    return {
      response: response,
      wifiCount: patched.wifiCount, cellCount: patched.cellCount,
      kind: extraction.kind
    };
  }

  // 对外主入口：输入原始响应字节 + 配置，输出改写后的响应字节
  function spoofAppleResponse(responseBytes, config) {
    var extraction = null, strictError = null;
    try {
      extraction = extractAppleWLocPayload(responseBytes);
    } catch (err) {
      strictError = err;
    }
    if (extraction) {
      var patched = patchAppleWLocPayload(extraction.payload, config);
      if (patched.wifiCount > 0 || patched.cellCount > 0) {
        return buildPatchedResponse(extraction, patched);
      }
      strictError = new Error("no patchable location fields via " + extraction.kind);
    }
    var raw = scanPatchAppleWLoc(responseBytes, config);
    return {
      response: raw.response,
      wifiCount: raw.wifiCount, cellCount: raw.cellCount,
      kind: raw.kind, offset: raw.offset,
      strictError: strictError ? strictError.message : null
    };
  }

  /* ===================== 平台适配：配置 / 存储 / 通知 ===================== */

  function parseBoolean(value, defaultValue) {
    if (value === true || value === false) return value;
    if (typeof value === "string") {
      var v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
      if (v === "false" || v === "0" || v === "no" || v === "off") return false;
    }
    return defaultValue;
  }

  function parseArgumentString(arg) {
    var out = {};
    if (typeof arg !== "string" || !arg) return out;
    var pairs = arg.split("&");
    for (var i = 0; i < pairs.length; i += 1) {
      var idx = pairs[i].indexOf("=");
      if (idx <= 0) continue;
      var key = pairs[i].slice(0, idx).trim();
      var value = pairs[i].slice(idx + 1).trim();
      if (key) out[key] = decodeURIComponent(value);
    }
    return out;
  }

  function normalizeConfig(input) {
    var cfg = {}, key;
    for (key in DEFAULT_CONFIG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) cfg[key] = DEFAULT_CONFIG[key];
    }
    input = input || {};
    for (key in input) {
      if (Object.prototype.hasOwnProperty.call(input, key)) cfg[key] = input[key];
    }
    cfg.enabled = parseBoolean(cfg.enabled, true);
    cfg.failOpen = parseBoolean(cfg.failOpen, true);
    cfg.debug = parseBoolean(cfg.debug, false);
    cfg.latitude = Number(cfg.latitude);
    cfg.longitude = Number(cfg.longitude);
    cfg.horizontalAccuracy = Math.trunc(Number(cfg.horizontalAccuracy));
    if (!Number.isFinite(cfg.latitude) || cfg.latitude < -90 || cfg.latitude > 90) {
      throw new Error("invalid latitude");
    }
    if (!Number.isFinite(cfg.longitude) || cfg.longitude < -180 || cfg.longitude > 180) {
      throw new Error("invalid longitude");
    }
    if (!Number.isFinite(cfg.horizontalAccuracy) || cfg.horizontalAccuracy < 0) {
      cfg.horizontalAccuracy = DEFAULT_CONFIG.horizontalAccuracy;
    }
    cfg.authTtl = Math.trunc(Number(cfg.authTtl));
    cfg.authGrace = Math.trunc(Number(cfg.authGrace));
    if (!Number.isFinite(cfg.authTtl) || cfg.authTtl < 60) cfg.authTtl = DEFAULT_CONFIG.authTtl;
    if (!Number.isFinite(cfg.authGrace) || cfg.authGrace < cfg.authTtl) cfg.authGrace = DEFAULT_CONFIG.authGrace;
    cfg.strictAuth = parseBoolean(cfg.strictAuth, false);
    cfg.authNotify = parseBoolean(cfg.authNotify, false);
    cfg.licenseKey = typeof cfg.licenseKey === "string" ? cfg.licenseKey.trim() : "";
    cfg.authUrl = typeof cfg.authUrl === "string" ? cfg.authUrl.trim() : "";
    return cfg;
  }

  // 存储适配：Surge/Loon/Shadowrocket/Stash 用 $persistentStore，QX 用 $prefs
  function storeRead(key) {
    try {
      if (typeof $persistentStore !== "undefined") return $persistentStore.read(key);
      if (typeof $prefs !== "undefined") return $prefs.valueForKey(key);
    } catch (e) { /* ignore */ }
    return null;
  }

  function storeWrite(value, key) {
    try {
      if (typeof $persistentStore !== "undefined") return $persistentStore.write(value, key);
      if (typeof $prefs !== "undefined") return $prefs.setValueForKey(value, key);
    } catch (e) { /* ignore */ }
    return false;
  }

  // HTTP 适配：Surge/Loon/Shadowrocket/Stash 用 $httpClient，QX 用 $task
  function httpGet(url, callback) {
    try {
      if (typeof $httpClient !== "undefined") {
        $httpClient.get(url, function (error, response, data) {
          callback(error || null, typeof data === "string" ? data : null);
        });
        return;
      }
      if (typeof $task !== "undefined") {
        $task.fetch({ url: url }).then(
          function (resp) { callback(null, resp.body || null); },
          function (err) { callback(err || new Error("fetch failed"), null); }
        );
        return;
      }
    } catch (e) { /* fallthrough */ }
    callback(new Error("no http client available"), null);
  }

  /* ------------------------- 授权检查（可选） ------------------------- */

  // 设备指纹：一码一机的绑定依据。每台设备生成一次并持久化，
  // 激活卡密时随请求发给授权服务器绑定。
  function getDeviceId() {
    var existing = storeRead(DEVICE_KEY);
    if (existing && typeof existing === "string" && existing.length >= 8) return existing;
    var id = "";
    for (var i = 0; i < 16; i += 1) {
      id += Math.floor(Math.random() * 16).toString(16);
    }
    storeWrite(id, DEVICE_KEY);
    return id;
  }

  function readAuthCache() {
    var raw = storeRead(AUTH_STORE_KEY);
    if (!raw) return null;
    try {
      var j = JSON.parse(raw);
      if (j && typeof j.allowed === "boolean" && typeof j.ts === "number") return j;
    } catch (e) { /* ignore */ }
    return null;
  }

  // 纯函数，便于测试：返回 "allow" / "deny" / "fetch"
  // 规则：本地已知到期（expiresAt 已过）→ 直接拒绝，不再发请求；
  //       缓存新鲜 → 按缓存；否则 → 需要联网校验。
  function decideAuth(cached, nowMs, config) {
    if (!cached || typeof cached.ts !== "number") return "fetch";
    if (typeof cached.expiresAt === "number" && cached.expiresAt > 0 && nowMs >= cached.expiresAt) {
      return "deny";
    }
    if (nowMs - cached.ts < config.authTtl * 1000) {
      return cached.allowed ? "allow" : "deny";
    }
    return "fetch";
  }

  function authorize(config, callback) {
    var now = Date.now();
    var cached = readAuthCache();
    var decision = decideAuth(cached, now, config);
    if (decision === "allow") { callback(true, null); return; }
    if (decision === "deny") {
      var denyReason = "denied";
      if (cached) {
        if (typeof cached.expiresAt === "number" && cached.expiresAt > 0 && now >= cached.expiresAt) {
          denyReason = "expired";
        } else if (typeof cached.reason === "string") {
          denyReason = cached.reason;
        }
      }
      callback(false, denyReason);
      return;
    }

    var sep = config.authUrl.indexOf("?") >= 0 ? "&" : "?";
    httpGet(config.authUrl + sep + "key=" + encodeURIComponent(config.licenseKey) +
      "&did=" + encodeURIComponent(getDeviceId()),
      function (err, data) {
        var allowed = null, expiresAt = null, reason = null;
        if (!err && data) {
          try {
            var j = JSON.parse(data);
            if (typeof j.allowed === "boolean") {
              allowed = j.allowed;
              if (typeof j.expiresAt === "number" && j.expiresAt > 0) expiresAt = j.expiresAt;
              if (typeof j.reason === "string") reason = j.reason;
            }
          } catch (e) { /* ignore */ }
        }

        if (allowed === null) {
          // 服务器不可达：本地已知到期时间 → 到期前宽限沿用，到期后拒绝；
          // 无到期信息 → 宽限期内沿用旧结果；否则按 strictAuth（默认放行）
          if (cached && typeof cached.expiresAt === "number" && cached.expiresAt > 0) {
            allowed = cached.allowed && now < cached.expiresAt;
            reason = allowed ? null : "expired";
            log(config, "auth fetch failed, use cached expiry allowed=" + allowed);
          } else if (cached && (now - cached.ts) < config.authGrace * 1000) {
            allowed = cached.allowed;
            log(config, "auth fetch failed, use stale cache allowed=" + allowed);
          } else {
            allowed = !config.strictAuth;
            log(config, "auth fetch failed, no cache, fallback allowed=" + allowed);
          }
        } else {
          var entry = { allowed: allowed, ts: now };
          if (expiresAt) entry.expiresAt = expiresAt;
          if (reason) entry.reason = reason;
          storeWrite(JSON.stringify(entry), AUTH_STORE_KEY);
          log(config, "auth fetched: allowed=" + allowed +
            (expiresAt ? " expiresAt=" + new Date(expiresAt).toISOString() : "") +
            (reason ? " reason=" + reason : ""));
        }
        callback(allowed, allowed ? null : (reason || "denied"));
      });
  }

  // 被拒绝/到期时的通知（每天最多一次）
  function maybeNotifyDeny(config, reason) {
    if (!config.authNotify) return;
    var now = Date.now();
    var last = Number(storeRead(AUTH_NOTIFY_KEY)) || 0;
    if (now - last < 86400000) return;
    storeWrite(String(now), AUTH_NOTIFY_KEY);
    if (reason === "expired") {
      notify("虚拟定位", "授权已到期", "如需继续使用，请联系模块提供方续期");
    } else if (reason === "device_mismatch") {
      notify("虚拟定位", "授权码已绑定其他设备", "如需更换设备，请联系模块提供方解绑");
    } else {
      notify("虚拟定位", "授权已停用", "请联系模块提供方");
    }
  }

  function notify(title, subtitle, body) {
    try {
      if (typeof $notification !== "undefined") { $notification.post(title, subtitle, body); return; }
      if (typeof $notify !== "undefined") { $notify(title, subtitle, body); return; }
    } catch (e) { /* ignore */ }
  }

  function log(config, message) {
    if (config && config.debug) console.log("[wloc] " + message);
  }

  // 配置优先级：持久化存储（在线选点写入） > 模块参数 > 默认值
  function loadConfig() {
    var cfg = normalizeConfig(parseArgumentString(typeof $argument === "string" ? $argument : ""));
    var raw = storeRead(STORE_KEY);
    if (raw) {
      try {
        var stored = JSON.parse(raw);
        if (stored && typeof stored === "object") {
          if (parseBoolean(stored.enabled, true) === false) cfg.enabled = false;
          if (Number.isFinite(Number(stored.latitude))) cfg.latitude = Number(stored.latitude);
          if (Number.isFinite(Number(stored.longitude))) cfg.longitude = Number(stored.longitude);
          if (Number.isFinite(Number(stored.horizontalAccuracy))) {
            cfg.horizontalAccuracy = Math.trunc(Number(stored.horizontalAccuracy));
          }
        }
      } catch (e) { /* 存储内容损坏则忽略 */ }
    }
    return cfg;
  }

  /* ============================ 代理运行主流程 ============================ */

  function doneWithBytes(bytes) {
    // 有 bodyBytes 能力就回 bodyBytes，否则回二进制字符串 body
    if (typeof $response !== "undefined" && bodyToBytes($response.bodyBytes) !== null) {
      $done({ bodyBytes: bytes });
    } else {
      $done({ body: bytesToBinaryString(bytes) });
    }
  }

  function patchAndPass(config) {
    var bodyBytes = messageBodyToBytes($response);
    if (!bodyBytes || bodyBytes.length === 0) { $done({}); return; }

    try {
      var result = spoofAppleResponse(bodyBytes, config);
      log(config, "patched via " + result.kind +
        " wifi=" + result.wifiCount + " cell=" + result.cellCount +
        " -> " + config.latitude + "," + config.longitude);
      doneWithBytes(result.response);
    } catch (err) {
      console.log("[wloc] patch failed: " + err.message);
      $done({}); // failOpen：放行原始响应
    }
  }

  function main() {
    if (typeof $request === "undefined" || typeof $response === "undefined" ||
        typeof $done === "undefined") {
      return; // 非代理运行环境（如 Node 测试），不执行
    }
    var url = ($request && $request.url) || "";
    if (!/\/clls\/wloc/.test(url)) { $done({}); return; }

    var config;
    try {
      config = loadConfig();
    } catch (err) {
      console.log("[wloc] config error: " + err.message);
      $done({}); return;
    }
    if (!config.enabled) { $done({}); return; }

    // 授权检查（可选）：licenseKey 为空则不启用，行为和以前完全一致
    if (config.licenseKey && config.authUrl) {
      authorize(config, function (allowed, reason) {
        if (!allowed) {
          log(config, "license denied: key=" + config.licenseKey +
            (reason ? " reason=" + reason : ""));
          maybeNotifyDeny(config, reason);
          $done({}); // 放行原始响应 = 模块对这个人“失效”，定位恢复真实值
          return;
        }
        patchAndPass(config);
      });
      return;
    }
    patchAndPass(config);
  }

  main();

  /* ===================== Node 测试导出（代理环境忽略） ===================== */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      spoofAppleResponse: spoofAppleResponse,
      patchAppleWLocPayload: patchAppleWLocPayload,
      parseArpc: parseArpc,
      serializeArpc: serializeArpc,
      parseFields: parseFields,
      firstFieldByNumber: firstFieldByNumber,
      signedVarintFieldValue: signedVarintFieldValue,
      makeVarintField: makeVarintField,
      makeLengthDelimitedField: makeLengthDelimitedField,
      buildAppleWLocResponse: buildAppleWLocResponse,
      concatBytes: concatBytes,
      bytesFromArray: bytesFromArray,
      coordToInt: coordToInt,
      normalizeConfig: normalizeConfig,
      decideAuth: decideAuth,
      APPLE_WLOC_MARKER: APPLE_WLOC_MARKER,
      writeUInt16BE: writeUInt16BE,
      writeUInt32BE: writeUInt32BE,
      writePascalString: writePascalString
    };
  }
})();
