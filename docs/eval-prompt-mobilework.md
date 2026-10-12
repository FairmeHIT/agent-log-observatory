# Mobilework 评测 Session 核心数据记录提示词

> 适用 Agent：Mobilework · 时区：`Asia/Shanghai`

---

## 你的任务

**读取你自身的本地运行日志，提取刚才那次任务的核心观测指标**，并输出一段 JSON 代码块。

### 任务 ID 规则

每次评测任务必须生成一个**任务 ID**（`task_id`）。

- **格式**：`eval-mobilework-<YYYYMMDD>-<HHmmss>`，例如 `eval-mobilework-20261010-164500`
- **生成时机**：评测开始时立即生成
- **文件命名**：指标 JSON 保存为独立文件，路径为 `%USERPROFILE%\.mobilework\eval-results\<task_id>.json`
- **返回要求**：回答**首行**输出 `task_id: <你的任务ID>`，回答**末尾** JSON 代码块中同样包含 `task_id` 字段

### 提取原则

1. **缺失不等于零**：无法获取的指标 `value` 填 `null`，`state` 填 `"not-captured"`，`missing_reason` 给出原因
2. **证据分级**：`direct`（原生字段）、`derived`（计算）、`estimated`（推断）、`unknown`（无法判断）
3. **去重**：Token 消费按唯一 usage 记录去重，session 表累计量与 runs 轮次量不双加；LLM 调用按 event 计数
4. **时间**：所有时间用 `Asia/Shanghai` ISO-8601（`+08:00`）。TTFT 取原生首模型输出时间
5. **不冒充**：`session.next.retried.1` 携带 sessionID 不足以定位并发重试；`cost` 字段需核实是否为真实值
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
| ★核心 | `%USERPROFILE%\.mobilework\xdg\data\opencode\opencode.db` | SQLite（`-readonly`） | `session` 表：`id`/`model`/`tokens_input`/`tokens_output`/`tokens_reasoning`/`tokens_cache_read`/`tokens_cache_write`/`cost`/`time_created`/`time_updated`；`event` 表：`type`（`session.next.step.started.1`/`session.next.tool.called.1`/`session.next.tool.success.1`/`session.next.tool.failed.1`/`session.next.retried.1` 等）/`aggregate_id`/`seq` |
| ★核心 | `%USERPROFILE%\.mobilework\data\<account_id>\analytics\runs.jsonl` | NDJSON | `instanceId`/`status`/`tokensInput`/`tokensOutput`/`durationMs`/`ts` |
| ★核心 | `%USERPROFILE%\.mobilework\plugin-reporting\model-raw\` | JSON | 模型请求边界、首 chunk 时间相关字段 |
| 补充 | `%USERPROFILE%\.mobilework-trace-dashboard\stream-timings.json` | JSON (v4) | `messageId`/`sessionId`/`startedAt`/`firstChunkAt`/`lastChunkAt`/`chunkCount` |
| 补充 | `%USERPROFILE%\.mobilework\electron\logs\main.log` | log | 错误归因 |
| 补充 | `%USERPROFILE%\.mobilework\electron\logs\renderer.log` | log | 渲染层错误 |
| 补充 | `%USERPROFILE%\.mobilework\electron\logs\maf.log` | log | MAF 引擎错误 |
| 补充 | `%USERPROFILE%\.mobilework\plugin-reporting\abort-marks\*.json` | JSON | 中止/失败原因 |

**跨源关联**：`session.id` 关联 opencode.db → runs.jsonl（`instanceId`）→ model-raw → stream-timings.json（`sessionId`）

**搜索策略**：
1. 先从 opencode.db `session` 表确定本次 session 的原生 ID
2. 查 `event` 表按 event type 计数各类调用/步骤
3. 在 `runs.jsonl` 和 `model-raw/` 中搜索匹配的轮次摘要和首 chunk 时间
4. 检查 `stream-timings.json` 是否有历史首 chunk 记录
5. 所有数据库用只读方式打开，不修改、不 checkpoint
6. 在 `source.log_paths_searched` 中列出所有已搜索路径（含未找到的），`log_files_found` 列出实际找到的文件

---

## 输出 JSON 格式

在回答末尾输出如下 JSON 代码块（```json 包裹），并将同内容保存到 `%USERPROFILE%\.mobilework\eval-results\<task_id>.json`。所有字段必须存在；无法获取的填 `null`。

> 以下示例中的具体数值仅为格式演示，实际值请从你的日志中提取。

```json
{
  "schema_version": "eval-session-metrics-0.1.0",
  "task_id": "eval-mobilework-20261010-164500",
  "agent": "mobilework",
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
