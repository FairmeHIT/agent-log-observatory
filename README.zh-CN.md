> 2026-10-14：WorkBuddy 调用 usage 保留显式 session_id；客户端清理 sessions 索引后，历史身份凭 transcript 原生 sessionId 核验。Mobilework/TeleAgent 支持精确会话查询，Console 补采与分项统计见 [可靠性复核增量](docs/reliability-review-2026-10-14.html#capture-backfill).

> 2026-10-14 v0.0.12：采集可信度、Console 保存与总览统计复核见 [可靠性复核回执](docs/reliability-review-2026-10-14.html)。旧历史不改写；口径未知的 Token 总量、未准入记录及不可核验快照排除出统计。

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

更新：**2026-10-14，工程 v0.0.11；豆包 Adapter/Collector 0.3.0**。以下按当前源码提取路径核对，不代表所有客户端版本或每个会话都已实测。

✅ 已有只读提取/派生计算路径（前提是源含相应字段） · ⚠️ 条件可用、部分覆盖、估计或需要可选采集器 · ❌ 当前缺失或无有效提取路径。实际结果以 `value`、`state`、`evidence_grade`、`coverage` 和 `missing_reason` 为准；源不提供时返回 null，不以 0 代替。

### 时延

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `turn_e2e_ms` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| `llm_attempt_ttft_ms` | ❌ | ⚠️ | ❌ | ❌ | ✅ | ⚠️ | ⚠️ |
| `session_first_response_ms` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `session_lifespan_ms` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |

### Token 与成本

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `token_input` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_output` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_cache_read` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_reasoning` | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `token_total` | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ |
| `cache_hit_rate` | ✅ | ⚠️ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `generation_output_tps` | ⚠️ | ⚠️ | ⚠️ | ❌ | ✅ | ❌ | ❌ |
| `max_context` | ✅ | ✅ | ✅ | ❌ | ✅ | ⚠️ | ✅ |
| `context_window` | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `credits` | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ⚠️ |

### 调用、工具与步骤

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `llm_call_count` | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| `success_rate` | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| `llm_retry_count` | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| `tool_call_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `llm_error_count` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `tool_error_count` | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| `step_count` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `human_confirm_count` | ❌ | ⚠️ | ✅ | ⚠️ | ❌ | ❌ | ⚠️ |
| `compaction_count` | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| `compaction_threshold` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

### 诊断与事件

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `failures_gateway` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `failures_tool` | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ | ⚠️ |
| `failures_model` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `failures_dependency` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `failures_agent` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `dependency_error_count` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `agent_error_count` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `event_count_agent_input` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_llm_request` | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ |
| `event_count_llm_response` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_tool_call` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_tool_result` | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |

### 口径与条件

- **TTFT**：WorkBuddy 的 generation span 结束只证明生成完成，TTFT 保持缺失；Mobilework 仅纳入明确会话绑定与首输出锚点，未绑定代理响应到达不能按时间窗借给会话；Codex 用 turn 开始到首 reasoning/agentMessage item 的派生时间；opencode 依赖可选插件首输出记录。这些时间锚点不能统一声称为原生首 token。TeleAgent reasoning 开始不等于首 token，仍缺失 TTFT。
- **Token 与成本**：Mobilework 已有 reasoning 字段；TeleAgent 当前 usage 提取不包含 reasoning。Codex rollout input 包含 cache、output 包含 reasoning，分项不能重复相加；旧会话无分项时仍可能有总量。`credits` 在 WorkBuddy 是 Credits，在 Mobilework/TeleAgent/opencode 读取到 cost 时单位是 USD，零值/缺字段当前可能返回 null，不能跨单位汇总。
- **首响应、吞吐与上下文**：首响应相对 session 开始，独立于单次调用 TTFT；opencode 已实现首响应。输出 TPS 依赖输出 Token 与 generation/decode 时长。`max_context` 的各 Agent 定义不同；Codex rollout 缺失时不再用累计 Token 冒充峰值上下文。
- **成功、确认与步骤**：`success_rate` 仅统计已知调用/工具终态，部分 Adapter 返回同名的 LLM 与工具结果，不能视为业务成功率或混为同一口径。Mobilework/opencode 人工确认依据 ask 权限规则与工具使用估计；豆包只认明确审批配对。Step 是各源的步骤/事件定义，不保证跨 Agent 一致。
- **诊断与返回事件**：`failures_*` 主要是日志规则分类，不证明根因。DSH 当前诊断为空占位，表中不算可采集。Mobilework/TeleAgent/DSH/Codex/opencode 的 `event_count_tool_result` 当前以调用数派生，不保证实际收到返回；豆包有单独的唯一结果计数与原始返回行计数。

### 豆包新增指标（0.3）

默认只读 trajectory 可获得以下配对与覆盖指标；CDP 是显式开启的实时补充，仅观察用户已有流量，不主动发送消息。RPA/Bridge 是已有基础设施日志的只读提取。

| 指标 | 状态 | 来源与口径 |
| --- | --- | --- |
| `assistant_message_count` / `agent_observed_count` | ✅ | 有效助手消息行数、具有可读轨迹的 Agent 数。 |
| `tool_call_count` / `tool_result_count` | ✅ | 按 session + agent + call ID 配对的唯一调用与返回；返回含孤立结果。 |
| `tool_unresolved_count` / `tool_orphan_result_count` | ✅ | 未见返回的调用、未找到调用的返回；不直接认定执行失败。 |
| `tool_duplicate_call_count` / `tool_duplicate_result_count` / `tool_type_count` | ✅ | 重复原生 ID 的调用/返回记录数、不同工具名称数。 |
| `tool_terminal_coverage` | ✅ | 已知结构化终态 / 唯一调用；存在返回但终态全未知时可为 0。 |
| `tool_success_rate` / `tool_error_count` / `failures_tool` | ⚠️ | 仅结构化 status/success/exit_code；终态未知时成功率/错误数保持 partial 或 null。 |
| `source_parse_error_count` / `source_partial_line_count` / `source_freshness_ms` | ✅ | 非法完整行、未写完尾行、距最近文件写入的时间；不作为任务发生时间。 |
| `client_request_count` / `client_headers_ms` / `client_first_text_ms` | ⚠️ CDP | 观测请求数、请求到响应头/首解析文本的平均耗时（ms）。 |
| `client_stream_ms` / `client_reply_e2e_ms` | ⚠️ CDP | 请求到 HTTP 结束 / 明确 SSE 回复结束的平均耗时（ms），不等于任务 E2E。 |
| `stream_chunk_count` / `stream_max_pause_ms` | ⚠️ CDP | 文本更新数、每请求最大更新间隔的均值（ms），不统计心跳为输出。 |
| `stream_output_chars` / `stream_output_chars_per_second` | ⚠️ CDP | 每请求输出字符数及字符速率均值（chars/s），不换算 Token 或 tok/s。 |
| `client_network_error_count` / `client_cancelled_count` / `collector_gap_count` | ⚠️ CDP | 观测到的网络错误、取消、存在断连/流不支持/解析缺口的请求数。 |
| `collector_bound_event_count` / `collector_unbound_event_count` | ⚠️ CDP | 已绑定会话事件数；未绑定事件数保持 installation scope。 |
| `human_request_count` / `human_confirm_count` / `human_wait_ms` | ⚠️ CDP | 明确审批 ID、请求与决定配对；有时间的配对计算平均等待，不识别普通“是/确认”回复。 |
| `task_completed_observed_count` | ⚠️ CDP | 仅显式 completed 事件数，不证明业务成功。 |
| `rpa_run_count` / `rpa_run_ms` / `rpa_command_ms` | ⚠️ RPA | 已观测 runner_completed 数、运行/命令平均耗时（ms）。 |
| `bridge_latency_ms` / `bridge_execution_ms` / `bridge_queue_depth` | ⚠️ RPA | Bridge 延迟、执行时间（ms）及观测队列深度均值。 |

CDP 需要客户端开启本机调试端口、支持流协议，并具备明确 `trajectory_session_id` 或已核实且唯一的 `conversationBindings`。缓冲回补文本没有原始到达时间，不填首文本耗时；回复完成不等于任务完成。全局 RPA/Bridge 保持 installation scope，只有明确 session ID 或会话私有目录所有权才归入会话。

豆包仍缺失 **Token usage、成本、内部 LLM TTFT、实际模型路由、重试分组、原生 Step 和无时间戳轨迹的轮次 E2E/会话时长**；`llm_call_count` 仅在存在明确 `llm_call_id` 时部分可用，助手消息数另计。2026-10-13 验证包含协议 fixture、HTTP/UI 测试与本机轨迹只读检查；真实 CDP 采集尚未验收。

完整口径、版本与会话绑定见 [0.3 实现说明](docs/doubao-observation-v0.3.md)；测试与真实采集边界见[验证回执](docs/doubao-validation-2026-10-13.md)；参考项目分析见[研究报告](docs/doubao-observability-research.md)。

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
| `mobilework-llm-proxy` | 请求/响应到达时间（派生；不能保证原生首 token） | 转发用户已有流量；新进程需正确代理路由 |
| `doubao-cdp-collector` | 客户端响应头/首文本/回复耗时、流输出、明确工具/审批事件 | 否 — 客户端需手动开启本机 CDP；会话需明确绑定 |

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
npm test          # 单元/集成测试（含豆包观测协议 fixture）
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

## 五类图表数据与统计缺口修复（v0.0.11）

Dashboard 顶部“图表数据”和 GET /api/chart-data 提供五类图表数据；完整/选中会话导出也包含 chart_data。新版全量实时只读导出附采集窗口和分节状态，避免缓存指标与新调用记录拼接。

旧文件可用 node scripts/prepare-chart-data.mjs --input tester-1=export.json --output chart-data.json 离线处理。任务成功与 Pass@5/Pass^5 依赖外部 Outcome 和明确 Task/Trial/Batch 绑定；观测活动代理单列。Mobilework 流段/重试不冒充 LLM 请求，TeleAgent 工具名/状态读取原生字段，工具率不再覆盖 LLM 率；cache 包含关系 unknown 时命中率留 null。

完整口径、历史数据缺口及验证范围见 [图表数据契约](docs/chart-data.html)，机器契约见 schemas/chart-data.schema.json 和 schemas/chart-bindings.schema.json。
