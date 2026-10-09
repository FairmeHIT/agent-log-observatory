# Collector 整体设计：补全 TTFT / LLM 重试 / 人工确认等缺口指标

> Status: 历史设计稿 v0.1；部署以 docs/deployment.md 为准（v0.0.9 默认落盘改为项目 runtime）。
> Scope: observatory 侧只读约束不变；本文档定义各 Agent 客户端侧采集器的统一输出格式、落盘约定、observatory 侧共享读取层，以及三个 Agent 各自的采集器实现方案。

## 1. 背景与目标

observatory 当前有 7 个适配器，部分指标在若干 Agent 上恒为 `not-captured`：

| 指标 | WorkBuddy | Mobilework | opencode | 根因 |
|---|---|---|---|---|
| TTFT | not-captured | not-captured（数据碰撞） | not-captured | 数据源无首 token 时间锚点 / 时间戳粒度碰撞 |
| LLM 重试 | not-captured | captured（has_retry=true） | not-captured | 无 retry 字段 |
| 人工确认 | not-captured | estimated | estimated | 无实际次数 |

**目标**：在各 Agent 客户端侧加装轻量采集器，按统一格式落盘 attempt 级时延事件；observatory 侧新增一个共享 reader，各适配器 `extractMetrics` 调用，把 `not-captured` 升级为 `captured`。

**非目标**：
- 不改 observatory 的只读约束（不直接修改 Agent 原始数据）。
- 不改 `lib/metrics.mjs` 的计算公式（`computeTTftMs` 已存在，直接复用）。
- 不改前端 `index.html` 的渲染逻辑（指标名不变）。

## 2. 核心设计原则

1. **采集器在 Agent 侧，reader 在 observatory 侧**。采集器只负责"写"，reader 只负责"读"，两者通过文件系统解耦。
2. **字段对齐已有计算函数**。`lib/metrics.mjs` 的 `computeTTftMs(attempt)` 期望 `requested_at` / `first_output_at` / `first_output_source`，采集器原样输出这些字段，reader 直接喂给计算函数，零适配。
3. **时间精度显式声明**。Mobilework 碰撞事故的教训：每条记录带 `timestamp_basis` + `precision_ns`，reader 据此判定是否可信（低于物理下限的值标记 `timestamp_collision`）。
4. **采集器失败不影响 observatory**。reader 找不到采集文件时返回空数组，适配器回退到原有 `not-captured` 逻辑，不抛错。
5. **Adapter 隔离不变**。新增 Agent 采集器只需新建目录 + 适配器 `extractMetrics` 调 reader，不改 `lib/` 核心。

## 3. 统一落盘格式（attempt-level JSONL）

### 3.1 文件路径约定

```
runtime/collectors/<agent_object>/attempts-<YYYYMMDD>.jsonl
```

- 按天轮转，便于清理与并发写。
- `<agent_object>` ∈ {workbuddy, mobilework, opencode, ...}，与 `adapters/` 命名一致。
- 每行一个 JSON 对象（attempt 级）。

### 3.2 Attempt 记录 Schema

字段对齐 `lib/metrics.mjs::computeTTftMs(attempt)` 输入 + `lib/normalizer.mjs::normalizeEvent` 标识字段。

```jsonc
{
  "schema_version": "collector-attempt-0.1.0",
  "agent_object": "opencode",
  "installation_id": "default",
  "session_id": "ses_xxx",
  "turn_id": "turn_1",
  "step_id": "step_1",
  "llm_call_id": "msg_0e0b...",
  "attempt_id": "att_0e0b..._0",
  "attempt_index": 0,
  "is_retry": false,
  "retry_of": null,

  // —— 时延锚点（核心），对齐 computeTTftMs ——
  "requested_at": 1790475934450,
  "first_output_at": 1790475934521,
  "first_output_source": "native",
  "stream_ended_at": 1790475936100,
  "timestamp_basis": "epoch_ms",
  "precision_ns": 100,

  // —— 模型路由 ——
  "provider": "bifrost",
  "requested_model": "deepseek-deepseek-flash",
  "routed_model": "deepseek/deepseek-flash",

  // —— 状态与失败归因 ——
  "status": "ok",
  "error_kind": null,
  "http_status": 200,

  // —— Token usage（可选，与原生日志去重） ——
  "usage": {
    "input": 1234,
    "output": 567,
    "cache_read": 0,
    "cache_write": 0,
    "reasoning": 0
  },

  // —— 人工确认（可选） ——
  "human_confirm": {
    "required": false,
    "decided_at": null,
    "decision": null
  },

  // —— 采集器自标识 ——
  "collector": "opencode-provider-wrapper",
  "collector_version": "0.1.0",
  "collected_at": 1790475936200
}
```

### 3.3 字段语义

| 字段 | 必填 | 语义 | 喂给哪个计算函数 |
|---|---|---|---|
| `requested_at` | 是 | LLM 请求发出的时刻（epoch ms） | `computeTTftMs` 的 start |
| `first_output_at` | 是* | 首 token / 首 chunk 到达时刻 | `computeTTftMs` 的 first_output |
| `first_output_source` | 是 | `native`（真实首 token） / `derived`（推断） | `computeTTftMs` 的 evidence_grade |
| `stream_ended_at` | 否 | 流式结束时刻，可算总生成时间 | output TPS |
| `timestamp_basis` | 是 | `epoch_ms` / `monotonic_ns` | reader 判定碰撞 |
| `precision_ns` | 是 | 时钟实际精度（ns） | reader 判定碰撞 |
| `is_retry` / `attempt_index` | 是 | 重试标记 | retry 计数 |
| `attempt_id` | 是 | attempt 唯一 ID | `computeTTftMs` 的 scope_id |

*`first_output_at` 在无首 token 观测时可为 null，reader 返回 `missing_first_chunk`。

### 3.4 时间精度与碰撞防护（吸取 Mobilework 教训）

- 采集器**必须**用高精度时钟记录 `first_output_at`：
  - Node.js: `process.hrtime.bigint()` 转换为 epoch ms（取整数部分）+ `precision_ns`（余数）
  - 浏览器/Electron: `performance.timeOrigin + performance.now()`
- `timestamp_basis` 为 `monotonic_ns` 时，reader 用纳秒差值计算，避免毫秒碰撞。
- reader 仍保留物理下限校验（`TTFT_PHYSICAL_FLOOR_MS = 5`），但仅对 `epoch_ms` 精度生效；`monotonic_ns` 精度足够时跳过。

## 4. observatory 侧共享 reader（`lib/collector-reader.mjs`）

### 4.1 接口

```js
// 读取某 session 的全部 attempt 记录
readAttempts(agentObject, sessionId, options?) → Promise<Attempt[]>

// 从 attempts 计算 TTFT 均值（复用 computeTTftMs）
computeTtftFromAttempts(attempts, sessionId) → MetricResult

// 从 attempts 计算重试次数
computeRetryFromAttempts(attempts, sessionId) → MetricResult

// 从 attempts 计算人工确认次数
computeHumanConfirmFromAttempts(attempts, sessionId) → MetricResult
```

### 4.2 路径解析

```js
const collectorDir = path.join(os.homedir(), ".agent-log-observatory", "collectors", agentObject);
// 扫描该目录下 attempts-*.jsonl，过滤 session_id 匹配的行
```

### 4.3 回退语义

- 目录不存在 / 文件不存在 → 返回 `[]`，适配器回退到原 `not-captured`。
- 文件存在但解析失败 → 跳过坏行，记录 `coverage.parse_errors`。
- attempt 有数据但全部低于物理下限 → 返回 `timestamp_collision`（与现有 Mobilework 逻辑一致）。

## 5. 三个 Agent 采集器实现方案

### 5.1 opencode session.hook plugin（已实现 P1，实测验证）

**原理**：opencode V2 plugin 的 `setup(ctx)` 运行时 ctx 含 `session.hook` 方法（注册 `http.request` / `http.response` / `retry` hooks），event 含 `sessionID` / `agent` / `model` / `kind`。在 hook 回调里记录时间戳，落盘到 collector JSONL。

**调研关键发现（已写入注释）**：
- `@opencode-ai/plugin@1.18.34` 的 `.d.ts`（`dist/v2/promise/context.d.ts` 和 `dist/v2/effect/context.d.ts`）是**过时子集**——只声明了 `agent/aisdk/catalog/command/integration/plugin/reference/skill` 等字段，**没有** `session` / `event` / `permission` / `provider` / `model`。
- 但**运行时** opencode v2.0.6 的 setup ctx 实际含完整字段（与在线文档 https://opencode.ai/v2/docs/build/plugins 一致）：`session` / `event` / `permission` / `provider` / `model` / `tool` / `vcs` / `websearch` / `worktree` / `shell` / `generate` / `storage` / `rpc` 等。
- `ctx.event.subscribe()` 返回的是**全局 registry 事件流**（`model.updated` / `provider.updated` / `command.updated`），**不含** session 执行事件（`session.next.text.*`）。session 执行事件必须通过 `ctx.session.hook("http.request"/"http.response"/"retry")` 获取。
- V2 plugin 要求 `export default { id, setup(ctx) }` 对象格式（V1 的函数导出会被拒绝：`Plugin must export a default definition with an id and an effect or setup function`）。

**为什么不用 provider wrapper / event-stream**：
- provider wrapper（AISDKHooks language wrapper）能拿到 doStream 首 chunk，但**拿不到 sessionID**（opencode 调 provider 时不传 session 上下文）。
- event-stream（fetch `/api/event` SSE）方案：`ctx.event.subscribe` 只返回全局 registry 事件，不含 session 执行流；直接 fetch SSE 需要 server URL（plugin ctx 不暴露），且 V2 server 端口动态绑定。
- `ctx.session.hook` 是官方机制，event 天然含 sessionID + model + kind，最干净。

**hook → 指标映射**：

| hook | event 字段 | 映射 |
|---|---|---|
| `http.request` | `sessionID` / `agent` / `model` / `kind` / `request` | `requested_at = Date.now()`（hook 触发即请求发出） |
| `http.response` | `sessionID` / `agent` / `model` / `kind` / `response` | `first_output_at = Date.now()`（响应头到达 ≈ 首 token） |
| `retry` | `sessionID` / `attempt` / `error` / `decision` | `is_retry=true` / `attempt_index` / `error_kind` |

- 只采 `kind === "primary"`（agent loop 主请求），忽略 `compaction` / `title` / `generate`。
- `(sessionID, kind)` 作 draft key：http.request 建 draft，http.response finalize 落盘。

**实现**：`collectors/opencode-collector-plugin/index.mjs`
- V2 plugin 格式：`export default { id: "opencode-collector", async setup(ctx) {...} }`
- `ctx.session.hook("http.request", cb)` / `ctx.session.hook("http.response", cb)` / `ctx.session.hook("retry", cb)`
- setup 返回 cleanup 函数（`controller.abort()` / `drafts.clear()`）
- 落盘字段对齐 `schemas/collector-attempt.schema.json`（`collector-attempt-0.1.0`）
- `first_output_source: "derived"`（响应头到达时刻，非真实首 SSE chunk，但足够接近）

**安装**：`node collectors/install-opencode.mjs install`
- 备份 `opencode.jsonc` → `opencode.jsonc.collector.bak`
- 在 `plugins` 数组追加 plugin 目录绝对路径
- 不触碰 providers/models/apiKey/baseURL（已用 diff 验证：唯一差异是 plugins 字段，12 个 modelID / 13 个 provider 全保留）
- 重启 `opencode service restart` 生效

**卸载**：`node collectors/install-opencode.mjs uninstall`

**实测结果**（session `ses_eff1c8b8fffeEVlF8x7EKU23kC`，8 个 attempt）：
- `llm_attempt_ttft_ms`: value=4305ms, state=`captured`（从 `not-captured` 升级），coverage eligible=8/observed=8/finished=8/collisions=0
- `llm_retry_count`: value=0, state=`captured`（从 `not-captured` 升级），coverage 8/8/8
- 单次 TTFT 实测值 2.6s / 5.2s（合理 LLM 首 token 延迟，远超 5ms 物理下限，零碰撞）

**侵入度**：低。只加一行 plugins 引用，不改 provider 配置。

**已知限制**：
- `first_output_at` 是 http.response hook 触发时刻（响应头到达），不是真实首 SSE chunk 到达。标 `derived`。如需精确首 token，可在 http.response 回调里 tee response.body 读第一个 chunk（复杂化，暂不做）。
- `ctx.session.hook` 是运行时能力但不在 `.d.ts` 类型声明里——opencode 升级后若改 hook 签名，plugin 不会编译报错但运行时可能失效。需在 opencode 升级后回归测试。
- hook event 的 `kind` 字段区分 primary/compaction/title/generate；若 opencode 未来新增 kind，需更新过滤逻辑。
- `requested_at` / `first_output_at` 用 `Date.now()`（plugin 进程内时钟，毫秒精度），标 `timestamp_basis: "epoch_ms"` / `precision_ns: 1`。reader 应用 5ms 物理下限过滤。

### 5.2 Mobilework MITM 反向代理（P3 已实现，HTTP 反向代理 + time-window 匹配）

**现状**：`~/.mobilework-trace-dashboard/stream-timings.json` 已由 trace-dashboard sidecar 采集，但用 `Date.now()` 毫秒粒度，导致 `firstChunkAt === startedAt` 碰撞（delta 0-1ms，低于 5ms 物理下限）。

**调研结论（sidecar 闭源）**：trace-dashboard sidecar 代码在整个 Mobilework 安装中找不到——
- `app.asar`（36MB JS）：❌ 无 `stream-timings`/`firstChunkAt`/`stallGaps`/`measurementVersion` 等关键词
- `app-dist/assets/app-*.js`（8MB 前端 bundle）：❌ 无匹配
- `opencode-plugins/`（15 个插件文件）：❌ 无匹配
- `opencode.exe`（146MB 二进制，node 分块搜索）：❌ 无匹配
- `openwork-orchestrator.exe`（120MB 二进制）：❌ 无匹配
- `~/.mobilework/` 数据目录：❌ 无匹配

sidecar 代码嵌入编译二进制或已在新版移除，**无法修改时间源**。

**opencode.db part 时间戳也不可行**：step-start → first-reasoning delta 仅 3-36ms（含 step 初始化 + 本地代理缓冲，非真实 TTFT）。Mobilework 用本地 model-proxy（`http://127.0.0.1:53074`）转发 LLM 请求，真实 TTFT（请求发出 → 首 token 从远端 API 到达）被代理隐藏。

**最终方案：MITM HTTP 反向代理**。Mobilework 的 LLM API 全部是 HTTP（非 HTTPS），无需 CA 证书。将 `providers.jsonc` 的 baseURL 从 `http://<real-api>` 改为 `http://127.0.0.1:8890/<prefix>`，由本代理按 prefix 转发到真实 target，同时记录时延。

**架构**：
```
opencode engine → http://127.0.0.1:8890/v1 (代理) → http://47.112.174.22:38421/v1 (真实 API)
                 http://127.0.0.1:8890/p/mw-auto  → http://127.0.0.1:53074/p/mw-auto
```

**session_id 处理**：HTTP 请求体是标准 OpenAI chat 格式，不含 session_id。代理写 `session_id: null`，适配器用 **time-window 匹配**（`requested_at ∈ [session.time_created, session.time_updated]`，从 opencode.db 获取）。多个 session 并发时可能有歧义，但 Mobilework 通常单 session 运行。

**组件**：
- `collectors/mobilework-llm-proxy/index.mjs`：HTTP 反向代理（`http.createServer`），采集 `requested_at`（请求到达）/ `first_output_at`（响应头到达）/ `stream_ended_at`，支持 SSE 流式 pipe
- `collectors/mobilework-llm-proxy/proxy-config.json`：路由配置（path_prefix → target 映射）
- `collectors/install-mobilework-proxy.mjs`：安装/卸载脚本（备份 providers.jsonc，替换 baseURL，生成 proxy-config.json，可回退）

**adapter 集成**：`mobilework-adapter.mjs` 优先读 collector attempts（time-window 匹配），无采集器数据时回退 `stream-timings.json`（已知碰撞，判 `timestamp_collision`）。capabilities 的 `has_ttft` 动态化。

**回退语义**：
- 代理未运行 / 无采集器数据 → 回退 stream-timings.json → `timestamp_collision`
- 代理有数据但 session 时间窗内无 attempt → `not_instrumented`
- 代理有数据且时间窗匹配 → `captured`（真实 TTFT，delta 通常 100ms-5s）

### 5.3 WorkBuddy trace 直读（零侵入，已实现 P2，实测验证）

**原理**：调研发现 WorkBuddy 的 `~/.workbuddy/traces/<pid>/trace_*.json` 已含 `generation` 类型 span，每条带 `startedAt`（ISO string，请求发出）/ `endedAt`（ISO string，响应完成）/ `duration`（ms）/ `status`。`trace.sessionId` 可直接关联 session。**无需 MITM 代理**——直接在 adapter 里读 trace 构建 attempt 对象。

**调研过程**：
1. 最初设计为 MITM 代理（mitmproxy addon + CA 证书 + 改启动方式），侵入度高。
2. 探测 WorkBuddy 数据目录时发现 `traces/` 目录有 102 个 trace 文件，每个含 `spans` 数组。
3. span 类型分布：`custom:mcp_tools`、`agent:cli`、`generation:generation`、`function:Bash`。
4. `generation` span 的 `toolOutput` 是 `"object":"chat.completion"`（非 chunk）→ **非流式响应**，因此 `first_output_at ≈ endedAt`（response complete = first output）。
5. transcript 的 `providerData` 含 `conversationRequestId`/`messageId`/`traceId`/`model`，且 `trace.sessionId === transcript sessionId`，可直接关联。
6. 实测 13 个 generation span 全部通过时间邻近匹配到 transcript messageId，零碰撞，TTFT 值 2.7s-10.9s（合理）。

**hook → 指标映射**：

| trace 数据 | 字段 | 映射 |
|---|---|---|
| generation span `startedAt` | ISO string | `requested_at = new Date(startedAt).getTime()` |
| generation span `endedAt` | ISO string | `first_output_at = new Date(endedAt).getTime()`（非流式：response complete = first output） |
| generation span `status`/`error` | string | `status`/`error_kind` |
| generation span `spanId` | string | `attempt_id`/`llm_call_id` |

- `first_output_source: "derived"`（非真实首 token，是 response complete 时刻；对非流式响应等价于首 token）
- `timestamp_basis: "epoch_ms"`，`precision_ns: 1`

**实现**：`adapters/workbuddy-adapter.mjs`
- `_wbDataDir()`：动态读 `AGENT_LOG_WORKBUDDY_DATADIR` env var（便于测试覆盖），默认 `~/.workbuddy`
- `_findTraceFile(sessionId)`：遍历 `traces/<pid>/trace_*.json`，匹配 `trace.sessionId === sessionId`
- `_readGenerationSpans(sessionId)`：读取 trace，过滤 `type === "generation" && startedAt && endedAt`
- `_generationSpansToAttempts(spans, sessionId)`：转为 collector-attempt 格式，传给 `computeTtftFromAttempts`
- `_hasTraceGenerationSpans()`：检查 traces 目录是否有 generation span（用于 capabilities 动态化）
- `capabilities`：`has_ttft` 动态化（trace 有数据=true），`has_retry` 仍 false（trace 无重试信号）
- `extractMetrics`：优先用 trace generation spans 计算 TTFT，无 trace 数据时回退 `not_instrumented`

**侵入度**：**零**。只读 WorkBuddy 已有的 trace 文件，不安装代理、不信任 CA、不改启动方式、不加 plugin。

**实测结果**（session `464e2951-85b8-438f-9561-941731355059`，13 个 generation span）：
- `llm_attempt_ttft_ms`: value=13690ms, state=`captured`（从 `not-captured` 升级），coverage eligible=13/observed=13/finished=13/collisions=0
- evidence_grade: `derived`（非流式 response complete 作为 first output）
- 单次 TTFT 值：2.7s, 3.1s, 2.7s, 6.6s, 74.9s, 34.3s, 9.1s, 9.2s, 10.9s, 4.9s, 10.3s, 3.5s, 5.3s

**已知限制**：
- `first_output_at` 是 generation span `endedAt`（response complete），不是真实首 SSE chunk。对非流式响应等价于首 token；若 WorkBuddy 未来切换流式，需改用 transcript 首 reasoning timestamp 或 trace 子 span。
- retry 仍 `not_instrumented`：trace generation span 的 `status` 可标识失败（`error`），但无法判定是否被重试（无 call_id 关联多个 attempt）。后续可按"error span 后短时间内有新 ok span"启发式推断。
- trace 覆盖率：34 sessions → 39 traces with sessionId（不是每个 session 都有 trace；活跃 session 可能无 trace）。
- `startedAt`/`endedAt` 是 ISO string（毫秒精度），转 epoch_ms 后 `precision_ns: 1`，reader 应用 5ms 物理下限过滤。

### 5.4 Doubao CDP Collector（P4 已实现，实测 TTFT=183ms）

**原理**：Doubao 是 Chromium 147 应用，支持 `--remote-debugging-port` 开启 CDP 调试。通过 WebSocket 连接 CDP Network 域，拦截 `POST /chat/completion`（SSE `text/event-stream`）的完整生命周期。

**调研关键发现**：
- Doubao 技术栈：Chromium 147 非标准 Electron，无插件机制，不读 `HTTP_PROXY` → MITM 代理方案不可行。
- CDP target：`doubao://doubao-chat/chat/<conversation_id>`，LLM 端点 `POST https://www.doubao.com/chat/completion`。
- SSE 事件类型：`SSE_HEARTBEAT`、`SSE_ACK`、`FULL_MSG_NOTIFY`、`STREAM_MSG_NOTIFY`、`STREAM_CHUNK`、`CHUNK_DELTA`、`SSE_REPLY_END`。
- `Network.streamDataReceived` **不触发**（Doubao SSE 流不产生此事件）→ TTFT 用 `responseReceived` 时间戳（derived）。
- `conversation_id` 在 postData `client_meta.conversation_id`（嵌套 JSON），非顶层字段。
- SSE 响应体（`SSE_REPLY_END`）**不含** token usage 或 model 字段，仅含 `fetch_token`（非 usage）。

**CDP 时间戳陷阱**：CDP `timestamp` 是单调时钟（非 epoch），`wallTime` 是 epoch 秒（仅 `requestWillBeSent` 有）。转换公式：`epoch_ms = requested_at + (event_ts - req_ts) * 1000`。

**hook → 指标映射**：

| CDP 事件 | 字段 | 映射 |
|---|---|---|
| `Network.requestWillBeSent` | `wallTime` / `request.postData` | `requested_at` + `conversation_id` + `model` |
| `Network.responseReceived` | `timestamp` / `response.status` | `first_output_at`（derived TTFT）+ `http_status` |
| `Network.loadingFinished` | `timestamp` | `stream_ended_at` + `getResponseBody` → usage |
| `Network.loadingFailed` | `errorText` / `canceled` | `status=error` + `error_kind` |

**session_id 处理**：CDP 采集的 `conversation_id` 与 agent mode workspace 的 session 目录名是不同 ID 空间。adapter 用 **time-window 匹配**（trajectory 文件 ctime/mtime 作为时间窗，`filterByTimeWindow` 过滤 collector attempts）。

**实现**：`collectors/doubao-cdp-collector/index.mjs`
- 独立 Node 进程，WebSocket→CDP，无需安装到 Doubao
- 进程锁（`runtime/doubao-cdp-collector.lock`）防多实例
- Keep-alive 心跳（`setInterval`）防事件循环退出
- WebSocket 泄漏防护（连接失败时 `ws.close()`）
- `processedRequestIds` Set 防重连重复处理
- `Network.enable` 成功前不处理事件（`networkReady` 标志）
- 落盘字段对齐 `schemas/collector-attempt.schema.json`（`collector-attempt-0.1.0`）

**启动**：
```cmd
REM 1. Doubao 以调试端口启动
"D:\02-software-install\doubao-zijie\Doubao\app\Doubao.exe" --remote-debugging-port=9223

REM 2. 启动采集器（启动.cmd 检测到 CDP 端口时也会自动附着）
启动.cmd
```

**实测结果**（conversation `38445522909057538`）：
- `llm_attempt_ttft_ms`: value=183ms, state=`captured`（从 `not-captured` 升级），`first_output_source: "derived"`
- `llm_retry_count`: value=0, state=`captured`（从 `not-captured` 升级）
- e2e: 3761ms（`loadingFinished` - `requestWillBeSent`，时间戳正确转换）

**侵入度**：低。Doubao 需以 `--remote-debugging-port` 启动（一次性），采集器独立进程运行，不改 Doubao 安装。

**已知限制**：
- TTFT 是 derived（`responseReceived` 响应头到达），非真实首 SSE chunk。
- SSE 响应体无 usage/model → `token_input`/`token_output`/`token_total` 仍 `not-captured`。
- `conversation_id` 与 trajectory session_id 不同 ID 空间，靠时间窗匹配（近似）。

## 6. observatory 适配器改动（最小化）

每个适配器 `extractMetrics` 里，把硬编码的 `not-captured` 替换为 reader 调用：

```js
// adapters/opencode-adapter.mjs，extractMetrics 末尾
import { readAttempts, computeTtftFromAttempts } from "../lib/collector-reader.mjs";

const attempts = await readAttempts("opencode", sessionId);
const ttft = attempts.length > 0
  ? computeTtftFromAttempts(attempts, sessionId)
  : makeMetricResult("llm_attempt_ttft_ms", null, {
      unit: "ms", scope: "session", scope_id: sessionId,
      state: "not-captured", missing_reason: "not_instrumented",
    });
// 替换原有硬编码的 not-captured 记录
```

`capabilities()` 里 `has_ttft` 从静态 `false` 改为动态：
```js
has_ttft: await hasCollectorData("opencode"),  // 检查 collector 目录是否有数据
```

**改动文件清单**：
- `lib/collector-reader.mjs`（新增）
- `adapters/opencode-adapter.mjs`（extractMetrics 替换 TTFT 行）
- `adapters/workbuddy-adapter.mjs`（同上 + human_confirm）
- `adapters/mobilework-adapter.mjs`（优先读 collector，回退 stream-timings.json）
- `adapters/*/capabilities`（has_ttft 动态化）

## 7. 测试计划

### 7.1 新增 fixture
```
tests/fixtures/collector-sample/
  opencode/attempts-20261003.jsonl   # 3 条 attempt，含 1 条 retry
  workbuddy/attempts-20261003.jsonl  # 2 条 attempt
```

### 7.2 新增测试（`tests/test-collector-reader.mjs`）
- `readAttempts` 路径解析正确
- `computeTtftFromAttempts` 复用 `computeTTftMs`，输出 `captured`
- 高精度（`monotonic_ns`）数据不触发物理下限过滤
- 低精度（`epoch_ms`）碰撞数据触发 `timestamp_collision`
- 文件不存在时返回空数组（回退语义）
- retry 计数：`is_retry=true` 或 `attempt_index>0`

### 7.3 不破坏现有测试
- 现有 56 测试全过（采集器不存在时适配器回退到原逻辑）。

## 8. 落地顺序与里程碑

| 阶段 | 交付物 | 状态 | 依赖 |
|---|---|---|---|
| P0 | `lib/collector-reader.mjs` + schema + fixture + 测试 | ✅ 完成 | 无 |
| P1 | opencode session.hook plugin + 适配器接入 | ✅ 完成（实测 TTFT=4305ms） | P0 |
| P2 | WorkBuddy trace 直读 + 适配器接入 | ✅ 完成（实测 TTFT=13690ms） | P0 |
| P3 | Mobilework MITM 反向代理 + time-window 匹配 | ✅ 完成（代理 + 安装脚本 + adapter 接入 + 6 测试） | P0 + sidecar 调研（闭源） |
| P4 | observatory `capabilities` 动态化 + 文档更新 | ✅ 完成 | P1-P3 |
| P5 | Doubao CDP Collector + 适配器接入 + 文件监听方案 A | ✅ 完成（实测 TTFT=183ms） | P0 + CDP 探测 |

## 9. 已知风险

1. **WorkBuddy session 关联**：trace 的 generation span 通过时间邻近匹配 messageId，零碰撞实测验证。
2. **Mobilework sidecar 闭源**：trace-dashboard sidecar 代码在安装目录和二进制中均未找到，无法修改时间源。已用 MITM 反向代理方案绕过——代理在 HTTP 层拦截真实请求/响应时延，不依赖 sidecar。
3. **Mobilework session_id 匹配**：MITM 代理无法从 HTTP 请求提取 session_id（标准 OpenAI 格式），用 time-window 匹配。多 session 并发时可能有歧义，但 Mobilework 通常单 session 运行。
4. **opencode 重试语义**：用 `ctx.session.hook("retry")` 采集，event 含 `sessionID`/`attempt`/`error`/`decision`，实测 retry=0（无重试场景）。
5. **采集器写入竞态**：多 attempt 并发时 `appendFileSync` 可能交错，需用 `O_APPEND` 或加锁。
6. **Mobilework providers.jsonc 修改**：安装脚本备份原文件（`.llm-proxy-bak`），可回退。Mobilework 更新可能覆盖修改，需重新安装。
7. **磁盘增长**：按天轮转 + 30 天清理策略（reader 默认 `limitDays=30`），单 Agent 单日预计 < 1MB。
