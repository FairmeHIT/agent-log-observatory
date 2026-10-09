# DSH（DeepSeek Harness）数据源明细

> 本文件从 [SPEC.md](../../SPEC.md) §2.6 拆分，自包含 DSH（DeepSeek Harness）的数据源探测明细：安装目录、数据目录、数据源表、事件格式、字段语义、指标可用性与限制。  
> 所属项目：Agent Log Observatory · 能力归属：`Observation & Evidence Layer` · 状态：`draft`  
> 跨 Agent 指标覆盖矩阵见 [SPEC.md §3](../../SPEC.md#3-指标覆盖矩阵)。

---

**安装目录**：`<DSH_INSTALL_ROOT>/`（默认 `D:\02-software-install\dsh\`）
- Electron 应用，可执行文件 `DeepSeek Harness.exe`（244MB）
- 内置 Node.js + pnpm 运行时（`dsh-runtimes/dsh-primary-runtime/`）
- 支持多 profile（desktop/web），profile 中含 `cordis.yml` 配置和 `package.json` 依赖

**用户数据目录**：`%USERPROFILE%/.dsh/`

| 路径 | 格式 | 内容 | 可提取指标 |
|---|---|---|---|
| `sessions/<workspace-slug>/session-<uuid>/session.v4.jsonl.zstd` | **多帧 zstd JSONL**（每行单独 zstd 压缩后拼接） | 会话头 + 事件流（step/start, reasoning-chunks, tool-call-chunks, assistant/chunk, tool/call, text-chunks, session/title-llm-request, session/end-seed） | **TTFT**（step/start.time → 首 chunk time0）、**单轮 E2E**（step/start → 本 step 末 chunk time0）、**Session lifespan**（createdAt → 末事件 time）、LLM 调用数（step/start 计数）、工具调用数（tool/call 计数）、Step 数、Event 分类计数、model（title-llm-request route） |
| `sessions/<workspace-slug>/session-<uuid>/session.jsonl.zstd` | 同上（旧版本格式，version=0） | 同上，事件结构兼容 | 同上 |
| `storages/session_projcache/sessions/session-<uuid>.json` | JSON（projection cache，version=7） | **sessionStats**：{turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens}、**tokenUsage.totals**：{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}、**modelSelection.lastUsed**：{provider, model, reasoningEffort}、**contextPressure**：{surfaceTokens, contextWindow, pressureTokens}、**permissions**：{preset, sandbox, approval}、**llmRetry**、**title** | **TTFT**（sessionStats.ttftMs / ttftSteps 均值，原生内置）、**Token 全量**（tokenUsage.totals 四项）、**Cache hit rate**（cacheRead / (uncachedInput + cacheRead)）、**Output TPS**（decodeTokens / decodeMs）、**Max context**（contextPressure.surfaceTokens/contextWindow）、**LLM 总时延**（sessionStats.llmMs）、**Tool 总时延**（sessionStats.toolMs）、**Turn/Step 计数**、**Model**、**Retry**（llmRetry，当前为空 {}） |
| `storages/session_projcache.json` | JSON | 全局 session 列表缓存 | 会话发现、workspace 映射 |
| `storages/workspace.json` | JSON | workspace 元数据 | workspace 列表 |
| `profiles/desktop/cordis.yml` + `cordis.patch.yml` | YAML | profile 配置 | profile 模式 |
| `.credentials.yaml` | YAML | API key refs（DEEPSEEK_API_KEY, BIFROST_API_KEY） | 不提取（脱敏） |
| `.anonymous-user-id` | text | 匿名用户 ID | 不提取 |
| `settings.yaml.imported` | YAML | 默认模型配置（provider: deepseek-official, model: deepseek-v4-flash, reasoningEffort: high）、Bifrost provider 配置 | 默认 model/provider |

**Electron 应用数据目录**：`%APPDATA%\dsh-desktop\`

| 路径 | 格式 | 内容 | 可提取指标 |
|---|---|---|---|
| `logs/harness.log` | text | Desktop 启动/profile 修复/harness-node 启动日志 | 无直接指标（debug 用） |
| `harness/profiles/` | dir | Node.js profile（pnpm 管理的 @deepseek-ai 包） | 无直接指标 |
| `harness/.desktop-bin/` | dir | pnpm shim | 无直接指标 |
| `blob_storage/`, `Cache/`, `Local Storage/`, `Session Storage/` | Electron 标准 | Electron 缓存 | 不提取 |

**事件格式示例（多帧 zstd JSONL，每帧一行 JSON）**：

```
session              {"type":"session","version":4,"id":"session-...","createdAt":1790690600473,"cwd":"D:\\...","agentPreset":"standard"}
session/title-llm-request {"type":"session/title-llm-request","seq":12,"time":1786773324712,"data":{"route":{"provider":"deepseek-official","model":"deepseek-v4-flash"}}}
step/start           {"type":"step/start","seq":159,"time":1786773422423,"data":{"turn":2,"step":2}}
reasoning-chunks     {"type":"reasoning-chunks","seq0":172,"time0":1786773423293,"data":{"turn":2,"step":2,"dt":[1,0,0,...],"texts":[" key"," files",...]}}
tool-call-chunks     {"type":"tool-call-chunks","seq0":381,"time0":1786773424750,"data":{"turn":2,"step":2,"id":"call_...","name":"glob","args":[...]}}
assistant/chunk      {"type":"assistant/chunk","seq":815,"time":1786773441972,"data":{"turn":2,"step":5,"chunk":{"type":"tool-call-delta"}}}
tool/call            {"type":"tool/call","seq":1063,"time":1786773448558,"data":{"turn":2,"step":6,"callId":"call_...","name":"read","arguments":"{...}"}}
text-chunks          {"type":"text-chunks","seq0":2461,"time0":1786773471809,"data":{"turn":2,"step":11,"dt":[28,0,26,...],"texts":["继续","。",...]}}
session/end-seed     {"type":"session/end-seed","seq":25151,"time":1788099716454,"data":{}}
```

**字段语义**：
- `seq`/`seq0`：事件序号（全局递增）；`seq0` 用于 chunk 聚合事件（首 chunk seq）
- `time`/`time0`：epoch ms 时间戳；`time0` 用于 chunk 聚合事件（首 chunk 时间）
- `data.turn`/`data.step`：轮次/步骤编号
- `data.dt`：chunk 间 delta 时间数组（ms），可用于精确重建 chunk 时序
- `data.texts`：chunk 文本碎片数组
- `data.index`：同 step 内的 chunk 流序号

**sessionStats 原生指标（projection cache 直接提供）**：

| 字段 | 说明 | 示例值 |
|---|---|---|
| `sessionStats.ttftMs` | 全 step TTFT 总和（ms） | 36368 |
| `sessionStats.ttftSteps` | 有 TTFT 测量的 step 数 | 36 |
| `sessionStats.llmMs` | 全 step LLM 处理总时间（ms） | 177233 |
| `sessionStats.toolMs` | 全 step 工具执行总时间（ms） | 146221 |
| `sessionStats.decodeMs` | 全 step decode（生成）总时间（ms） | 140865 |
| `sessionStats.decodeTokens` | 全 step decode 输出 Token 总数 | 22328 |
| `sessionStats.turns` | 总轮次数 | 3 |
| `sessionStats.steps` | 总步骤数 | 38 |

**可提取指标与限制**：

| 指标 | DSH 来源 | 口径说明 |
|---|---|---|
| **TTFT** | ✅ sessionStats.ttftMs / ttftSteps（原生均值）；或事件级 step/start.time → 首 reasoning/text-chunks.time0 | 双源：projection cache 原生统计 + 事件级精确重建；chunk 级 dt 数组可恢复逐 token 时序 |
| **单轮 E2E** | ✅ sessionStats.llmMs + toolMs（全 session 汇总）；或事件级 step/start → 本 step 末 chunk time0 | sessionStats 为汇总；事件级可按 turn 分组逐轮计算 |
| **Session lifespan** | ✅ session.createdAt → 末事件 time（session/end-seed 或最后 chunk） | 注意 end-seed 时间可能远超最后 chunk（session 后续被 seed 触发） |
| **Token 全量** | ✅ tokenUsage.totals（uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens） | input 为 **uncached**（不含 cache），cache_hit_rate = cacheRead / (uncachedInput + cacheRead) |
| **Cache hit rate** | ✅ cacheReadTokens / (uncachedInputTokens + cacheReadTokens) | input_excludes_cache = true |
| **Output TPS** | ✅ sessionStats.decodeTokens / (sessionStats.decodeMs / 1000) | 原生 decode 时长 + token 数 |
| **Max context** | ✅ contextPressure.surfaceTokens / contextWindow | 1M context window |
| **LLM 调用数** | ✅ step/start 事件计数（每 step 一次 LLM 调用）；或 sessionStats.steps | step/start 是每步 LLM 调用的起点 |
| **工具调用数** | ✅ tool/call 事件计数 | tool/call 为完成态工具调用 |
| **Step 数** | ✅ sessionStats.steps | 原生 |
| **Turn 数** | ✅ sessionStats.turns | 原生 |
| **Model** | ✅ modelSelection.lastUsed 或 session/title-llm-request data.route | provider + model + reasoningEffort |
| **Retry** | ⚠️ llmRetry（当前为空 {}，结构已定义） | 结构存在但当前无 retry 记录 |
| **人工确认** | ⚠️ permissions.approval = "ask"（审批模式声明，非次数计数） | 仅知模式，不知实际审批次数 |
| **Credits** | ❌ not-captured | 数据源无 cost/credit 字段 |
| **失败归因** | ❌ not-captured | 无 error/failure 事件类型 |
| **Compaction** | ❌ not-captured | 未发现 compaction 事件 |

**限制**：
- session 文件为 **多帧 zstd**（每行单独压缩后拼接），不能直接 `zstdDecompressSync` 整文件（仅解首帧），需按帧 magic `28 B5 2F FD` 分割逐帧解压。
- `session/end-seed` 时间戳可能远超最后实际事件（被后续 seed 操作触发），**不应作为 session 结束时间**；应使用最后非 end-seed 事件的时间。
- tokenUsage 的 input 是 **uncached**（不含 cache read），与 WorkBuddy（input 含 cache）口径不同，跨 Agent 对比时需归一。
- 无 SQLite 数据库，所有数据为 JSONL.zstd + JSON 文件。
- profile（desktop/web）的差异不影响指标提取；`agentPreset`（standard）为默认预设。
