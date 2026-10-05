# ShellCrashUI

> 给 **ShellCrash** 用的 LuCI 控制面板。这个项目**不是 ShellCrash 本体**，
> 也不修改它的任何代码——它只是一个浏览器界面，让你不用 SSH 上去敲菜单。

启停服务、看内核与 API 状态、一键跳转 **Zashboard**、把面板部署到路由器、
在线改内核运行参数、编辑 ShellCrash 配置、测各站点延迟——都在一个页面里。

包名 `luci-app-shellcrashui`，纯 shell + 前端 JS，不含任何与 CPU 架构相关的二进制，
所以安装包是架构无关的（ipk 为 `all`，apk 为 `noarch`），在 arm64 及任何其他 OpenWrt 目标上都能装。

支持 **OpenWrt 25.12+（apk）** 与 **24.10 及更早（opkg）**。

> **本项目完全由 DeepSeek 完成**——需求由使用者提出，从代码编写、测试到真机调试全部由 AI 完成。

---

## 一、功能

### 运行控制页（ShellCrashUI → 运行控制）

顶部是四个一眼要看到的指标块，下面是详情与操作。

| 能力 | 说明 |
|---|---|
| 概览条 | 服务状态（含 PID 与内存）、内核类型与版本、API 端口与可达性、本地面板部署情况 |
| 服务控制 | 打开面板 / 启动 / 停止 / 重启 / 热重载配置 / 开机自启切换，排成一行 |
| 延迟测试 | 见下节 |
| 服务详情 | ShellCrash 版本、安装目录、配置文件路径、主机架构、各代理端口、密钥、开机自启 |
| 相关页面 | 直达 Zashboard 面板与内核设置页 |

### 运行日志页（ShellCrashUI → 运行日志）

| 能力 | 说明 |
|---|---|
| 日志查看 | 自动定位 ShellCrash 日志文件，取不到时回退到系统日志里过滤 ShellCrash / 内核相关行 |
| 自动刷新 | 可选每 3 秒拉取一次；关掉时不发任何请求 |
| 行数 | 可在「基础设置」里调整 |

### 基础设置页（ShellCrashUI → 基础设置）

插件**自身**的选项，不涉及 ShellCrash 或内核的配置。

| 能力 | 说明 |
|---|---|
| 探测覆盖 | 安装目录、API 端口、API 密钥、混合代理端口——留空即自动探测 |
| 行为 | 状态刷新间隔、日志显示行数、延迟测试目标（`名称\|URL` 格式） |
| 探测顺序说明 | 页面上直接列出插件推断各项的顺序，方便对照排查 |

### 延迟测试（运行控制页内）

| 能力 | 说明 |
|---|---|
| 站点延迟 | 默认测百度 / 谷歌 / GitHub / YouTube，进页面自动测一次，也可手点 |
| 真实可达性 | 请求经内核**混合端口**发出，所以国内站点按规则直连、国外站点走代理，反映的是规则分流后的实际结果，而不是裸网络能不能通 |
| 并发执行 | 所有目标并行探测，4 个站点约 1.2 秒返回 |
| 可自定义 | 「基础设置 → 延迟测试目标」按 `名称\|URL` 的格式自由增删 |

### 内核与 ShellCrash 设置页（ShellCrash → 内核与 ShellCrash 设置）

| 能力 | 说明 |
|---|---|
| 内核运行参数 | 代理模式（规则/全局/直连）、日志等级、允许局域网连接、IPv6、TCP 并发，**通过 Clash API 立即生效、无需重启** |
| ShellCrash 配置 | 直接编辑 `ShellCrash.cfg`，保存前自动备份为 `.bak`，支持从备份恢复、保存并重启 |

> 两者的区别很关键：**内核运行参数**改的是本次运行（ShellCrash 重启后会按 `config.yaml` 重建，改动失效）；
> **ShellCrash 配置**是内核配置的源头，改完需要重启 ShellCrash 才会被套用。
> 页面里把这条也写清楚了，避免误解。
>
> 另外，`unified-delay` 不在 mihomo 的 `PATCH /configs` 支持范围内——实测调用返回成功但值不变，
> 所以页面只展示它、不提供修改。

### Zashboard 页面（ShellCrash → Zashboard 面板）

| 能力 | 说明 |
|---|---|
| 一键打开 | 按当前「面板模式」直接跳到面板，自动带上后端地址与密钥 |
| 启动并打开 | 服务没起来时，先启动 ShellCrash，轮询等待 API 就绪后再打开面板 |
| 四种模式 | 内核 `external-ui` / LuCI 站点目录 / 在线站点 / 自定义地址 |
| 直达链接表 | 四种模式的完整 URL 都列出来，可单独打开或复制 |
| 部署与更新 | 从 GitHub Release 下载 Zashboard 并解压到指定目录，带镜像加速与后台进度 |
| 卸载 | 分别卸载 LuCI 站点目录或内核 ui 目录里的面板 |

---

## 二、安装

### 1. arm64 一键安装（推荐）

把 `scripts/install-arm64.sh` 和对应格式的安装件一起丢到路由器的 `/tmp`：

```sh
sh /tmp/install-arm64.sh                    # 自动按包管理器选择
sh /tmp/install-arm64.sh --manual           # 强制走手动解包
sh /tmp/install-arm64.sh --with-shellcrash  # 顺便装 ShellCrash 本体
```

脚本会先校验 `uname -m` 必须是 `aarch64` / `arm64`，再装依赖，再装插件，最后刷新 rpcd 与 uhttpd。

### 2. 直接用包管理器

```sh
# OpenWrt 25.12 及以后（apk-tools 3）
apk add --allow-untrusted ./luci-app-shellcrashui-1.0.0-r1.apk

# OpenWrt 24.10 及更早（opkg）
opkg update
opkg install ./luci-app-shellcrashui_1.0.0-1_all.ipk
```

> `.apk` 没有可信私钥签名，所以必须加 `--allow-untrusted`。
> 如果依赖解析失败（例如系统里没有 `curl` / `unzip` 的源），改用下面的手动方式。

### 3. 手动安装（任何版本都能用）

```sh
tar -xzf luci-app-shellcrashui-1.0.0-rootfs.tar.gz -C /
chmod 0755 /usr/libexec/luci-shellcrashui/*.sh
sh /etc/uci-defaults/99-luci-app-shellcrashui && rm -f /etc/uci-defaults/99-luci-app-shellcrashui
/etc/init.d/rpcd restart
```

装完刷新浏览器（Ctrl+F5）或重新登录 LuCI，菜单出现在 **服务 → ShellCrash**。

### 依赖

`luci-base`（必需）、`curl`（热重载用）、`unzip`（部署面板用）、`ca-bundle`（HTTPS 下载用）。
后三个缺失时插件仍能运行，只是对应功能会明确提示装哪个包。

---

## 三、面板模式与免密钥直连

Zashboard 支持用 URL 查询参数预填后端信息：

```
?protocol=http&hostname=192.168.1.1&port=9090&secret=你的密钥
```

插件就是用这个机制实现「打开面板即连上」的。四种模式：

| 模式 | 生成的地址 | 适用场景 |
|---|---|---|
| `core` | `http://路由器IP:API端口/ui/` | 在 ShellCrash 菜单里选了 Zashboard 面板（内核 `external-ui`） |
| `local` | `http://路由器IP/zashboard/` | 本插件把面板部署到了 `/www/zashboard`，由 uhttpd 提供 |
| `remote` | `https://board.zash.run.place/` | 面板不在路由器上，用官方在线站点连你的内核 |
| `custom` | 你自己填的地址 | 自建 Docker / 反代 / NAS 上的面板 |

`auto` 模式会按 `core → local → remote` 的顺序自动挑一个能用的。

插件会先探测内核 API 实际走的是 HTTP 还是 HTTPS，再据此禁用走不通的路，并说明原因。

> **混合内容规则（很重要）**：浏览器不允许 HTTPS 页面请求 HTTP 后端，这条策略**没有例外**
> （只有 localhost 例外）。所以当内核 API 是 HTTP 时，**只有本地面板能用**：
>
> | 面板 | 页面协议 | 能否连 HTTP 后端 |
> |---|---|---|
> | `core` 内核 ui | HTTP | ✅ |
> | `local` LuCI 站点 | HTTP | ✅ |
> | `remote` 在线站点 | **HTTPS** | ❌ 被浏览器拦掉 |
>
> 想让在线站点也能用，得给内核配上 HTTPS API（mihomo 的 `external-controller-tls`），
> 之后插件探测到 `api_tls` 为真，会自动放开这条路并把填充协议切成 `https`。
>
> 同理，如果你用 HTTPS 反向代理访问 LuCI 本身，页面里的跳转同样受这条规则限制。

### 把面板部署到路由器

- **部署到 LuCI 站点目录**：解压到 `/www/zashboard`，由 uhttpd 直接提供。好处是完全不依赖内核的
  `external-ui`，也不会被 ShellCrash 重新生成配置时冲掉。
- **部署到内核 ui 目录**：解压到 `$CRASHDIR/ui`，还需要在 ShellCrash 菜单里把面板选成 Zashboard
  （即设置内核的 `external-ui: ui`）。

下载走 GitHub Release，失败时按顺序尝试加速前缀（内置 `ghfast.top` / `gh-proxy.com` /
`ghproxy.net` / `mirror.ghproxy.com`，可在设置里覆盖）。解压优先用 `unzip`，缺失时尝试自动安装，
再退到 `python3` / `bsdtar` / GNU `tar`。

---

## 四、配置项

`/etc/config/shellcrash`，也可以直接在页面上改。

| 选项 | 默认 | 说明 |
|---|---|---|
| `crashdir` | 空 | ShellCrash 安装目录，留空自动探测 |
| `api_port` | 空 | 内核 API 端口覆盖，留空自动探测（默认 9090） |
| `mixed_port` | 空 | 混合代理端口覆盖，仅用于展示 |
| `secret` | 空 | API 密钥覆盖，留空自动探测 |
| `panel_mode` | `auto` | `auto` / `core` / `local` / `remote` / `custom` |
| `panel_url` | 空 | `custom` 模式的面板地址 |
| `remote_url` | `https://board.zash.run.place/` | 在线站点地址 |
| `panel_query` | `1` | 是否附加 `protocol/hostname/port/secret` 参数 |
| `panel_protocol` | `http` | 附加参数里的协议 |
| `panel_query_extra` | 空 | 原样追加的额外参数，例如 `theme=dark` |
| `mirror` | 空 | GitHub 加速前缀，多个用空格分隔 |
| `zashboard_version` | `latest` | `latest` 或具体 tag，例如 `v1.4.0` |
| `poll_interval` | `5` | 状态刷新间隔（秒） |
| `log_lines` | `200` | 日志显示行数 |

---

## 五、自动探测逻辑

插件不硬编码 ShellCrash 的布局，按下面的顺序推断，任一步成功即停止：

**安装目录**：UCI `crashdir` → `/etc/ShellCrash` → `/tmp/ShellCrash` → `/usr/share/ShellCrash`
→ `/opt/ShellCrash` → `/data/ShellCrash` → `/etc/ShellClash` → `/usr/bin/crash` 软链接指向的目录
→ `/etc/init.d/shellcrash` 里的 `CRASHDIR=` 赋值。

**API 端口**：UCI `api_port` → 内核命令行 `-f` / `-d` 定位到的 `config.yaml` 里的
`external-controller` → ShellCrash 配置里的 `db_port` / `api_port` → `9090`。

**API 密钥**：UCI `secret` → 运行时 `config.yaml` 的 `secret` → ShellCrash 配置里的
`secret` / `api_secret` / `db_secret`。

**内核进程**：先按 `$CRASHDIR/bin/` 匹配命令行，再按 `mihomo` / `clash-meta` / `clash` /
`sing-box` / `xray` 匹配进程名。

**启停命令**：优先 `/etc/init.d/shellcrash <动作>`，没有 init 脚本时退到
`sh $CRASHDIR/start.sh <动作>`。

如果哪一步判断错了，在「基础设置」里手工填 `crashdir` / `api_port` / `secret` 即可绕过。

---

## 六、从源码编译

### 放进 OpenWrt 源码树

```sh
# 假设 OpenWrt 源码在 ~/openwrt，feeds 已 update/install
cp -r luci-app-shellcrashui ~/openwrt/package/
cd ~/openwrt
make menuconfig      # LuCI → Applications → luci-app-shellcrashui
make package/luci-app-shellcrashui/compile V=s
```

产物在 `bin/packages/<架构>/luci/` 下。arm64 例如 `aarch64_cortex-a53`。
因为 `LUCI_PKGARCH:=all`，装到任意 arm64 目标都没问题。

### 用 OpenWrt SDK

```sh
# 下载对应 arm64 目标的 SDK 后
cp -r luci-app-shellcrashui ~/sdk/package/
cd ~/sdk
./scripts/feeds update -a && ./scripts/feeds install -a
make package/luci-app-shellcrashui/compile V=s
```

### 不用 SDK，直接打出三种包

```sh
python3 scripts/build.py              # 全部
python3 scripts/build.py --format apk # 只要 apk

# 如果设备上 apk 报架构不匹配，用设备的真实架构重新构建
python3 scripts/build.py --format apk --apk-arch "$(ssh root@路由器 apk --print-arch)"
```

`build.py` 只用 Python 标准库，Windows / Linux / macOS 都能跑，产出：

| 文件 | 用途 |
|---|---|
| `luci-app-shellcrashui_1.0.0-1_all.ipk` | opkg 系统 |
| `luci-app-shellcrashui-1.0.0-r1.apk` | apk 系统（v2 格式，无签名，`arch = noarch`） |
| `luci-app-shellcrashui-1.0.0-rootfs.tar.gz` | 手动安装，通用兜底 |
| `SHA256SUMS` | 校验和 |

---

## 七、目录结构

```
luci-app-shellcrashui/
├── Makefile                                  # OpenWrt 包定义
├── htdocs/luci-static/resources/
│   ├── shellcrashui/panel.js                 # 共用模块：面板地址构造与可用性判断
│   └── view/shellcrashui/
│       ├── main.js                           # 运行控制页（含延迟测试）
│       ├── log.js                            # 运行日志页
│       ├── general.js                        # 基础设置页（插件自身选项）
│       ├── zashboard.js                      # Zashboard 面板页
│       └── settings.js                       # 内核与 ShellCrash 设置页
├── root/
│   ├── etc/
│   │   ├── config/shellcrash                 # UCI 默认配置
│   │   └── uci-defaults/99-luci-app-shellcrashui
│   ├── usr/libexec/luci-shellcrashui/
│   │   ├── ctl.sh                            # 后端：状态 / 控制 / 日志 / 内核参数 / 延迟
│   │   └── zashboard.sh                      # 后端：面板部署 / 后台任务
│   └── usr/share/
│       ├── luci/menu.d/luci-app-shellcrashui.json
│       └── rpcd/acl.d/luci-app-shellcrashui.json
├── scripts/
│   ├── build.py                              # ipk / apk / tar.gz 打包
│   ├── install.sh                            # 设备端一键安装
│   ├── diag.sh                               # 环境诊断（只读，密钥脱敏）
│   ├── test-views.js                         # 视图无头渲染测试（Node）
│   └── check-shell.py                        # shell 脚本结构静态检查
└── dist/                                     # 构建产物
```

### 提交前建议跑的两个测试

```sh
# 1. 前端视图无头渲染：桩掉 LuCI 运行时，真的调用 load()/render()
#    以及每一个按钮的处理函数。能抓到 node --check 抓不到的运行时错误，
#    例如未声明变量（ReferenceError）、面板 URL 拼接错误。
node scripts/test-views.js

# 2. shell 脚本结构检查：引号配对、$() 嵌套、if/fi、case/esac、do/done 配平。
python3 scripts/check-shell.py root/usr/libexec/luci-shellcrashui/*.sh
```

---

## 八、安全说明

- rpcd ACL 只授予两个后端脚本的执行权限，**没有**授予通用的 `file` ubus 权限，也没有授予
  `ubus` 下的 `file` 对象权限——拿到本插件 ACL 的用户无法借此读写任意文件。
- `ctl.sh` 只接受固定的几个动作（`status` / `start` / `stop` / `restart` / `reload` /
  `enable` / `disable` / `logs`），不接受任意命令拼接。
- `zashboard.sh` 的下载动作只接受 `install` / `uninstall` 加 `luci` / `core` 两个固定目标，
  下载地址由脚本自己解析或来自 UCI 里配置的镜像前缀。
- 页面上的「复制链接」会把 `secret` 写进剪贴板，请勿把链接分享给他人。
- 本插件不修改 ShellCrash 自己的配置文件，也不会去改写内核生成的 `config.yaml`。

---

## 九、卸载

```sh
# apk 系统
apk del luci-app-shellcrashui

# opkg 系统
opkg remove luci-app-shellcrashui

# 清理面板文件（按需）
rm -rf /www/zashboard
rm -rf /etc/ShellCrash/ui
rm -rf /tmp/luci-shellcrashui
```

---

## 十、常见问题

**apk 报 `ERROR: ...apk: unexpected end of file`**
两种可能，先排除第一种：

1. **传输被截断**（SFTP 中断、网页上传超限）。两边算出来的值必须一致：

   ```sh
   # 在你自己的电脑上（对刚下载到的文件）
   sha256sum luci-app-shellcrashui-1.0.0-r1.apk

   # 在路由器上
   sha256sum /tmp/luci-shellcrashui-1.0.0-r1.apk
   ```

   对不上就重新上传（MobaXterm 的 SFTP 面板比网页上传可靠）。
   注意：重新运行 `build.py` 会重新打时间戳，新产物与原产物的哈希**不会**相同，
   请以随包发布的 `dist/SHA256SUMS` 为准。

2. 包本身的格式问题。`scripts/build.py` 已经处理了 apk-tools 3 上实测出来的
   四个坑，手工造包时任何一个漏掉都会失败：

   | 坑 | 症状 | 处理 |
   |---|---|---|
   | 控制段带了 tar 结尾的全零块 | `unexpected end of file` | apk 把解压后的控制段与数据段当成**一个连续的 tar 流**读，只有数据段能带结束标记 |
   | `.PKGINFO` 缺 `datahash` | 校验失败 | 必须填数据段**压缩后**字节的 SHA256 |
   | 文件缺 `APK-TOOLS.checksum.SHA1` PAX 扩展头 | `file format is obsolete (e.g. missing embedded checksum)` | 每个普通文件都要带内容 SHA1 的 PAX 头，目录不需要 |
   | 只有 `.post-install` 没有 `.post-upgrade` | 升级后菜单/ACL 不生效 | apk 在**替换/升级**安装时只跑 `.post-upgrade`，首次安装才跑 `.post-install`，两个都要给 |

> 另外，用 Python 的 `tarfile` 手工造 apk 时，它在关闭归档时会按 10240 字节的
> 记录块补齐，所以不能简单地"砍掉最后 1024 字节"——中间还会残留几千字节零块，
> 效果和第一个坑完全一样。正确做法是按成员头里的 `size` 字段精确累加出占用长度。

**apk 报架构不匹配**
重新构建时指定设备真实架构：

```sh
python3 scripts/build.py --format apk --apk-arch aarch64_cortex-a53
# 设备上执行 apk --print-arch 可得准确值
```

**菜单没出现**
强制刷新浏览器（Ctrl+F5），或退出 LuCI 重新登录。仍未出现就执行：

```sh
rm -f /tmp/luci-indexcache && rm -rf /tmp/luci-modulecache
/etc/init.d/rpcd restart && /etc/init.d/uhttpd restart
```

**页面提示「未安装」**
ShellCrash 装在了非标准目录。执行 `sh scripts/diag.sh` 看第 2 节的输出，然后在
「基础设置 → ShellCrash 安装目录」里手工填。

**状态显示"已停止"，但内核其实在跑**
内核进程名不在识别列表里。在诊断输出第 5 节看实际进程名与命令行。

**「热重载配置」报错**
需要 `curl`：`opkg install curl`（或 `apk add curl`）。另外内核没运行、或 API 端口/密钥
填错也会失败。

**部署面板一直失败**
路由器到 GitHub 的连通性问题。在「面板设置 → GitHub 加速前缀」里填一个可用的前缀，
或先手动把 Zashboard 的 `dist.zip` 解压到 `/www/zashboard`。

**跳转面板后仍要求填地址**
说明这一条的链接没能自动带过后端信息。检查「面板设置 → 自动填充后端地址和密钥」是否开启。
如果是在线站点（HTTPS）连 HTTP 内核，浏览器会拦掉请求——这是混合内容策略，没有例外，
插件已经把这条路禁用并说明了原因，请改用两个本地面板。

---

## 十一、实测环境

本插件是在真实设备上跑通并逐项核对过的，不是只做了静态检查：

| 项 | 值 |
|---|---|
| 设备 | 联发科 Filogic（MT7981），aarch64 |
| 固件 | OpenWrt 25.12.4 (r32933-4ccb782af7)，target `mediatek/filogic` |
| 包管理器 | apk-tools 3，`/etc/apk/arch` = `aarch64_cortex-a53` |
| ShellCrash | 1.9.5beta3，安装在 `/etc/ShellCrash` |
| 内核 | mihomo v1.19.17，启动命令 `/tmp/ShellCrash/CrashCore -d /etc/ShellCrash -f /tmp/ShellCrash/config.yaml` |
| 面板 | Zashboard 已部署在 `/etc/ShellCrash/ui`，`external-ui: ui` |

实测结果：

- `apk add --allow-untrusted` 安装通过，`arch = noarch` 被接受
- LuCI 菜单四个条目正常装配
- 前端 JS 由 uhttpd 正常提供（HTTP 200），本地源码与设备上安装的文件逐字节一致
- 后端自动探出：API 端口 **9999**（不是默认 9090）、redir 端口 7892、内核 `meta` / `v1.19.17`、面板目录 `/etc/ShellCrash/ui`
- 延迟测试 4 个站点并发返回，共约 1.2 秒
- 内核运行参数的每一项都在真机上改过并还原，确认立即生效

该设备上 `secret` 未设置，并且缺少 `unzip` / `python3` / `pkill` / `base64`，
插件对这些情况都能正确降级或自动补齐依赖。

---

## 十二、开发与测试

改完代码建议跑这两个脚本，它们能抓到单纯 `node --check` 抓不到的问题：

```sh
# 前端视图无头渲染：桩掉 LuCI 运行时，真的调用 load()/render() 与每一个
# 按钮的处理函数，并检查内联样式在明暗主题下都不会「浅底浅字」
node scripts/test-views.js

# shell 脚本结构检查：引号配对、$() 嵌套、if/fi、case/esac、do/done 配平
python3 scripts/check-shell.py root/usr/libexec/luci-shellcrashui/*.sh
```

`scripts/diag.sh` 是给用户排查用的只读环境诊断脚本（密钥脱敏），
可以直接让用户跑完把输出贴回来。

### 写 LuCI 资源模块的坑

自定义模块（放在 `htdocs/luci-static/resources/` 下，用 `'require a.b as b'` 引入）
**必须返回 Class，不能返回普通对象**：

```js
'require baseclass';
return baseclass.extend({ ... });   // 正确
// return { ... };                  // 错误
```

LuCI 的加载器拿到工厂的返回值后会做 `Class.isSubclass()` 检查，然后 `new`
出实例再交给使用方。返回普通对象会直接抛：

```
TypeError: "a.b" factory yields invalid constructor
```

依赖这个模块的页面会全部白屏。`scripts/test-views.js` 里已经复刻了这道检查，
本地跑一次就能发现，不用等用户到浏览器里报错。

打包：

```sh
python3 scripts/build.py                 # ipk + apk + rootfs.tar.gz
SOURCE_DATE_EPOCH=1700000000 python3 scripts/build.py   # 可复现构建
```

---

## 十三、相关链接

- ShellCrash：<https://github.com/juewuy/ShellCrash>
- Zashboard：<https://github.com/Zephyruso/zashboard>
- Zashboard 在线站点：<https://board.zash.run.place/>
- mihomo 文档（`external-controller` / `secret` / `external-ui`）：<https://wiki.metacubex.one/>

## 许可

**MIT**，全文见 [LICENSE](LICENSE)。

选 MIT 的理由：本项目是独立的 shell + JS 程序，不链接、也不包含 ShellCrash /
Zashboard / mihomo 的任何代码，copyleft 在这里没有实际收益；MIT 最短、最通用，
下游塞进固件或二次分发都没有摩擦。

**全部源码都在仓库里**，没有任何二进制或混淆内容。唯一不在版本库中的是打包产物
（`dist/`，已由 `.gitignore` 排除），它由 `scripts/build.py` 从同一份源码生成，
你在本地跑一次就能得到与发布版一致的包。

本项目是给 ShellCrash 写的**第三方界面**，与 ShellCrash、Zashboard、mihomo 的
作者没有隶属关系。
