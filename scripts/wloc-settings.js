/*
 * wloc-settings.js — 选点坐标存储脚本（http-request 类型）
 * 支持：Surge / Shadowrocket / Loon / Stash / Quantumult X
 *
 * 兼容 Yu9191/wloc 选点页的完整接口约定：
 *   保存：GET /wloc-settings/save?lon=113.9&lat=22.5&acc=25
 *         （也接受 longitude/latitude/accuracy 参数名）
 *   查询：GET /wloc-settings/save?action=query
 *   清除：GET /wloc-settings/save?action=clear （兼容旧式 ?clear=1）
 *
 * 响应带 CORS 头（选点页在 workers.dev 跨域调用，缺了会被浏览器拦截）。
 * 坐标写入代理工具持久化存储（key: wloc_settings），wloc.js 下次拦截时读取。
 */
(function () {
  "use strict";

  var STORE_KEY = "wloc_settings";

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

  function notify(title, subtitle, body) {
    try {
      if (typeof $notification !== "undefined") { $notification.post(title, subtitle, body); return; }
      if (typeof $notify !== "undefined") { $notify(title, subtitle, body); return; }
    } catch (e) { /* ignore */ }
  }

  function getParam(params, names) {
    for (var i = 0; i < names.length; i += 1) {
      var m = new RegExp("[?&]" + names[i] + "=(-?[0-9.]+)").exec(params);
      if (m) return Number(m[1]);
    }
    return NaN;
  }

  function readStored() {
    var raw = storeRead(STORE_KEY);
    if (!raw) return null;
    try {
      var j = JSON.parse(raw);
      if (j && Number.isFinite(Number(j.latitude)) && Number.isFinite(Number(j.longitude))) {
        return j;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function respondJson(obj) {
    var body = JSON.stringify(obj);
    var headers = {
      "Content-Type": "application/json; charset=utf-8",
      // 选点页在 workers.dev 域下跨域调用 gs-loc.apple.com，必须带 CORS 头
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    };
    if (typeof $task !== "undefined") {
      // Quantumult X
      $done({ status: "HTTP/1.1 200 OK", headers: headers, body: body });
      return;
    }
    // Surge / Loon / Shadowrocket / Stash
    $done({ response: { status: 200, headers: headers, body: body } });
  }

  function main() {
    if (typeof $request === "undefined" || typeof $done === "undefined") return;
    var url = ($request && $request.url) || "";

    // 浏览器跨域预检（简单 GET 一般不触发，兜底）
    if (($request.method || "GET").toUpperCase() === "OPTIONS") {
      respondJson({});
      return;
    }

    var actionMatch = /[?&]action=(\w+)/.exec(url);
    var action = actionMatch ? actionMatch[1] : (/[?&]clear=1/.test(url) ? "clear" : "save");

    /* ---- 查询当前已存坐标（选点页「当前生效坐标」） ---- */
    if (action === "query") {
      var stored = readStored();
      if (stored) {
        respondJson({
          success: true,
          longitude: Number(stored.longitude),
          latitude: Number(stored.latitude),
          accuracy: Number(stored.accuracy || stored.horizontalAccuracy) || 25,
          updatedAt: stored.updatedAt || null
        });
      } else {
        respondJson({ success: false, error: "无已保存的坐标" });
      }
      return;
    }

    /* ---- 清除已存坐标 ---- */
    if (action === "clear") {
      storeWrite(null, STORE_KEY);
      notify("虚拟定位", "已清除保存的坐标", "回退到模块参数/默认值，重启设备后生效");
      respondJson({ success: true });
      return;
    }

    /* ---- 保存坐标（默认动作） ---- */
    var lon = getParam(url, ["lon", "longitude"]);
    var lat = getParam(url, ["lat", "latitude"]);
    var acc = getParam(url, ["acc", "accuracy"]);

    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || lat === 0 ||
        !Number.isFinite(lon) || lon < -180 || lon > 180 || lon === 0) {
      respondJson({ success: false, error: "缺少 lon/lat 参数" });
      return;
    }

    var accuracy = Number.isFinite(acc) && acc > 0 ? Math.trunc(acc) : 25;
    // 两套字段名都写：Yu9191 选点页读 accuracy，wloc.js 读 horizontalAccuracy
    var record = {
      longitude: lon,
      latitude: lat,
      accuracy: accuracy,
      horizontalAccuracy: accuracy,
      enabled: true,
      updatedAt: new Date().toISOString()
    };

    if (!storeWrite(JSON.stringify(record), STORE_KEY)) {
      respondJson({ success: false, error: "持久化存储写入失败" });
      return;
    }
    notify("虚拟定位已设置", lat + ", " + lon, "下次网络定位请求时生效");
    respondJson({ success: true, longitude: lon, latitude: lat, accuracy: accuracy });
  }

  main();
})();
