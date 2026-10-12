# TeleAgent 评测 Session 核心数据记录提示词

> 适用 Agent：TeleAgent · 时区：`Asia/Shanghai`

---

## 你的任务

**读取你自身的本地运行日志，提取刚才那次任务的核心观测指标**，并输出一段 JSON 代码块。

### 任务 ID 规则

每次评测任务必须生成一个**任务 ID**（`task_id`）。

- **格式**：`eval-teleagent-<YYYYMMDD>-<HHmmss>`，例如 `eval-teleagent-20261010-170000`
- **生成时机**：评测开始时立即生成
- **文件命名**：指标 JSON 保存为独立文件，路径为 `%USERPROFILE%\.local\share\TeleAgent\eval-results\<task_id>.json`
- **返回要求**：回答**首行**输出 `task_id: <你的任务ID>`，回答**末尾** JSON 代码块中同样包含 `task_id` 字段

### 提取原则

1. **缺失不等于零**：无法获取的指标 `value` 填 `null`，`state` 填 `"not-captured"`，`missing_reason` 给出原因
2. **证据分级**：`direct`（原生字段）、`derived`（计算）、`estimated`（推断）、`unknown`（无法判断）
3. **去重**：Token 消费按 `[cost]` 行的 `request_id` 去重；`processResult` 重复 usage 不再次相加
4. **时间**：所有时间用 `Asia/Shanghai` ISO-8601（`+08:00`）
5. **不冒充**：`request_id` 是应用请求范围，不等于 LLM call ID；`cost` 值需核实是否为真实值；`[perm]` by 非通配符不等于人工确认，需 `approvalID` 非空且有 human actor 证据
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
| ★核心 | `%USERPROFILE%\.local\share\TeleAgent\log\super-agent-server-YYYY-MM-DD.log` | Go 日志 | 行首时间戳；`[request_id:...]`；`[cost]` 行（`provider=`/`tokens(in=N out=N cacheRead=N)`/`cost=$N`）；`[perm]` 行（`tool=`/`action=allow/deny`/`by=`）；`[tool_instruction_review]` 行（`toolID=`/`result=`/`action=`/`approvalID=`/`durationMs=`）；`processResult` 行；`resolveModel` 行；`[prune]` 行（`pruned=`）；`[Error]` 行 |
| ★核心 | `%USERPROFILE%\.local\share\TeleAgent\teleagent.db` | SQLite（`-readonly`） | `session` 表：`id`/`time_created`/`time_updated`；`message` 表：`id`/`session_id`；`part` 表：`id`/`message_id`/`session_id` |
| 补充 | `%USERPROFILE%\.config\TeleAgent\TeleAgent.jsonc` | JSONC | Provider 配置：模型名、context/output limit |
| 补充 | `%USERPROFILE%\.config\TeleAgent\skills\.tool-usage-log.json` | JSON | 按会话统计工具调用次数 |
| 补充 | `%USERPROFILE%\.local\share\TeleAgent\logs\main-2.3.1.log` | log | Electron 主进程日志 |
| 补充 | `%USERPROFILE%\.local\share\TeleAgent\js-log\js-2.3.1.log` | log | JS 运行时错误 |

**跨源关联**：`Service Prompt start` 行中 `session id:ses_...` 建立 `request_id` → `session_id` 映射；teleagent.db 用于会话发现和元数据

**搜索策略**：
1. 先从 teleagent.db `session` 表确定本次 session 的原生 ID
2. 在 `super-agent-server-YYYY-MM-DD.log` 中搜索该 session 的 `request_id`
3. 按 `[cost]` 行提取 Token 分项，按 `request_id` 去重
4. 按 `[perm]` / `[tool_instruction_review]` 行提取人工确认证据
5. 检查日志中是否存在模型首 chunk / 首 token 相关时间锚点，以此判断 TTFT 是否可提取
6. 在 `source.log_paths_searched` 中列出所有已搜索路径（含未找到的），`log_files_found` 列出实际找到的文件

---

## 输出 JSON 格式

在回答末尾输出如下 JSON 代码块（```json 包裹），并将同内容保存到 `%USERPROFILE%\.local\share\TeleAgent\eval-results\<task_id>.json`。所有字段必须存在；无法获取的填 `null`。

> 以下示例中的具体数值仅为格式演示，实际值请从你的日志中提取。

```json
{
  "schema_version": "eval-session-metrics-0.1.0",
  "task_id": "eval-teleagent-20261010-170000",
  "agent": "teleagent",
  "agent_version": "Agent 版本号，未知填 null",
  "session_id": "本次 session 的原生 ID",
  "captured_at": "2026-10-10T17:00:00.000+08:00",
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
