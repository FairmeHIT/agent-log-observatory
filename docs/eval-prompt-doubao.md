# 豆包（Doubao）评测 Session 核心数据记录提示词

> 适用 Agent：豆包 / Doubao Work · 时区：`Asia/Shanghai`

---

## 你的任务

**读取你自身的本地运行日志，提取刚才那次任务的核心观测指标**，并输出一段 JSON 代码块。

### 任务 ID 规则

每次评测任务必须生成一个**任务 ID**（`task_id`）。

- **格式**：`eval-doubao-<YYYYMMDD>-<HHmmss>`，例如 `eval-doubao-20261010-165000`
- **生成时机**：评测开始时立即生成
- **文件命名**：指标 JSON 保存为独立文件，路径为 `%LOCALAPPDATA%\Doubao\eval-results\<task_id>.json`
- **返回要求**：回答**首行**输出 `task_id: <你的任务ID>`，回答**末尾** JSON 代码块中同样包含 `task_id` 字段

### 提取原则

1. **缺失不等于零**：无法获取的指标 `value` 填 `null`，`state` 填 `"not-captured"`，`missing_reason` 给出原因
2. **证据分级**：`direct`（原生字段）、`derived`（计算）、`estimated`（推断）、`unknown`（无法判断）
3. **两层轨迹**：LLM trajectory 与 RPA runner 是两层独立轨迹，需通过 `session_id`+`agent_id` 关联，但不重复计耗时/消费
4. **不冒充**：RPA runner 的时间戳属于 DOM 操作层，不可冒充 LLM 推理层时间；`mtime` 仅用于发现，不提供发生时间
5. **自行探索**：以下不预设哪些指标可用、哪些不可用。请实际读取日志文件后，根据找到的数据自行判断每个指标的 `value` / `state` / `evidence_grade` / `missing_reason`

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
| ★核心 | `%LOCALAPPDATA%\Doubao\User Data\Default\.doubao\agent_mode\workspace\.sessions\<session_id>\agents\<agent_id>\system\trajectory.jsonl` | NDJSON | `role`（`user`/`assistant`/`tool`）/`content`/`tool_calls[]`（`id`/`function.name`/`function.arguments`）/`tool_call_id` |
| ★核心 | `%LOCALAPPDATA%\Doubao\rpa-dev\local-preview\production-traces\run-<timestamp>\runner-events.ndjson` | NDJSON | `ts`/`unix_ms`/`event`（`runner_started`/`runner_completed`/`child_command_started`/`child_command_finished`）/`duration_ms`/`exit_code`/`business_step` |
| 补充 | `%LOCALAPPDATA%\Doubao\rpa-dev\local-preview\bridge.log` | NDJSON | `bridge_version`/`component`/`event`/`ts`/`unix_ms`/`method`/`elapsed_ms`/`ok`/`execution_ms` |
| 补充 | `%USERPROFILE%\Doubao\chats\YYYY-MM-DD\new-chat-N\` | dir | 对话产出文件 |
| 补充 | `%LOCALAPPDATA%\Doubao\app\debug.log` | log | 应用调试日志 |
| 补充 | `%LOCALAPPDATA%\Doubao\User Data\sdk_storage\log\` | dir | SDK 日志 |

**跨源关联**：`session_id`+`agent_id` 关联 trajectory → RPA trace

**搜索策略**：
1. 遍历 `.sessions/` 子目录找到本次 session 的 `trajectory.jsonl`
2. 按 `role` 字段统计 LLM 调用、工具调用、工具结果
3. 在 `production-traces/run-*/` 中搜索 RPA runner 事件
4. 检查 trajectory 中是否存在时间戳字段（如 `ts`/`unix_ms`），以此判断时延指标是否可提取
5. 检查是否存在 Token 相关字段，以此判断 Token 指标是否可提取
6. 在 `source.log_paths_searched` 中列出所有已搜索路径（含未找到的），`log_files_found` 列出实际找到的文件

---

## 输出 JSON 格式

在回答末尾输出如下 JSON 代码块（```json 包裹），并将同内容保存到 `%LOCALAPPDATA%\Doubao\eval-results\<task_id>.json`。所有字段必须存在；无法获取的填 `null`。

> 以下示例中的具体数值仅为格式演示，实际值请从你的日志中提取。

```json
{
  "schema_version": "eval-session-metrics-0.1.0",
  "task_id": "eval-doubao-20261010-165000",
  "agent": "doubao",
  "agent_version": "Agent 版本号，未知填 null",
  "session_id": "本次 session 的原生 ID",
  "captured_at": "2026-10-10T16:50:00.000+08:00",
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
