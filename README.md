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

## 目录结构

```
├── scripts/                # 源码（可读，改这里）
│   ├── wloc.js             #   核心脚本：拆 ARPC+protobuf → 改坐标 → 封回（五平台通用）
│   └── wloc-settings.js    #   选点脚本：拦截 /wloc-settings/save 写入持久化存储
├── dist/                   # 发布版（混淆后，模块实际加载的是这里，勿手改）
│   ├── wloc.js
│   └── wloc-settings.js
├── build/
│   └── obfuscate.js        # 混淆构建脚本（pnpm run build 重新生成 dist/）
├── worker/
│   ├── wloc-auth-worker.js # 卡密后端（Cloudflare Workers + KV）
│   ├── wrangler.toml       # 一键部署/CLI 部署配置
│   └── package.json        # Worker 依赖（wrangler）
├── modules/
│   ├── wloc.sgmodule     # Surge / Egern（支持参数化）
│   ├── wloc.module       # Shadowrocket（小火箭）
│   ├── wloc.plugin       # Loon
│   ├── wloc.conf         # Quantumult X 配置片段
│   └── wloc.stoverride   # Stash
└── test/
    └── test-core.js      # Node 单元测试（node test/test-core.js）
```

## 快速开始

### 1. 上传本仓库

把本仓库上传到 GitHub（仓库名保持 **wloc**），模块里的脚本地址已配置为
`https://raw.githubusercontent.com/Lululu-0715/wloc/main/scripts/…`，上传后即自动生效，无需修改。

### 2. 导入模块并开启 MITM

- 在代理工具中导入对应平台的模块文件，可直接用 raw 链接订阅，例如 Surge：
  `https://raw.githubusercontent.com/Lululu-0715/wloc/main/modules/wloc.sgmodule`
- 开启 **HTTPS 解密（MITM）**，生成 CA 证书并在 iOS 上安装；再到
  **设置 → 通用 → 关于本机 → 证书信任设置** 里开启「完全信任」。
- 确认 MITM 主机名包含 `gs-loc.apple.com`、`gs-loc-cn.apple.com`（模块已自带）。

### 3. 选点（在线选点页）

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

### 4. 生效（重要）

iOS 会缓存定位结果，改完坐标后按此顺序操作成功率最高：

1. 先在选点页设好目标坐标
2. 开飞行模式 → 关闭定位服务 → **重启设备**
3. 关飞行模式（Wi-Fi 也关掉重连）→ 确认代理已连接（出现 VPN 图标）
4. 打开定位服务 → 打开地图验证

> iOS 26+ 强化了定位缓存，**必须重启设备**才能清掉旧定位；开关飞行模式/定位服务不够。

## 模块参数

Surge / 小火箭可在模块参数面板直接填写；Loon / Stash 改配置里的 `argument=`；
Quantumult X 不支持参数传递，请用在线选点或直接改 `scripts/wloc.js` 里的 `DEFAULT_CONFIG`。

| 参数 | 说明 | 默认值 |
|---|---|---|
| `latitude` | 目标纬度（WGS-84） | 22.544577 |
| `longitude` | 目标经度（WGS-84） | 113.94114 |
| `horizontalAccuracy` | 水平精度（米） | 25 |
| `debug` | 日志开关 | false |
| `failOpen` | 改写失败时放行原始响应 | true |

## 卡密系统（限时分享商品化：月卡/季卡/半年卡/年卡/永久卡）

完整的卡密售卖体系：**批量生成卡密 → 发给买家 → 买家首次使用自动激活并开始计时
→ 到期自动失效**。一码一机防共享，可随时吊销/解绑，后台查看所有卡状态。

### 卡种

| 卡种 | plan 参数 | 有效期（激活后起算） |
|---|---|---|
| 月卡 | `monthly` | 30 天 |
| 季卡 | `season` | 90 天 |
| 半年卡 | `halfyear` | 180 天 |
| 年卡 | `yearly` | 365 天 |
| 永久卡 | `permanent` | 永久（除非吊销） |
| 自定义 | `days=N` | N 天（1~3650） |

### 生命周期

```
生成卡密(未激活，不计时，可囤货)
   │  买家首次使用 → 自动激活：绑定设备指纹 + 开始倒计时
   ▼
使用中（一码一机，换设备拒绝；本地缓存 6 小时，几乎无感）
   │
   ├─ 到期 → 自动失效 + 弹通知「授权已到期，请联系提供方续期」
   ├─ 你吊销 → 失效
   └─ 你解绑 → 回到未激活状态（买家换手机时你用，新设备重新激活计时）
```

### 防滥用设计

- **一码一机**：激活时绑定设备指纹（客户端自动生成并持久化），换机拒绝并提示解绑。
- **激活后计时**：未激活的卡永不过期，可以放心批量生成囤货。
- **本地记住到期时间**：到期后哪怕断网也立即失效，堵死"断网续命"。
- **断网宽限**：未到期但服务器暂时不可达 → 到期日前宽限放行，不误伤。
- **永久卡不计时**：`expiresAt` 为 null，只能靠吊销停用。

### 部署（Cloudflare Workers + KV，免费额度足够）

#### 方式一：一键部署（推荐）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Lululu-0715/wloc/tree/main/worker)

点击按钮 → 按提示授权 GitHub 并连接 Cloudflare → 自动完成部署，
得到形如 `https://wloc-auth.<你的子域名>.workers.dev` 的地址。

> 一键部署要求本仓库为 **public**（Cloudflare 需要拉取代码）。

**部署后必做三步**（在 Cloudflare 后台操作）：

1. **绑定 KV**：Workers & Pages → KV → 创建命名空间（任意名字）→
   回到 `wloc-auth` Worker → Settings → Bindings → 添加 KV 绑定，
   变量名必须是 **`AUTH_KV`**。
2. **设置管理密码**：Worker → Settings → Variables → 添加 Secret
   **`ADMIN_TOKEN`**（建议 `openssl rand -hex 16` 生成）。
3. **验证**：浏览器访问
   `https://wloc-auth.<子域名>.workers.dev/admin/create?token=密码&plan=monthly&count=1`，
   返回卡密 JSON 即部署成功。

#### 方式二：手动部署

```bash
cd worker
npm install
npx wrangler login        # 首次需要
npm run deploy
# 然后同样完成上面的「绑定 KV + 设置 ADMIN_TOKEN」两步
```

也可以不新建 Worker：把 `worker/wloc-auth-worker.js` 的 `/check` 和 `/admin`
路由合并进你现有的选点 Worker，共用一个域名。

#### 部署后：对接模块

- 如果合并进了选点 Worker（`wloc-1993.575613136.workers.dev`），
  `scripts/wloc.js` 里 `DEFAULT_CONFIG.authUrl` 的默认值正好就是它，**不用改**。
- 如果用了一键部署的新 Worker，把 `authUrl` 改成
  `https://wloc-auth.<子域名>.workers.dev/check`，然后 `pnpm run build` 重新混淆并推送。

### 日常运营（浏览器直接访问）

| 操作 | 请求 |
|---|---|
| 批量生成 10 张月卡 | `/admin/create?token=密码&plan=monthly&count=10&note=9月批次` |
| 生成 1 张永久卡 | `/admin/create?token=密码&plan=permanent&count=1` |
| 自定义 45 天 | `/admin/create?token=密码&days=45&count=1` |
| 吊销 | `/admin/revoke?token=密码&code=WLOC-XXXX` |
| 解绑（买家换手机） | `/admin/unbind?token=密码&code=WLOC-XXXX` |
| 全部卡状态+统计 | `/admin/list?token=密码` |

卡密形如 `WLOC-8F3K-2N9Q-7D4X`（已去除 0/O、1/I/L 易混淆字符），
`/admin/list` 返回每张卡的状态（unused/active/expired/revoked）、
剩余天数、是否已绑机，以及各状态数量汇总。

### 卖给买家时怎么发

- **Surge / 小火箭**：把卡密填在模块参数的 `licenseKey` 里发给他
  （或改好模块文件里的 `argument=...&licenseKey=WLOC-XXXX`）。
- **Loon / Stash**：改模块文件 `argument=` 里的 `licenseKey=`。
- **Quantumult X**：不支持参数传递，为买家改 `scripts/wloc.js` 的
  `DEFAULT_CONFIG.licenseKey`，`pnpm run build` 后把混淆版发他。
- **你自己用的**：`licenseKey` 留空，不走任何授权检查。

### 说明与限制

这是**软授权**，不是加密 DRM。发布版（`dist/`）已做代码混淆——变量名十六进制化、
敏感字符串（授权地址、存储 key、接口路径）全部编码隐藏，可以拦住随手翻代码、
顺手删校验的人；但混淆不是加密，懂逆向的人配合调试器仍然能绕过。
防君子不防黑客，适合熟人分享场景。授权检查只拦截"改写"，
不影响对方正常上网和真实定位。

## 修改源码 & 重新构建

模块实际加载的是 `dist/` 下的**混淆版**。要改逻辑请改 `scripts/` 源码，
然后重新构建并两套都跑测试：

```bash
pnpm install        # 首次
pnpm run build      # scripts/ → dist/（混淆）
pnpm test           # 源码版 + 混淆版各跑一遍完整测试（28 项 ×2）
```

混淆参数（`build/obfuscate.js`）已针对代理工具环境调优：只产出 ES5 语法
（兼容 iOS 12 的 JavaScriptCore）、不动属性名和对象键名（JSON 解析和配置合并
依赖它们）、不开控制流平坦化（protobuf 解析是热路径，避免卡顿）。

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
- 请勿用于违反 App 服务条款或法律法规的用途（如作弊、打卡欺诈等）。
