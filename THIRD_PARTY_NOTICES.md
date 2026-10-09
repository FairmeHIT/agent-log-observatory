# 第三方声明与发布前检查

本项目基于 [Apache License 2.0](LICENSE) 开源，Copyright 2026 lihuafu (https://github.com/FairmeHIT)。

本文件登记已归档依赖的第三方组件授权信息。

| 组件 | 版本 | 授权/来源记录 |
|---|---|---|
| better-sqlite3 | 13.0.3 | MIT；完整文本 `vendor/licenses/better-sqlite3-LICENSE`；源码仓库 WiseLibs/better-sqlite3 |
| node-addon-api | 8.9.2 | MIT；完整文本 `vendor/licenses/node-addon-api-LICENSE.md`；源码仓库 nodejs/node-addon-api |
| SQLite | 本地 CLI 3.53.4；better-sqlite3 内亦有嵌入版 | SQLite 上游将源码置于 public domain；可按其 copyright 页面核验。当前本地 CLI 的历史下载出处未独立核验，不据哈希宣称可信来源 |

npm 包中的预构建原生模块与源码一并归档，保留包内文件及授权文本。重分发时不要删除 `vendor/licenses/`、本文件和包内许可证。

## 原件/来源核验

- 来源与版本见 `docs/dependency-inventory.md`；本地归档哈希见 `vendor/manifest.json`。
- npm tarball 是当前已安装包的重打包；与原始上游发布 tarball 的 integrity 不同是预期行为。
- Node.js、Windows/PowerShell、闭源 Agent 客户端不随仓库分发，由用户遵循各自许可证自行准备。
- 发布前核查 SQLite CLI 来源、第三方分发条款和本项目版权归属；必要时用官方校验后的二进制替换并同步 manifest。

上游识别信息：`https://github.com/WiseLibs/better-sqlite3`、`https://github.com/nodejs/node-addon-api`、`https://sqlite.org/copyright.html`。本地完整许可证是当前归档授权的直接依据。
