# Tests

Run `npm test` from the project root (Node 24.x).

- normalizer/redaction/adapters/collector-reader: 83 metric, contract, and sanitization tests.
- portability: 12 tests covering JSONC, Unicode/spaces/relative paths, local config errors, simulated client plugin/proxy install rollback, conflict rejection, in-project collection output, offline dependencies, and start/stop boundary checks.
- Doubao observation: synthetic multi-agent trajectories and protocol tests cover complete tool arrays, call/result identity, duplicate/orphan/unresolved returns, explicit terminals, malformed/tail records, session binding conflicts, SSE fragmentation/snapshots/buffer races, disconnects, late WS notifications, approvals, schema/redaction, and RPA scope. No real prompts or client configuration writes.

New portability tests write only to gitignored `runtime/portability-tests/` and never modify real agent configs. Failure diagnostics are preserved; user paths are never recursively deleted.

Full deployment verification: after `npm run release`, run `node scripts/setup.mjs` and `npm test` in the export directory. This does not substitute for real cross-version/cross-machine agent collection compatibility testing.

- Chart data: test-chart-data.mjs covers source namespaces, whole-snapshot deduplication, exact-k outcomes, token scope/inclusion rules, interleaved Mobilework stream pairing, TeleAgent SQLite projections, terminal conflicts, live-read errors and weighted comparison. test-doubao-api.mjs additionally checks GET/POST full/selected export and chart-data HTTP output.
