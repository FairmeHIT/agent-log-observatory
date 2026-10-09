# 工具、插件与文件归档清单

> 盘点日期：2026-10-04。当前可运行实现为唯一基准，不以旧 README 的“零依赖/Node 18”描述为准。

## 1. 必须随项目分发

| 内容 | 当前版本/原始文件 | 安装位置 / 用途 |
|---|---|---|
| SQLite CLI | `runtime/sqlite3.exe`，3.53.4，Windows x64 | 项目内；读取 Agent SQLite 用 `-readonly` |
| better-sqlite3 | 13.0.3，`vendor/npm/better-sqlite3-13.0.3.tgz` | setup 离线装入本项目 `node_modules/`；自有 Dashboard 缓存库 |
| node-addon-api | 8.9.2，`vendor/npm/node-addon-api-8.9.2.tgz` | better-sqlite3 的传递依赖；同样本地离线安装 |
| opencode 插件 | `collectors/opencode-collector-plugin/{index.mjs,package.json}`，实现 0.3.0 | 源码留项目；客户端仅注册绝对路径引用 |
| Mobilework 代理 | `collectors/mobilework-llm-proxy/`，实现 0.2.0 | 项目内运行；本机路由在 `runtime/mobilework-proxy.json` |
| Doubao CDP 采集器 | `collectors/doubao-cdp-collector/`，实现 0.1.0 | 项目内运行，无用户目录插件副本 |
| 改造前采集器原件 | `vendor/archives/collectors-before-portability-20261004.tar.gz` | 原 index/package、两种安装脚本、attempt schema；仅历史归档，不执行旧默认路径 |
| 安装/状态/卸载 | `collectors/install-*.mjs` | 按部署文档显式执行，默认 setup 不运行 |
| 部署/进程/迁移工具 | `scripts/{setup,doctor,paths,import-legacy-collectors,audit-local-installation,export-release}.mjs`、`services.ps1`、根目录 `.cmd` | 项目内，无全局工具安装 |
| 调试探针 | `scripts/probe-doubao-cdp*.mjs` | 实验/可选；不属于部署前提，trigger 可能主动发送消息 |

`vendor/manifest.json` 登记文件大小/版本/来源说明/SHA-256；doctor 核验完整性。源码安装入口以当前 `collectors/` 为准，不要为保持“原件”而运行老归档。

## 2. 原件来源与授权边界

- 两个 npm tgz 是从本机正在用的 **已安装 npm 包重打包**（`npm pack --ignore-scripts`），不是声称下载了上游原始 tgz。保留现有源码、原生预构建文件及包内许可证；lockfile 固定本地 tgz 与 integrity。
- SQLite CLI 来自现有项目文件，版本由实际二进制 `-version` 得到；历史下载来源与官方上游二进制哈希**未独立核验**。记录本地 SHA-256 只保证归档一致，不等于上游签名/供应链认证。公开发布前应重新核验来源。
- `vendor/licenses/` 留存两个 npm 依赖的 MIT 原文；SQLite 授权说明见 `THIRD_PARTY_NOTICES.md`。
- 项目自身尚未选择开源许可证；`private:true` 防止误 npm publish，**不代表代码已经授予开源使用权**。版权/授权归属由项目所有者确认，不自动给闭源客户端重新授权。

## 3. 不打包的外部前提/可选输入

| 外部项 | 必须？ | 理由与部署方式 |
|---|---|---|
| Node.js 24.x + npm | 是 | 平台运行时，由用户自行安装；当前验证 24.19.0，不捆绑整个个人 Node 安装目录 |
| Windows x64 / 自带 PowerShell | 当前验证环境 | 后台启动和进程观测；不要求 WMI `wmic` 命令行工具 |
| 七种 Agent 客户端、账号/模型权限 | 至少有日志才有真实展示 | 各自按厂商安装和使用，本项目只读其日志；不提供闭源安装包/账号 |
| opencode plugins 引用 | 只用可选插件时 | 必须写客户端配置；提供 install/status/uninstall 和备份 |
| Mobilework providers 变更 | 只用反向代理时 | 默认环境变量方案不改配置；反向方案显式备份/回退 |
| Doubao 调试启动参数 | 只用可选 CDP 时 | 手动本地调试端口，不安装插件 |
| Mobilework trace-dashboard 旧 sidecar | 否 | 只读已有 `stream-timings.json`；闭源 sidecar 原件未取得，不作为部署门槛，不承诺复制其全部效果 |
| EAQE Bundle/父工作区/旧 Dashboard | 否 | 显式配置时只读输入；独立运行不需要兄弟目录 |
| Python、全局 sqlite、全局 npm 插件 | 否 | 当前标准安装/运行流程不使用 |

## 4. 本机盘点与私有数据

本次没有自动安装/卸载客户端插件，没有修改 Agent 原始日志或外部配置。盘点脚本只检查配置存在性和本插件引用/哈希；结果在 `runtime/private/local-installation.json`，不进发布。本机未找到默认位置的 opencode 配置，不能声称该外部注册已验证。

旧 `~/.agent-log-observatory/collectors/` 的 attempts 已通过 copy-only 导入项目 runtime；同名文件跳过，源目录保留。运行中的旧客户端/采集器需用户自行停旧、重启后才采用新路径。

本机配置、代理上游地址、采集历史、缓存 DB、资源快照、诊断与启动日志全部私有。发布白名单不包含它们；整个工作目录不是可直接开源的归档。
