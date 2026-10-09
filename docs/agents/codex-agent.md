# Codex（OpenAI Codex Desktop）数据源明细

> 本文件从 SPEC.md §2 拆分而来，是 Codex Agent 的完整数据源探测记录。SPEC.md 总览见 [SPEC.md](../../SPEC.md)。

## 安装目录

`%LOCALAPPDATA%\OpenAI\Codex\`（Electron 桌面应用）
- 可执行文件：`bin\<hash>\codex.exe`
- app-server daemon：`~/.codex/packages/app-server-daemon/releases/<version>\bin\codex.exe`
- version.json：`{"latest_version":"0.159.2"}`

## 用户数据目录

`%USERPROFILE%/.codex/`

### 核心数据源

| 路径 | 格式 | 内容 | 可提取指标 |
|---|---|---|---|
| `config.toml` | TOML | `model = "kimi-k3"`, `model_provider = "kimi"`, `model_context_window = 1048576`, `model_auto_compact_token_limit = 900000`, `model_providers.*` | **Context Window**（模型最大上下文）、**Compaction threshold**（自动压缩阈值）、默认 model/provider |
| `state_5.sqlite` → `threads` | SQLite | 19 threads，列：`id, title, created_at, updated_at, created_at_ms, updated_at_ms, model, model_provider, tokens_used, cwd, approval_mode, sandbox_policy, git_sha, git_branch, git_origin_url, cli_version, first_user_message, archived, reasoning_effort, agent_nickname, agent_role` | **Sessions**、**Model**、**Token 总量**（`tokens_used`）、**Session lifespan**、**Approval mode**、**Reasoning effort** |
| `thread_history_1.sqlite` → `thread_turns` | SQLite | 列：`thread_id, turn_id, status, error_json, started_at, completed_at, duration_ms, first_user_item_id, final_agent_item_id` | **Turn E2E**（`duration_ms` 原生）、**Turn status/success rate**、**Session lifespan** |
| `thread_history_1.sqlite` → `thread_items` | SQLite | 列：`thread_id, turn_id, item_id, item_type, item_json, created_at_ms, started_at_ms, completed_at_ms`；8 种 item_type（见下） | **Step count**、**Tool calls**、**Reasoning count**、**Compaction count**、**Event 分类计数**、**TTFT**（first item started_at − turn started_at） |
| `logs_2.sqlite` → `logs` | SQLite | 列：`id, ts, ts_nanos, level, target, feedback_log_body, module_path, file, line, thread_id, process_uuid, estimated_bytes`；feedback_log_body 为 Rust OTel span 格式文本 | **Per-turn Token**（`total_usage_tokens=NNNN`）、**Compaction threshold**（`auto_compact_scope_limit=Some(NNNN)`）、**Context window limit**（`full_context_window_limit=Some(NNNN)`）、**Model**（`model=xxx`）、**Reasoning effort** |
| `sessions/<Y>/<M>/<D>/rollout-*.jsonl` | JSONL | 会话 rollout 事件流（路径存于 `threads.rollout_path`，兼容 `\\?\` 扩展前缀）；含 `token_usage_record`（逐次调用 `usage.input_tokens/cached_input_tokens/cache_write_input_tokens/output_tokens/reasoning_output_tokens/total_tokens`，另有累计型 `turn_token_usage`/`thread_token_usage` 不使用）与 `event_msg/token_count`（运行时 `model_context_window`） | **Token 分项**（input/output/cache_read/cache_write/reasoning/total）、**Cache hit rate**、**峰值上下文**、**运行时 Context window** |
| `session_index.jsonl` | JSONL | `{id, thread_name, updated_at}` | 会话发现（轻量索引） |
| `.codex-global-state.json` | JSON (54KB) | 全局状态 | 无直接指标 |
| `history.jsonl` | JSONL | 命令历史 | 无直接指标 |
| `hooks.json` | JSON | Hooks 配置 | 无直接指标 |
| `sessions/2026/` | dir | 会话文件目录 | 备用 |

### thread_items 类型

| item_type | 说明 | 示例 item_json |
|---|---|---|
| `reasoning` (2960) | 推理过程 | `{"type":"reasoning","id":"...","text":"...","time":{"start":...,"end":...}}` |
| `commandExecution` (2445) | 命令/工具执行 | `{"type":"commandExecution","id":"...","command":"...","args":...}` |
| `agentMessage` (305) | Assistant 文本输出 | `{"type":"agentMessage","id":"...","text":"...","phase":"commentary"}` |
| `mcpToolCall` (197) | MCP 工具调用 | `{"type":"mcpToolCall","id":"...","tool":...}` |
| `userMessage` (134) | 用户输入 | `{"type":"userMessage","id":"...","content":[{"type":"text","text":"..."}]}` |
| `webSearch` (57) | Web 搜索 | `{"type":"webSearch","id":"..."}` |
| `contextCompaction` (30) | **上下文压缩事件** | `{"type":"contextCompaction","id":"..."}` |
| `fileChange` (14) | 文件变更 | `{"type":"fileChange","id":"..."}` |

### logs feedback_log_body Token 格式

```
session_loop{thread_id=01a0bdf4-...}:turn{model=gpt-5.5 codex.turn.reasoning_effort=high}:session_task.run:run_turn: post sampling token usage turn_id=01a0bdf4-... total_usage_tokens=16184 auto_compact_scope_tokens=16184 auto_compact_scope_limit=Some(244800) auto_compact_limit_scope=Total full_context_window_limit=Some(258400) full_context_window_limit_reached=false token_limit_reached=false
```

可 regex 提取：
- `total_usage_tokens=(\d+)` — 本次采样总 token
- `auto_compact_scope_limit=Some\((\d+)\)` — 压缩阈值
- `full_context_window_limit=Some\((\d+)\)` — 实际上下文窗口限制
- `model=(\S+)` — 模型名
- `thread_id=([a-f0-9-]+)` — 关联 thread

### 可提取指标

| 指标 | Codex 来源 | 口径说明 |
|---|---|---|
| **TTFT** | ✅ thread_items：turn 内首个 reasoning/agentMessage 的 `started_at_ms` − turn `started_at` | 事件级精确 |
| **Turn E2E** | ✅ thread_turns.duration_ms（原生） | 原生精确 |
| **Session lifespan** | ✅ threads.created_at → updated_at | 秒级精度 |
| **Token 总量** | ✅ rollout token_usage_record 逐调用求和（首选）；回退 threads.tokens_used 或 logs.total_usage_tokens 逐轮 diff | rollout 精确 |
| **Token 分项（in/out/cache/reasoning）** | ✅ rollout token_usage_record.usage（input 含 cache、output 含 reasoning，实测 total=input+output 3646/3646 成立） | 逐调用精确 |
| **Cache** | ✅ rollout cache_write_input_tokens（几乎恒为 0） | 逐调用精确 |
| **Cache hit rate** | ✅ rollout cached_input_tokens / input_tokens | 派生 |
| **Output TPS** | ⚠️ rollout output_tokens 已可用但未接线 | turn duration 含工具调用，非纯生成时长，暂不计算 |
| **Max context** | ✅ rollout input_tokens 峰值（旧会话回退 threads.tokens_used 近似） | 逐调用峰值 |
| **Context window** | ✅ 运行时 rollout event_msg/token_count.model_context_window；回退 config.toml.model_context_window | 运行时优先 |
| **Compaction threshold** | ✅ config.toml.model_auto_compact_token_limit (900000) 或 logs.auto_compact_scope_limit | 配置级 |
| **Compaction count** | ✅ thread_items contextCompaction 计数 | 事件级 |
| **LLM calls** | ✅ thread_turns 计数（每 turn 一次 LLM 调用） | |
| **Tool calls** | ✅ commandExecution + mcpToolCall 计数 | |
| **Steps** | ✅ thread_items 总数（不含 userMessage） | |
| **Model** | ✅ threads.model 或 logs model= | |
| **Success rate** | ✅ thread_turns.status = "completed" 比例 | |
| **Human confirm** | ⚠️ threads.approval_mode = "OnRequest"（模式声明，非次数） | |
| **Credits** | ❌ not-captured | 无 cost/credit 字段 |
| **Retry** | ❌ not-captured | 无 retry 标记 |

### 限制

- **rollout `token_usage_record` 是 Token 分项的主数据源**（每次 LLM 调用一条）：`usage` 为单次调用值，`turn_token_usage`/`thread_token_usage` 为累计值不得直接求和；字段语义经 3646 条真实记录实测：`total_tokens == input_tokens + output_tokens`（100%）、`cached ⊆ input`、`reasoning ⊆ output`。
- 旧会话（rollout 缺失或无 usage 记录）回退 `logs_2`：日志不记录逐 token 的 input/output/cache 分项，只有 `total_usage_tokens` 总量。
- `total_usage_tokens` 是**累计值**（非 per-turn），且同一 turn 有多次采样日志（reasoning/response 各一条），需按 `turn_id` 去重取最后值再 diff。
- `full_context_window_limit` 在日志中可能不同于 config.toml 的 `model_context_window`（随模型/provider 变化，如 gpt-5.5 = 258400 vs kimi-k3 = 1048576）。
- `threads.tokens_used` 是聚合值（全 session 累计，含所有采样请求），不是逐轮明细；逐轮需从 logs 解析。
- logs.`feedback_log_body` 是 Rust debug 格式（非 JSON），含换行符；`querySqlite` 的 list-mode 回退会在换行处截断 → **必须用 SQL `substr/instr` 原位提取 `total_usage_tokens`、`turn_id`、`model` 等字段，不能 SELECT 全文到 Node 端解析**。
- 无 SQLite 统一存储 token 明细（与 TeleAgent/Mobilework 的 part.data JSON 不同）。
