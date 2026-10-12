# 评测 Session 核心数据记录提示词（通用版）

> 适用对象：WorkBuddy、Mobilework、豆包（Doubao）、TeleAgent  
> 用途：每次向 Agent 提交评测任务时一并发送本提示词，要求 Agent 在完成任务后自检本地日志并输出本次 session 的结构化指标 JSON。  
> 项目契约：[AGENTS.md](../AGENTS.md) · [SPEC.md](../SPEC.md) · 指标口径 `metrics-0.2.0`

---

## 一、任务

请在完成本次评测任务后，**读取你自身的本地运行日志**，提取本次 session 的核心观测指标，并按本文件第三节定义的 JSON Schema 输出一段 JSON 代码块。

### 任务 ID 规则

每次评测任务必须生成一个**任务 ID**（`task_id`），用于唯一标识本次评测并与后续指标文件、记录关联。

- **格式**：`eval-<agent>-<YYYYMMDD>-<HHmmss>`，例如 `eval-workbuddy-20261010-164500`。
  - `<agent>`：小写 Agent 名称（`workbuddy`/`mobilework`/`doubao`/`teleagent`）
  - `<YYYYMMDD>`：评测提交日期（北京时区）
  - `<HHmmss>`：评测提交时间（时分秒，24h 制）
- **生成时机**：评测开始时立即生成，在回答开头和最终 JSON 中都返回。
- **文件命名**：指标 JSON 必须保存为独立文件，文件名为 `<task_id>.json`。例如 `eval-workbuddy-20261010-164500.json`。
- **返回要求**：在回答**首行**输出 `task_id: <你的任务ID>`，在回答**末尾**的 JSON 代码块中同样包含 `task_id` 字段，方便评测方自动提取和归档。

### 提取原则

1. **缺失不等于零**：无法从日志中获取的指标，`value` 必须填 `null`，`state` 填 `"not-captured"`，并在 `missing_reason` 中给出具体原因。`0` 仅表示采集充分且确认未发生。
2. **证据分级**：每个指标标注 `evidence_grade`：
   - `direct`——日志中有原生字段直接记录
   - `derived`——由原生字段计算得出
   - `estimated`——基于规则推断（仅参考，不进入精确对比）
   - `unknown`——无法判断
3. **去重**：Token 消费按唯一 usage 记录 ID 去重，不逐行求和；LLM 调用按逻辑 call ID 计数，不按 stream 段数或 rawUsage 行数替代。
4. **时间**：所有时间用 `Asia/Shanghai` 时区 ISO-8601（`+08:00`）。TTFT 取原生首模型输出时间，响应头时间 ≠ 首 token 时间。
5. **不冒充**：`isRetryable` 不代表真实重试；`function_call_result.status` 不代表业务成功；审批通过 ≠ 工具执行成功。

---

## 二、指标定义

### 1. 时延指标

| 指标 ID | 单位 | 定义 | 采集边界 |
|---|---|---|---|
| `ttft_ms` | ms | 首模型输出时间 − 请求开始时间（同一次 attempt） | 首非空模型生成 chunk（text/reasoning/tool-input）的原生时间；缺任一边界为 null |
| `e2e_duration_s` | s | 本轮执行提交 → 本轮完整执行结束（含工具调用），不含等待用户下轮输入 | 缺开始/结束为 null |

### 2. Token 消耗

| 指标 ID | 单位 | 定义 | 注意事项 |
|---|---|---|---|
| `input_tokens` | tokens | 原始输入 Token | 标注是否含 cache |
| `output_tokens` | tokens | 原始输出 Token | 标注是否含 reasoning |
| `cache_hit_tokens` | tokens | 缓存命中读取 Token | 保留原始分项，不叠加 |

### 3. LLM / Tool / Step 计数

| 指标 ID | 单位 | 定义 |
|---|---|---|
| `llm_call_count` | 次 | 唯一逻辑 LLM 调用数 |
| `llm_success_count` | 次 | 终态为 ok 的调用数 |
| `llm_failure_count` | 次 | 终态为 error 的调用数 |
| `tool_call_count` | 次 | 实际工具调用数（去重） |
| `tool_success_count` | 次 | 终态为 ok 的工具调用数 |
| `tool_failure_count` | 次 | 终态为 error 的工具调用数 |
| `step_count` | 次 | 唯一逻辑 Step 数（重试/stream 不新增） |
| `human_confirm_count` | 次 | 去重人工确认数（审批通过 ≠ 人工确认） |
| `event_count` | 次 | 去重标准事件总数 |

### 4. 失败归因

| 字段 | 说明 |
|---|---|
| `failure_reasons` | 数组，每条含 `category`（gateway/tool/model/dependency/agent/permission_denied/cancelled/unknown）、`message`（≤200 字摘要）、`evidence_grade`（direct/estimated） |

---

## 三、输出 JSON 格式

请在回答末尾输出如下格式的 JSON 代码块（用 ```json 包裹），并将同内容保存为独立文件 `<task_id>.json`。所有字段必须存在；无法获取的填 `null`。

```json
{
  "schema_version": "eval-session-metrics-0.1.0",
  "task_id": "eval-workbuddy-20261010-164500",
  "agent": "workbuddy | mobilework | doubao | teleagent",
  "agent_version": "Agent 版本号，未知填 null",
  "session_id": "本次 session 的原生 ID",
  "captured_at": "2026-10-10T15:30:00.000+08:00",
  "timezone": "Asia/Shanghai",

  "latency": {
    "ttft_ms": {
      "value": 1234,
      "unit": "ms",
      "state": "captured",
      "evidence_grade": "direct",
      "missing_reason": null
    },
    "e2e_duration_s": {
      "value": 8.64,
      "unit": "s",
      "state": "captured",
      "evidence_grade": "direct",
      "missing_reason": null
    }
  },

  "tokens": {
    "input_tokens": {
      "value": 15393,
      "unit": "tokens",
      "state": "captured",
      "evidence_grade": "direct",
      "input_includes_cache": true,
      "missing_reason": null
    },
    "output_tokens": {
      "value": 77,
      "unit": "tokens",
      "state": "captured",
      "evidence_grade": "direct",
      "output_includes_reasoning": true,
      "missing_reason": null
    },
    "cache_hit_tokens": {
      "value": 13952,
      "unit": "tokens",
      "state": "captured",
      "evidence_grade": "direct",
      "missing_reason": null
    }
  },

  "counts": {
    "llm_call_count":     { "value": 5,   "success": 4, "failure": 1, "state": "captured", "evidence_grade": "direct" },
    "tool_call_count":    { "value": 3,   "success": 3, "failure": 0, "state": "captured", "evidence_grade": "direct" },
    "step_count":         { "value": 8,   "state": "captured", "evidence_grade": "direct" },
    "human_confirm_count":{ "value": null, "state": "not-captured", "evidence_grade": "unknown", "missing_reason": "not_instrumented" },
    "event_count":        { "value": 25,  "state": "captured", "evidence_grade": "direct" }
  },

  "failure_reasons": [
    {
      "category": "model",
      "message": "LLM response parse error: unexpected JSON structure",
      "evidence_grade": "direct"
    }
  ],

  "source": {
    "log_paths_searched": [
      "~/.workbuddy/projects/<workspace-slug>/<sessionId>.jsonl"
    ],
    "log_files_found": [
      "~/.workbuddy/projects/my-project/030c3642-b9b0-4a6b-a1c0-7a1ddd0a67ed.jsonl"
    ],
    "notes": "简要说明采集过程、已搜索但未找到的源、以及任何数据限制"
  }
}
```

---

## 四、各 Agent 日志搜索路径指南

请根据你的 Agent 类型，在以下路径中启发式搜索本次 session 的日志文件。路径中的环境变量请展开为本机实际路径。

### WorkBuddy

| 优先级 | 路径 | 格式 | 用途 |
|---|---|---|---|
| ★核心 | `%USERPROFILE%\.workbuddy\projects\<workspace-slug>\<sessionId>.jsonl` | NDJSON | **Token 分项**（`providerData.rawUsage`：`prompt_tokens`/`completion_tokens`/`prompt_cache_hit_tokens`/`completion_thinking_tokens`/`credit`）、**LLM 调用**（`message` role=assistant）、**工具调用**（`function_call`/`function_call_result` 按 `callId` 关联）、**Step**（`reasoning`+`function_call`+`function_call_result`）、**E2E**（`timestamp` 字段，user 提交 → 最后非 user 事件） |
| ★核心 | `%USERPROFILE%\.workbuddy\traces\<workerPid>\trace_<traceId>.json` | JSON | **TTFT**——`spans[]` 中 `type:"generation"` 的 `startedAt`→`endedAt`（非流式响应 first_output≈response complete）；通过 transcript 中 `providerData.traceId` 关联 |
| 补充 | `%USERPROFILE%\.workbuddy\sessions\<pid>.json` | JSON | 会话元数据：`sessionId`、`startedAt`、`version` |
| 补充 | `%USERPROFILE%\.workbuddy\logs\main.log` | JSON lines | 应用层错误（gateway/dependency/timeout） |
| 补充 | `%USERPROFILE%\.workbuddy\logs\YYYY-MM-DD\*.log` | JSON lines | 按日期分目录的组件日志 |
| 补充 | `%LOCALAPPDATA%\WorkBuddy\logs\` | log | Electron 层日志（与 `~/.workbuddy/logs/` 互补） |

> **WorkBuddy 限制**：transcript 无首 token 时间锚点，TTFT 依赖 trace generation span；无可靠重试关联（`isRetryable` ≠ 真实重试）；无人工确认事件。

### Mobilework

| 优先级 | 路径 | 格式 | 用途 |
|---|---|---|---|
| ★核心 | `%USERPROFILE%\.mobilework\xdg\data\opencode\opencode.db` | SQLite（`-readonly`） | **Token**（`session` 表：`tokens_input`/`tokens_output`/`tokens_reasoning`/`tokens_cache_read`/`tokens_cache_write`）、**LLM 调用**（`event` 表 `session.next.step.started.1` 计数）、**工具调用**（`event` 表 `session.next.tool.called.1` + `session.next.tool.success.1`/`session.next.tool.failed.1`）、**Step**（`session.next.step.started.1` 去重）、**E2E**（`session.time_created`→`time_updated` 或 `runs.jsonl` 的 `durationMs`） |
| ★核心 | `%USERPROFILE%\.mobilework\data\<account_id>\analytics\runs.jsonl` | NDJSON | 轮次级摘要：`status`、`tokensInput`/`tokensOutput`、`durationMs`、`ts` |
| ★核心 | `%USERPROFILE%\.mobilework\plugin-reporting\model-raw\` | JSON | 模型请求边界、首 chunk 时间（需字段齐全才算 TTFT） |
| TTFT | `%USERPROFILE%\.mobilework-trace-dashboard\stream-timings.json` | JSON (v4) | **历史 TTFT**——`firstChunkAt`−`startedAt`；model-raw 被清理后此文件是唯一来源（需 dashboard 曾运行） |
| 补充 | `%USERPROFILE%\.mobilework\electron\logs\main.log` | log | 错误归因 |
| 补充 | `%USERPROFILE%\.mobilework\electron\logs\renderer.log` | log | 渲染层错误 |
| 补充 | `%USERPROFILE%\.mobilework\electron\logs\maf.log` | log | MAF 引擎错误 |
| 补充 | `%USERPROFILE%\.mobilework\plugin-reporting\abort-marks\*.json` | JSON | 中止/失败原因 |

> **Mobilework 限制**：TTFT 条件可用（需 stream-timings.json 或 model-raw 含首 chunk）；`cost` 字段当前恒为 0；`session.next.retried.1` 携带重试证据但 sessionID 不足以定位并发重试。

### 豆包（Doubao）

| 优先级 | 路径 | 格式 | 用途 |
|---|---|---|---|
| ★核心 | `%LOCALAPPDATA%\Doubao\User Data\Default\.doubao\agent_mode\workspace\.sessions\<session_id>\agents\<agent_id>\system\trajectory.jsonl` | NDJSON | **LLM 调用**（`role:"assistant"` 行数）、**工具调用**（`assistant.tool_calls[]` 总数）、**工具结果**（`role:"tool"` 行数，按 `tool_call_id` 关联）、**Event**（总行数） |
| ★核心 | `%LOCALAPPDATA%\Doubao\rpa-dev\local-preview\production-traces\run-<timestamp>\runner-events.ndjson` | NDJSON | RPA 层：`runner_completed`（`duration_ms`、`steps`）、`child_command_finished`（`duration_ms`、`exit_code`、`business_step`）——属于 `rpa_run` scope，不冒充 LLM E2E |
| 补充 | `%LOCALAPPDATA%\Doubao\rpa-dev\local-preview\bridge.log` | NDJSON | Bridge 通信：`ok`、`execution_ms`、`queue_depth` |
| 补充 | `%USERPROFILE%\Doubao\chats\YYYY-MM-DD\new-chat-N\` | dir | 对话产出 |
| 补充 | `%LOCALAPPDATA%\Doubao\app\debug.log` | log | 应用调试日志 |
| 补充 | `%LOCALAPPDATA%\Doubao\User Data\sdk_storage\log\` | dir | SDK 日志 |

> **豆包限制**：trajectory.jsonl **无时间戳**（无 `ts`/`unix_ms` 字段），无法计算 TTFT 或步骤间延迟；**无 Token 数据**；**无模型名**。`mtime` 仅用于发现/游标，不提供发生时间。RPA runner 有精确时间戳但属于 DOM 操作层，非 LLM 推理层。

### TeleAgent

| 优先级 | 路径 | 格式 | 用途 |
|---|---|---|---|
| ★核心 | `%USERPROFILE%\.local\share\TeleAgent\log\super-agent-server-YYYY-MM-DD.log` | Go 日志 | **Token**（`[cost]` 行：`tokens(in=N out=N cacheRead=N)`，按 `request_id` 去重）、**工具调用**（`processResult` 行计数）、**人工确认**（`[perm]` 行 `action=allow/deny` + `[tool_instruction_review]` 行 `approvalID` 非空时）、**压缩**（`[prune]` 行 `pruned>0`）、**模型名**（`resolveModel` 行）、**失败归因**（`[Error]` 行） |
| ★核心 | `%USERPROFILE%\.local\share\TeleAgent\teleagent.db` | SQLite（`-readonly`） | 会话列表（`session` 表）、消息存储（`message`/`part` 表）——**Token/模型/成本不在 DB 中** |
| 补充 | `%USERPROFILE%\.config\TeleAgent\TeleAgent.jsonc` | JSONC | Provider 配置：模型名、context/output limit（配置上限 ≠ 实际输入峰值） |
| 补充 | `%USERPROFILE%\.config\TeleAgent\skills\.tool-usage-log.json` | JSON | 按会话统计工具调用次数（交叉校验） |
| 补充 | `%USERPROFILE%\.local\share\TeleAgent\logs\main-2.3.1.log` | log | Electron 主进程日志 |
| 补充 | `%USERPROFILE%\.local\share\TeleAgent\js-log\js-2.3.1.log` | log | JS 运行时错误 |

> **TeleAgent 限制**：日志无模型首 chunk 锚点，TTFT 为 `not-captured`；`request_id` 是应用请求范围，不等于 LLM call ID；`cost=$0` 当前为占位值；`[perm]` by 非通配符 ≠ 人工确认，需 `approvalID` 非空且有 human actor 证据。

---

## 五、搜索策略

1. **先确定 session_id**：从会话元数据文件或日志中确认本次 session 的原生 ID。
2. **按优先级搜索**：先查 ★核心 路径，再查补充路径。路径中含 `<sessionId>`、`<workspace-slug>` 等占位符时，遍历子目录匹配。
3. **跨源关联**：WorkBuddy 用 `providerData.traceId` 关联 transcript→trace；Mobilework 用 `session.id` 关联 DB→runs→model-raw；豆包用 `session_id`+`agent_id` 关联 trajectory→RPA trace；TeleAgent 用 `request_id` 关联日志→DB session。
4. **只读**：所有数据库用 `-readonly` 打开；不修改、不 checkpoint、不写入 Agent 源目录。
5. **记录搜索过程**：在 JSON `source.log_paths_searched` 中列出所有已搜索路径（含未找到的），`log_files_found` 列出实际找到并读取的文件，`notes` 简要说明采集覆盖情况。

---

## 六、完整输出示例（WorkBuddy 场景）

```json
{
  "schema_version": "eval-session-metrics-0.1.0",
  "task_id": "eval-workbuddy-20261010-164500",
  "agent": "workbuddy",
  "agent_version": "1.2.3",
  "session_id": "030c3642-b9b0-4a6b-a1c0-7a1ddd0a67ed",
  "captured_at": "2026-10-10T16:45:30.123+08:00",
  "timezone": "Asia/Shanghai",

  "latency": {
    "ttft_ms": {
      "value": 1820,
      "unit": "ms",
      "state": "captured",
      "evidence_grade": "derived",
      "missing_reason": null
    },
    "e2e_duration_s": {
      "value": 12.3,
      "unit": "s",
      "state": "captured",
      "evidence_grade": "direct",
      "missing_reason": null
    }
  },

  "tokens": {
    "input_tokens": {
      "value": 34506,
      "unit": "tokens",
      "state": "captured",
      "evidence_grade": "direct",
      "input_includes_cache": true,
      "missing_reason": null
    },
    "output_tokens": {
      "value": 95,
      "unit": "tokens",
      "state": "captured",
      "evidence_grade": "direct",
      "output_includes_reasoning": true,
      "missing_reason": null
    },
    "cache_hit_tokens": {
      "value": 13952,
      "unit": "tokens",
      "state": "captured",
      "evidence_grade": "direct",
      "missing_reason": null
    }
  },

  "counts": {
    "llm_call_count":      { "value": 3,   "success": 3, "failure": 0, "state": "captured", "evidence_grade": "direct" },
    "tool_call_count":     { "value": 2,   "success": 2, "failure": 0, "state": "captured", "evidence_grade": "direct" },
    "step_count":          { "value": 7,   "state": "captured", "evidence_grade": "direct" },
    "human_confirm_count": { "value": null, "state": "not-captured", "evidence_grade": "unknown", "missing_reason": "not_instrumented" },
    "event_count":         { "value": 18,  "state": "captured", "evidence_grade": "direct" }
  },

  "failure_reasons": [],

  "source": {
    "log_paths_searched": [
      "~/.workbuddy/projects/*/<sessionId>.jsonl",
      "~/.workbuddy/traces/*/trace_*.json",
      "~/.workbuddy/sessions/*.json",
      "~/.workbuddy/logs/main.log"
    ],
    "log_files_found": [
      "~/.workbuddy/projects/my-project/030c3642-b9b0-4a6b-a1c0-7a1ddd0a67ed.jsonl",
      "~/.workbuddy/traces/12345/trace_6742e6b0b7af4abead113f0f0d4bc3d7.json"
    ],
    "notes": "TTFT derived from trace generation span (startedAt→endedAt, non-streaming response). Retry and human_confirm not instrumented in WorkBuddy logs."
  }
}
```

---

## 七、完整输出示例（豆包场景——大量 null）

```json
{
  "schema_version": "eval-session-metrics-0.1.0",
  "task_id": "eval-doubao-20261010-165000",
  "agent": "doubao",
  "agent_version": null,
  "session_id": "dd33457e-f409-493e-8475-d72b9fb9734b",
  "captured_at": "2026-10-10T16:50:00.000+08:00",
  "timezone": "Asia/Shanghai",

  "latency": {
    "ttft_ms": {
      "value": null,
      "unit": "ms",
      "state": "not-captured",
      "evidence_grade": "unknown",
      "missing_reason": "not_instrumented"
    },
    "e2e_duration_s": {
      "value": null,
      "unit": "s",
      "state": "not-captured",
      "evidence_grade": "unknown",
      "missing_reason": "not_instrumented"
    }
  },

  "tokens": {
    "input_tokens": {
      "value": null,
      "unit": "tokens",
      "state": "not-captured",
      "evidence_grade": "unknown",
      "input_includes_cache": null,
      "missing_reason": "not_instrumented"
    },
    "output_tokens": {
      "value": null,
      "unit": "tokens",
      "state": "not-captured",
      "evidence_grade": "unknown",
      "output_includes_reasoning": null,
      "missing_reason": "not_instrumented"
    },
    "cache_hit_tokens": {
      "value": null,
      "unit": "tokens",
      "state": "not-captured",
      "evidence_grade": "unknown",
      "missing_reason": "not_instrumented"
    }
  },

  "counts": {
    "llm_call_count":      { "value": 4,   "success": null, "failure": null, "state": "captured", "evidence_grade": "direct" },
    "tool_call_count":     { "value": 6,   "success": null, "failure": null, "state": "captured", "evidence_grade": "direct" },
    "step_count":          { "value": null, "state": "not-captured", "evidence_grade": "unknown", "missing_reason": "not_instrumented" },
    "human_confirm_count": { "value": null, "state": "not-captured", "evidence_grade": "unknown", "missing_reason": "not_instrumented" },
    "event_count":         { "value": 14,  "state": "captured", "evidence_grade": "direct" }
  },

  "failure_reasons": [],

  "source": {
    "log_paths_searched": [
      "%LOCALAPPDATA%/Doubao/User Data/Default/.doubao/agent_mode/workspace/.sessions/*/agents/*/system/trajectory.jsonl",
      "%LOCALAPPDATA%/Doubao/rpa-dev/local-preview/production-traces/run-*/runner-events.ndjson",
      "%LOCALAPPDATA%/Doubao/rpa-dev/local-preview/bridge.log"
    ],
    "log_files_found": [
      "C:/Users/fairm/AppData/Local/Doubao/User Data/Default/.doubao/agent_mode/workspace/.sessions/dd33457e/agents/agent-001/system/trajectory.jsonl"
    ],
    "notes": "trajectory.jsonl has no timestamps, no token data, no model name. LLM/tool/event counts available from role-based line counting. TTFT, E2E, tokens, step_count all not-captured. RPA runner-events.ndjson not found for this session."
  }
}
```
