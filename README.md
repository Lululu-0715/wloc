# wloc — 虚拟定位代理模块

通过代理工具的 MITM 能力拦截 Apple 网络定位接口（`gs-loc.apple.com/clls/wloc`）的响应，
把 WiFi 热点和蜂窝基站的坐标替换为指定坐标，**免越狱**修改 iOS 设备定位。

支持：**Surge / Shadowrocket / Loon / Quantumult X / Stash**（Egern 可用 Surge 模块）

> 参考：[acheong08/ios-location-spoofer](https://github.com/acheong08/apple-corelocation-experiments)（原始研究）、
> [bg4sgp/ios-location-spoofer](https://github.com/bg4sgp/ios-location-spoofer)（多平台移植思路）。
> 本项目代码为独立实现，仅供开发调试、App 测试与学习研究使用。

## 原理

iPhone 把周围 Wi-Fi 的 BSSID 和基站信息发给 Apple，Apple 返回这些设备的坐标清单，
iOS 据此算出本机位置。本模块在响应回设备的路上拦截，把清单里的坐标全部改成目标值，
系统算出来的位置就是你指定的地方。

```
iPhone ──WLOC 请求──▶ Apple ──坐标清单──▶ [代理拦截改写坐标] ──▶ iPhone 算出假位置
```

## 本仓库内容

> ⚠️ **本仓库是分发仓**，只存放代理客户端运行时需要的文件，**没有源码**。
> 目录里出现的内容就是下面这些，其余一律不在这里。

| 路径 | 说明 |
|---|---|
| `dist/wloc.js` | 改写逻辑主体（模块实际加载的就是这个），客户端每次请求时实时拉取 |
| `dist/wloc-settings.js` | 选点脚本：拦截 `/wloc-settings/save`，把坐标写入客户端持久化存储 |
| `modules/wloc.sgmodule` | Surge / Egern 模块（支持参数化） |
| `modules/wloc.module` | Shadowrocket（小火箭） |
| `modules/wloc.plugin` | Loon |
| `modules/wloc.conf` | Quantumult X 配置片段 |
| `modules/wloc.stoverride` | Stash |

仓库必须保持**公开**：客户端通过 `raw.githubusercontent.com` 拉取，私有仓库取不到。
`dist/` 是构建产物，**请勿直接修改**——改动会在下次同步时被覆盖。

## 快速开始

### 1. 导入模块并开启 MITM

在代理工具中导入对应平台的模块文件，可直接用 raw 链接订阅，例如 Surge：

```
https://raw.githubusercontent.com/Lululu-0715/wloc/main/modules/wloc.sgmodule
```

开启 **HTTPS 解密（MITM）**，生成 CA 证书并在 iOS 上安装；再到
**设置 → 通用 → 关于本机 → 证书信任设置** 里开启「完全信任」。
确认 MITM 主机名包含 `gs-loc.apple.com`、`gs-loc-cn.apple.com`（模块已自带）。

### 2. 选点（在线选点页）

在 **连着代理** 的 iPhone 上用 Safari 打开选点页：

> **https://wloc-1993.575613136.workers.dev**

在地图上选好位置后点保存。选点页会向
`gs-loc.apple.com/wloc-settings/save?lat=…&lon=…` 发请求，
`wloc-settings.js` 拦截该请求并把坐标写入代理工具的持久化存储，**不会真正发到 Apple**。
收到「虚拟定位已设置」通知即保存成功。

坐标优先级：**在线选点储存 > 模块参数 > 脚本默认值**。

恢复默认（清除已存坐标）：

```
https://gs-loc.apple.com/wloc-settings/save?clear=1
```

### 3. 生效（重要）

iOS 会缓存定位结果，改完坐标后按此顺序操作成功率最高：

1. 先在选点页设好目标坐标
2. 开飞行模式 → 关闭定位服务 → **重启设备**
3. 关飞行模式（Wi-Fi 也关掉重连）→ 确认代理已连接（出现 VPN 图标）
4. 打开定位服务 → 打开地图验证

> iOS 26+ 强化了定位缓存，**必须重启设备**才能清掉旧定位；开关飞行模式/定位服务不够。

## 模块参数

Surge / 小火箭可在模块参数面板直接填写；Loon / Stash 改配置里的 `argument=`；
Quantumult X 不支持参数传递，请用在线选点。

| 参数 | 说明 | 默认值 |
|---|---|---|
| `latitude` | 目标纬度（WGS-84） | 22.544577 |
| `longitude` | 目标经度（WGS-84） | 113.94114 |
| `horizontalAccuracy` | 水平精度（米） | 25 |
| `debug` | 日志开关 | false |
| `failOpen` | 改写失败时放行原始响应 | true |
| `licenseKey` | 授权码，留空则不启用授权检查 | 空 |

## 排错

把参数里的 `debug` 改成 `true`，在代理工具日志里搜 `wloc`：

- `patched via arpc wifi=N cell=M` → 拦截和改写都成功了，剩下的是缓存问题（重启设备）。
- `patch failed` → 把日志贴出来排查；脚本默认 failOpen，改写失败会放行原始响应，不影响正常定位。
- 完全没有日志 → MITM 没生效：检查证书信任开关、hostname 列表、VPN 是否连接。

## 恢复真实定位

关闭或删除模块即可；如果用过在线选点，再访问一次 `?clear=1` 清除存储的坐标，重启设备。

## 实现说明

- 只替换已存在的经纬度（字段 1/2）和精度（字段 3），其余协议字段
  （BSSID、海拔、运动状态等）**原样透传**，最大限度避免被系统判定为非法响应。
- 响应封装自适应四种格式：ARPC 信封 / synthetic 前缀 / marker 搜索 / 裸 protobuf，
  均失败时还有原始字节扫描兜底（应对 iOS beta 封装变化）。
- int64 用高低位实现，不依赖 BigInt，兼容 iOS 12 的 JavaScriptCore。
- 蜂窝基站坐标（根消息字段 22/24 → 子消息字段 5）一并改写。

## 注意事项

- 只改写**网络定位（Wi-Fi/基站）**，不影响 GPS 芯片定位；室内/Wi-Fi 环境下效果最好。
- 国内地图 App（高德/百度）使用 GCJ-02 火星坐标，填 WGS-84 坐标会有偏移，注意坐标系转换。
- 客户端默认通过 `raw.githubusercontent.com` 拉取脚本；刚更新完若手机上仍是旧行为，
  是 CDN/客户端缓存，稍等或重启代理工具。
- 请勿用于违反 App 服务条款或法律法规的用途（如作弊、打卡欺诈等）。
