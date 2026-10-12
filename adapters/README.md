# Adapter Development Guide

Each agent has one adapter file implementing the `BaseAdapter` interface.

## Interface Requirements

- `discover(config)` — instance alias, sources, versions, modes, health
- `capabilities(context)` — source × field × scope × time-window
- `extractSessions(options)` — { items, nextCursor, asOf, coverage }
- `extractTurns(sessionId, options)` — turns and unbound client_run_summary
- `extractEvents(sessionId, options)` — deduplicated events with sources
- `extractCalls(sessionId, options)` — model attempts / actual ToolCall
- `extractUsage(sessionId, options)` — unique consumption records + semantics
- `extractFailures(sessionId, options)` — evidence-backed diagnostics
- `extractMetrics(sessionId, options)` — delegates to the shared metrics engine only
- `subscribe(options)` — local-live only; AbortSignal/override/cursor
- `close()` — stop subscriptions, flush sanitized cache

## Design Constraints

- Extract facts/semantics; never reimplement agent-specific metric formulas
- Prefer exact native ID correlation; multi-candidate time matching yields `estimated` grade only
- SQLite access is read-only (`-readonly`); never checkpoint or migrate
- All output passes through `lib/redactor.mjs` sanitization
