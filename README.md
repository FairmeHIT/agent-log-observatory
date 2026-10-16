> 2026-10-14：WorkBuddy 调用 usage 保留显式 session_id；客户端清理 sessions 索引后，历史身份凭 transcript 原生 sessionId 核验。Mobilework/TeleAgent 支持精确会话查询，Console 补采与分项统计见 [可靠性复核增量](docs/reliability-review-2026-10-14.html#capture-backfill).

> 2026-10-14 v0.0.12：采集可信度、Console 保存与总览统计复核见 [可靠性复核回执](docs/reliability-review-2026-10-14.html)。旧历史不改写；口径未知的 Token 总量、未准入记录及不可核验快照排除出统计。

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

## Chart data and export consistency

Version 0.0.11 adds a chart-data download and `GET /api/chart-data`. Full and selected exports include the same five chart families, source/denominator/coverage evidence and live read-window receipts. Independent outcomes and explicit task/trial bindings are required for success and Pass@5/Pass^5; activity is reported separately.

Prepare older exports offline with `node scripts/prepare-chart-data.mjs --input tester-1=export.json --output chart-data.json`. See the [chart-data contract and gap analysis](docs/chart-data.html) for multi-tester identity, cohort bindings, token semantics and validation limits. No new dependencies.

## Metric Coverage

Updated **2026-10-14: project v0.0.12, Doubao adapter/collector 0.3.0**. Coverage reflects implemented extraction paths, not verification of every client version or session.

✅ Implemented read/derived calculation path when source fields exist · ⚠️ Conditional, partial, estimated or requires an optional collector · ❌ Missing or no usable extraction path. Actual `value`, `state`, `evidence_grade`, `coverage` and `missing_reason` determine availability; missing data stays null.

### Latency

| Metric | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `turn_e2e_ms` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ |
| `llm_attempt_ttft_ms` | ❌ | ⚠️ | ❌ | ❌ | ✅ | ⚠️ | ⚠️ |
| `session_first_response_ms` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `session_lifespan_ms` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |

### Tokens & Cost

| Metric | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `token_input` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_output` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_cache_read` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `token_reasoning` | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `token_total` | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ |
| `cache_hit_rate` | ✅ | ⚠️ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `generation_output_tps` | ⚠️ | ⚠️ | ⚠️ | ❌ | ✅ | ❌ | ❌ |
| `max_context` | ✅ | ✅ | ✅ | ❌ | ✅ | ⚠️ | ✅ |
| `context_window` | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `credits` | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ⚠️ |

### Calls, Tools & Steps

| Metric | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `llm_call_count` | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| `success_rate` | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| `llm_retry_count` | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ⚠️ |
| `tool_call_count` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `llm_error_count` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `tool_error_count` | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| `step_count` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `human_confirm_count` | ❌ | ⚠️ | ✅ | ⚠️ | ❌ | ❌ | ⚠️ |
| `compaction_count` | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| `compaction_threshold` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

### Diagnostics & Events

| Metric | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | opencode |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `failures_gateway` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `failures_tool` | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ | ⚠️ |
| `failures_model` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `failures_dependency` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `failures_agent` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `dependency_error_count` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `agent_error_count` | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| `event_count_agent_input` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_llm_request` | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ |
| `event_count_llm_response` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_tool_call` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `event_count_tool_result` | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |

### Semantics & Conditions

- **TTFT:** WorkBuddy generation spans only establish completion, so TTFT is missing. Mobilework requires explicit session membership and a first-output anchor; unbound proxy response arrival is excluded; Codex derives time from turn start to first reasoning/agentMessage item; opencode requires optional plugin output timing. These anchors do not uniformly prove native first-token arrival. TeleAgent reasoning start is not a first-token anchor.
- **Tokens and cost:** Mobilework has reasoning fields; TeleAgent currently does not extract reasoning usage. Codex rollout input includes cache and output includes reasoning, so do not add those components twice; older sessions can have totals without breakdowns. `credits` means Credits for WorkBuddy and source-reported USD cost for Mobilework/TeleAgent/opencode; zero/missing cost may currently return null. Never sum different units.
- **First response, throughput and context:** First response is relative to session start and separate from attempt TTFT; opencode now implements it. Output TPS requires output tokens and generation/decode duration. `max_context` definitions differ; Codex cumulative totals are excluded from peak context.
- **Success, approvals and steps:** `success_rate` describes known call/tool outcomes; tool outcomes use a separate metric name. It is not business success or a uniform cross-agent measure. Mobilework/opencode infer approvals from ask rules and tools; Doubao requires explicit approval pairs. Step definitions depend on the source.
- **Diagnostics and return events:** `failures_*` primarily classify log patterns, not proven root causes. DSH diagnostic output is currently a placeholder and is marked unavailable. Mobilework/TeleAgent/DSH/Codex/opencode leave `event_count_tool_result` missing because calls alone do not prove independently observed returns; Doubao exposes both unique results and raw trajectory return rows.

### Doubao Added Metrics (0.3)

Default trajectory reads provide pairing and coverage metrics. Optional CDP observes existing user traffic without sending prompts; RPA/Bridge reads existing infrastructure logs.

| Metrics | Availability | Source / Meaning |
| --- | --- | --- |
| `assistant_message_count` / `agent_observed_count` | ✅ | Valid assistant rows and agents with readable trajectory. |
| `tool_call_count` / `tool_result_count` | ✅ | Unique calls and results paired by session + agent + call ID. |
| `tool_unresolved_count` / `tool_orphan_result_count` | ✅ | Calls without observed results; results without observed calls. |
| `tool_duplicate_call_count` / `tool_duplicate_result_count` / `tool_type_count` | ✅ | Duplicate-ID records and distinct tool names. |
| `tool_terminal_coverage` | ✅ | Known structured terminal states / unique calls; may be 0 even when results exist. |
| `tool_success_rate` / `tool_error_count` / `failures_tool` | ⚠️ | Explicit status/success/exit_code only; unknown terminal states keep rates/counts partial or null. |
| `source_parse_error_count` / `source_partial_line_count` / `source_freshness_ms` | ✅ | Malformed complete rows, incomplete tail rows and age since latest file write. |
| `client_request_count` / `client_headers_ms` / `client_first_text_ms` | ⚠️ CDP | Observed requests and mean request-to-headers / first parsed text latency (ms). |
| `client_stream_ms` / `client_reply_e2e_ms` | ⚠️ CDP | Mean request-to-HTTP-end / explicit SSE-reply-end (ms); not task E2E. |
| `stream_chunk_count` / `stream_max_pause_ms` | ⚠️ CDP | Text-update count and mean per-request maximum update pause (ms). |
| `stream_output_chars` / `stream_output_chars_per_second` | ⚠️ CDP | Mean output character count and character rate (chars/s); not tokens or tok/s. |
| `client_network_error_count` / `client_cancelled_count` / `collector_gap_count` | ⚠️ CDP | Observed network terminal errors, cancellations and requests with capture gaps. |
| `collector_bound_event_count` / `collector_unbound_event_count` | ⚠️ CDP | Session-bound event count; unbound events remain installation-scoped. |
| `human_request_count` / `human_confirm_count` / `human_wait_ms` | ⚠️ CDP | Explicit approval IDs and paired decisions; mean wait for matched timed pairs. |
| `task_completed_observed_count` | ⚠️ CDP | Explicit completed events only; not a business-success measure. |
| `rpa_run_count` / `rpa_run_ms` / `rpa_command_ms` | ⚠️ RPA | Observed runner_completed count, mean run/command duration (ms). |
| `bridge_latency_ms` / `bridge_execution_ms` / `bridge_queue_depth` | ⚠️ RPA | Mean bridge latency, execution time (ms) and observed queue depth. |

CDP requires a loopback debug port, supported streaming protocol, and explicit `trajectory_session_id` or a verified unique `conversationBindings` mapping. Buffered historical text has no original arrival time and cannot supply first-text latency. Reply completion does not prove task completion. Global RPA/Bridge data remains installation-scoped unless an explicit session ID or session-owned path establishes membership.

Doubao still lacks **token usage, cost, internal LLM TTFT, actual model routing, retry grouping, native steps and untimed trajectory turn E2E/session lifespan**. Logical calls are only partially available with explicit `llm_call_id`; assistant messages are counted separately. Validation on 2026-10-13 covered protocol fixtures, HTTP/UI tests and read-only local trajectories; actual CDP capture has not been validated.

See the [0.3 contract and session binding](docs/doubao-observation-v0.3.md), [validation receipt](docs/doubao-validation-2026-10-13.md), and [reference research](docs/doubao-observability-research.md).

## Quick Start

**Prerequisites:** Node.js 24.x (verified on 24.19.0), Windows x64.

```powershell
# 1. Install dependencies (offline from vendor/)
node scripts/setup.mjs

# 2. Start the dashboard
node server.mjs
```

Open `http://127.0.0.1:8780/` in your browser. Press `Ctrl+C` to stop.

Alternatively, double-click `start.cmd` to start the dashboard + Mobilework proxy + Doubao CDP collector in the background. Use `stop.cmd` to stop all project processes (never kills agent clients).

## Optional Collectors

Some metrics require optional collectors that augment agent logs with additional timing data:

| Collector | Metrics Added | Requires External Config |
|---|---|---|
| `opencode-collector-plugin` | TTFT, retry, human-confirm | Yes — explicit install into opencode config |
| `mobilework-llm-proxy` | Request/response-arrival timing (derived; not guaranteed native first-token arrival) | Forwards existing user traffic; new processes require correct proxy routing |
| `doubao-cdp-collector` | Client headers/first-text/reply timing, stream output, explicit tool/approval events | No — manually enable local CDP; session binding must be explicit |

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
npm test          # unit/integration tests, including Doubao observation fixtures
npm run release   # generate standalone release directory
```

API endpoints: `GET /api/health` · `GET /api/sessions` · `GET /api/metrics/compare`

`GET /api/sessions/:agent/default/:session/metrics?fresh=1` explicitly samples through the read-only adapter instead of using the dashboard cache. The response records `source: "live"` and `fresh: true`; this does not sync the database, install collectors, or prove complete capture. Omit `fresh` (or use `0`) to retain the existing cache-first behavior. Values other than `0`/`1` return 400. Implementation: `lib/session-metrics-read.mjs`; regression: `tests/test-session-metrics-read.mjs`. This supports independent evaluation archives without making this project depend on an evaluation console.

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
