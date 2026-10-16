# Changelog

All notable changes to this project are documented in this file.

## v0.0.13 — opencode storage token semantics (2026-10-15)

- Mobilework（内嵌 opencode 引擎）与独立 opencode 的存储级 token 包含关系已从 opencode 源码实证（`packages/opencode/src/session/session.ts` getUsage）：`tokens_input` 不含 cache read/write、`tokens_output` 不含 reasoning、cache 分项为独立加性桶、totalTokens 不落库。
- 新增 `lib/opencode-storage-semantics.mjs` 统一标注口径；Mobilework session 表与 opencode 消息级/session 回退三条提取路径全部接入，归一总量 = input + output + cache_read + cache_write + reasoning（`normalized_total_false_false_exclusive`）。
- 未接入前采集的 unknown 口径保持 null 不回填；历史 Trial 需重新采样才会带新口径。回归测试覆盖"未证明口径仍拒绝归一"与"证明口径不可被调用方覆盖"。

## v0.0.12 — Reliable historical capture and token semantics (2026-10-14)

- Preserve explicit Session ownership for call usage, validate archived WorkBuddy identity from native transcripts, and query Mobilework/TeleAgent by exact Session ID.
- Read-only, loopback session-evidence helper for explicit historical recovery; no cache sync, collector installation or client/model requests.
- Console integration and private seven-day recovery results are recorded in docs/reliability-review-2026-10-14.html. Missing values and unknown Total semantics remain null; old Trials and scores are immutable.

## v0.0.11 — Chart data and observation consistency (2026-10-14)

- Live bounded-window export snapshots, per-section failure receipts, chart-data GET endpoint and UI download; selected exports share the same path.
- Five chart families with distinct activity proxies and external-outcome cohorts, exact-k explicit task/trial binding, tester/installation namespaces and input SHA-256 receipts. Offline preparation preserves input files and refuses output overwrite.
- Mobilework scalar SQLite projection, stream-kind/sequence pairing, retry-event isolation and missing logical-call semantics; TeleAgent native tool name/call ID/state/timing and step-finish requirement.
- Unique/raw/duplicate record counts, conflict-aware known-terminal rates, unresolved/cancelled coverage, separate LLM/tool rates and metric-cache snapshot replacement. Cache comparison preserves metric metadata, pools known denominators and rejects mixed units/semantics.
- Unknown cache semantics stay null; process-wide Mobilework diagnostics stay installation-scoped; WorkBuddy trace duration requires session binding. No additional dependency or client configuration write.
- Regression, real local read-only sample checks and chart-data contract: docs/chart-data.html. Historical missing telemetry and business outcomes are not backfilled by inference.

## v0.0.10 — Doubao observation follow-up (2026-10-13)

- Doubao adapter/collector 0.3.0: unique tool/result pairing, unknown terminal coverage, source freshness and explicit session binding; assistant messages no longer substitute for logical LLM calls.
- Protocol-probed incremental SSE and independent WS observation, metadata-only event schema and health diagnostics. Client headers/first-text/reply timing is separate from internal TTFT; usage/retry remain missing.
- Shared metrics-0.3.0 formulas, installation-scoped RPA/Bridge API, UI evidence/coverage cards, synthetic fixtures, research and deployment contract. No additional dependencies.

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

## 0.0.12 — 2026-10-14

- Validate token inclusion semantics in the shared accounting engine, preserve true zeros and partial component coverage; uncertain totals remain null.
- Reject malformed/failed SQLite reads, with a lossless Node built-in read-only fallback for CLI encoding faults.
- Preserve unknown/cancelled Codex and DSH terminals; separate LLM/tool rate identities and remove cumulative-token peak-context fallback.
- Exclude completion-span end and unbound proxy response arrival from first-token timing; reject invalid clocks.
- Console integration review: sealed full-identity saved samples, whole sampling versions, semantic/coverage reporting and exactly-five scored Trial cohorts. See docs/reliability-review-2026-10-14.html.
- Close underscore-key allowlist bypass; consistently filter call/metric/failure/excerpt APIs and omit raw diagnostic/conversation bodies.
