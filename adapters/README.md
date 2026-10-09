# Adapter 开发指南

每个 Agent 对应一个适配器文件，实现 `BaseAdapter` 接口。

## 接口要求

- `discover(config)` — 返回实例别名、sources、versions、modes、health
- `capabilities(context)` — 返回 source × field × scope × time-window
- `extractSessions(options)` — 返回 { items, nextCursor, asOf, coverage }
- `extractTurns(sessionId, options)` — 轮次及 unbound client_run_summary
- `extractEvents(sessionId, options)` — 去重事件及来源
- `extractCalls(sessionId, options)` — model attempts / actual ToolCall
- `extractUsage(sessionId, options)` — 唯一消费记录 + semantics
- `extractFailures(sessionId, options)` — 带证据诊断
- `extractMetrics(sessionId, options)` — 仅委托共享指标引擎
- `subscribe(options)` — local-live only; AbortSignal/覆盖/游标
- `close()` — 停订阅、刷新已脱敏缓存

## 设计约束

- 提取事实/语义，不另写对象专属同名公式
- 原生 IDs 精确关联优先，多候选时间匹配只留 estimated
- 只读 SQLite（`-readonly`），不执行 checkpoint/迁移
- 所有输出经过 `lib/redactor.mjs` 脱敏
