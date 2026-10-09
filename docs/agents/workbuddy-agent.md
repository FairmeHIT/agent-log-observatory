# WorkBuddy 数据源明细

> 本文件从 [SPEC.md](../../SPEC.md) §2.2 拆分，自包含 WorkBuddy 的数据源探测明细：安装目录、数据目录、数据源表、事件格式、字段语义、指标可用性与限制。  
> 所属项目：Agent Log Observatory · 能力归属：`Observation & Evidence Layer` · 状态：`draft`  
> 跨 Agent 指标覆盖矩阵见 [SPEC.md §3](../../SPEC.md#3-指标覆盖矩阵)。

---

**安装目录**：`<WORKBUDDY_INSTALL_ROOT>/`
- Electron 应用，`resources/app.asar`（317MB）
- `debug.log`：安装目录级调试日志

**用户数据目录**：`%USERPROFILE%/.workbuddy\`

### 会话流水（transcript）：`projects/<workspace-slug>/<sessionId>.jsonl`（核心数据源）

NDJSON 格式，每个 session 一份文件。每行一条事件，type 字段区分消息类型。**关键发现：`function_call` 和 `assistant` 类型条目携带 `providerData.rawUsage`，包含完整 Token 分拆和 Credits。**

| type | role | 含义 | 关键字段 | 映射 |
|---|---|---|---|---|
| `session-meta` | — | 会话元数据 | `sessionId`、`meta` | 会话元信息 |
| `message` | `user` | 用户输入 | `content`、`timestamp`、`providerData.permissionMode` | **agent.input** |
| `message` | `assistant` | LLM 响应 | `content`、`providerData.rawUsage`、`providerData.model`、`status` | **llm.response** |
| `reasoning` | — | 推理/思考步骤 | `rawContent[].text`、`providerData.model`、`providerData.traceId` | **思考（Step）** |
| `function_call` | — | 工具调用 | `name`、`arguments`、`callId`、`providerData.rawUsage`、`providerData.model` | **tool.call**；rawUsage 仅为消费证据，不伪造请求开始 |
| `function_call_result` | — | 工具结果 | `name`、`callId`、`status`(completed/error)、`output`、`providerData.rawResponse` | **tool.result** |

**`providerData.rawUsage` 结构**（存在于 `function_call` 和 `assistant` 类型条目中）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `prompt_tokens` | integer | 输入 Token |
| `completion_tokens` | integer | 输出 Token |
| `total_tokens` | integer | 总 Token |
| `prompt_cache_hit_tokens` | integer | 缓存命中 Token |
| `prompt_cache_miss_tokens` | integer | 缓存未命中 Token |
| `completion_thinking_tokens` | integer | 推理/思考 Token |
| `credit` | number | Credits 消耗 |
| `cached_tokens` | integer | 缓存 Token（旧字段） |
| `cache_read_input_tokens` | integer | 缓存读取输入 |
| `cache_creation_input_tokens` | integer | 缓存创建输入 |
| `prompt_cache_write_tokens` | integer | 缓存写入 |

**`providerData` 其他关键字段**：

| 字段 | 说明 | 示例值 |
|---|---|---|
| `model` | 实际模型名 | `glm-5.3-flash`、`deepseek-v4.1-flash` |
| `requestModelId` | 请求模型 ID | `fast-model` |
| `requestModelName` | 请求模型名 | `快思` |
| `traceId` | 关联 trace 文件 | `6742e6b0b7af4abead113f0f0d4bc3d7` |
| `messageId` | 消息 ID | `01a0e256495a7fcc8b8485cdbebef586` |
| `conversationRequestId` | 会话请求 ID | `01a0e25634707cb8abca5c0ba6c0fb5b` |
| `agent` | Agent 类型 | `cli` |

**数据结构示例（function_call 行，含 rawUsage）**：
```json
{
  "type": "function_call",
  "timestamp": 1790503706238,
  "providerData": {
    "model": "glm-5.3-flash",
    "requestModelId": "fast-model",
    "traceId": "6742e6b0b7af4abead113f0f0d4bc3d7",
    "rawUsage": {
      "prompt_tokens": 34506,
      "completion_tokens": 95,
      "total_tokens": 34601,
      "prompt_cache_hit_tokens": 13952,
      "prompt_cache_miss_tokens": 20554,
      "completion_thinking_tokens": 24,
      "credit": 0.28
    }
  },
  "callId": "call_81d832d01fe9487199893402",
  "name": "Bash",
  "arguments": "{\"command\":\"mkdir -p ...\"}",
  "sessionId": "030c3642-b9b0-4a6b-a1c0-7a1ddd0a67ed"
}
```

**可提取指标与限制**：

| 指标 | 提取方式及前置条件 |
|---|---|
| Token 分项、Credits | rawUsage 按唯一 usage/可靠调用关联去重；多个 function_call/assistant 可能复制同一消费，禁止直接逐行求和 |
| 输入峰值 | 单调用输入量，声明 prompt_tokens 是否含缓存；不是输入+输出或 Session 累计峰值 |
| LLM 调用 | generation span、原生请求标识和消息组关联；rawUsage 行数仅为消费记录数，无开始证据不生成 llm.request |
| 工具调用/结果 | callId 去重关联 function_call/result；明确终态才统计成功/错误，未闭合 unknown |
| 重试 | 显式 retry 或同一逻辑调用的独立 attempts；isRetryable 只是可重试，同工具同参数仅为重复候选 |
| Step | 有真实循环边界才计数，reasoning/function_call/result 行数不是 Step 数 |
| 时延 | trace.duration 保留 Trace scope，相邻消息差只是消息间隔，不替代生成时间/轮次 E2E |
| 模型/诊断 | providerData.model 与请求模型分列；结构化错误/exitCode 优先，日志推断单列 |

> 已有 transcript 未发现首 token 时间，TTFT 暂为 not-captured；无可靠 request/attempt 关联时调用数/重试率为 null。已有 Hook 清单未含人工确认事件，不推断确认次数。

### 运行时轨迹（trace）：`traces/<workerPid>/trace_<traceId>.json`

每个 trace 一份 JSON，含 trace 汇总 + spans 数组。

| 字段 | 类型 | 说明 |
|---|---|---|
| trace.traceId | string | Trace ID |
| trace.name | string | 通常是 "Agent workflow" |
| trace.workerPid | integer | Worker 进程 PID |
| trace.startedAt | ISO-8601 | 开始时间（UTC） |
| trace.endedAt | ISO-8601 | 结束时间（UTC） |
| trace.duration | integer | 持续毫秒 |
| trace.status | string | `ok` / `error` |
| trace.spanCount | integer | Span 数 |
| trace.totalTokens | integer | Token 总量（汇总值，可能为 0） |
| spans[].type | string | `agent` / `generation` / `function` / `custom` |
| spans[].status | string | `ok` / `error` |
| spans[].agentName | string | Agent 名称 |
| spans[].toolInput | string | 工具输入 JSON |

**可提取指标**：Trace 范围时延、同类 Span P50/P95、源状态与诊断；未经范围映射验证，不称任务或轮次 E2E。

> transcript 的 `providerData.traceId` 可将每条 `.jsonl` 事件关联到 trace 文件，打通两层。

### 会话元数据：`sessions/<pid>.json`

| 字段 | 说明 |
|---|---|
| pid | 进程 PID |
| sessionId | 会话 UUID |
| cwd | 工作目录 |
| startedAt | 启动时间（epoch ms） |
| version | WorkBuddy 版本 |
| os / arch / hostname | 环境信息 |
| endpoint | 本地 HTTP 端口 |

### 应用运行日志：`~/.workbuddy/logs/`

**顶层日志文件**：

| 文件 | 内容 | 可提取指标 |
|---|---|---|
| `main.log` / `main.old.log` | 主进程 JSON 日志：timestamp、level、scope、message | 应用层错误频次（网关/依赖/超时） |
| `renderer.log` / `renderer.old.log` | 渲染进程日志 | 渲染层错误 |
| `daemon.log` / `daemon.old.log` | Daemon 日志 | 守护进程错误 |
| `network-failover.jsonl` | 网络故障转移日志 | 网络错误 |
| `mcp-apps-diag.log` | MCP 诊断日志 | MCP 错误 |
| `file-service.log`、`automation.log`、`vendor-extract.log` | 组件日志 | 组件错误 |

**按日期分目录** `logs/YYYY-MM-DD/`：

| 文件模式 | 内容 |
|---|---|
| `workbuddyMainThread__<hash>.log` | 主线程日志 |
| `__workbuddy_cli_host__-<n>-<hash>.log` | CLI Host 日志 |
| `<workspace-slug>__<hash>.log` | 工作区级日志 |
| `edge-sync.log` | Edge 同步日志 |
| `daemon-memory-diag.log` | Daemon 内存诊断 |
| `extension-scheduler-diag.log` | 扩展调度诊断 |
| `sdk/*.log` | SDK 日志 |

**分类子目录**：

| 目录 | 内容 |
|---|---|
| `Crash-Log/` | 崩溃报告 JSON（daemon / main / sidecar） |
| `editor_sdk/` | 编辑器 SDK 日志 |
| `migration/` | 版本迁移日志 |
| `perf/` | 性能日志 NDJSON（worker 启动时间） |
| `sandbox/` | 沙箱日志 |
| `startup/` | 启动日志 |
| `update/` | 更新日志 |
| `weixinpay/` | 微信支付日志（binary） |

### 其他数据源

| 路径 | 格式 | 内容 |
|---|---|---|
| `projects/<path>/<uuid>.file-rollback.ndjson` | NDJSON | 文件回滚事件 |
| `pending-telemetry/outcome-update-*.json.reported` | JSON | 遥测上报 |
| `tasks/<taskId>/*.json` | JSON | 任务定义 |
| `plugins/installed_plugins.json` | JSON | 插件清单 |
| `shell-snapshots/*.sh` | shell | Shell 环境快照 |
| `Electron logs (AppData/Local/WorkBuddy/logs/)` | log | Electron 层日志（与 `~/.workbuddy/logs/` 互补） |
