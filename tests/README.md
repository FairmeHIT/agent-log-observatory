# Tests

Run `npm test` from the project root (Node 24.x).

- normalizer/redaction/adapters/collector-reader: 83 metric, contract, and sanitization tests.
- portability: 12 tests covering JSONC, Unicode/spaces/relative paths, local config errors, simulated client plugin/proxy install rollback, conflict rejection, in-project collection output, offline dependencies, and start/stop boundary checks.

New portability tests write only to gitignored `runtime/portability-tests/` and never modify real agent configs. Failure diagnostics are preserved; user paths are never recursively deleted.

Full deployment verification: after `npm run release`, run `node scripts/setup.mjs` and `npm test` in the export directory. This does not substitute for real cross-version/cross-machine agent collection compatibility testing.
