# Apple WLOC 定位修改（独立版）

修改 Apple 网络定位（WiFi / 基站）返回的坐标，实现 iOS 虚拟定位。
拦截 WLOC 响应并改写经纬度，配合网页选点使用。

> 本仓库基于社区维护版整理，已将所有地址指向本仓库，可独立订阅使用。

---

## 订阅地址

| 客户端 | 订阅链接 |
|---|---|
| **Shadowrocket（小火箭）** | `https://raw.githubusercontent.com/Lululu-0715/wloc/main/modules/wloc.module` |
| Surge / Egern | `https://raw.githubusercontent.com/Lululu-0715/wloc/main/modules/wloc.sgmodule` |
| Quantumult X | `https://raw.githubusercontent.com/Lululu-0715/wloc/main/modules/wloc.conf` |
| Loon | `https://raw.githubusercontent.com/Lululu-0715/wloc/main/modules/wloc.lpx` |
| Stash | `https://raw.githubusercontent.com/Lululu-0715/wloc/main/modules/wloc.stoverride` |

---

## 使用方法

1. 订阅对应客户端的模块，启用模块
2. 开启 **HTTPS 解密（MITM）**，确认域名列表包含：
   ```
   gs-loc.apple.com
   gs-loc-cn.apple.com
   gsp-ssl.ls.apple.com
   bluedot.is.autonavi.com
   bluedot.is.autonavi.com.gds.alibabadns.com
   ```
3. 安装并**信任** MITM 证书（设置 → 通用 → 关于本机 → 证书信任设置）
4. 打开选点页面 `https://wloc.333012.xyz/`，选位置 → 「储存到设备」
5. 打开地图验证

> Safari 的保存请求必须经过代理客户端才能被拦截。

---

## 参数

| 参数 | 含义 | 默认 |
|---|---|---|
| longitude / latitude | 目标经纬度 | 透传（不修改） |
| accuracy | 精度（米） | 25 |
| randomRadius | 随机扰动半径（米），0=关闭 | 0 |
| logLevel | 日志级别 | info |

**优先级：** 页面保存的坐标 > 模块参数 > 默认值

> **注意：** 默认占位坐标 `113.94114 / 22.544577` 被脚本判定为"未设置"，会进入透传模式。
> 若要用模块参数生效，请改成其他坐标；正常使用建议直接在选点页面选点。

---

## 恢复真实定位

- 关闭模块，或
- 在选点页面点「清除数据」，或
- 在客户端清除持久化数据（键名 `wloc_settings`）

iOS 26+ 因系统定位缓存，可能需要重启设备才能生效。

---

## 注意事项

- 仅修改网络定位（WiFi / 基站），**不影响 GPS 硬件定位**
- 需要 MITM 证书信任，否则不生效
- iOS 27 beta 6 起上游报告存在 TLS/MITM 限制，未做真机复核
- 仅在自己拥有或获授权的设备上进行定位测试

---

## 文件结构

```
├── dist/
│   ├── wloc.js              # 拦截 WLOC 响应，改写坐标
│   └── wloc-settings.js     # 接收选点页面的保存请求
├── modules/
│   ├── wloc.module          # Shadowrocket
│   ├── wloc.sgmodule        # Surge / Egern
│   ├── wloc.conf            # Quantumult X
│   ├── wloc.lpx             # Loon
│   └── wloc.stoverride      # Stash
└── wloc.jpg
```
