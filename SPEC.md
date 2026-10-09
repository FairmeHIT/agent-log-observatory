> 当前部署边界（v0.0.9，2026-10-04）：项目内归档依赖/采集器，Node 24.x + Windows x64；runtime 为私有运行产物。默认只读与显式 opt-in 采集分离，安装/回退及当前文件边界以 AGENTS.md 和 docs/deployment.md 为准。下文保留原始架构规格，历史阶段状态不代表当前安装门槛。

# Agent Log Observatory — 需求分析与工程 SPEC

> 状态：`draft`（工程规格，尚未实现或验收）  
> 规格版本：`0.2.0`；更新日期：2026-09-29  
> 创建时间：2026-09-29  
> 能力归属：`Observation & Evidence Layer`；横切 `Contract/Identity/Security` 和 `Presentation/Delivery`，仅向 `Evaluation & Grading` 提供证据，不实现评分  
> Agent Object 适用范围：WorkBuddy、Mobilework、TeleAgent、Doubao(豆包 Work)、DSH(DeepSeek Harness)、Codex(OpenAI Codex Desktop)

---

## 1. 目标与边界

### 1.1 定位与继承关系

将多个 Agent 客户端中的本地日志标准化、关联和统一展示。本项目是**多 Agent 日志观察台**，不是业务成功判定系统，也不是特定两个 Agent 专用监测系统。未来对象通过 Adapter 接入，不修改核心指标语义。

[`mobilework-trace-dashboard`](../mobilework-trace-dashboard/) 是已有 Mobilework 深度观测原型及 EAQE Bundle 阅读器；本项目将其能力适配器化，而不是只复制 SQLite 查询。旧项目继续独立可用，本阶段不修改或废弃它。

本文件为工程规格事实源，不另建重复维护的正式叙事 Markdown。当前目录仅有 SPEC；下文目录、API、Schema 和验收命令均为**计划**，不能描述为已完成。正式阅读材料若后续建立，遵循工作区 HTML-first 策略。

### 1.2 目标指标

| 维度 | 指标与展示边界 |
|---|---|
| 时延 | 模型请求 TTFT、首文本延迟、单轮 E2E、Session 墙钟跨度、活跃执行时长、同轮步骤间隔、P50/P95；互不替代 |
| Token | 原始输入/输出/推理/缓存读写分项、供应商总量、同口径归一总量、生成吞吐、轮次产出率、观测输入峰值 |
| 成本 | 原始 Credits 与货币成本及单位；未知价格不反解成官方单价，不将 Credits 当货币 |
| LLM | 逻辑调用数、实际 attempt 数、重试数及终态覆盖；stream 段数另计 |
| 工具 | 实际调用、实际重试、执行结果、Skill/MCP/普通工具类型及识别依据 |
| 权限 | 自动权限决策、审查、人工确认分别统计，不将审批通过视为工具执行成功 |
| Event / Step | 原始记录数、去重后的标准事件数、逻辑 Step 数分别展示 |
| 诊断 | 有直接证据的错误与规则推断的候选归因分开统计，保留 unknown |

所有指标遵循 §8 的统一口径；§2 的数据源发现只是提取入口，不构成指标可用或可比的证明。

### 1.3 运行模式和边界

| 模式 | 允许的数据源 | 能力边界 |
|---|---|---|
| `offline`（默认） | 配置目录下已有 SQLite、JSON/NDJSON/log、旧观察台脱敏摘要和 EAQE Bundle | 不访问 Agent runtime；没有历史首 chunk 的 TTFT 为 not-captured |
| `local-live`（显式启用） | offline 数据 + 本机 Agent runtime 的只读 GET/SSE | 用于未来事件的首 chunk、模型路由及能力采集；不回填未曾采集的历史事实 |

- **原始源只读**：不修改 Agent 数据库、日志、配置、插件或授权规则；不部署 Hook、不触发任务、不自动登录。
- **本地与最小授权**：服务仅绑定 `127.0.0.1`；不访问云端、不接受非 loopback runtime 地址。local-live 的读取凭据仅在内存使用，不进入缓存、日志、API 或导出；连接失败时降级并声明缺失。
- **允许自身派生写入**：仅在独立、可配置的数据目录保存脱敏摘要、游标和缓存；默认在用户数据目录下、Agent 原始目录和仓库之外。禁写 Agent 源目录及研究资产目录。
- **脱敏先于持久化和响应**：采用字段白名单，不暴露 Prompt、模型/推理正文、工具参数/输出正文、凭据或个人绝对路径；标题/工作区默认使用别名。不沿用旧工具任意原始表导出权限。
- **缺失不等于零或失败**：缺失指标为 null；0 仅表示采集覆盖充分且确认没有发生。estimated 值只进入参考区，不进入默认跨 Agent 排名。
- **观测不等于评测**：Stop、客户端 completed、tool.result 和 Agent final answer 不能证明业务成功。外部 Outcome 单独展示来源，不合成评分。

### 1.4 本次修订

2026-09-29 的 0.2.0 修订保留四对象的数据源目录及新增 TeleAgent 日志发现，统一多源融合、调用/attempt、时间粒度、Token 去重、权限/工具边界与缺失语义，并加入 Mobilework 迁移验收。规格修订不代表重新探测日志或真实业务验证。实施优先级见 §12。

---

## 2. Agent 日志源探测结果

> 本节保留已有探测记录，属于样本发现而非本次复核结论；文件大小、条数、安装形态和字段存在性随版本变化。Adapter 必须运行时探测并报告版本、覆盖和缺失原因。安装路径用配置占位符，用户数据路径用环境变量，不硬编码个人机器路径。

### 2.1 总览

| Agent | 安装目录 | 主要数据目录 | 数据库 | 日志格式 | 数据丰富度 |
|---|---|---|---|---|---|
| WorkBuddy | `<WORKBUDDY_INSTALL_ROOT>/` | `~/.workbuddy/` | 无（JSON/NDJSON） | JSON/NDJSON/log | 高（transcript 含 rawUsage + trace + 多层日志） |
| Mobilework | `<MOBILEWORK_INSTALL_ROOT>/` | `~/.mobilework/` | SQLite (opencode.db) + runs.jsonl | SQLite/JSON/NDJSON/log | 高 |
| TeleAgent | `<TELEAGENT_INSTALL_ROOT>/` | `~/.local/share/TeleAgent/` + `~/.config/TeleAgent/` | SQLite (teleagent.db) | Go log/SQLite/JSON | 中-高（server log 含 cost/perm/tool_review） |
| Doubao | `<DOUBAO_INSTALL_ROOT>/` | `%LOCALAPPDATA%\Doubao\User Data\Default\.doubao\` + `rpa-dev\` | 无（NDJSON/JSON） | NDJSON/JSON/log | 中（LLM trajectory + RPA trace 双层） |
| DSH | `<DSH_INSTALL_ROOT>/` | `~/.dsh/` + `%APPDATA%\dsh-desktop\` | 无（JSONL.zstd/JSON） | zstd JSONL/JSON/log | 高（sessionStats 自带 TTFT/decode/llmMs + tokenUsage + 事件级 chunk 时间戳） |
| Codex | `<CODEX_INSTALL_ROOT>/` | `~/.codex/` | SQLite (state_5 + thread_history + logs_2) | SQLite/TOML/JSONL | 高（原生 Turn E2E + compaction threshold + context window + per-turn token usage） |

> 各 Agent 的完整数据源明细（安装目录、数据目录、数据源表、事件格式、字段语义、指标可用性表、限制）见 [docs/agents/](docs/agents/)，下表为索引。

### 2.2 各 Agent 数据源明细（分文件维护）

| Agent | 详情文件 | 核心数据源 | 数据丰富度 |
|---|---|---|---|
| WorkBuddy | [docs/agents/workbuddy-agent.md](docs/agents/workbuddy-agent.md) | .jsonl transcript（rawUsage）+ trace JSON + 多层日志 | 高（缺 TTFT/重试/人工确认） |
| Mobilework | [docs/agents/mobilework-agent.md](docs/agents/mobilework-agent.md) | SQLite (opencode.db) + runs.jsonl + model-raw + stream-timings | 高 |
| TeleAgent | [docs/agents/teleagent-agent.md](docs/agents/teleagent-agent.md) | super-agent-server Go 日志（`[cost]`/`[perm]`/`[tool_instruction_review]`）+ SQLite | 中-高 |
| Doubao | [docs/agents/doubao-agent.md](docs/agents/doubao-agent.md) | LLM trajectory.jsonl + RPA runner-events + bridge.log 双层 | 中（缺 Token/时间戳/Credits） |
| DSH | [docs/agents/dsh-agent.md](docs/agents/dsh-agent.md) | session JSONL.zstd（多帧 zstd）+ projection cache（sessionStats/tokenUsage） | 高（原生 TTFT） |

---

## 3. 指标覆盖矩阵

> `✅` = 可提取（有数据源和提取路径）　`⚠️` = 部分可提取（近似、条件可用或推算）　`❌` = not-captured（数据源中无此信息）

### 3.1 指标 vs Agent 数据源可用性

| 指标 | WorkBuddy | Mobilework | TeleAgent | Doubao | DSH | Codex | 说明 |
|---|---|---|---|---|---|---|---|
| **TTFT** | ❌ | ⚠️ stream-timings.json | ❌（v2.6 DB 有 reasoning.time.start，适配器已支持） | ❌ | ✅ sessionStats.ttftMs | ✅ thread_items 首 item started_at − turn started_at | DSH/Codex 原生，Mobilework 条件 |
| **任务 E2E 时延** | ✅ per-turn | ✅ runs.jsonl | ✅ DB step-finish | ⚠️ mtime | ✅ per-step | ✅ thread_turns.duration_ms（原生） | WorkBuddy/Mobilework/DSH/Codex 精确 |
| **Session 墙钟跨度** | ✅ transcript 首末 | ✅ session time | ✅ 日志首末 | ❌ | ✅ createdAt→末事件 | ✅ threads created_at→updated_at | 新增独立指标 |
| **Token 消耗量** | ✅ rawUsage | ✅ session tokens | ✅ step-finish tokens | ❌ | ✅ tokenUsage.totals | ✅ rollout token_usage_record + threads.tokens_used | 全部（除 Doubao） |
| **Token 吞吐量** | ✅ completion/时延 | ✅ output/duration | ✅ total/E2E | ❌ | ✅ decodeTokens/decodeMs | ⚠️ tokens_used / sum(duration_ms) | DSH 原生精确 |
| **输入 Tokens** | ✅ prompt_tokens（含 cache） | ✅ tokens_input | ✅ in（不含 cache） | ❌ | ✅ uncachedInput | ✅ rollout usage.input_tokens（含 cache） | 跨 Agent 注意 input_includes_cache |
| **输出 Tokens** | ✅ completion_tokens | ✅ tokens_output | ✅ out | ❌ | ✅ outputTokens | ✅ rollout usage.output_tokens（含 reasoning） | 全部可计（除 Doubao） |
| **命中 Tokens (cache)** | ✅ prompt_cache_hit | ✅ cache_read | ✅ cacheRead | ❌ | ✅ cacheReadTokens | ✅ rollout usage.cached_input_tokens | 全部可计（除 Doubao） |
| **Tokens-Credits 换算** | ✅ credit | ⚠️ cost=0 | ❌ cost=0 | ❌ | ❌ | ❌ | WorkBuddy 有 credit |
| **最大上下文** | ✅ max(prompt+completion) | ✅ tokens_input 峰值 | ✅ max(in+cacheRead) | ❌ | ✅ surfaceTokens | ✅ rollout input_tokens 峰值 | 全部可计（除 Doubao） |
| **Context Window** | ❌ | ❌ | ❌ | ❌ | ✅ contextPressure.contextWindow | ✅ 运行时 token_count.model_context_window + config.toml | DSH/Codex |
| **Compaction threshold** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ config.toml + logs.auto_compact_scope_limit | 仅 Codex |
| **LLM 调用次数** | ✅ rawUsage 行数 | ✅ event started | ✅ step-start 数 | ✅ assistant 行数 | ✅ step-start 数 | ✅ thread_turns 计数 | 全部可计 |
| **LLM 重试率** | ⚠️ isRetryable | ✅ retried event | ❌ | ❌ | ⚠️ llmRetry（空） | ❌ | Mobilework 精确 |
| **LLM 成功率** | ✅ 成功/总 | ✅ step status | ✅ 成功/总 | ⚠️ 无标记 | ⚠️ 无 error 事件 | ✅ thread_turns.status=completed | WorkBuddy/Mobilework/TeleAgent/Codex |
| **工具调用次数** | ✅ function_call | ✅ tool.called | ✅ step-finish | ✅ tool_calls[] | ✅ tool/call | ✅ commandExecution+mcpToolCall | 全部可计 |
| **人工确认次数** | ❌ | ❌ | ✅ perm by≠通配 | ✅ user 确认 | ⚠️ approval="ask" | ⚠️ approval_mode="OnRequest"（模式） | TeleAgent/Doubao |
| **Event 总数** | ✅ jsonl 行数 | ✅ event COUNT | ✅ log 行数 | ✅ trajectory+runner | ✅ zstd 帧数 | ✅ thread_items COUNT | 全部可计 |
| **Step 总数** | ✅ reasoning+func | ✅ step.started | ❌ | ✅ 循环对数 | ✅ sessionStats.steps | ✅ thread_items 总数 | WorkBuddy/Mobilework/Doubao/DSH/Codex |
| **Compaction 次数** | ❌ | ✅ compaction event | ✅ compaction part | ❌ | ❌ | ✅ contextCompaction items | Mobilework/TeleAgent/Codex |
| **失败归因** | ⚠️ error+log | ✅ event+log | ⚠️ log | ⚠️ log | ❌ | ⚠️ thread_turns.error_json | 需日志解析 |

### 3.2 数据源能力总结

```text
Codex       ████████████████████  高覆盖（SQLite threads+turns+items+logs，原生 E2E/compaction/context window，缺 cache 明细）
DSH         ████████████████████  高覆盖（sessionStats 原生 TTFT/decode/llmMs + tokenUsage + 事件级 chunk 时间戳）
Mobilework  ████████████████████  高覆盖（SQLite + event + model-raw + runs.jsonl + logs）
WorkBuddy   ██████████████████░░  高覆盖（transcript rawUsage + trace + 多层日志；缺 TTFT/重试/人工确认）
TeleAgent   ████████████████░░░░  中-高覆盖（DB part JSON step-finish tokens + reasoning time；缺 Credits/cache 明细）
Doubao      ████████░░░░░░░░░░░░  中等覆盖（LLM trajectory + RPA trace 双层，缺 Token/时间戳/Credits）
```

### 3.3 not-captured 原则

- `❌` 对应字段设为 `null`，不折算为 0 或失败。
- `⚠️` 标注提取口径（近似/条件/推算），附证据等级。
- 跨 Agent 对比时，不可比项明确标注，不用看似精确的总分掩盖差异。

---

## 4. 标准化数据模型

### 4.1 契约、身份和粒度

草案契约 `normalized-observation-0.2.0`；实现阶段建立 JSON Schema、合成 Fixture 和校验器，下列是字段规格，不是已发布 Schema。核心类别不出现 Mobilework 特有的 session.next.* 名称。

| 实体 | 定义 |
|---|---|
| Session | 客户端会话，可含多轮；保留 parent_session_id/root_session_id |
| Turn | 一次用户提交触发的执行范围；原生 turn ID 或有证据的确定性映射，不将 Session 自动当 Turn |
| Step | 逻辑 Agent 循环，可含模型多 attempts 与工具调用，重试不新增逻辑 Step |
| LlmCall / Attempt | 逻辑模型调用及实际请求尝试；text/reasoning/tool-input 是同 attempt 的输出流段 |
| ToolCall | 实际执行，call_id 与消息/Step 关联；权限审查独立 |
| Task / Trial | 外部执行/评测身份，只通过显式绑定接入，不从 Session ID 猜造 |

实体身份键含 `agent_object + installation_id + native_id`，不同对象/实例不碰撞；派生 ID 使用版本化确定性规则，保留原生 ID 供本地审计。关联为空或不唯一必须说明原因，不能挂“最近事件”。

### 4.2 NormalizedEvent 字段

| 字段 | 类型与要求 |
|---|---|
| schema_version / event_id | 固定契约版本 / 稳定去重 ID |
| agent_object / installation_id / adapter_version / agent_version | 可扩展对象名 / 实例别名 / 规则版本 / 可空源版本 |
| session_id / root_session_id / parent_session_id | 会话结构；无法定位 Session 的源留 source diagnostics，不强行归会话 |
| turn_id / step_id / llm_call_id / attempt_id / call_id / message_id | 可空粒度身份，不相互冒充 |
| evaluation_run_id / task_id / trial_id / binding_status | 可空外部身份；bound/unbound/ambiguous，bound 需显式证据 |
| trace_id / span_id / parent_span_id | 可空 Trace 关联，Span 不等于 Step |
| event_category | llm.request / llm.response / tool.call / tool.result / agent.input / step.start / step.end / other |
| event_subtype / event_type_raw | 标准子类如 stream.start/usage/retry/permission.decision / 保留原始 type 和版本后缀 |
| occurred_at / received_at / source_seq | 原生时间可空 / 采集时刻 / 可空源序号。received_at 不替代 occurred_at |
| timestamp_basis / precision_ms | native/receipt/unknown / 有效精度；源时区未知则不算时延 |
| status | ok/error/running/cancelled/unknown；是源/执行状态，不是业务成功 |
| requested_model / routed_model / provider | 请求与响应实际模型分列，缺 routed_model 不推相邻步骤 |
| tool_name / tool_kind / skill_name / tool_kind_basis | skill/mcp/tool/unknown；分类依据是原生 provider、skill input.name 或带时间快照，不凭颜色/模糊名称 |
| usage_record_ids / cost_record_ids | 可空唯一消费引用，不能把事件上复制的 usage 再计一次 |
| evidence_refs / field_evidence / metadata | 脱敏来源 / 字段等级 / 白名单元数据，不透传原始对象 |

只有请求开始证据才生成 llm.request；完整模型响应/终态且调用唯一关联才生成 llm.response。usage 和 stream-start 缺该证据时记 other，不补齐虚假请求/响应对。

### 4.3 Session、调用与消费模型

- **Session**：身份、父子关系、项目/标题别名、source_status、生命周期、turn_ids、子实体引用、完整度、MetricResult。原始累计 Token 与规范聚合分区，不能二次叠加。
- **Turn**：输入事件引用、submitted_at、execution_started_at/ended_at、执行区间、状态/来源；没有可信结束则 finished E2E=null，运行中只报 live_elapsed。
- **LlmCall/Attempt**：逻辑 ID、step_id、attempt_ids；attempt 保留 requested_at、first_output_at、first_text_at、generation_ended_at、request_ended_at、模型、status、usage_record_ids。没有逻辑关联可保留独立 attempt，但逻辑调用数 null。
- **ToolCall**：call_id、Step/attempt、started_at/ended_at、status、retry_of、exit_code、工具类型与依据；审批生命周期单独记录。
- **UsageRecord**：usage_record_id、关联实体、scope、原始 input/output/reasoning/cache_read/cache_write/reported_total、Credits/货币 cost 与单位；包含关系（input_includes_cache/output_includes_reasoning/cache_write_accounting）可 unknown，记录 token_semantics_version 及来源。未知分项为 null。
- **树范围**：root-tree/self 明确，遍历去重、环检测、深度限制；触限标 partial。Task/Trial 传到子会话需显式绑定规则与证据。

### 4.4 Evidence 和 MetricResult

EvidenceRef：source_id、source_kind（sqlite/transcript/reporting/runtime/summary/log/bundle）、源定位符（表/主键/seq 或源别名/行号）、原始 type、解析规则版本、采集覆盖窗口、关联状态。

field_evidence 对身份、时间、模型、usage、状态分别标记 direct/derived/estimated/unknown：原生提取 direct，已知完整事实计算 derived，规则推断 estimated。不能用某个字段的高等级为其它字段背书。

所有指标返回封套，而非裸数字：

```json
{
  "metric": "llm_attempt_ttft_ms",
  "definition_version": "metrics-0.2.0",
  "value": null,
  "unit": "ms",
  "scope": "llm_attempt",
  "scope_id": "attempt-example",
  "scope_membership": "self",
  "state": "not-captured",
  "evidence_grade": "unknown",
  "missing_reason": "missing_first_chunk",
  "source_refs": [],
  "coverage": {"eligible": 1, "observed": 0, "finished": 1},
  "numerator": null,
  "denominator": null,
  "semantic_profile": "first-model-output",
  "comparable": false
}
```

state=captured/partial/not-captured/not-applicable；estimated 是证据等级，不是覆盖状态。partial 的 observed_value 仅为已观测部分，默认 value=null，除非定义允许且用户显式选择。比率保留分子/分母，零分母为 null/zero_denominator。

### 4.5 时间、缺失和安全

- 新生时间 ISO-8601 `+08:00`，展示 Asia/Shanghai，不依赖系统时区；历史 UTC 保留 source_timestamp，不改写源。内部计算用 epoch，精度不得超过源。
- 无原生事件时间时 occurred_at=null；不用 Date.now/mtime/RPA 时间伪造。source_seq 负责源内排序，received_at 仅采集诊断；无时区输入需配置源时区，否则 unknown。
- 稳定 missing_reason：source_unavailable、not_instrumented、missing_start、missing_end、missing_first_chunk、unbound、ambiguous、partial_capture、semantic_unknown、zero_denominator、unsupported_version、not_applicable。
- 完整度按 source/字段/scope/窗口，不能 has_tokens=true 就宣称历史全集可用；known-ok/error/running/cancelled/unknown 分列，缺失不折成0。
- JSON metadata/error、cache、API、SSE、JSON/Markdown 导出统一白名单；原文即使不命中 secret 正则也不得输出。

---

## 5. 提议目录结构

```
agent-platform-projects/agent-log-observatory/
├── README.md                         # 项目说明和快速启动
├── SPEC.md                           # 本文件：需求分析与工程规格
├── 需求文档.md                        # 版本化需求记录（沿用 mobilework-trace-dashboard 惯例）
├── 版本迭代说明.md                     # 版本变更记录
├── server.mjs                        # Node.js HTTP 服务（主入口）
├── index.html                        # 单页 Dashboard 前端
├── 启动.cmd                            # Windows 一键启动（Dashboard + 采集器）
├── 停止.cmd                            # Windows 一键停止（本项目登记进程）
├── 启动Mobilework.cmd                   # Mobilework 栈（代理 + Dashboard + 客户端）
├── runtime/
│   └── sqlite3.exe                   # 便携 SQLite（复用 mobilework-trace-dashboard）
├── adapters/                         # Agent 数据源适配器（核心扩展点）
│   ├── README.md                     # 适配器开发指南
│   ├── base-adapter.mjs              # 抽象基类：定义 NormalizedEvent/Session 契约
│   ├── workbuddy-adapter.mjs         # WorkBuddy 适配器
│   ├── mobilework-adapter.mjs        # Mobilework 适配器（复用现有 dashboard 逻辑）
│   ├── teleagent-adapter.mjs         # TeleAgent 适配器
│   └── doubao-adapter.mjs            # Doubao 适配器
├── lib/                              # 共享库
│   ├── normalizer.mjs                # 原始数据 → NormalizedEvent/Session
│   ├── evidence.mjs                  # 字段来源、覆盖和缺失原因
│   ├── correlator.mjs                # 身份关联、幂等去重和冲突
│   ├── metrics.mjs                   # 指标计算引擎（TTFT、P50/P95、重试率等）
│   ├── aggregator.mjs                # 跨 Agent 聚合和对比
│   ├── log-parser.mjs                # 非结构化日志解析（Electron/Go log → 结构化事件）
│   ├── redactor.mjs                  # 脱敏引擎
│   ├── time.mjs                      # 北京时间格式化（+08:00）
│   └── config.mjs                    # 配置加载（Agent 路径、端口、数据源）
├── schemas/                          # 计划建立版本化 JSON Schema
│   ├── normalized-event.schema.json
│   ├── normalized-session.schema.json
│   └── metric-result.schema.json
├── tests/
│   ├── README.md
│   ├── test-normalizer.mjs           # 归一化测试
│   ├── test-metrics.mjs              # 指标计算测试
│   ├── test-adapters.mjs             # 适配器契约测试
│   ├── test-mobilework-parity.mjs     # 迁移基线和有意口径变更
│   ├── test-redaction.mjs            # 全出站路径脱敏验证
│   ├── expected/                     # 独立计算的 Fixture 期望值
│   └── fixtures/                     # 脱敏测试数据
│       ├── workbuddy-sample/
│       ├── mobilework-sample/
│       ├── teleagent-sample/
│       └── doubao-sample/
├── releases/                         # 发布归档
├── NODE-LICENSE.txt                  # Node.js 许可证
├── THIRD-PARTY-NOTICES.txt           # 第三方声明
└── WINDOWS-README.txt                # Windows 用户说明
```

### 5.1 关键设计决策

1. **Node.js ESM + 内置 HTTP/SSE**：沿用旧项目；分发包含 Node/SQLite 与许可、版本和校验值，不依赖用户系统安装。
2. **Adapter 提取、共享计算**：对象适配提取事实/语义，共享引擎计算统一指标；extractMetrics 只能委托共享引擎，不另写对象专属同名公式。
3. **按字段多源融合**：无“数据库可用就跳过 JSON/log”的格式优先级；身份/时间/usage/状态按字段选择主证据，同时读取互补源，同语义冲突留痕。
4. **幂等/增量**：原生 event/call/message/usage ID 优先；文件源使用 source_id+generation+offset/行序，处理轮转/截断/重读。跨源凭共同 ID 或可验证复合键去重，不按时间近似静默合并。
5. **Scope-first**：self/root-tree 与 Session/Turn/Step/attempt/ToolCall/Trace/HTTP/RPA 明确；根/子并发时间取区间并集，消费按唯一 usage 求和。
6. **读一致性和限额**：只读 SQLite（尊重 WAL 状态）、超时和分页；不执行 checkpoint/迁移、不拷贝裸 DB 冒充快照。记录 as_of/revision；文件尾行未写完则下次重读，解析错误报告 source health。
7. **离线优先**：显式开启才订阅本机 runtime；断连、临时源清理或触限时 partial，不猜测补齐。脱敏先于写入和出站。
8. **版本治理**：记录 schema/metric/adapter/源版本，不支持返回 unsupported_version；核心语义变更同步 Schema、样例、期望和迁移说明。

### 5.2 Mobilework 字段融合规则

| 字段/关系 | 主证据与补充 |
|---|---|
| 会话/树 | session.id/parent_id；工具 task 仅显式 sessionID 唯一时补充，遍历失败 partial |
| 请求/真实模型 | reporting 请求边界/响应模型，旧 routed 摘要历史补充；不推测相邻模型 |
| 首 chunk/stream | runtime 原生发生时间优先；只有 receipt 时单列观测延迟，不进入默认模型 TTFT |
| Step/attempt/工具 | event 与 message/part 按明确 ID 关联，原始 type 后缀保留；重试/失败关联必须唯一 |
| usage | 原生 assistant usage 明细，session/runs 同范围校验而非相加 |
| 轮次/压缩 | user/prompted + 当前轮次/原生 ID 定位，compaction 原生消息，无边界不推算 |
| 能力/工具类型 | 原生 provider、skill input.name、带时间快照；当前补采不冒充历史创建快照 |

runs 无 run ID 时仅唯一输入/时间映射可建 turn_id，否则保留 unbound client_run_summary。累计摘要 revision/as_of 替换旧值，独立运行追加；同数值不同调用不能合并。

---

## 6. 适配器接口 SPEC

### 6.1 BaseAdapter（拟实现）

读取统一支持 limit/cursor/as_of/abortSignal。路径仅来自配置/discover，API 不接受任意文件路径。

```javascript
export class BaseAdapter {
  static agentObject = 'abstract';
  static adapterVersion = '0.2.0';
  async discover(config) {} // 实例别名、sources、versions、modes、health
  async capabilities(context) {} // source × field × scope × time-window
  async extractSessions(options = {}) {} // { items, nextCursor, asOf, coverage }
  async extractTurns(sessionId, options = {}) {}
  async extractEvents(sessionId, options = {}) {}
  async extractCalls(sessionId, options = {}) {} // model attempts / actual ToolCall
  async extractUsage(sessionId, options = {}) {} // 唯一消费记录 + semantics
  async extractFailures(sessionId, options = {}) {} // 带证据诊断，非评分
  async extractMetrics(sessionId, options = {}) {} // 仅委托共享指标引擎
  async subscribe(options = {}) {} // local-live only; AbortSignal/覆盖/游标
  async close() {} // 停订阅、刷新已脱敏缓存
}
```

### 6.2 各对象映射

| 对象 | 组合源 | 核心映射和禁止项 |
|---|---|---|
| WorkBuddy | transcript + trace + Session 元数据 + 应用日志 | user/function_call/result 保留原义；rawUsage 分组去重，generation/request 候选调用；不以工具行数代表 LLM 请求、不以 isRetryable 代表真实重试 |
| Mobilework | SQLite session/message/part/event + reporting + runs + 旧脱敏摘要 + 可选 runtime | 继承 §5.2；根/子、Step/attempt、stream、请求/实际模型、工具分类分离；不直接 import 旧 server 的启动副作用，提取纯逻辑并 Fixture 回归 |
| TeleAgent | DB + super-agent-server log + 配置/工具汇总 | request_id 为应用范围，cost→usage、perm/review→权限/审查、prune→压缩、resolveModel→请求模型；汇总与逐次事件分列，不合成缺少边界的执行，不以 cost 算 TTFT |
| Doubao | trajectory + RPA runner + bridge + Session 目录 | assistant/tool_calls 原生 ID 关联；RPA command 与 LLM ToolCall 不直接相加，双层证据可关联但不重复；无时间时按 source_seq，mtime 不作发生时间 |

### 6.3 错误与降级

- 原生 IDs 精确关联优先；多候选时间匹配只留 estimated/unbound 诊断，不进入精确指标。
- 日志轮转/乱序/迟到保留 source diagnostics；后续唯一关联更新稳定实体，不新增重复调用。
- Agent 存在不等于全部源可用。坏行、锁库、缺表或未知版本局部告警，其它 Adapter 仍工作。
- API 不输出绝对路径、凭据、parser 原文异常或源正文，仅错误码、源别名、脱敏计数。

---

## 7. API SPEC

### 7.1 REST API（计划）

路由只读，:agent 是注册名，:installation 是 discover 别名。Session 等路径片段编码/验证，不提供任意路径读接口。列表支持 since/until/cursor/limit，返回 as_of、coverage、next_cursor。

| 方法 | 路由 | 内容 |
|---|---|---|
| GET | `/api/agents` | 已注册/已发现对象及实例、availability/source health |
| GET | `/api/agents/:agent/:installation/capabilities` | 版本、范围、窗口能力 |
| GET | `/api/sessions?agents=workbuddy,mobilework&since=...&limit=...` | 脱敏 Session 列表 |
| GET | `/api/sessions/:agent/:installation/:session` | Session 树和完整度 |
| GET | `/api/sessions/:agent/:installation/:session/turns` | 轮次及 unbound client_run_summary |
| GET | `/api/sessions/:agent/:installation/:session/events` | 去重事件及来源，原始记录数另列 |
| GET | `/api/sessions/:agent/:installation/:session/calls` | Step/调用/attempt/工具执行/审查关系 |
| GET | `/api/sessions/:agent/:installation/:session/metrics?scope=turn&scope_id=...` | MetricResult；self/root-tree 显式指定 |
| GET | `/api/sessions/:agent/:installation/:session/failures` | 直接错误与 estimated 候选分区 |
| GET | `/api/metrics/compare?agents=workbuddy,mobilework&metric=turn_e2e_ms&scope=turn` | 可比项及排除原因，不评分 |
| GET | `/api/metrics/aggregate?agent=mobilework&metric=turn_e2e_ms&scope=turn&percentile=50,95` | 算法、样本量、缺失率及 cohort |
| GET | `/api/failures/summary?agent=mobilework&since=...` | 各层诊断频数、unknown 与关联覆盖 |
| GET | `/api/export/sessions/:agent/:installation/:session?format=markdown` | 白名单 Markdown/JSON，不输出源正文 |
| GET | `/api/health` | 源健康/限额/实时连接/增量告警 |
| GET | `/api/events/stream` | 观察台脱敏 SSE 通知，不代理 runtime 原始载荷 |
| GET | `/api/eaqe-bundles`、`/api/eaqe-observations?bundle=...` | 旧 EAQE 阅读路由及 Bundle ID 兼容，见 §9.2 |

响应含 schema/metric_definition_version；合法未捕获/不可比指标 200 + null/原因，未知实体404、非法 scope/游标400、源局部故障写 health。禁止任意 CORS/跨 origin 读取，HTML 对源字符串转义，防止日志内容执行脚本。

### 7.2 页面

| 视图 | 要求 |
|---|---|
| Overview / Session List | 实例、模式、source health、时间/范围筛选，不以 DB 存在宣称完整能力 |
| Session / Trace | 沿用旧表格/展开态，root-tree/self、子会话、轮次分隔，Step/attempt/审批分列 |
| Latency | TTFT、首文本、单轮 E2E、active、Session lifespan 分列，running 不进完成样本 |
| Token / Cost | 每个有已验证 usage 的对象均可展示，分项/profile/原始总量/归一总量/货币/Credits分列 |
| Compare / Statistics | scope、语义、样本量/缺失率；跨对象显式勾选，estimated 默认排除 |
| Diagnostics | 错误和候选归因分区；拒绝审批、取消、未捕获不等工具失败 |
| Evidence / EAQE | 来源/时窗/身份/路由/完整度；外部 Outcome 不替代观测状态 |

SSE 仅对开始、首包、重试、终态或稳定 revision 变化通知重绘，普通 chunk 不整页刷新。沿用15秒兜底同步和局部运行计时，无变化不重建列表，保留滚动/展开态；间隔可配置并测试。

---

## 8. 指标计算口径

统一定义版本 `metrics-0.2.0`。共享引擎只消费满足身份、scope、语义、覆盖条件的事实，禁止用特定对象的原始事件名定义全平台公式。

### 8.1 时延和分位数

| 指标 ID | 口径及条件 |
|---|---|
| llm_attempt_ttft_ms | 同 attempt 的 first_output_at − requested_at；首非空模型生成 chunk（text/reasoning/tool-input）原生时间，排除心跳/控制事件；缺任一边界 null |
| llm_attempt_first_text_ms | first_text_at − requested_at；与首模型输出分列，仅推理/工具参数输出不冒充文本 TTFT |
| request_to_observed_chunk_ms | 首 chunk receipt − 已知 request start；仅接收时间时展示观测延迟，不进入默认 TTFT 对比 |
| turn_e2e_ms | submitted_at → 本轮完整执行结束（含工具/关联子代理）；不能用最后 cost 替代结束，不含等待用户下轮输入 |
| turn_execution_ms | execution_started_at → execution_ended_at，与包含提交后调度等待的 E2E 分列 |
| session_lifespan_ms | created → last_updated，仅生命周期墙钟跨度，不称任务执行耗时 |
| active_execution_ms | 已闭合轮次执行区间并集；root-tree 对根/子重叠取并集，不重复相加；self 可独立展示 |
| step_gap_ms | 同轮同上下文，上个完整 Step（含工具）结束 → 下一模型请求开始；重叠为0、跨轮不计；阈值仅控制展示，不更改原始量 |
| trace_duration_ms / application_request_ms / rpa_run_ms | 原生对应范围时长，不能自动称 turn_e2e |
| live_elapsed_ms | 已知开始 → 当前采集时刻的运行计时，不进已完成时长/分位数 |

- chunk 延迟/批量上报可能存在，observed_chunk_gap_ms 保留 stream_kind、时间依据和覆盖；未经独立证明不称“断流/无效耗时”，不算效率损失。
- 缺结束、负时长、时钟冲突、映射不唯一、范围覆盖不足返回 null/原因，estimated 单独参考。
- 分位采用 nearest-rank：合法样本升序，Pp=x[ceil(p*n)-1]，p=.50/.95，返回 algorithm/n。n=0 为null；n<5标 insufficient_sample、仅参考；5≤n<20 的P95标 low_sample，不排名；20并非可靠性保证。
- 同 cohort 固定定义版本、scope/membership、时间依据、完成状态、模型/对象与查询范围。没有显式任务/Trial绑定，仅作日志样本描述性对比，不称公平 Benchmark/Agent 质量排序。

### 8.2 Token、上下文和成本

1. **消费去重**：UsageRecord 是一次独立消费事实，可复制在 function_call/assistant、cost/processResult 或多个源；凭原生共同 ID/已验证关联去重，不以数值相同认定同一消费。重复范围未知则 partial/null。
2. **保留包含关系**：input_includes_cache、output_includes_reasoning、cache_write_accounting、usage_scope、reported_total、token_semantics_version；未知是 unknown，不假定分项互斥。
3. **总量分列**：reported_total 原样；normalized_total 仅已知包含语义时求互斥分项；legacy_mobilework_display_total=input+output+reasoning+cacheRead+cacheWrite，仅旧 UI parity，不能称统一成本/默认跨对象总量。
4. **范围不双加**：Session 累计、runs 轮次、per-call 明细只在同 scope/as_of 校验；根视图按唯一消费合并子会话，不同时加根累计与子累计。partial 展示 observed 与覆盖，不折缺失为0。

| 指标 | 统一口径 |
|---|---|
| 原始 input/output/reasoning/cache_read/cache_write | 保留分项/语义；缺推理量 null，不自动取0 |
| normalized_total_tokens | 语义明确的 input_full+output_full；input不含缓存则按已知读写 usage 语义补齐，output已含reasoning不再加；未知关系 null |
| generation_output_tps | 同 attempt 对应 output_full /（generation_ended_at−first_output_at）秒；区间>0且 scope相同。附 profile（包含 reasoning/工具参数与否），不是 Token/HTTP 或消息间隔 |
| turn_output_tps | 同轮 output_full / turn_execution 秒，称轮次产出率，不称模型生成吞吐 |
| cache_hit_rate | cache_read/input_full；input已含cache时不再加cache_read，分母>0且语义明确 |
| observed_input_peak_tokens | 同模型/profile的单次 input_full 最大值；不是Session累计、输入+输出或配置上限 |
| configured_context_limit | 配置声明上限，不证明本次使用了该容量 |
| credits / monetary_cost | Credits与货币cost分列、单位明确；0区分真零/占位。缺权威价格和计费规则不推官方单价；拟合仅探索假设，非费用事实 |

### 8.3 调用、重试、成功、人工确认与 Step

| 指标 | 统一口径 |
|---|---|
| llm_call_count | 唯一逻辑 llm_call_id 数；无逻辑映射null，另报attempt/消费记录数 |
| llm_attempt_count | 唯一实际请求attempt数，不用stream-start/assistant/rawUsage/cost行数无条件替代 |
| llm_retry_count / llm_retry_rate | 同逻辑调用中初次以外的实际attempt数 / 全部实际attempt数；另报有重试调用占比，名称/分母分离。覆盖或关联不足null |
| tool_call_count / tool_retry_rate | 实际ToolCall数；追加工具attempt数/全部实际工具attempt数。必须retry_of/原生关联，同名同参数或called-success差不证明重试 |
| attempt_success_rate / tool_execution_success_rate | known-ok/(known-ok+known-error)，明确终态为分母；同时报告总请求、cancelled/running/unknown和terminal_coverage，禁止隐藏缺失。exit=0只是源执行状态，不是业务成功 |
| human_confirm_count | 去重approval_id的human决定数；审批请求/自动权限/审查通过率另列。普通回复、allow规则、审批请求本身不计人工确认 |
| step_count | 唯一逻辑step_id数，重试/stream不新增；消息/Span/RPA business_step另计 |
| compaction_count | 去重原生compaction或语义已证实的prune完成记录，不从Token突降猜测 |
| event_count | 去重标准事件数、category合计；原始record_count分源另列。一行可拆多条tool.call，标准数不必等于源行数 |

terminal_coverage=(known-ok+known-error)/全部实际attempts，用于解释成功率；零分母null。客户端completed、审批通过、模型正常回应都是过程指标，不生成任务成功率。仅捕获retry而缺初次请求时保留证据，完整retry_rate为null。

### 8.4 诊断和归因

| 类别 | 证据要求 |
|---|---|
| gateway | 已定位模型上游传输/请求的超时、连接/TLS/5xx；本机任意HTTP错误不自动归网关 |
| tool | 明确执行失败/异常/非零退出且唯一call关联；缺success/拒绝审批/正文error不直接判错 |
| model | 模型响应格式/解析/协议错误或明确拒绝；拒绝不自动等于业务失败 |
| dependency | 定位sidecar/bridge/DB/MCP故障，不把所有非HERTZ Error归依赖 |
| agent | 定位Agent控制流/运行器内部错误，已知下游错误不重复称根因 |
| permission_denied / cancelled / unknown | 拒绝、取消、未归因/缺失独立，不硬塞工具失败 |

每条diagnostic保留ID、实体/阶段、规则版本、source_refs、direct/estimated、primary_category及secondary_tags。多日志同错误先去重，主类别互斥，不能确定则unknown；多个标签不叠加成多次失败。输出是证据支持的诊断，不是已证明因果根因，更不是Grader Score。

---

## 9. 与现有系统的集成关系

### 9.1 与 mobilework-trace-dashboard 的关系

旧项目既有 Mobilework 原生深度观测，也已有多对象 EAQE Bundle 阅读能力；不能描述为“只有单 Agent SQLite Dashboard”。本项目继承其可验证的观察能力，统一核心契约，将对象特性放进 Adapter；旧项目继续独立可用，不直接改造其发布包。

迁移依据：[server.mjs](../mobilework-trace-dashboard/server.mjs)、[index.html](../mobilework-trace-dashboard/index.html)、[需求文档](../mobilework-trace-dashboard/需求文档.md)、[版本迭代说明](../mobilework-trace-dashboard/版本迭代说明.md)。以下为迁移要求，不代表全部已实现。

| 能力 | 迁移要求 | 验收分类 |
|---|---|---|
| SQLite session/message/part/event 与 reporting/model-raw | 提取只读查询与纯解析器，多源按字段融合；新增 runs/audit 等源另验，不冒充旧版已覆盖 | 原有已证能力保持；新增能力独立验收 |
| 父子会话与 task 链接 | 显式 parent_id/sessionID 建树；root-tree 展示子代理，循环、缺失及不唯一关联报告 partial | 保持对象关系；加强完整度 |
| 请求模型与实际路由模型 | requested/routed 分列，保留模型识别依据和适用窗口；配置声明不能代替实际响应 | 保持且明确证据等级 |
| Step、attempt、重试链 | 保留原生消息/步骤/重试 ID 关联；text/reasoning/tool-input stream 不重复计 LLM 调用 | 统一口径后的有意变更 |
| 历史 stream/routed 摘要 | 支持已知 `mobilework-stream-timings/v4`、`mobilework-routed-models/v2` 的白名单读取；旧版本需显式版本映射，未知版本告警 | 保持已记录事实；不补造历史首 chunk |
| 实时首包与 chunk 间隔 | local-live opt-in；发生时间和 receipt 分列。旧“断流等待/无效耗时”只能映射 observed_chunk_gap，不直接判浪费 | 有意纠正名称与推断边界 |
| Skill/MCP/普通工具 | 继承类型与识别依据、原生 provider/skill name、能力快照窗口；当前目录不冒充历史快照 | 保持，输出允许公开的别名 |
| 轮次、压缩、执行时长 | 保留轮次边界/compaction；同轮间隔与跨轮用户等待分开，执行区间取并集 | 保持已有修正并补根/子去重 |
| Token/成本 | 保留原始分项与 Credits；旧 display total 仅以 `legacy_mobilework_display_total` 显示，默认归一总量走 §8 | 有意变更；旧显示与统一消费不混用 |
| Trace/导出 | 保留脱敏事件、工具类型、证据引用与完整度；不迁移任意原始表/Prompt/工具正文导出 | 安全收窄，不要求原文逐字 parity |
| 页面刷新 | Step/首包/重试/终态/revision 触发增量更新；chunk 不整页刷新；15s 兜底，保留展开/筛选状态及局部运行计时 | 保持交互行为，不固定旧 DOM |
| EAQE 目录、身份、证据时窗 | 保留多 Bundle、多 Trial、对象分组与显式跨对象选择；Outcome 独立展示 | 保持接口及契约语义 |

**迁移判定**：每项登记 `unchanged / intentional-change / not-migrated`、原实现入口、synthetic fixture、expected 与差异理由。未迁移能力在 UI/API 显式声明，不能静默删去或笼统称“完全兼容”。不直接 import 会启动服务/订阅 runtime 的旧 server；抽取纯逻辑，不复制副作用。

旧测试中存在真实 Session、已运行服务、个人路径或可选浏览器依赖，不能直接视为可移植验收。按其验证意图重建无敏感信息的 synthetic fixture 与独立 expected；旧测试和真实数据不改动。Parity 核对定义/关系/事实，故意纠正的公式按新口径验，不强求复现旧误计。

### 9.2 EAQE Bundle 兼容与 agent-eval 边界

参照 [EAQE Dashboard 集成工程入口](../../agent-eval/40-engineering/integrations/mobilework-trace-dashboard/README.md)。实现时必须覆盖下列兼容面：

| 兼容面 | 要求 |
|---|---|
| 输入配置 | `EAQE_DASHBOARD_BUNDLE` 默认单包；`EAQE_DASHBOARD_BUNDLE_ROOT` 递归发现；可选 `EAQE_DASHBOARD_BUNDLES` 多路径（平台路径分隔符），去重 |
| 文件接纳 | 仅 `format=eaqe-observation-dashboard-bundle-0.1.0`；binding/preflight/Outcome 文件不误接纳；未知格式诊断且不影响其它包 |
| 目录/选择路由 | 保留 `GET /api/eaqe-bundles`、`GET /api/eaqe-observations?bundle=<bundle-id>` 及默认包选择；未配置/无效选择返回明确404，不影响原生日志路由 |
| Bundle 身份 | 同一配置重复扫描 ID 稳定；不同 Trial 同名 `dashboard-bundle.json` 不合并。旧版父目录名 ID 无冲突时可兼容；碰撞时加命名空间并提供无歧义别名，不能任取首个包 |
| 业务身份 | 保留 evaluation_run_id/task_id/trial_id/trace_id 及来源；身份缺失显示 unbound，不把 session_id 自动变成 trial_id |
| 证据来源与时窗 | 保留显式 `evidence_origin=trace|hook|other`；缺字段的旧包可用版本化兼容推断并标注 derived。Trace/Hook/Event Window 分列，observed_at 不冒充 occurred_at |
| 页面 | 按身份/对象/别名筛选，按 Agent Object 分组；多 Trial 比较；跨对象必须显式选择且检查可比条件 |
| 安全 | Bundle 也走字段白名单与脱敏；目录标签/文件名默认别名，不输出个人路径。只兼容安全字段和已记录语义，不无条件透传旧 JSON |

NormalizedEvent 是观察台内部工程契约，**不是** EAQE Observation Event。若向 Bundle Builder 输出，另建版本化 mapper，对现有 EAQE Schema、identity binding、capability/preflight 做校验；不靠字段改名声称契约统一。Mapper 未完成前只读已有 Bundle，不宣称能反向生产有效 EAQE 事件。

本工具不运行 Agent、不创建 Task/Trial、不执行 Outcome Verifier 或 Grader。外部 Outcome 保留 verifier、验收标准、来源和运行身份，与 collector 状态分栏；客户端成功不能覆盖独立 Outcome，Fixture 不能标为真实 Trial。各对象差异不反向修改 agent-eval 核心语义。

### 9.3 与 LoongSuite Pilot 的关系

Pilot 可通过 Hook/插件等采集遥测；本项目默认被动读取已有本地文件，显式 local-live 时仅订阅已运行 runtime 的只读接口，不安装 Hook/插件或控制 Agent。两者互补，而非互相替代或“Pilot 等于整个观测体系”。

未来接入 Pilot/OTel/EAQE 证据须使用单独、版本化映射，保留 origin/trace/span/时间依据/覆盖/身份；多来源同事实按可靠 ID 去重。当前不承诺统一两者原始 Schema，也不将 Pilot 缺少的事件通过日志推断伪造为 Hook 证据。

---

## 10. 验证计划与验收标准

### 10.1 验证层次与执行状态

本节是实现后的验收要求，**当前未执行**：目录只有 SPEC，没有测试工程或已实现服务。规格结构检查只能说明文档一致，不能替代以下验证。

1. **契约/纯逻辑**：synthetic fixture 覆盖 Schema、关联、去重、指标与缺失；expected 手算或独立生成，不能调用被测指标引擎生成自身答案。
2. **Adapter/源融合**：可公开的人工构造 SQLite/JSON/日志与版本样例；无 Agent 安装、真实 Session、网络或凭据依赖。
3. **API/UI/兼容安全**：本机 fixture 服务，验证 API/SSE、刷新、EAQE、多对象与导出；浏览器依赖单独安装、版本固定。
4. **授权真实只读验收**：另行使用用户授权的本地源，所有产物在仓库外；报告只带脱敏计数、版本、源窗口和差异。源读取通过不证明业务成功，更不能把 synthetic fixture 说成真实 Trial。

计划配置 `npm run check`（语法/契约/静态校验）、`npm test`（离线 fixture）、`npm run test:browser`（浏览器 fixture）。这些不是当前可执行的现成命令；实施时在 README/package.json 落地并记录环境、命令、结果与证据位置。

### 10.2 核心语义黄金用例

以下时间单位 ms、数量为人工构造值；未说明时覆盖完整、关联唯一、时间同源。断言包括 value/state/evidence_grade/missing_reason/coverage，而不只比较数字。

| ID | 输入/场景 | 必须满足的期望 |
|---|---|---|
| CALL-01 | 1个已绑定逻辑调用、1次请求，text/reasoning/tool-input 各1个 stream | llm_call=1、attempt=1、stream=3；不能按stream计3次请求 |
| CALL-02 | 1个原生Step/逻辑调用，初次请求失败后实际重试1次 | Step=1、call=1、attempt=2、retry=1、retry_rate=1/2 |
| CALL-03 | 仅 error.isRetryable=true，没有后续请求证据 | 不新增实际retry；若缺完整调用覆盖，retry=null/partial，而非“下界1” |
| CALL-04 | 有重试事件，但同session中2个候选call且不能唯一关联 | 保留unbound/ambiguous；不任意挂入任一调用、不进入精确retry率 |
| USAGE-01 | 同 usage ID 在 function_call/assistant 或 cost/processResult 重复出现 | 消费只计一次；不同call相同usage数值仍计两次 |
| USAGE-02 | input=100已含cache_read=40，output=20已含reasoning=5 | normalized_total=120、cache_hit_rate=.4；原始分项保留，不再叠加40或5 |
| USAGE-03 | uncached_input=60+cache_read=40，visible_output=15+reasoning=5，互斥语义明确 | input_full=100、output_full=20、normalized_total=120、cache_hit_rate=.4 |
| USAGE-04 | 分项有值但包含关系未知；或根累计与子usage重叠未知 | 原始分项可展示，统一总量=null/semantic_unknown 或 partial，不静默相加 |
| TIME-01 | 两轮执行[0,1000]与[10000,12000]，Session墙钟[0,12000] | active=3000、lifespan=12000；9000用户等待不计step_gap |
| TIME-02 | 根执行[0,1000]、子执行[200,700]，树完整 | root-tree active=1000而非1500；消费按唯一usage，不加根累计+子累计 |
| TIME-03 | request=0、首模型chunk=200、首text=400，同attempt原生时间 | TTFT=200、first_text=400；仅有首chunk receipt=250时TTFT=null，observed_delay=250 |
| TIME-04 | TeleAgent应用收到请求0、cost记录2000、HTTP完成3000，无模型首chunk | application_request=3000；TTFT=null；cost不产生虚构request/response边界 |
| TIME-05 | 同轮Step完整结束1000、下个请求1200；重叠时下个请求900 | step_gap分别200与0；跨轮同样两个时间不产生该指标 |
| TIME-06 | 无事件时间，仅mtime；另有独立RPA运行[0,500] | LLM时延=null；RPA=500独立展示；source_seq排序，无mtime造occurred_at |
| RATE-01 | 1个ok、1个error、1个unknown执行结果 | execution_success_rate=.5、known_terminal_coverage=2/3；不报2/3业务成功 |
| RATE-02 | 完整窗口内没有确认；另一个窗口完全未采集审批 | 前者human_confirmation=0/captured，后者=null/not-captured；拒绝/取消单列 |
| PERM-01 | perm allow、review result=1、approvalID/allow规则；普通用户回复“好” | 无实际执行证据不能tool.success；无明确human actor+decision不能计人工确认 |
| STAT-01 | 完成且同口径样本[10,20,30,40,50] | nearest-rank P50=30、P95=50、n=5且P95=low_sample；n=0为null |
| STAT-02 | 混入running/null/estimated、不同定义版本/时间基础/scope/profile | 默认排除或分组并报告eligible/excluded/reason，不混为一个可比总体 |
| DIAG-01 | 多源重复同错误，同时带gateway/dependency标签 | 同一diagnostic只计1次，primary互斥、secondary不叠加；未证明根因明确标注 |

### 10.3 数据源、增量与 Mobilework 迁移回归

| ID | 验证项 | 通过标准 |
|---|---|---|
| SRC-01 | 无安装/只发现1对象/只读源缺表 | API准确声明registered/discovered/available；不要求本机必须四对象齐全、不用计数>0作为唯一成功标准 |
| SRC-02 | SQLite WAL/锁/超时；坏JSON、NDJSON尾半行；一源暂不可用 | 有界只读查询、不checkpoint；尾半行下次重读，坏行可定位到脱敏源别名；其它源/对象仍服务 |
| SRC-03 | 文件轮转/截断/重复读取/乱序迟到、事件重放 | generation/offset与原生ID使读取幂等；迟到补关联不增加重复事实；不能用时间靠近吞并独立记录 |
| SRC-04 | runs累计摘要多revision，独立run同数值，as_of不同 | 同范围累计更新而非相加；独立run保留；不同as_of不直接对账 |
| SRC-05 | 根/子缺失、循环、多父关系、工具task关联不唯一 | 有界遍历、partial/ambiguous明确；不重复耗时/消费、不无声丢节点 |
| MW-01 | DB、reporting、model-raw、runs提供互补/冲突字段 | 多源都参与；身份/真实模型/usage/时序按§5.2；冲突留证据而非“高优先级存在便跳过” |
| MW-02 | stream-timings/v4、routed-models/v2已知窗口与缺历史首包 | 正确恢复已记录事实/覆盖；缺历史首包不回填；未知格式unsupported_version |
| MW-03 | Skill/MCP/普通工具、compaction、task子会话与model路由 | 类型及识别依据、树、轮次、实际模型完整保留；每项有迁移分类和expected |
| MW-04 | 旧legacy total、chunk gap与新口径并行 | 旧显示可复核但不作为默认统一总量；chunk批报不宣称真实断流/浪费；有意变更报告可审计 |
| UI-01 | 连续chunk、首包/重试/终态、revision、15s兜底 | 普通chunk不整页重绘；关键变化可见；运行计时局部更新，筛选/展开/选择状态稳定 |

Adapter版本、源版本、schema/metric版本在样例和回执中固定。新增对象/源必须增加相关fixture；相同核心黄金用例由不同Adapter映射后继续成立。

### 10.4 EAQE、隐私与真实只读验收

| ID | 验证项 | 通过标准 |
|---|---|---|
| EAQE-01 | 单包、递归ROOT、多路径BUNDLES、不同Trial同名文件与同父目录名碰撞 | 去重且选中准确；ID稳定、冲突不任取；非bundle JSON不入目录 |
| EAQE-02 | 无配置、默认包、显式bundle选择、格式损坏、未知ID | 两条兼容路由状态明确；无效包不影响原生查询；无任意path读取 |
| EAQE-03 | trace/hook/other、新旧包、身份缺失、Fixture与外部Outcome | 显式origin优先；旧推断标derived；独立窗口/对象分组和身份筛选正确；不伪造Trial、不把Stop当Outcome |
| EAQE-04 | 未来export mapper的契约/identity/capability preflight | 使用现有契约真实校验；未绑定不宣称评测就绪；mapper缺失时只提供只读Bundle能力 |
| SEC-01 | 人工canary：密钥、Prompt、reasoning、工具正文、绝对路径及无敏感键名的自由文本 | API/SSE/cache/JSON与Markdown导出均无canary；白名单拒绝原文。仅regex零命中不足以通过 |
| SEC-02 | 标题/metadata包含HTML脚本、跨源请求、非loopback地址、路径穿越/符号链接出界 | HTML转义、Origin/CORS约束；拒绝非loopback runtime/任意path；解析后仍在授权源范围，不写源目录 |
| SEC-03 | offline运行、local-live断连/凭据、缓存写入 | offline不连接runtime/外网；凭据只在内存；派生目录在仓库和Agent源之外且已脱敏，断连声明覆盖缺失 |
| REAL-01 | 用户授权后，固定源版本/as_of与窗口，独立只读抽样核对 | 原始库/文件不修改，逐字段比较并记录一致/差异/不可观测；只产生仓库外脱敏回执，不承诺所有指标可用 |

真实验收结束报告适配器版本、源健康、可用字段、精确/推导/估计/未知数量及差异清单。不以“读取到了session”代替指标验收，也不以日志指标验收宣称业务结果通过。

---

## 11. 限制与风险

| 风险 | 影响与约束 | 缓解/必须暴露的信息 |
|---|---|---|
| 历史首chunk未记录或只有receipt | TTFT缺失/不是模型原生时延；完整generation span也不等于首包 | null+missing_first_chunk；观测延迟/trace时长分列，不拿其它范围替代 |
| 缺call/attempt/Step/重试关联 | 不能用isRetryable、错误后新cost或stream数推出实际重试 | 返回unbound/ambiguous/partial；精确retry率不可用，不编“下界” |
| 多源usage复制/分项包含语义未知 | 消费、缓存率及统一总量可能重计 | 原生ID去重、profile版本化、原始分项保留；未知语义不排名 |
| TeleAgent应用request与模型调用多对多 | request_id不能自动代表LLM call；cost不是request/first token | HTTP范围独立；cost/processResult去重；缺模型边界null |
| 权限/审查不等于执行、人类决策 | allow/result=1/approval规则可能误计成功或人工确认 | actor+decision+关联证据；权限、工具执行、独立业务Outcome分离 |
| cost=0占位、单位/价格缺失 | 假零成本、Credits混货币或虚构官方单价 | 真零/占位/未知分离；保留单位来源，不反推费用事实 |
| Doubao无LLM usage/时间或双层弱关联 | LLM时延/Token缺失，RPA不能填补模型边界 | source_seq排序，mtime仅发现诊断；RPA独立scope，关联不唯一不合并 |
| chunk批量上报与时钟差 | 观测gap可能不是生成停顿；负时长/错序 | 时间依据和精度、窗口、clock冲突提示，不称无效耗时 |
| 数据库WAL/日志轮转/部分写入 | 不一致快照、重复或漏读 | 有界只读、as_of/revision、幂等游标与局部健康；不能为取快照写原始库 |
| 版本漂移/正则规则遗漏 | 源字段改名或误判；一个高证据字段掩盖其它缺失 | 解析/profile版本固定；unsupported_version局部降级；字段级证据与规则回归 |
| 根/子、Session/Turn/Trace范围混淆 | 时间/消费双算，任务等待误计执行 | 显式scope/membership、树完整度、区间并集和usage唯一性 |
| 样本量小/模型任务不同/覆盖偏差 | P95不稳定，跨对象排名误导 | n/排除原因/semantic_profile显式；可比门禁，不宣称公平Benchmark |
| Bundle同名冲突、身份或契约缺失 | 读错Trial、把Fixture展示成真实结果 | 稳定ID/冲突处理、既有Schema/identity/preflight，不补造身份 |
| 源正文/异常/目录标签泄露 | 白名单之外的日志原文包含敏感业务信息 | 脱敏先于持久化/响应；canary覆盖所有出站面；安全兼容优先于旧原文导出 |
| 旧Dashboard能力静默退化 | 新方案看似统一却失去树、路由、流时序或工具识别 | §9迁移矩阵逐项登记，§10 parity；不迁移项公开声明 |
| 当前仅规格、无实现 | 文档完成易被误报成工程或真实验证完成 | 保持draft；分阶段完成回执，真实验收另记录；不写虚构测试通过 |

---

## 12. 实施顺序与完成门禁

本项目的实施排序仅针对观察台，不改变工作区以 WorkBuddy 先跑最小真实评测闭环的主线。先用已有 Mobilework 原型验证迁移不退化，再用其它对象验证核心契约可替换。

| 阶段 | 交付与范围 | 完成门禁 |
|---|---|---|
| P0：核心契约 + Mobilework离线迁移 | Schema/Evidence/MetricResult、纯指标引擎、脱敏/关联/去重；synthetic fixtures；Mobilework DB/reporting及已知脱敏摘要、多源融合、树/工具类型/轮次/usage；最小API/页面 | §10黄金用例、SRC/MW及离线安全通过；§9矩阵每项有分类；不支持项显式返回缺失；无依赖真实Agent的自动测试 |
| P1：可替换对象与兼容交付 | WorkBuddy transcript/trace、TeleAgent结构化日志/DB；EAQE只读目录/页面兼容；opt-in local-live、时序增量UI、受限对比 | 同一核心用例适用于多Adapter；EAQE/UI/安全回归；授权真实只读核对留脱敏回执，明确哪些TTFT/重试等仍不可得 |
| P2：Doubao双层与诊断增强 | Doubao LLM/RPA分别映射，bridge关联；版本化诊断、扩展源、可选EAQE export mapper | 双层不双算、未知时间/usage不伪造；mapper如交付通过现有契约及binding/preflight；诊断不得冒充Grader/根因证明 |

每阶段回执包含变更文件/实现版本、测试命令与结果、synthetic或真实证据类型、覆盖窗口、遗留限制、安全检查与迁移差异。缺少首chunk/原生重试/人工确认是源能力限制，不通过臆测清零来满足门禁。

**本次规格完成标准**：目标/边界明确，旧能力迁移可追踪，指标口径可手算，缺失/可比/隐私规则可测试，实施顺序与验收可执行。达到该标准只表示工程规格优化完成，不表示P0/P1/P2已实现、全部对象已支持或业务验证通过。
