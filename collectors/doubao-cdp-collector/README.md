# Doubao CDP Collector 0.3.0

Optional Node.js 24.x observer using built-in HTTP/WebSocket. No extra packages or client plugins. Enable the client's loopback CDP manually; the collector observes existing traffic and never sends prompts or changes the DOM.

Output: project `runtime/collectors/doubao/events-YYYYMMDD.jsonl` and `health.json`; exclusive lock: `runtime/doubao-cdp-collector.lock`. Records contain allowlisted identifiers, statuses, character counts and observation times; no request/response bodies, tool arguments or credentials. Old attempts are preserved but do not supply internal TTFT/retry.

Streaming uses protocol-probed `Network.streamResourceContent` and `Network.dataReceived.data`. Buffered historical text has no invented arrival time. Client headers/first-text/reply timing is separate from internal LLM TTFT; usage remains missing. Session binding requires an explicit trajectory ID or verified unique mapping.

[Install, verify and rollback](../../docs/deployment.md#4-doubao-cdp无额外插件) · [Metrics, schema, limits and validation](../../docs/doubao-observation-v0.3.md).
