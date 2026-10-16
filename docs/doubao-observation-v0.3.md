# 豆包观测增强 v0.3

日期：2026-10-13（Asia/Shanghai）。工程版本维持 v0.0.10；Doubao adapter/collector 为 0.3.0，新增指标定义为 `metrics-0.3.0`，其他 Agent 继续使用原定义版本。

本次实现依据[源码研究](doubao-observability-research.md)，参考任务快照的执行完整性、Studio 的运行状态与诊断、CDP 的客户端流事件。采集器不发送消息、不注入脚本、不读取 Cookie，不修改豆包原始日志。SSE 正文仅在有大小限制的内存解析器中用于计数字符，输出白名单元数据；不落盘正文、工具参数或请求凭据。

## 已实现的指标及边界

| 来源 | 指标 | 口径 |
|---|---|---|
| trajectory | `assistant_message_count`、`agent_observed_count`、事件分类计数 | 助手消息和可读轨迹中的 Agent；不推断内部 LLM 调用/重试/步骤 |
| 工具配对 | `tool_call_count`、`tool_result_count`、`tool_unresolved_count`、`tool_orphan_result_count` | 会话 + Agent + 原生 call ID；同名工具的不同调用分别统计，跨 Agent 同 ID 分开；无 ID 使用源行位置标识 |
| 工具诊断 | `tool_duplicate_call_count`、`tool_duplicate_result_count`、`tool_type_count` | 重复原生调用/返回记录及工具类型；工具总数包含唯一关联的 CDP 补充事件，正文不含 error 不证明成功 |
| 工具终态 | `tool_terminal_coverage`、`tool_success_rate`、`tool_error_count` | 结构化 status/success/exit_code；成功率为 ok/(ok+error)，覆盖率为已知终态/唯一调用；未知结果、孤立返回或相互冲突的状态不推断 |
| 数据源 | `source_parse_error_count`、`source_partial_line_count`、`source_freshness_ms` | 非法完整行、未写完尾行、距最近文件写入的时间；mtime 不参与历史事件/E2E 计算 |
| CDP HTTP | `client_request_count`、`client_headers_ms`、`client_first_text_ms` | 请求计数、请求→响应头、请求→首个解析出的文本更新；首文本是客户端可见耗时，不是内部 LLM TTFT |
| CDP HTTP | `client_stream_ms`、`client_reply_e2e_ms` | 请求→HTTP 结束、请求→明确 SSE 回复结束；回复结束不证明工作任务或业务成功 |
| CDP SSE | `stream_chunk_count`、`stream_max_pause_ms`、`stream_output_chars`、`stream_output_chars_per_second` | 可识别的文本更新数；每请求最大更新间隔；每消息最新绝对字符数之和；该字符数/(首更新→末更新秒数)，各请求取均值；不是 Token/tok/s |
| CDP 覆盖 | `client_network_error_count`、`client_cancelled_count`、`collector_gap_count`、绑定/未绑定事件数 | 观测窗口内网络终态与断连/流支持/解析缺口；未绑定数是 installation scope，不能代表某一会话 |
| CDP 明确审批 | `human_request_count`、`human_confirm_count`、`human_wait_ms` | conversation + Agent + approval ID 唯一配对；仅接受 allow/deny/modified；普通“是/确认”回复不推断审批 |
| CDP 明确任务状态 | `task_completed_observed_count` | 仅计显式 completed 事件；没有事件则 null，不推断业务正确性 |
| RPA/Bridge | `rpa_run_count`、`rpa_run_ms`、`rpa_command_ms`、`bridge_latency_ms`、`bridge_execution_ms`、`bridge_queue_depth` | 已观测 runner_completed 数与结构化数值均值；属于执行基础设施，不与工具调用/LLM 时延相加 |

工具返回总数是唯一已配对返回 + 孤立返回；`event_count_tool_result` 保留 trajectory 的原始返回行数，便于与去重计数比较。对于只观察到部分数据的指标使用 `partial` 和 coverage，`captured` 也仅描述当前可读源快照，不保证历史完整。

仍缺失：Token usage、费用、实际模型路由、内部 TTFT、重试分组、原生 Agent loop/Step、无时间戳轨迹的轮次 E2E。只有明确 `llm_call_id` 才输出部分逻辑调用数；请求指定模型/窗口仅作为配置元数据，不填充实际路由/最大上下文指标。计划/产物质量、账号额度与 DOM 任务状态采集仍是后续工作。

## 会话绑定

CDP conversation ID 与 `.sessions/<目录名>` 属于不同命名空间。移除了时间窗关联：并发会话不能通过 mtime 或“时间接近”借用指标。

仅两种绑定被接受：事件含明确 `trajectory_session_id`，或本机配置中具有已核实且唯一的 `conversationBindings`：

```json
{
  "agents": {
    "doubao": {
      "conversationBindings": {
        "verified-session-directory-id": "verified-conversation-id"
      }
    }
  }
}
```

映射默认为空；须依据已知关联填入，不能仅凭同名/时间重叠猜测。一个 conversation 配给多个目录时，映射关联拒绝匹配。显式 trajectory ID 与映射冲突时，以原生显式命名空间为准。无绑定的事件保留在项目 runtime，不分摊到所有会话。

RPA 全局日志只凭原生 session ID 归入会话；会话私有 `agents/*/rpa-projects/*/.rpa-dev/traces/**/runner-events.ndjson` 通过目录所有权关联，与文件内相反的显式 session ID 冲突时跳过。全局数据可从只读接口 `GET /api/agents/doubao/default/infrastructure` 查看；该接口不返回正文。

## 采集协议、健康与数据保留

- 出站请求仅匹配 `https://www.doubao.com/chat/completion`。target 限豆包页面及可发现的 worker/iframe，调试 WebSocket 限本机指定端口。没有发现所有 worker 的保证。
- 探测 `/json/protocol` 是否支持实验性的 `Network.streamResourceContent`，成功后读取 `bufferedData` 与 `Network.dataReceived.data`。不调用响应全文回读、不拦截/重放请求。
- 缓冲回补文本的真实到达时间未知，`occurred_at:null`、`delayed:true`，不会以回补时间或后续 chunk 填充首文本耗时。事件完成时间按完成解析的 chunk 计，不能恢复 chunk 内部的分时点。
- SSE 增量处理 UTF-8、CRLF、多行 data、心跳与不同事件类型；只有支持的文本块参与计数。快照/增量按消息累积，带 event ID 的重复通知去重；缺少稳定 ID 的重复增量无法保证识别。
- WS 独立于 HTTP 请求寿命，HTTP 结束后的工具通知仍可观察。10028 工具通知具有源码参考；额外 tool.result/审批/任务状态字段是明确结构协议支持，真实客户端是否发送仍须实测。
- `runtime/collectors/doubao/events-YYYYMMDD.jsonl` 使用上海日期；事件 schema 为 `doubao-collector-event-0.1.0`。`health.json` 保存版本、连接数、支持状态、写入错误、更新时间；无正文或页面标题。锁在 `runtime/doubao-cdp-collector.lock`。
- 断连记录 capture.gap；不补发历史请求。锁采用独占创建，遇到旧锁先检查归属，不自动抢锁或杀进程。正常退出仅移除本实例锁。
- 读取最近 30 个事件日文件；单个 JSONL 超过 32 MiB 不全文读取；全局 RPA 读取最近 100 个 run 目录。SSE 单事件及所有累计消息文本分别限制 1 MiB、至多 100 条消息；每个 target 至多 100 个未结束请求，超限标记缺口。不自动删除/轮转源文件。
- 没有原生时间的会话在无日期筛选时展示，指定发生时间区间时无法证明属于该区间，不凭文件时间纳入。运行中的旧服务不会热换代码；正常重启后后台刷新豆包缓存，也可用已有 `metrics?fresh=1` 只读检查最新口径。
- 历史 `attempts-*` 保留原样，0.3 不再据其响应头派生内部 TTFT，也不从其缺失字段推断 0 次重试。

## 验证

新增合成 fixture 和协议测试覆盖：多工具消息、跨 Agent 同 ID、重复/孤立/未返回结果、结构化终态、错误/尾行、并发绑定冲突、UTF-8 分片、SSE 快照去重、缓冲与直播竞争、流不支持、断连、晚到 WS、明确审批配对、RPA scope、白名单及 schema。

检查命令：`node scripts/setup.mjs`、`npm run doctor`、`npm test`、`npm run release`。测试协议数据不能宣称真实客户端采集成功；客户端 CDP 当前不可连接，尚未完成 0.3 的真实采集验收。适配器对现有本机数据的只读检查与客户端安装/主动采集分别记录。

本次结果见[2026-10-13 验证回执](doubao-validation-2026-10-13.md)。
