# 一键导出观测数据 — 设计文档

> 设计日期：2026-10-09  
> 状态：已批准

## 1. 目标

开发人员手动向各 Agent 发送评测任务后，通过本工具统计日志信息，需要一键导出全部观测数据（含每 Agent 每 Session 的详细日志内容），以便后续统一汇总分析。

## 2. 导出格式

单个 JSON 文件，结构化嵌套，适合 Python/JS 脚本解析。

文件名：`observatory-export-YYYYMMDD-HHmmss.json`

## 3. 数据结构

### 3.1 顶层结构

```
├── export_metadata        ← 导出元信息 + 过滤条件 + 统计摘要
├── summary               ← 跨 Agent 聚合对比（复用 /api/metrics/compare 逻辑）
└── agents                ← 按 Agent 分组的详细数据
    └── {agent_name}
        ├── agent_info    ← 发现状态 + 适配器版本 + 能力声明
        └── sessions[]
            ├── session          ← 标准化会话元数据
            ├── metrics[]        ← 全量指标结果（含 state/missing_reason）
            ├── events[]         ← 标准化事件流（LLM请求/响应/工具调用等）
            ├── usage[]          ← 每次LLM调用的Token用量
            ├── calls            ← LLM调用 + 工具调用时序
            ├── failures         ← 失败归因诊断
            └── timeline[]      ← Token累积曲线
```

### 3.2 字段详情

#### export_metadata

```json
{
  "exported_at": "2026-10-09T14:30:00.000+08:00",
  "exported_at_epoch_ms": 1728460200000,
  "tool_version": "v0.0.9",
  "filter": {
    "agents": "all" | ["workbuddy", "codex"],
    "since": null | "2026-10-01",
    "until": null | "2026-10-09"
  },
  "statistics": {
    "total_agents": 3,
    "available_agents": 2,
    "total_sessions": 15,
    "sessions_by_agent": { "workbuddy": 5, "codex": 8, "opencode": 2 }
  }
}
```

#### summary

复用 `/api/metrics/compare` 的聚合逻辑输出跨 Agent 指标对比速览。

#### agents.{name}.agent_info

```json
{
  "available": true,
  "adapter_version": "0.2.0",
  "agent_version": null,
  "sources": { "projectsDir": true, "tracesDir": true },
  "missing_reasons": [],
  "modes": ["offline"]
}
```

#### agents.{name}.sessions[]

每个 session 对象包含 6 个数据维度，与 API 各端点返回一致：

| 字段 | 来源 | 说明 |
|---|---|---|
| `session` | normalized session object | 标准化会话元数据 |
| `metrics` | `extractMetrics()` 结果数组 | 含 value/state/missing_reason/evidence_grade |
| `events` | `extractEvents()` 结果数组 | 标准化事件流 |
| `usage` | `extractUsage()` 结果数组 | 每次LLM调用的Token用量 |
| `calls` | `extractCalls()` 结果 | `{ llm_calls, tool_calls, trace_duration_ms }` |
| `failures` | `extractFailures()` 结果 | `{ diagnostics, summary, source_available }` |
| `timeline` | `extractTimeline()` 结果数组 | Token累积曲线 |

### 3.3 设计约束

- 保留 `state` + `missing_reason`：不丢失"缺失不冒充 0"的语义
- 不可用的 Agent 也出现：`agent_info.available: false` + `sessions: []`
- 不含原始 Prompt/响应正文、凭据、令牌（遵循项目安全约束）
- 数据通过 `redact()` + `whitelistFilter()` 脱敏

## 4. 导出方式

### 4.1 API

```
GET /api/export?agents=workbuddy,codex&since=2026-10-01&until=2026-10-09
```

- `agents`：可选，逗号分隔的 Agent 名称；不填则导出全部
- `since` / `until`：可选，日期字符串或 epoch ms
- 响应：`Content-Type: application/json`，`Content-Disposition: attachment; filename=observatory-export-YYYYMMDD-HHmmss.json`
- 数据源：优先从 DB 缓存读取，DB 无数据时回退到 adapter 实时提取

### 4.2 UI

Dashboard 顶部添加"导出数据"按钮：
- 点击弹出 Agent 多选 + 日期范围选择
- 确认后浏览器触发 JSON 文件下载

## 5. 数据量估算

- 每 session 约 20-75KB（events 占大头）
- 100 个 session 约 2-7.5MB
- 单文件 JSON 完全可行，无需分片

## 6. 实现范围

1. `server.mjs`：新增 `/api/export` 端点
2. `index.html`：新增导出按钮 + 弹窗 UI
3. 复用现有 `observatory-db.mjs` 查询逻辑和 adapter 方法
4. 导出过程同步执行（数据量可控，无需异步任务）
