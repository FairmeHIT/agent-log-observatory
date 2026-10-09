# Agent 数据源明细索引

> 本目录存放各 Agent 对象的数据源探测明细，从 [SPEC.md](../../SPEC.md) §2 拆分而来。
> 每个文件自包含对应 Agent 的安装目录、数据目录、数据源表、事件格式、字段语义、指标可用性和限制。
> 所属项目：Agent Log Observatory · 能力归属：`Observation & Evidence Layer` · 状态：`draft`

| Agent | 详情文件 | 核心数据源 | 数据丰富度 |
|---|---|---|---|
| WorkBuddy | [workbuddy-agent.md](workbuddy-agent.md) | .jsonl transcript（rawUsage）+ trace JSON + 多层日志 | 高（缺 TTFT/重试/人工确认） |
| Mobilework | [mobilework-agent.md](mobilework-agent.md) | SQLite (opencode.db) + runs.jsonl + model-raw + stream-timings | 高 |
| TeleAgent | [teleagent-agent.md](teleagent-agent.md) | super-agent-server Go 日志（`[cost]`/`[perm]`/`[tool_instruction_review]`）+ SQLite | 中-高 |
| Doubao | [doubao-agent.md](doubao-agent.md) | LLM trajectory.jsonl + RPA runner-events + bridge.log 双层 | 中（缺 Token/时间戳/Credits） |
| DSH | [dsh-agent.md](dsh-agent.md) | session JSONL.zstd（多帧 zstd）+ projection cache（sessionStats/tokenUsage） | 高（原生 TTFT） |
| Codex | [codex-agent.md](codex-agent.md) | SQLite（state_5 + thread_history + logs_2）+ config.toml | 高（原生 Turn E2E + compaction threshold + context window） |

> 各 Agent 的跨对象指标覆盖矩阵见 [SPEC.md §3](../../SPEC.md#3-指标覆盖矩阵)。
