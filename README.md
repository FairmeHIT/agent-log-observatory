# Agent Log Observatory

> Copyright 2026 lihuafu (https://github.com/FairmeHIT)  
> Licensed under the [Apache License, Version 2.0](LICENSE).

跨 Agent 的本地日志观测 Dashboard：统一展示时延、Token、LLM/工具调用、人工确认和失败归因。支持 WorkBuddy、Mobilework、TeleAgent、Doubao、DSH、Codex、opencode。

**定位：可独立复制/clone 的项目，不依赖本工作区的其他子项目。** 没有安装的 Agent 显示不可用；源数据没有的指标显示 `not-captured`，不会伪装为 0。

## 1. 安装（Windows x64）

1. 安装 **Node.js 24.x（含 npm）**，确认 `node --version`。本次验证版本为 24.19.0；旧文档中的 Node 18 不适用于当前代码。
2. clone 仓库，或取得完整的发布目录，进入项目根目录。
3. 执行：

   ```powershell
   node scripts/setup.mjs
   ```

   从 `vendor/npm/` 离线安装锁定依赖；自检原生模块/文件哈希；首次生成本地配置。**不需要全局安装 SQLite、Python、插件或其他 Dashboard。**
4. 按需编辑 `agent-log-observatory.config.json` 中的 Agent 路径。默认使用当前用户数据目录，不要复制别人的配置。启动器要拉起 Mobilework 时，填写其 `installDir`。
5. 启动：

   ```powershell
   node server.mjs
   ```

   浏览器访问 `http://127.0.0.1:8780/`；前台运行用 `Ctrl+C` 停止。

也可双击 `启动.cmd`：一键在后台隐藏启动 Dashboard + Mobilework 代理 + 豆包 CDP 采集器（豆包未开调试端口时自动跳过），日志在 `runtime/logs/`；`停止.cmd` 停止全部本项目登记的进程，不杀其他 Node 或 Agent，也绝不终止 Agent 客户端。

## 2. 可选：补充采集

历史 Dashboard 不要求安装采集器。完整步骤、限制和回退见 [部署与采集器安装](docs/deployment.md)。

| 需求 | 项目内实现 | 需要改项目外配置吗？ |
|---|---|---|
| opencode TTFT/retry | `collectors/opencode-collector-plugin/` | **是**：显式安装后只增加客户端插件引用；源码不复制到用户目录 |
| Mobilework HTTP TTFT | `collectors/mobilework-llm-proxy/` | 默认**否**：通过新启动进程的 `HTTP_PROXY`；可选反向代理才修改 providers 配置 |
| Doubao TTFT/retry | `collectors/doubao-cdp-collector/` | **否**：客户端需手动带本地 CDP 调试参数启动 |

```powershell
# 一键：Dashboard + Mobilework 代理 + 豆包 CDP 采集器（豆包未开调试端口时自动跳过）
.\启动.cmd
# 停止全部本项目服务
.\停止.cmd

# Mobilework TTFT：代理 + Dashboard + 自动带 HTTP_PROXY 的客户端
# （先关闭已打开的 Mobilework；用完先自行关闭客户端，再执行 停止.cmd）
.\启动Mobilework.cmd

# 豆包 TTFT：豆包带 --remote-debugging-port=9223 启动后，运行 启动.cmd 即自动附着采集
```

**代理仅支持 HTTP 上游，不支持 HTTPS CONNECT；不同客户端版本的插件/CDP 能力可能不同。** 按文档验证实际产生的采集文件，不把“进程启动”当成“指标已采集”。

## 3. 配置与文件边界

- `agent-log-observatory.config.example.json`：可提交的通用配置，缺省读取当前用户的 Agent 数据。
- `agent-log-observatory.config.json`：本机路径/设置，忽略提交。支持 `~/`、`${LOCALAPPDATA}` 和相对项目根目录的路径；反斜杠需按 JSON 转义。
- `runtime/`：缓存库、采集 JSONL、诊断、日志、PID、安装缓存和临时文件；仅 `sqlite3.exe` / `README.md` 随发布分发。
- `vendor/`：当前依赖安装包、许可证、原始采集器归档与 SHA-256 清单；**必须随项目分发**。
- Agent 客户端、账号、模型服务和它们的原始日志属于外部输入，不打包、不修改。EAQE Bundle / Mobilework 旧 sidecar 数据是可选输入，不是启动依赖。

从旧用户目录迁移采集历史（只复制缺失文件，不删源、不覆盖同名文件）：

```powershell
node scripts/import-legacy-collectors.mjs
```

## 4. 验证与发布

```powershell
npm run doctor
npm test
# 生成不含本地配置、真实历史和 node_modules 的独立发布目录
npm run release
```

API 检查：`GET /api/health`、`GET /api/sessions`、`GET /api/metrics/compare?limit=5`。新电脑不必具备全部七个 Agent；已有日志才能显示真实会话，采集器只能补充安装后的数据，不能凭空补齐历史 TTFT/Token。

发布输出在 `releases/agent-log-observatory-0.0.9/`。**发布前仍需人工审查源码/fixture 的隐私，以及选择项目开源许可证**；当前没有替作者指定许可证。不要把整个工作目录压缩后直接公开。

## 文档

- [部署、安装、使用与回退](docs/deployment.md)
- [工具/插件归档清单与外部依赖边界](docs/dependency-inventory.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [协作契约](AGENTS.md) · [指标与架构规格](SPEC.md) · [适配器指南](adapters/README.md)
