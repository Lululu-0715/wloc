/*
 * wloc-settings.js — 在线选点坐标存储脚本（http-request 类型）
 * 支持：Surge / Shadowrocket / Loon / Stash / Quantumult X
 *
 * 用法：在浏览器/快捷指令里访问
 *   https://gs-loc.apple.com/wloc-settings/save?lat=22.544577&lon=113.94114&acc=25
 * 本脚本拦截该请求，把坐标写入代理工具的持久化存储（key: wloc_settings），
 * 并直接返回 200，不会真正发到 Apple。
 *
 * 特殊参数：clear=1 时清除已保存坐标（回退到模块参数或默认值）。
 */
(function () {
  "use strict";

  var STORE_KEY = "wloc_settings";

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

  function getParam(url, name) {
    var m = new RegExp("[?&]" + name + "=(-?[0-9.]+)").exec(url);
    return m ? Number(m[1]) : NaN;
  }

  function respondOk(message) {
    var body = JSON.stringify({ ok: true, message: message });
    if (typeof $task !== "undefined") {
      // Quantumult X：script-echo-response 的响应格式
      $done({
        status: "HTTP/1.1 200 OK",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: body
      });
      return;
    }
    // Surge/Loon/Shadowrocket/Stash 的 http-request 脚本合成响应
    $done({
      response: {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: body
      }
    });
  }

  function main() {
    if (typeof $request === "undefined" || typeof $done === "undefined") return;
    var url = ($request && $request.url) || "";

    // 清除模式：/wloc-settings/save?clear=1
    if (/[?&]clear=1/.test(url)) {
      storeWrite(null, STORE_KEY);
      notify("虚拟定位", "已清除保存的坐标", "回退到模块参数/默认值，重启设备后生效");
      respondOk("cleared");
      return;
    }

    var lat = getParam(url, "lat");
    var lon = getParam(url, "lon");
    var acc = getParam(url, "acc");

    if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lon) || lon < -180 || lon > 180) {
      notify("虚拟定位", "坐标无效", url);
      respondOk("invalid coordinates");
      return;
    }

    var payload = {
      latitude: lat,
      longitude: lon,
      horizontalAccuracy: Number.isFinite(acc) && acc > 0 ? Math.trunc(acc) : 25,
      enabled: true,
      updatedAt: new Date().toISOString()
    };
    storeWrite(JSON.stringify(payload), STORE_KEY);
    notify("虚拟定位已设置", lat + ", " + lon, "下次网络定位请求时生效");
    respondOk("saved " + lat + "," + lon);
  }

  main();
})();
