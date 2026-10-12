# Agent Log Observatory

跨 Agent 的本地日志观测与统计分析工具。只读采集 7 个 AI 编码 Agent 的本地日志，标准化为统一指标体系，提供每 session 详情、跨 Agent 对比和失败归因——不安装 Hook、不修改 Agent 客户端。

**English** | [中文文档](README.zh-CN.md)

## 支持的 Agent

| Agent | 数据源 | 平台 |
|---|---|---|
| WorkBuddy | `~/.workbuddy/` transcript JSONL + trace spans | Windows |
| Mobilework | `~/.mobilework/` SQLite（runs, model-raw, parts） | Windows |
| TeleAgent | `~/.local/share/TeleAgent/` SQLite + Go 日志 | Windows |
| Doubao | `${LOCALAPPDATA}/Doubao/` trajectory JSONL | Windows |
| DSH | `~/.dsh/` 事件 JSONL + zstd 帧 | Windows |
| Codex | `~/.codex/` SQLite + `sessions/**/rollout-*.jsonl` | Windows |
| opencode | `~/.local/share/opencode/` SQLite（session/message/part） | 跨平台 |

未安装的 Agent 显示不可用，不报错。无法获取的指标返回 `null` + `state: "not-captured"`，不冒充 0。

## 指标覆盖

✅ 可采集 · ❌ 不可采集（数据源缺失） · — 不适用

### 延迟

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `turn_e2e_ms`（轮次端到端） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `llm_attempt_ttft_ms`（TTFT） | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `session_first_response_ms`（首响应） | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| `session_lifespan_ms`（会话时长） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Token

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `token_input`（输入） | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_output`（输出） | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_cache_read`（缓存命中） | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_reasoning`（推理） | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `token_total`（总计） | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `cache_hit_rate`（命中率） | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `max_context`（峰值上下文） | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `context_window`（上下文窗口） | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `credits`（费用） | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### LLM 调用与错误

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `llm_call_count`（调用数） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `success_rate`（成功率） | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `llm_retry_count`（重试数） | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| `llm_error_count`（错误数） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `failures_model`（模型失败归因） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 工具与步骤

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `tool_call_count`（工具调用数） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tool_error_count`（工具错误数） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `failures_tool`（工具失败归因） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `step_count`（步骤数） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `human_confirm_count`（人工确认） | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| `compaction_count`（压缩次数） | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |

### 错误与事件

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `dependency_error_count`（依赖错误） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `agent_error_count`（Agent 错误） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_agent_input`（用户输入数） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_llm_response`（LLM 响应数） | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |

## 快速开始

**前置条件：** Node.js 24.x（验证版本 24.19.0），Windows x64。

```powershell
# 1. 安装依赖（从 vendor/ 离线安装）
node scripts/setup.mjs

# 2. 启动 Dashboard
node server.mjs
```

浏览器访问 `http://127.0.0.1:8780/`，`Ctrl+C` 停止。

也可双击 `start.cmd`：一键在后台启动 Dashboard + Mobilework 代理 + 豆包 CDP 采集器；`stop.cmd` 停止全部本项目进程（不杀 Agent 客户端）。

## 可选采集器

部分指标需要可选采集器补充 Agent 日志中缺失的时延数据：

| 采集器 | 补充指标 | 是否需改外部配置 |
|---|---|---|
| `opencode-collector-plugin` | TTFT、重试、人工确认 | 是 — 需显式安装到 opencode 配置 |
| `mobilework-llm-proxy` | TTFT（通过 HTTP 代理） | 否 — 新进程自动带 `HTTP_PROXY` |
| `doubao-cdp-collector` | TTFT、重试、context_window | 否 — 客户端需带 `--remote-debugging-port` 启动 |

完整步骤见[部署指南](docs/deployment.md)。

## 配置

- `agent-log-observatory.config.json` — 本机 Agent 路径（忽略提交）。支持 `~/`、`${LOCALAPPDATA}` 和相对路径。
- `agent-log-observatory.config.example.json` — 可提交的通用模板。
- `runtime/` — 缓存数据库、采集 JSONL、日志（忽略提交，除 `sqlite3.exe`）。
- `vendor/` — 锁定依赖、许可证、SHA-256 清单。**发布时必须随附。**

Agent 客户端、账号、模型服务及其原始日志属于外部输入，不打包、不修改。

## 验证

```powershell
npm run doctor    # 环境 + 原生模块 + 数据源检查
npm test          # 102 个单元/集成测试
npm run release   # 生成独立发布目录
```

API：`GET /api/health` · `GET /api/sessions` · `GET /api/metrics/compare`

## 架构

```
adapters/          # 7 个 Agent 适配器（discover, extractSessions, extractMetrics, ...）
lib/               # 共享：指标引擎、证据模型、SQLite 查询、标准化器
collectors/        # 可选采集器（opencode 插件、mobilework 代理、doubao CDP）
server.mjs         # HTTP 服务 + 同步循环 + API 路由
index.html         # 单页 Dashboard（会话列表、详情、对比）
runtime/           # observatory.db、采集 JSONL、日志（忽略提交）
```

Agent 特定逻辑在 `adapters/`，共享指标引擎在 `lib/metrics.mjs`——适配器不另写公式。

## 许可证

[Apache License 2.0](LICENSE) · Copyright 2026 [FairmeHIT](https://github.com/FairmeHIT)
