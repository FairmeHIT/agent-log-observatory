# AGENTS.md：项目契约与边界

> Scope：本项目及子目录。首次阅读：本文件 → SPEC.md → README.md。
> 使用标准名称 `AGENTS.md`，不另建内容重复的 `AGENT.md`。

## 1. 定位

可独立 clone/部署的跨 Agent 本地日志观测工具；不依赖父工作区、其他 Dashboard 或某个开发者的用户目录。Agent 差异留在 Adapter Plane，指标引擎保持通用。

当前工程版本 **v0.0.9**。Windows x64 + Node.js **24.x** 是本次验证组合；跨系统移植须另验，不能照搬旧版 Node 18 的说明。

## 2. 文件所有权与外部边界

| 类别 | 归属/位置 | 规则 |
|---|---|---|
| 服务、UI、适配器、共享库、schema | 项目根目录、`adapters/`、`lib/`、`schemas/` | 不引用父目录或旁路子项目 |
| 插件、采集器、安装/启动/停止脚本 | `collectors/`、`scripts/`、根目录 `.cmd` | 唯一可执行源码在项目内；复制/安装规则有文档 |
| 第三方依赖/原始插件归档 | `vendor/`、`runtime/sqlite3.exe` | 固定版本、保留许可证/来源/哈希；完整发布不得漏掉 |
| 本机配置/真实数据/运行产物 | 本地配置 JSON、`runtime/`、`node_modules/` | 忽略提交，不进入公共发布；缺失时可按文档重建 |
| Agent 客户端/账号/模型服务/原始日志 | 用户安装的外部输入 | 不复制进仓库，不自动安装客户端，不修改其原始日志 |
| 必须外置的插件注册/代理配置 | Agent 自己的配置目录 | 仅用户显式运行安装命令时允许；安装前备份，提供 status/uninstall，不动无关字段 |

**新增任何外部工具/插件依赖**，必须在 `docs/dependency-inventory.md` 登记：必要性、版本、原始文件/源码位置、许可证/分发状态、step-by-step 安装/验证/回退。未登记的个人机器工具不得成为隐性启动依赖。

项目内采集输出默认 `runtime/collectors/`；不得默认写入 `~/.agent-log-observatory/`。环境变量路径覆盖是显式高级选项，不得成为隐藏前提。旧历史只能显式 copy-only 导入，不自动删除/覆盖源。

## 3. 安全与语义约束

- **Agent 原始源只读**：SQLite 用 `-readonly`；不要 checkpoint、改库、改日志。
- **被动读取与主动采集分开**：默认 Dashboard 只读本地文件；不自动安装 Hook/插件，不自动发模型请求。可选代理会转发用户已有模型流量，不能声称其也完全离线。
- **脱敏**：API 保持 `redact()` + `whitelistFilter()`；正常采集诊断不落盘 Prompt/请求或响应正文、凭据、令牌。真实采集数据仍是私有运行数据。
- **缺失不冒充 0**：无法获取的指标返回 `value:null`、`state:"not-captured"`、`missing_reason`。
- **时间**：人类可读时间使用 `Asia/Shanghai`；区分原生、派生与估计证据。响应头时间不等于原生首 token 时间。
- **Adapter 隔离**：Agent 特定逻辑放 `adapters/`；`extractMetrics()` 委托 `lib/metrics.mjs`，不另写同名公式。
- **进程边界**：不得按端口、`node.exe`、Agent 名称杀无关进程。后台助手隐藏启动；只停止经路径核对的本项目登记进程。
- **配置**：项目内本机配置优先，环境变量显式覆盖；不用个人绝对路径当默认值。无效配置应报错，不静默切换用户目录里的旧配置。

## 4. 支持对象与缺口

| Agent | 默认外部数据源 | 主要限制/可选增强 |
|---|---|---|
| WorkBuddy | `~/.workbuddy/` transcript/trace | TTFT 依赖 generation span；重试/人工确认受源限制 |
| Mobilework | `~/.mobilework/` SQLite/runs/model-raw | HTTP 代理可补 TTFT；旧 sidecar 仅可选读入，不要求安装 |
| TeleAgent | `~/.local/share/TeleAgent/`、`~/.config/TeleAgent/` | 日志无首 token 锚点，TTFT nc |
| Doubao | `${LOCALAPPDATA}/Doubao/`、`~/Doubao/` | CDP 可补 derived TTFT/retry；当前响应无 Token usage |
| DSH | `~/.dsh/`、`${APPDATA}/dsh-desktop/` | 多帧 zstd；失败归因受源限制 |
| Codex | `~/.codex/` SQLite/config + `sessions/**/rollout-*.jsonl` | Token 分项读 rollout `token_usage_record`（input 含 cache、output 含 reasoning）；旧会话回退 logs 累计值按 turn 去重取 diff；credits/retry 缺失 |
| opencode | `~/.local/share/opencode/`、`~/.config/opencode/` | 可选 V2 session-hook 插件；版本兼容必须实测 |

新电脑只安装一部分 Agent 也是合法部署；不能要求七个都 `available=true`。

## 5. 验证与变更同步

```powershell
node scripts/setup.mjs
npm run doctor
npm test
npm run release
```

| 变更 | 必须同步 |
|---|---|
| Agent/数据源 | 适配器 discover/extract、fixture、适配器指南、缺口说明 |
| 指标/结构 | 共享 metrics/normalizer/evidence、schema、fixture/测试 |
| API/缓存表 | server/UI、observatory-db、需求与测试 |
| 路径/依赖/安装脚本 | 通用示例、部署文档、归档清单、SHA-256/lockfile、便携性测试 |
| 发布 | 白名单导出；排除个人配置/真实历史/凭据；人工核查许可证与隐私 |

验证回执区分自动测试、原生模块检查、真实只读检查与未实测的客户端安装；不把 Fixture 或进程启动说成真实 Agent 采集成功。
