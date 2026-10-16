# Doubao 0.3 验证回执

验证环境：2026-10-13（Asia/Shanghai），Windows x64，Node.js 24.19.0。工程 v0.0.10，Doubao adapter/collector 0.3.0。

| 检查 | 结果与边界 |
|---|---|
| 根目录 `npm run doctor` | 通过：Node/平台/内置 WebSocket + zstd、6 个归档 SHA-256、SQLite CLI、better-sqlite3 原生加载和内存查询 |
| 根目录 `npm test` | 119/119 通过；包括合成轨迹、SSE/WS 状态机、HTTP 接口、UI 渲染/转义、离线依赖和安装回退测试 |
| 根目录 setup | 首次被已运行服务占用的原生模块阻止（EPERM）；未杀无关服务。依赖按固定 vendor 包恢复，doctor/测试通过 |
| 独立导出目录 setup | `node scripts/setup.mjs --dependencies-only` 离线安装 2 个固定包成功，随后的原生模块/归档检查通过；不安装 Agent 或注册插件 |
| 独立导出目录测试 | 同一 119 项全部通过；导出目录使用自己的源码、依赖和 runtime，不引用父工作区库 |
| 发布 | `npm run release` 白名单导出；清单以 SHA-256 固定文件内容。验证时生成的运行数据留在单独验证目录，最终导出不含 node_modules、本机配置、真实日志或凭据 |
| 本机真实数据只读 | 完成 trajectory 只读配对检查；可观察工具调用/返回，未发现结构化工具终态，不能据此报告工具成功率。详细本机数量留在私有 `runtime/research/doubao-readonly-verification.json`，不进入发布包 |
| 本机 RPA | 发现全局 runner/bridge 与会话私有 RPA trace，按明确 ID/目录所有权过滤；仅基础设施耗时，不能作为内部 LLM/任务 E2E |
| 真实 CDP 采集 | 本机 9223 不可连接，0.3 尚未完成实际客户端采集验收；协议 fixture 不替代真实事件覆盖证据 |
| 外部客户端 | 未安装/重启豆包，未改其配置或原始源，未主动发送模型请求；已有运行服务未自动替换 |

自动测试中的所有新 Prompt/工具参数/响应均为合成数据。HTTP 测试在随机 loopback 端口运行隔离服务，仅终止测试自己创建的明确 server 子进程。UI 验证为脚本执行/渲染检查，不宣称跨浏览器视觉验收。

第三方归档核对：本次无新增运行依赖；已有 MIT 依赖许可证、SQLite 来源限制及 Apache-2.0 项目许可证保留。来源说明不等于独立验证上游二进制签名；没有对外发布或上传。

运行中的旧 Dashboard 不会热换代码。正常重启后应用新 adapter 并刷新豆包展示缓存；已有 `metrics?fresh=1` 可用于新服务的只读指标核对。实时流指标仍需客户端显式开启 CDP 并具备唯一会话绑定后再跟随用户任务验证。
