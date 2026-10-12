# Agent Log Observatory

A local-first observability dashboard for cross-agent LLM logging. It reads read-only logs from 7 AI coding agents, normalizes them into a unified metric schema, and presents per-session detail, cross-agent comparison, and failure attribution — without installing hooks or modifying agent clients.

[中文文档](README.zh-CN.md) | **English**

## Supported Agents

| Agent | Data Source | Platform |
|---|---|---|
| WorkBuddy | `~/.workbuddy/` transcript JSONL + trace spans | Windows |
| Mobilework | `~/.mobilework/` SQLite (runs, model-raw, parts) | Windows |
| TeleAgent | `~/.local/share/TeleAgent/` SQLite + Go logs | Windows |
| Doubao | `${LOCALAPPDATA}/Doubao/` trajectory JSONL | Windows |
| DSH | `~/.dsh/` event JSONL + zstd frames | Windows |
| Codex | `~/.codex/` SQLite + `sessions/**/rollout-*.jsonl` | Windows |
| opencode | `~/.local/share/opencode/` SQLite (session/message/part) | Cross-platform |

Agents not installed are shown as unavailable — no error. Missing metrics return `null` with `state: "not-captured"`, never disguised as `0`.

## Metric Coverage

✅ captured · ❌ not captured (source lacks the data) · — N/A

### Latency

| Metric | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `turn_e2e_ms` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `llm_attempt_ttft_ms` (TTFT) | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `session_first_response_ms` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| `session_lifespan_ms` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Tokens

| Metric | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `token_input` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_output` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_cache_read` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_reasoning` | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `token_total` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `cache_hit_rate` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `max_context` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `context_window` | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `credits` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### LLM Calls & Errors

| Metric | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `llm_call_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `success_rate` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `llm_retry_count` | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| `llm_error_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `failures_model` (pattern-level) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Tools & Steps

| Metric | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `tool_call_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tool_error_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `failures_tool` (pattern-level) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `step_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `human_confirm_count` | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| `compaction_count` | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |

### Errors & Events

| Metric | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `dependency_error_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `agent_error_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_agent_input` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_llm_response` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Quick Start

**Prerequisites:** Node.js 24.x (verified on 24.19.0), Windows x64.

```powershell
# 1. Install dependencies (offline from vendor/)
node scripts/setup.mjs

# 2. Start the dashboard
node server.mjs
```

Open `http://127.0.0.1:8780/` in your browser. Press `Ctrl+C` to stop.

Alternatively, double-click `启动.cmd` to start the dashboard + Mobilework proxy + Doubao CDP collector in the background. Use `停止.cmd` to stop all project processes (never kills agent clients).

## Optional Collectors

Some metrics require optional collectors that augment agent logs with additional timing data:

| Collector | Metrics Added | Requires External Config |
|---|---|---|
| `opencode-collector-plugin` | TTFT, retry, human-confirm | Yes — explicit install into opencode config |
| `mobilework-llm-proxy` | TTFT (via HTTP proxy) | No — uses `HTTP_PROXY` env on new processes |
| `doubao-cdp-collector` | TTFT, retry, context_window | No — client must start with `--remote-debugging-port` |

See [deployment guide](docs/deployment.md) for full instructions.

## Configuration

- `agent-log-observatory.config.json` — local agent paths (gitignored). Supports `~/`, `${LOCALAPPDATA}`, relative paths.
- `agent-log-observatory.config.example.json` — committable template with default user data paths.
- `runtime/` — cache DB, collector data, logs (gitignored, except `sqlite3.exe`).
- `vendor/` — locked dependencies, licenses, SHA-256 manifests. **Must ship with releases.**

Agent clients, accounts, model services, and their raw logs are external inputs — never copied, modified, or packaged.

## Verification

```powershell
npm run doctor    # environment + native module + data source check
npm test          # 102 unit/integration tests
npm run release   # generate standalone release directory
```

API endpoints: `GET /api/health` · `GET /api/sessions` · `GET /api/metrics/compare`

## Architecture

```
adapters/          # 7 agent adapters (discover, extractSessions, extractMetrics, ...)
lib/               # shared: metrics engine, evidence model, SQLite query, normalizer
collectors/        # optional collectors (opencode plugin, mobilework proxy, doubao CDP)
server.mjs         # HTTP server + sync loop + API routes
index.html         # single-page dashboard (sessions, detail, comparison)
runtime/           # observatory.db, collector JSONL, logs (gitignored)
```

Agent-specific logic lives in `adapters/`. The shared metrics engine in `lib/metrics.mjs` computes all derived metrics — adapters never reimplement formulas.

## License

[Apache License 2.0](LICENSE) · Copyright 2026 [FairmeHIT](https://github.com/FairmeHIT)
