# Changelog

All notable changes to this project are documented in this file.

## v0.0.10 — 2026-10-12

### Added

- 5 new per-session metrics with unified cross-agent coverage:
  - `session_first_response_ms` (estimated): wall-clock time from session start to first LLM response start. WorkBuddy uses the `reasoning` line timestamp (model starts generating), not the completed message timestamp. Doubao trajectory has no timestamps → not-captured. opencode uses first assistant message `time_created` − session `time_created`.
  - `llm_error_count` (direct, call-level): count of LLM calls with `status=error`.
  - `tool_error_count` (direct, call-level): count of tool calls with `status=error`.
  - `dependency_error_count` (direct, pattern-level): dependency errors (sidecar/daemon/IPC/ENOENT/DB).
  - `agent_error_count` (direct, pattern-level): agent errors (cancelled/streaming/internal exception).
- `makeErrorCountMetrics()` shared helper in `lib/metrics.mjs`: returns 9 metrics (4 call-level error counts + 5 pattern-level `failures_*`), eliminating duplicate `extractFailures` call in sync loop.
- WorkBuddy conversation excerpt panel: first user message + last assistant response, read live from transcript (not stored in DB), with `stripInjectedContext()` removing `<system-reminder>`, `<identity_context>`, `<project_context>` etc.
- `session_first_response_ms` added to opencode adapter.
- Doubao CDP collector v0.2.0: `context_window`, `reasoning_effort`, `tool_calls` fields.
- UI: error count cards in session detail, error count columns in comparison table.
- README rewritten: English default + Chinese version, with agent table and metric coverage matrix (✅/❌).

### Changed

- WorkBuddy `_getFirstAssistantTimestamp()`: now prefers `reasoning` line timestamp (response start) over `message, role=assistant` timestamp (response end), aligning with other 5 adapters.
- `hasNotCapturedRefreshable()`: now also triggers re-extraction when refreshable metrics are entirely missing from the DB (not just when `not-captured`), ensuring new metrics backfill existing sessions.
- Sync loop no longer calls `extractFailures` separately — `extractMetrics` handles it internally via `makeErrorCountMetrics()`.

### Fixed

- `lib/sqlite-query.mjs` `columnsFromSelect`: parenthesis-aware comma splitting to handle `json_extract()` arguments without column name misalignment.
- WorkBuddy `extractSessions` uses `_wbDataDir()` instead of `resolveAgentConfig()` for runtime env var override in tests.

### Acceptance

- `npm test` 102/102 pass.
- `npm run doctor` pass.
- After sync, all 7 agents have `llm_error_count`, `tool_error_count`, `dependency_error_count`, `agent_error_count` captured.

## v0.0.9 — 2026-10-04

### Added

- Independent deployment boundary: all self-developed tools/collectors stay in-project; archived npm packages, MIT licenses, original collector snapshots, SQLite version/hash, offline setup + doctor.
- All collection/diagnostic/lock/temp files converge to `runtime/`; legacy collector history imported copy-only; local proxy routes privatized; universal config covers 7 agents, no longer defaults to user-directory Observatory config.
- Rewritten Windows start/stop entry points: paths/ports from local config, hidden background helper, stops only project-registered PIDs after path verification, never kills by port/Node name, never kills agent clients.
- Merged start/stop scripts: `start.cmd` one-click start Dashboard + Mobilework proxy + Doubao CDP collector (auto-skip if CDP port 9223 not open, collector failure not treated as overall failure); `stop.cmd` one-click stop all project-registered services. Removed 4 duplicate start/stop scripts; `start-mobilework.cmd` (formerly `start-mobilework-with-collector.cmd`) still launches client with `HTTP_PROXY`.
- Release whitelist, portability test, Env Check fix hints synced with README/deployment/collector-design/SPEC docs.
- README/AGENTS simplified; new step-by-step deployment/install/rollback and dependency-boundary docs; whitelist release tool; clarified Node 24.x, Windows x64, HTTP proxy and plugin version constraints.
- Normal Doubao collection diagnostics no longer persist response body excerpts. Optional installer preserves unrelated config fields; tests cover backup, uninstall, and conflict rejection.

### Acceptance

- `npm test` 99/99; doctor 6-item archive SHA-256 and in-memory SQLite native query pass.
- `start.cmd`/`stop.cmd` full start/stop loop tested (3 services, port/registration/health endpoint, CDP port skip branch). Real client reinstall/cross-machine testing not covered by automated tests.

## v0.0.1 — 2026-09-29

### Added

- Project scaffolding: `lib/` (config, time, redactor, evidence, normalizer, correlator, metrics, aggregator, log-parser), `adapters/` (base + workbuddy/mobilework/teleagent/doubao), `schemas/` (normalized-event, metric-result), `tests/`.
- 4 agent adapters implementing discover/extractSessions/extractEvents/extractUsage, with field mappings per SPEC-verified data source paths.
- WorkBuddy adapter reads `.jsonl` transcript, parses `providerData.rawUsage` (prompt_tokens/completion_tokens/cache_hit/credit/model).
- Mobilework adapter uses portable sqlite3 read-only queries on opencode.db session/event tables.
- TeleAgent adapter parses super-agent-server log `[cost]`/`[perm]`/`[tool_instruction_review]`/`[prune]`/`resolveModel` lines.
- Doubao adapter reads `trajectory.jsonl` role=user/assistant/tool and tool_calls structure.
- `server.mjs` providing REST API and single-page HTML dashboard.
- All outbound data passes through redactor whitelist filter.

### Acceptance

- `node server.mjs` starts, `http://127.0.0.1:8780/api/health` returns 4 agent discovery results.
