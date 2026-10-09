# Mobilework 数据源明细

> 本文件从 [SPEC.md](../../SPEC.md) §2.3 拆分，自包含 Mobilework 的数据源探测明细：安装目录、数据目录、数据源表、事件格式、字段语义、指标可用性与限制。  
> 所属项目：Agent Log Observatory · 能力归属：`Observation & Evidence Layer` · 状态：`draft`  
> 跨 Agent 指标覆盖矩阵见 [SPEC.md §3](../../SPEC.md#3-指标覆盖矩阵)。

---

**安装目录**：`<MOBILEWORK_INSTALL_ROOT>/`
- Electron 应用，内嵌 OpenCode sidecar (`resources/sidecars/opencode.exe`)
- `resources/opencode-plugins/`：大量插件 JS（reporting、otel、file-reader 等）

**用户数据目录**：`%USERPROFILE%/.mobilework\`

### 主数据库：`xdg/data/opencode/opencode.db`（SQLite）

**session 表**（最丰富的数据源）：
| 列 | 类型 | 说明 |
|---|---|---|
| id | text | 会话 ID（`ses_*`） |
| model | text | JSON：`{"id":"shangtang/deepseek-v4-flash","providerID":"..."}` |
| agent | text | Agent 名称 |
| cost | real | 成本（当前均为 0） |
| tokens_input | integer | 输入 Token |
| tokens_output | integer | 输出 Token |
| tokens_reasoning | integer | 推理 Token |
| tokens_cache_read | integer | 缓存命中读取 |
| tokens_cache_write | integer | 缓存写入 |
| time_created | integer | 创建时间（epoch ms） |
| time_updated | integer | 更新时间 |
| time_compacting | integer | 压缩时间 |
| metadata | text | 元数据 JSON |
| workspace_id | text | 工作区 ID |
| parent_id | text | 父会话 ID（子代理） |

**session_message 表**：
| type | 含义 |
|---|---|
| `assistant` | 助手消息（LLM 响应） |
| `user` | 用户输入 |
| `agent-switched` | Agent 切换 |
| `compaction` | 上下文压缩 |
| `model-switched` | 模型切换 |

**event 表**（事件流，按 aggregate_id 分组、seq 排序）：
| event type | 映射 | 说明 |
|---|---|---|
| `session.next.step.started.1` | step.start | 步骤开始 |
| `session.next.step.ended.2` | step.end | 步骤结束 |
| `session.next.step.failed.2` | step.fail | 步骤失败（失败归因） |
| `session.next.tool.called.1` | tool.call | 工具调用 |
| `session.next.tool.input.started.1` | other: stream.start | 工具参数输出段边界，不等于模型请求/响应 |
| `session.next.tool.input.ended.1` | other: stream.end | 工具参数输出段边界，不等于模型请求/响应 |
| `session.next.tool.success.1` | tool.result | 工具成功 |
| `session.next.tool.failed.1` | tool.fail | 工具失败（失败归因） |
| `session.next.text.started.1` | other: stream.start | 文本输出段边界，不等于模型请求/响应 |
| `session.next.text.ended.1` | other: stream.end | 文本输出段边界，不等于模型请求/响应 |
| `session.next.reasoning.started.1` | other: stream.start | 推理输出段边界，不等于模型请求/响应 |
| `session.next.reasoning.ended.1` | other: stream.end | 推理输出段边界，不等于模型请求/响应 |
| `session.next.prompted.1` | agent.input | 用户提交 |
| `session.next.retried.1` | other (retry) | **模型重试**（携带 sessionID） |
| `session.next.compaction.started.1` | other (compaction) | 上下文压缩开始 |
| `session.next.compaction.ended.1` | other (compaction) | 上下文压缩结束 |
| `session.next.agent.switched.1` | other | Agent 切换 |
| `session.next.model.switched.1` | other | 模型切换 |
| `session.created.1` | other | 会话创建 |
| `message.updated.1` | other | 消息更新 |
| `message.part.updated.1` | other | 消息片段更新 |
| `session.updated.1` | other | 会话更新 |

> **事件关联**：保留原始 type 的版本后缀，解析匹配时归一；按 session/message/step/call 关联。重试时重复 step.started 不新增逻辑 Step；retried 增加 attempt，sessionID 单独不足以定位并发重试。请求边界优先 reporting，不计 stream-start 数。

### 任务级分析摘要：`data/<account_id>/analytics/runs.jsonl`

NDJSON 每行一条客户端任务/轮次摘要；原样本记录 252 条，运行时重新发现。它是补充聚合视图，不是业务 Outcome。

| 字段 | 类型 | 说明 |
|---|---|---|
| type | string | 固定 `"task"` |
| name | string | 任务名称（含会话 ID 前缀，如 `任务 ses_f421`） |
| instanceId | string | 会话实例 ID（`ses_*`），与 opencode.db session.id 关联 |
| status | string | 任务状态：`completed` / `failed` / `running` |
| tokensInput | integer | 输入 Token |
| tokensOutput | integer | 输出 Token |
| durationMs | integer | 任务持续毫秒 |
| ts | integer | 时间戳（epoch ms） |

**数据结构示例**：
```json
{"type":"task","name":"任务 ses_f421","instanceId":"ses_f4211291cffeJn0lOWJlyEGRC2","status":"completed","tokensInput":15393,"tokensOutput":77,"durationMs":8640,"ts":1789892951266}
```

> **关系与校验**：一个 Session 可有多条轮次摘要，session 表是累计量。轮次需原生 ID 或可验证输入/时间映射；重复摘要区分累计更新与新轮次，不只按 instanceId 去重，不把两源 Token 相加。同 scope/as_of 校验有差异时保留 reconciliation 状态，不静默覆盖。

### 其他数据源

| 路径 | 格式 | 内容 | 可提取指标 |
|---|---|---|---|
| `plugin-reporting/model-raw/` | JSON | 模型请求边界、请求/实际模型；字段按版本探测 | 首 chunk 证据齐全才算 TTFT，不假设历史 raw 文件必含 chunk 时间 |
| `~/.mobilework-trace-dashboard/stream-timings.json` | JSON | 已持久化的 stream 计时数据（v4 格式）：messageId、sessionId、startedAt、firstChunkAt、lastChunkAt、chunkCount、stallGapsMs | **TTFT**（firstChunkAt − startedAt）、断流等待（stallGapsMs）；当 model-raw 被清理后，此文件是历史 TTFT 的唯一来源（需 dashboard 曾运行） |
| `plugin-reporting/report-trace.log` | NDJSON | 上报追踪日志（scope/stage/message） | 上报完整性、sweep 错误 |
| `plugin-reporting/abort-marks/*.json` | JSON | 中止标记：`{"reason":"stop", "at": <epoch_ms>}` | 中止/失败（含原因和时间） |
| `plugin-reporting/current-turn/*.json` | JSON | 当前轮次状态：`{"turnId":"msg_...", "at": <epoch_ms>}` | 运行中状态 |
| `plugin-reporting/outbox/*/` | dir | 上报外发箱 | 上报完整性 |
| `electron/logs/main.log` | log | 主进程日志 | 错误归因 |
| `electron/logs/renderer.log` | log | 渲染进程日志 | 渲染错误 |
| `electron/logs/maf.log` | log | MAF 引擎日志 | 引擎错误 |
| `electron/logs/maf-engine.log` | log | MAF 引擎详细日志 | 引擎事件 |
| `electron/openwork-server-state.json` | JSON | 运行时状态 | 运行状态 |
| `config/runtime.sqlite` | SQLite | 运行时数据库 | 运行时配置 |
| `server/audit/ws_*.jsonl` | NDJSON | WebSocket 审计日志 | API 调用审计 |
| `venusguard/data/audit.db` | SQLite | 安全审计数据库 | 安全事件 |

**数据结构示例（session 行）**：
```json
{
  "id": "ses_f1f483a54ffeJXHD9JFmsGULra",
  "model": "{\"id\":\"shangtang/deepseek-v4-flash\",\"providerID\":\"----shangtang-deepseek-v4-flash\"}",
  "agent": "mobilework",
  "cost": 0.0,
  "tokens_input": 382822,
  "tokens_output": 18438,
  "tokens_reasoning": 22495,
  "tokens_cache_read": 813824,
  "tokens_cache_write": 0
}
```

**已有基线**：旧观察台 v0.0.28 已消费 SQLite、reporting、runtime 等部分源并支持 EAQE 阅读；不能宣称已消费本节全部源（如 runs.jsonl/审计库）。

旧服务通过本机 OpenCode SSE 采集首 chunk/stream，在自身用户目录保存 stream-timings.json、routed-models.json 和能力快照。offline 可读取已存在的脱敏摘要，local-live 可只读订阅；临时源清理后报告 partial，不伪造历史。

继承根/子会话、请求/实际模型、唯一重试关联、Skill/MCP 分类依据、原生 compaction、同轮时间及来源完整度。旧版本记录了 chunk 批量上报可能误判断流，默认只报观测 chunk 间隔，不称停顿/无效耗时。见 SPEC.md §9.1。
