# Doubao CDP Collector

Implementation lives in this directory; no extra npm packages or user-directory plugin copies required. Uses Node.js 24.x; requires the client to be started with loopback-only CDP enabled.

Install, usage, collection file verification, and rollback: see project `docs/deployment.md` §4.

Default output: `runtime/collectors/doubao/attempts-YYYYMMDD.jsonl`; locks/diagnostics also under project `runtime/`. Without a first-chunk event, TTFT falls back to derived response time; missing usage/model fields are never inferred.
