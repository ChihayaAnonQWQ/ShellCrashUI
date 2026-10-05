# 更新日志

## v1.0.0（未发布）

首个公开版本。三个页面：运行控制、Zashboard 面板、内核与 ShellCrash 设置。

### 运行控制

- 概览条：服务状态（PID / 内存）、内核类型与版本、API 端口与可达性、本地面板部署情况
- 服务详情表：ShellCrash 版本、安装目录、配置文件、主机架构、各代理端口、密钥、开机自启
- 服务控制：启动 / 停止 / 重启 / 热重载配置 / 开机自启开关
- 运行日志：自动定位日志文件，取不到时回退 `logread`
- 延迟测试：百度 / 谷歌 / GitHub / YouTube 并发探测，经混合端口发出以反映真实分流结果

### Zashboard 面板

- 四种打开方式：内核 `external-ui`、LuCI 站点目录、在线站点、自定义地址
- 自动判断每条路是否真的可用：未部署或会触发浏览器混合内容拦截的，直接禁用按钮并说明原因和解决办法
- 一键部署 / 更新面板到路由器，带 GitHub 加速前缀与后台任务进度
- 跳转链接自动带上 `protocol` / `hostname` / `port` / `secret`，打开即连，无需手填

### 内核与 ShellCrash 设置

- 内核运行参数在线修改（通过 Clash API，立即生效）：代理模式、日志等级、允许局域网连接、IPv6、TCP 并发
- ShellCrash 配置文件编辑器：自动备份为 `.bak`、支持从备份恢复、支持保存并重启

### 打包与安装

- 一次产出三种格式：`.ipk`（opkg）、`.apk`（apk-tools 3）、`rootfs.tar.gz`（手动兜底）
- 安装脚本按包管理器自动选择，失败时回退到解包安装
- 支持 `SOURCE_DATE_EPOCH` 的可复现构建

### 已适配的环境差异

针对真实设备上遇到的差异做了自动探测，无需手工配置：

- 端口与密钥只在运行时 `config.yaml` 里，不在 `ShellCrash.cfg`
- 内核路径写在 `configs/command.env` 的 `COMMAND=` 里，需要展开变量
- 内核类型是 `crashcore`、版本是 `core_v`、面板地址在 `hostdir`
- 部分固件缺 `unzip` / `python3` / `pkill` / `base64`，均能降级或自动补齐
- 深色主题下不使用硬编码背景色

### 已知限制

- `unified-delay` 不在 mihomo 的 `PATCH /configs` 支持范围内，调用返回成功但值不变，因此只展示不提供修改
- 内核运行参数的修改只作用于本次运行，ShellCrash 重启后会按 `config.yaml` 重建
- 在线站点（HTTPS）连不上 HTTP 内核 API，这是浏览器的混合内容策略，无解；插件会禁用该路径并说明
- `.apk` 未使用可信私钥签名，安装需要 `--allow-untrusted`

### 许可

MIT。全部源码都在仓库中，无二进制与混淆内容。

### 说明

本项目完全由 DeepSeek 完成：需求由使用者提出，代码编写、测试与真机调试全部由 AI 完成。
