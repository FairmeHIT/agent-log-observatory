# TeleAgent 数据源明细

> 本文件从 [SPEC.md](../../SPEC.md) §2.4 拆分，自包含 TeleAgent 的数据源探测明细：安装目录、数据目录、数据源表、事件格式、字段语义、指标可用性与限制。  
> 所属项目：Agent Log Observatory · 能力归属：`Observation & Evidence Layer` · 状态：`draft`  
> 跨 Agent 指标覆盖矩阵见 [SPEC.md §3](../../SPEC.md#3-指标覆盖矩阵)。

---

**安装目录**：`<TELEAGENT_INSTALL_ROOT>/`
- Electron 应用，`resources/app.asar`（409MB）
- 内嵌 Go super-agent-server（Hertz 框架）+ Node.js/Python 运行时
- `resources/scheduler/index.cjs`（648KB）调度器
- `resources/skills/`：大量内置 Skills（canvas-design、contract-review、deep-research 等）
- `resources/tools/`：工具定义（.ts + .txt）

**数据目录**：

| 目录 | 路径 | 内容 |
|---|---|---|
| 主数据 | `%USERPROFILE%/.local\share\TeleAgent\` | 数据库、日志、运行时 |
| 配置 | `%USERPROFILE%/.config\TeleAgent\` | 配置、Skills、工具 |
| 缓存 | `%USERPROFILE%/.cache\TeleAgent\` | 模型缓存 |

### super-agent-server 日志（核心数据源）

**路径**：`~/.local/share/TeleAgent/log/super-agent-server-YYYY-MM-DD.log`

Go 语言结构化日志（Hertz 框架），按日期滚动。**关键发现：日志不仅含 HTTP 请求，还包含 `[cost]`、`[perm]`、`[tool_instruction_review]`、`[prune]` 等标记行，可补充 Token 分项、权限、审查和压缩候选证据；语义/关联仍需验证，不直接称完整指标。**

**关联线索**：HTTP 路径及 Service Prompt start 可建立 request_id → session_id 映射；request_id 首先是应用请求 ID，不一定是一次 LLM 调用 ID。仅唯一映射可绑定，冲突/孤立日志留 unbound，不挂最近会话。

**日志行类型统计（2026-09-28，856KB）**：

| 行类型 | 出现次数 | 说明 |
|---|---|---|
| `[cost]` | 47 | Token 消耗和成本 |
| `[perm]` | 40 | 工具权限/人工确认 |
| `[tool_instruction_review]` | 312 | 工具审查决策和耗时 |
| `processResult` | 47 | 工具调用结果含 Token |
| `[tool] truncate` | 34 | 工具输出截断 |
| `[watermark]` | 84 | 水印/安全事件 |
| `[prune]` | 7 | 上下文压缩 |
| `MCP` | 35 | MCP 调用 |
| `[Error]` | 3 | 错误 |
| `http.request/finish` | 各 282 | HTTP 请求 |
| `hertz.route` | 94 | 路由注册 |

**`[cost]` 行结构**：
```
2026/09/28 15:39:56.047138 processor.go:744: [Info] [request_id:...] [cost] provider=NewApi tokens(in=25804 out=449 cacheRead=0) cost=$0.000000
```

| 字段 | 提取方式 | 说明 |
|---|---|---|
| timestamp | 行首 Go 时间戳 | 精确到微秒 |
| request_id | `[request_id:...]` | 关联会话和全部事件 |
| provider | `provider=NewApi` | LLM 提供商 |
| tokens.in | `tokens(in=N)` | 输入 Token |
| tokens.out | `tokens(out=N)` | 输出 Token |
| tokens.cacheRead | `tokens(... cacheRead=N)` | 缓存命中 Token |
| cost | `cost=$N` | 美元成本（当前恒为 0） |

**`[perm]` 行结构**：
```
2026/09/28 15:39:54.792813 processor.go:1453: [Info] [request_id:...] [perm] tool=powershell action=allow by=powershell:*
```

| 字段 | 提取方式 | 说明 |
|---|---|---|
| tool | `tool=N` | 工具名 |
| action | `action=allow/deny` | 权限决策 |
| by | `by=powershell:*` | 授权来源（权限规则） |

**`[tool_instruction_review]` 行结构**：
```
2026/09/28 15:39:55.572706 tool_instruction_review.go:208: [Info] [request_id:...] [tool_instruction_review] decision, toolID=powershell, result=1, action=allow, reason=..., approvalID=, durationMs=778
```

| 字段 | 说明 |
|---|---|
| toolID | 工具 ID |
| result | 审查结果（1=通过） |
| action | allow/deny |
| reason | 审查原因 |
| approvalID | 审批 ID（空=自动放行） |
| durationMs | 审查耗时 |

> `[tool_instruction_review]` 还包含 `request`、`response`、`completed`、`output review` 等子阶段行，可还原工具审查全流程。

**其他关键行**：

| 行模式 | 示例 | 可提取指标 |
|---|---|---|
| `Service Prompt start` | `session id:ses_...` | **request_id → session_id 映射** |
| `resolveModel` | `return direct model: NewApi/chat-flash` | **模型名** |
| `Processor ensureTitle start/end` | `latency=1.57s` | 标题生成耗时 |
| `processResult` | `{tool_calls {0x... 25804 449 0 {25600 0}}}` | 工具调用结果含 Token 数 |
| `[tool] truncate` | `tool=powershell outputLen=1354` | 工具输出长度 |
| `[watermark]` | `tool.execute.after triggered tool=powershell` | 水印事件 |
| `[prune]` | `total=0 pruned=0 candidates=0` | **上下文压缩** |
| `MCP` | MCP 调用/响应 | MCP 事件 |
| `[Error]` | HERTZ/连接错误/工具失败 | 失败归因 |

**可提取指标与限制**：

| 指标 | 提取方式及边界 |
|---|---|
| Token | cost 的 in/out/cacheRead 去重聚合，声明 in 是否含缓存；processResult 重复 usage 不再次相加 |
| 成本 | 原始 $0/currency 保留，占位或真零待验证；未知实际成本 null，不换算 Credits |
| 请求处理时长 | 同 request_id 的 receive/finish 为 application_request 时长；到 cost 的差只是处理阶段，不是 TTFT/任务 E2E |
| TTFT / 生成吞吐 | 缺模型请求、首 chunk/生成结束边界，not-captured；cost 写入不代表首 token |
| 消费记录/调用 | 去重 cost 记录数另列；证实一条 cost 对应一次独立调用才映射 attempt，多个 cost 不自动视为重试 |
| 工具/审查 | perm → permission.decision，review → 审查，均不等于 tool.call/result；执行需调用 ID 与实际边界 |
| 人工确认 | 审批请求、用户决定和 human actor 证据；by 非通配符/allow/approvalID 单独不足以证明人工参与 |
| 压缩 | pruned > 0 且上下文语义证实才计原生压缩，不计 Step |
| 模型/Provider | resolveModel 是配置/请求模型；未证实响应实际模型不写 routed_model |
| 诊断 | 明确阶段/状态/错误优先，审批拒绝归 permission_denied；HERTZ/HTTP 4xx 本身不定位网关/模型错误 |

> request_id 是应用请求范围；cost/perm/review 不能合成伪造 llm.request/response，也不能直接推出工具成功、真实重试或人工确认。新增发现保留，指标满足 SPEC.md §8 条件后才可用。

### 主数据库：`teleagent.db`（SQLite，辅助数据源）

**表结构**（比 Mobilework opencode.db 简化）：
| 表 | 列 | 与 Mobilework 差异 |
|---|---|---|
| session | id, project_id, parent_id, slug, directory, title, version, share_url, time_created, time_updated, time_compacting, time_archived, workspace_id | **缺少**：model、agent、cost、tokens_*、metadata |
| message | id, session_id, time_created, time_updated, data | 相同 |
| part | id, message_id, session_id, time_created, time_updated, data | 相同 |
| project | id, worktree, vcs, name, ... | 相同 |
| todo | session_id, content, status, priority, position | 相同 |

> teleagent.db 提供会话列表和消息存储，但 **Token/模型/成本数据不在数据库中，而在 super-agent-server 日志中**。数据库用于会话发现和最小元数据关联，日志用于指标提取；API 不回传消息正文。

### 其他数据源

| 路径 | 格式 | 内容 | 可提取指标 |
|---|---|---|---|
| `log/im-service-*.log` | log | IM 服务日志 | IM 通信事件 |
| `logs/main-2.3.1.log` | log | Electron 主进程日志 | 应用错误 |
| `js-log/js-2.3.1.log` | log | JS 日志 | JS 运行时错误 |
| `im-service/im-service.db` | SQLite | IM 服务数据库 | IM 数据 |
| `scheduler/scheduler.db` | SQLite | 调度器数据库 | 调度任务 |
| `scheduler/scheduler-daemon-state.json` | JSON | 调度器状态 | 调度状态 |
| `.config/TeleAgent/TeleAgent.jsonc` | JSONC | Provider 配置：模型名、context/output limit | **配置上下文上限**，不是实际输入峰值 |
| `.config/TeleAgent/skills/.tool-usage-log.json` | JSON | 按会话统计工具调用次数 | 工具调用汇总（与日志交叉校验） |
| `.config/TeleAgent/skills/.usage.json` | JSON | Skill 使用统计 | Skill 使用频率 |
| `skills-metadata.json` | JSON | Skills 元数据 | Skills 清单 |
| `session-status.json` | JSON | 会话状态 | 当前会话状态 |
| `.cache/TeleAgent/models.json` | JSON (5.8MB) | 模型定义缓存 | 模型清单 |
