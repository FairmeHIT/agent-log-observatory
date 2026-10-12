# WorkBuddy 评测 Session 核心数据记录提示词

> 适用 Agent：WorkBuddy · 时区：`Asia/Shanghai`

---

## 你的任务

**读取你自身的本地运行日志，提取刚才那次任务的核心观测指标**，并输出一段 JSON 代码块。

### 任务 ID 规则

每次评测任务必须生成一个**任务 ID**（`task_id`）。

- **格式**：`eval-workbuddy-<YYYYMMDD>-<HHmmss>`，例如 `eval-workbuddy-20261010-164500`
- **生成时机**：评测开始时立即生成
- **文件命名**：指标 JSON 保存为独立文件，路径为 `%USERPROFILE%\.workbuddy\eval-results\<task_id>.json`
- **返回要求**：回答**首行**输出 `task_id: <你的任务ID>`，回答**末尾** JSON 代码块中同样包含 `task_id` 字段

### 提取原则

1. **缺失不等于零**：无法获取的指标 `value` 填 `null`，`state` 填 `"not-captured"`，`missing_reason` 给出原因
2. **证据分级**：`direct`（原生字段）、`derived`（计算）、`estimated`（推断）、`unknown`（无法判断）
3. **去重**：Token 消费按唯一 `providerData.messageId` 去重，不逐行求和；LLM 调用按逻辑 messageId 计数，不按 stream 段数替代
4. **时间**：所有时间用 `Asia/Shanghai` ISO-8601（`+08:00`）。TTFT 取原生首模型输出时间，响应头时间 ≠ 首 token 时间
5. **不冒充**：`isRetryable` 不代表真实重试；`function_call_result.status` 不代表业务成功
6. **自行探索**：以下不预设哪些指标可用、哪些不可用。请实际读取日志文件后，根据找到的数据自行判断每个指标的 `value` / `state` / `evidence_grade` / `missing_reason`

---

## 指标定义

### 时延

| 指标 ID | 单位 | 定义 |
|---|---|---|
| `ttft_ms` | ms | 首模型输出时间 − 请求开始时间（同一次 attempt） |
| `e2e_duration_s` | s | 用户提交 → 本轮完整执行结束（含工具调用），不含等待用户下轮输入 |

### Token

| 指标 ID | 单位 | 定义 |
|---|---|---|
| `input_tokens` | tokens | 原始输入 Token（标注 `input_includes_cache`） |
| `output_tokens` | tokens | 原始输出 Token（标注 `output_includes_reasoning`） |
| `cache_hit_tokens` | tokens | 缓存命中读取 Token |

### LLM / Tool / Step

| 指标 ID | 单位 | 定义 |
|---|---|---|
| `llm_call_count` | 次 | 唯一逻辑 LLM 调用数（含成功/失败分项） |
| `tool_call_count` | 次 | 实际工具调用数（含成功/失败分项） |
| `step_count` | 次 | 唯一逻辑 Step 数（重试/stream 不新增） |
| `human_confirm_count` | 次 | 去重人工确认数（审批通过 ≠ 人工确认） |
| `event_count` | 次 | 去重标准事件总数 |

### 失败归因

`failure_reasons`：数组，每条含 `category`（gateway/tool/model/dependency/agent/permission_denied/cancelled/unknown）、`message`（≤200 字摘要）、`evidence_grade`

---

## 日志搜索路径

请按以下路径启发式搜索本次 session 的日志文件。路径中的环境变量请展开为本机实际路径。

| 优先级 | 路径 | 格式 | 关键字段 |
|---|---|---|---|
| ★核心 | `%USERPROFILE%\.workbuddy\projects\<workspace-slug>\<sessionId>.jsonl` | NDJSON | `type`/`role`/`timestamp`/`providerData.rawUsage`（`prompt_tokens`/`completion_tokens`/`prompt_cache_hit_tokens`/`completion_thinking_tokens`/`credit`）/`providerData.messageId`/`providerData.traceId`/`callId`/`name`/`status` |
| ★核心 | `%USERPROFILE%\.workbuddy\traces\<workerPid>\trace_<traceId>.json` | JSON | `trace.traceId`/`trace.sessionId`/`spans[]`（`type:"generation"` 的 `startedAt`/`endedAt`/`duration`/`status`） |
| 补充 | `%USERPROFILE%\.workbuddy\sessions\<pid>.json` | JSON | `sessionId`/`startedAt`/`version` |
| 补充 | `%USERPROFILE%\.workbuddy\logs\main.log` | JSON lines | `level`/`scope`/`message` |
| 补充 | `%USERPROFILE%\.workbuddy\logs\YYYY-MM-DD\*.log` | JSON lines | 按日期分目录的组件日志 |
| 补充 | `%LOCALAPPDATA%\WorkBuddy\logs\` | log | Electron 层日志 |

**跨源关联**：transcript 中 `providerData.traceId` → traces 目录下 `trace_<traceId>.json`

**搜索策略**：
1. 先从 `sessions/` 或 transcript 文件中确定本次 session 的原生 ID
2. 遍历 `projects/` 子目录匹配 `<sessionId>.jsonl`
3. 从 transcript 中提取 `providerData.traceId`，在 `traces/` 下查找对应 trace 文件
4. 所有数据库用只读方式打开，不修改源文件
5. 在 `source.log_paths_searched` 中列出所有已搜索路径（含未找到的），`log_files_found` 列出实际找到的文件

---

## 输出 JSON 格式

在回答末尾输出如下 JSON 代码块（```json 包裹），并将同内容保存到 `%USERPROFILE%\.workbuddy\eval-results\<task_id>.json`。所有字段必须存在；无法获取的填 `null`。

> 以下示例中的具体数值仅为格式演示，实际值请从你的日志中提取。

```json
{
  "schema_version": "eval-session-metrics-0.1.0",
  "task_id": "eval-workbuddy-20261010-164500",
  "agent": "workbuddy",
  "agent_version": "Agent 版本号，未知填 null",
  "session_id": "本次 session 的原生 ID",
  "captured_at": "2026-10-10T16:45:30.000+08:00",
  "timezone": "Asia/Shanghai",

  "latency": {
    "ttft_ms": {
      "value": null,
      "unit": "ms",
      "state": "captured | not-captured",
      "evidence_grade": "direct | derived | estimated | unknown",
      "missing_reason": null
    },
    "e2e_duration_s": {
      "value": null,
      "unit": "s",
      "state": "captured | not-captured",
      "evidence_grade": "direct | derived | estimated | unknown",
      "missing_reason": null
    }
  },

  "tokens": {
    "input_tokens": {
      "value": null,
      "unit": "tokens",
      "state": "captured | not-captured",
      "evidence_grade": "direct | derived | estimated | unknown",
      "input_includes_cache": null,
      "missing_reason": null
    },
    "output_tokens": {
      "value": null,
      "unit": "tokens",
      "state": "captured | not-captured",
      "evidence_grade": "direct | derived | estimated | unknown",
      "output_includes_reasoning": null,
      "missing_reason": null
    },
    "cache_hit_tokens": {
      "value": null,
      "unit": "tokens",
      "state": "captured | not-captured",
      "evidence_grade": "direct | derived | estimated | unknown",
      "missing_reason": null
    }
  },

  "counts": {
    "llm_call_count":       { "value": null, "success": null, "failure": null, "state": "captured | not-captured", "evidence_grade": "direct | derived | estimated | unknown" },
    "tool_call_count":      { "value": null, "success": null, "failure": null, "state": "captured | not-captured", "evidence_grade": "direct | derived | estimated | unknown" },
    "step_count":           { "value": null, "state": "captured | not-captured", "evidence_grade": "direct | derived | estimated | unknown" },
    "human_confirm_count":  { "value": null, "state": "captured | not-captured", "evidence_grade": "direct | derived | estimated | unknown", "missing_reason": null },
    "event_count":          { "value": null, "state": "captured | not-captured", "evidence_grade": "direct | derived | estimated | unknown" }
  },

  "failure_reasons": [
    {
      "category": "gateway | tool | model | dependency | agent | permission_denied | cancelled | unknown",
      "message": "≤200字摘要",
      "evidence_grade": "direct | estimated"
    }
  ],

  "source": {
    "log_paths_searched": [
      "列出所有已搜索的路径（含未找到的）"
    ],
    "log_files_found": [
      "列出实际找到并读取的文件"
    ],
    "notes": "简要说明采集过程、数据限制"
  }
}
```
