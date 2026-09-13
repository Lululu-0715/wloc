# wloc

iOS 网络定位修改。拦截 Apple 定位服务返回的经纬度，换成你指定的位置。

---

## 装完不生效？先看这条

**MITM 域名必须 5 个，少一个都不行。** 少的最多的是 `gsp-ssl.ls.apple.com` —— Apple 新版定位接口，缺了它请求根本拦不到。

```
gs-loc.apple.com
gs-loc-cn.apple.com
gsp-ssl.ls.apple.com
bluedot.is.autonavi.com
bluedot.is.autonavi.com.gds.alibabadns.com
```

本仓库模块已带好，订阅后确认没被覆盖即可。

---

## 订阅

| 客户端 | 链接 |
|---|---|
| **小火箭** | `https://raw.githubusercontent.com/Lululu-0715/wloc/refs/heads/main/modules/wloc.module` |
| Surge / Egern | `https://raw.githubusercontent.com/Lululu-0715/wloc/refs/heads/main/modules/wloc.sgmodule` |
| Quantumult X | `https://raw.githubusercontent.com/Lululu-0715/wloc/refs/heads/main/modules/wloc.conf` |
| Loon | `https://raw.githubusercontent.com/Lululu-0715/wloc/refs/heads/main/modules/wloc.lpx` |
| Stash | `https://raw.githubusercontent.com/Lululu-0715/wloc/refs/heads/main/modules/wloc.stoverride` |

小火箭用 `.module`，不是 `.sgmodule`。装之前把旧模块删掉。

---

## 三个前提

1. **开 HTTPS 解密**（有的客户端叫 MITM）
2. **证书装两遍** —— 客户端装一次，再去 `设置 → 通用 → 关于本机 → 证书信任设置` 打开开关
3. **走代理** —— 没开代理拦不到

---

## 用

1. 打开 `https://wloc-1993.575613136.workers.dev`
2. 地图上点选 / 搜地名 / 粘贴地图链接
3. 点**储存到设备**
4. 打开地图 App 看

---

## iOS 26+ 必须重启

系统会缓存旧坐标。脚本改成功了、日志也显示改了，但地图还是老位置 —— 是缓存，不是没生效。

**只能重启设备。** 飞行模式、关定位都不管用。

恢复真实定位同理，清完数据也要重启。

---

## 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `longitude` / `latitude` | 目标坐标 | 透传 |
| `accuracy` | 精度（米） | 25 |
| `randomRadius` | 随机抖动半径（米），0 关闭 | 0 |
| `logLevel` | 日志级别 | info |

优先级：**页面存的坐标 > 模块参数 > 默认值**

默认值 `113.94114 / 22.544577` 被脚本当作"没设置"，会透传。想用模块参数就别用这两个数。

---

## 恢复真实定位

选点页面点**清除数据**，或直接关模块。然后重启。

> 改过模块参数的，光清数据没用，参数也要改回默认值。

---

## 排查

**订阅 404** → raw 缓存，等 1~2 分钟
**提示"需要代理模块支持"** → 模块开关 / MITM / 证书 / 5 个域名，挨个查
**提示成功但没变** → 重启设备

---

## 文件

```
dist/          wloc.js（改坐标）  wloc-settings.js（收保存请求）
modules/       wloc.module / .sgmodule / .conf / .lpx / .stoverride
worker/        选点页面（wloc-worker.js + wrangler.jsonc）
docs/          shortcut-guide.md
wloc.jpg       图标
```

只玩小火箭：`dist/` + `modules/` 共 7 个文件就够。

**自建选点页面**：`worker/wloc-worker.js` 整段粘到 Cloudflare Workers 网页端控制台即可，不需要数据库和绑定。命令行则 `cd worker && npx wrangler deploy`。

---

## 说明

只改网络定位，**不动 GPS**。GPS 信号强时系统优先信 GPS，改了也没用 —— 室内 WiFi 定位场景效果最好。

`dist/` 里的脚本是编译过的，能跑别动。
