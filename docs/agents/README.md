# Agent Data Source Index

> Per-agent data source discovery details, split from [SPEC.md](../../SPEC.md) §2.
> Each file is self-contained: install dirs, data dirs, source tables, event formats, field semantics, metric availability, and limitations.
> Project: Agent Log Observatory · Layer: `Observation & Evidence Layer` · Status: `draft`

| Agent | Details | Primary Data Sources | Richness |
|---|---|---|---|
| WorkBuddy | [workbuddy-agent.md](workbuddy-agent.md) | .jsonl transcript (rawUsage) + trace JSON + multi-layer logs | High (missing TTFT/retry/human-confirm) |
| Mobilework | [mobilework-agent.md](mobilework-agent.md) | SQLite (opencode.db) + runs.jsonl + model-raw + stream-timings | High |
| TeleAgent | [teleagent-agent.md](teleagent-agent.md) | super-agent-server Go logs (`[cost]`/`[perm]`/`[tool_instruction_review]`) + SQLite | Med-high |
| Doubao | [doubao-agent.md](doubao-agent.md) | LLM trajectory.jsonl + RPA runner-events + bridge.log dual layer | Medium (missing tokens/timestamps/credits) |
| DSH | [dsh-agent.md](dsh-agent.md) | session JSONL.zstd (multi-frame zstd) + projection cache (sessionStats/tokenUsage) | High (native TTFT) |
| Codex | [codex-agent.md](codex-agent.md) | SQLite (state_5 + thread_history + logs_2) + config.toml | High (native Turn E2E + compaction threshold + context window) |

> Cross-agent metric coverage matrix: [SPEC.md §3](../../SPEC.md#3-指标覆盖矩阵).
