# Doubao（豆包 Work）数据源明细

> 本文件从 [SPEC.md](../../SPEC.md) §2.5 拆分，自包含 Doubao（豆包 Work）的数据源探测明细：安装目录、数据目录、数据源表、事件格式、字段语义、指标可用性与限制。  
> 所属项目：Agent Log Observatory · 能力归属：`Observation & Evidence Layer` · 状态：`draft`  
> 跨 Agent 指标覆盖矩阵见 [SPEC.md §3](../../SPEC.md#3-指标覆盖矩阵)。

---

**安装目录**：`<DOUBAO_INSTALL_ROOT>/`
- 非 Electron，基于 Chromium 内核自定义（Lark/飞书架构）
- `app/Doubao.dll`（318MB）、`app/liblark.dll`（162MB）
- `app/mcp_helper.dll`：MCP 支持
- `app/agent_infra.dll`：Agent 基础设施
- `app/task-mode-resource/`：任务模式资源

**数据目录**：

| 目录 | 路径 | 内容 |
|---|---|---|
| **LLM Agent 轨迹** | `%LOCALAPPDATA%/Doubao\User Data\Default\.doubao\agent_mode\workspace\.sessions\` | **核心**：LLM 对话轨迹 trajectory.jsonl |
| RPA 开发 | `%LOCALAPPDATA%/Doubao\rpa-dev\` | RPA 运行时和 trace（DOM 自动化层） |
| 对话 | `%USERPROFILE%/Doubao\chats\` | 按日期组织的对话产出 |
| Skills | `%USERPROFILE%/Doubao\skills\` + `.doubao/agent_mode/workspace/.skills/` | 用户自定义 Skills |
| 配置 | `%APPDATA%/Doubao\` | 公共配置 |

### LLM Agent 轨迹（核心数据源）

**路径模式**：`.doubao/agent_mode/workspace/.sessions/<session_id>/agents/<agent_id>/system/trajectory.jsonl`

NDJSON 格式，每行一条消息，类似 OpenAI Chat Completions 消息结构。当前发现 7 个会话，最大文件 180KB。

| role | 含义 | 关键字段 | 映射 |
|---|---|---|---|
| `user` | 用户输入 | `content` | **agent.input** |
| `assistant` | LLM 响应 | `content`（文本）、`tool_calls[]`（工具调用数组） | **llm.response** + **tool.call** |
| `tool` | 工具执行结果 | `content`（输出）、`tool_call_id`（关联 ID） | **tool.result** |

**assistant.tool_calls 结构**：
```json
{
  "id": "dd33457e-f409-493e-8475-d72b9fb9734b",
  "type": "function",
  "function": {
    "name": "PowerShell",
    "arguments": { "command": "...", "description": "..." }
  }
}
```

**可提取指标**：

| 指标 | 提取方式 |
|---|---|
| **助手消息数** | role=assistant 去重计数，无调用 ID 不替代 LLM 调用数 |
| **工具调用次数** | `role=assistant` 中所有 `tool_calls` 数组的元素总数 |
| **工具成功率** | 明确结构化终态/exit_code 且唯一 call 关联；正文不含 error 不是成功证据 |
| **Event: agent.input** | `role=user` 行数 |
| **Event: llm.response** | `role=assistant` 行数 |
| **Event: tool.call** | `role=assistant` 中 `tool_calls` 总数 |
| **Event: tool.result** | `role=tool` 行数 |
| **Step 总数** | 无原生循环边界则 null；assistant→tool 仅为消息模式，RPA business_step 独立 |
| **人工确认次数** | 显式审批/用户决定证据；普通 user 回复不推断，默认 not-captured |
| **工具名称列表** | `tool_calls[].function.name` 去重（如 PowerShell、Grep、Read、Write、TaskOutput） |
| **E2E 时延** | 无原生时间戳则 null；RPA runner 时长按 rpa_run 另列，不冒充 LLM/轮次 E2E |

**限制**：
- trajectory.jsonl **无显式时间戳**（无 ts/unix_ms 字段），无法直接计算 TTFT 或步骤间延迟。
- **无 Token 数据**（无 input/output token 计数）。
- **无模型名**（不记录实际调用的 LLM 模型）。
- mtime 只用于发现/游标，不提供历史发生时间；双层关联后 RPA 时间仍属 rpa_run，未经边界证明不转借给 LLM。

### 会话级附加文件

每个会话目录 `.sessions/<session_id>/` 下还包含：

| 路径 | 格式 | 内容 |
|---|---|---|
| `board.md` | md | 任务看板/计划 |
| `agents/<agent_id>/system/trajectory.jsonl` | NDJSON | **LLM 轨迹（上文）** |
| `agents/<agent_id>/rpa-projects/<project>/` | dir | RPA 项目代码 |
| `agents/<agent_id>/rpa-projects/<project>/.rpa-dev/traces/` | dir | RPA 本地 trace（JSON + HTML） |
| `agents/<agent_id>/rpa-projects/<project>/.rpa-dev/intake/` | dir | 需求/合约/语义审查 JSON |
| `attachments/` | dir | 附件 |
| `memory/` | dir | 会话记忆 |

### RPA 运行器 Trace（DOM 自动化层）

**路径**：`rpa-dev/local-preview/production-traces/run-<timestamp>/`

| 路径 | 格式 | 内容 | 可提取指标 |
|---|---|---|---|
| `runner-events.ndjson` | NDJSON | 运行器事件：ts、unix_ms、event、pid、method、duration_ms、exit_code、business_step | 步骤数、步骤延迟、成功/失败、E2E 时延 |
| `trace.json` | JSON | DOM 快照（页面元素、rect、classes） | DOM 状态 |
| `trace.html` | HTML | 可视化 trace | 人工查看 |
| `screenshots/` | PNG | 步骤截图 | 视觉证据 |

**runner-events 事件类型**：
- `runner_started`（含 from_step）、`runner_completed`（含 duration_ms、steps）
- `child_command_started`（含 method、business_step）、`child_command_finished`（含 duration_ms、exit_code）

**method 类型**：snapshot、navigate、fill、press、click、evaluate、wait-for-selector、wait-for-url、trace-evidence

### Bridge 日志

| 路径 | 格式 | 内容 | 可提取指标 |
|---|---|---|---|
| `rpa-dev/local-preview/bridge.log` | NDJSON (2.7MB) | Bridge 通信日志：bridge_version、component、event、pid、ts、unix_ms、method、elapsed_ms、ok、workspace_id、execution_ms、queue_depth | Bridge 调用次数、延迟、成功率、队列深度 |

### 其他数据源

| 路径 | 格式 | 内容 |
|---|---|---|
| `User Data/Default/agent_infra/` | dir | Agent 基础设施数据 |
| `User Data/Default/Local Storage/` | LevelDB | 本地存储 |
| `User Data/Default/IndexedDB/` | IndexedDB | 索引数据库 |
| `User Data/sdk_storage/log/` | dir | SDK 日志 |
| `app/debug.log` | log (306KB) | 应用调试日志 |
| `chats/YYYY-MM-DD/new-chat-N/` | dir | 对话工作区（含产出文件） |
| `skills/*/SKILL.md` | md | Skill 定义 |

**整体限制**：
- LLM trajectory 有工具调用结构但无 Token、无模型名、无时间戳。
- RPA trace 有精确时间戳和延迟但属于 DOM 操作层，非 LLM 推理层。
- 两层轨迹需通过 session_id + agent_id 交叉关联才能还原完整链路。
- 无 SQLite 数据库统一存储。
