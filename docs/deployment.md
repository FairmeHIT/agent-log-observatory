# 部署与采集器：step-by-step

本文所有命令在**项目根目录的 PowerShell**执行。只需历史 Dashboard 时，做到第 1 节即可；其余按所用 Agent 选择，不必全装。

## 1. 从零部署

1. 准备 Windows x64 和 Node.js 24.x（安装时保留 npm、加入 PATH）。运行 `node --version` / `npm --version`。
2. clone/复制完整项目，确认 `vendor/npm/*.tgz`、`vendor/manifest.json`、`runtime/sqlite3.exe` 存在。不要只复制 server/index。
3. `node scripts/setup.mjs`：离线 `npm ci`，依赖只装入项目 `node_modules/`，npm 缓存在 `runtime/npm-cache/`；不会安装客户端/插件、修改 Agent 配置或执行包安装 Hook。
4. 编辑 `agent-log-observatory.config.json`。用户数据目录有默认值；不同目录按字段覆盖。`installDir` 默认不猜测，只有需要拉起客户端时才填。例：

   ```json
   {
     "port": 8780,
     "agents": {
       "mobilework": { "installDir": "C:/Apps/Mobilework", "dataDir": "~/.mobilework" },
       "opencode": { "configDir": "~/.config/opencode", "dataDir": "~/.local/share/opencode" }
     }
   }
   ```

   不要填写 `<username>` 之类未替换占位符。`~/` 展开当前用户；`${LOCALAPPDATA}` / `${APPDATA}` 展开环境变量；相对路径从项目根解析。缺省路径见 `lib/config.mjs`。
5. `npm run doctor`，所有 `[FAIL]` 修复后再启动。`[OPTIONAL]` Agent 不存在不是安装失败。
6. `node server.mjs`，访问 `http://127.0.0.1:8780/`（自定义 port 后相应修改 URL）。或用 `启动.cmd` 隐藏后台一键启动 Dashboard 与采集器（豆包未开调试端口时自动跳过）、`停止.cmd` 全部停止。
7. 检查 `/api/health` 与 `/api/sessions`。先在至少一个 Agent 正常完成会话，刷新 Dashboard；空目录不能产生真实数据。

**同版本依赖已随项目归档，无需联网安装 npm 包**。Node 自身/Agent 客户端由用户准备；客户端正常使用可能需要网络与账号，不属于观察台离线保证。当前分发/测试范围仅 Windows x64；其他系统须准备对应 SQLite CLI 并验证适配器。

## 2. opencode 插件（必须外置的仅“注册引用”）

源码原件在 `collectors/opencode-collector-plugin/`；原始改造前归档在 `vendor/archives/`。项目内源码是后续安装的唯一来源，不另维护用户目录副本。

1. 安装并正常使用 opencode。当前实现面向已验证过的 **V2 `ctx.session.hook` 契约（v2.0.6）**；别的版本不能仅凭名称认为兼容。
2. 配置 `agents.opencode.configDir`，其中须存在 `opencode.jsonc` 或 `opencode.json`。先关闭/退出客户端。
3. 查看状态：

   ```powershell
   node collectors/install-opencode.mjs status
   ```

4. 显式安装：

   ```powershell
   node collectors/install-opencode.mjs install
   ```

   首次备份 `<配置文件>.collector.bak`，向 `plugins` 添加本项目插件绝对路径；不复制源码、不改模型/权限/凭据字段。配置会重排为 JSON，原始注释保留在备份。
5. 重启 opencode，正常发送一条消息；检查 `runtime/collectors/opencode/attempts-YYYYMMDD.jsonl` 和 Dashboard。诊断在 `runtime/plugin-hook-diag.jsonl`；出现 `no ctx.session.hook` 表示版本不兼容。
6. 卸载/回退：

   ```powershell
   node collectors/install-opencode.mjs uninstall
   ```

   只移除本项目引用，保留其他后续配置和备份，然后重启客户端。要完全恢复原始格式，**先另备份当前文件**，再手动将 `.collector.bak` 复制覆盖配置。

**项目搬家前先卸载，移动后重新 install**；客户端保存的是绝对路径，不会跟随 clone 自动更新。

## 3. Mobilework HTTP 代理（默认无需安装插件）

源码在 `collectors/mobilework-llm-proxy/`。当前实现仅转发 **HTTP 上游**，不能作为任意 HTTPS/CONNECT 代理；不支持的 provider 应直接使用客户端，不宣称已采集 TTFT。

### A. 推荐：进程级 HTTP_PROXY

1. 在本地配置填写 `agents.mobilework.installDir`，目录下应有 `MobileWork.exe`；非标准文件位置可显式设置 `$env:AGENT_LOG_MOBILEWORK_EXE`。
2. 自行关闭已打开的 Mobilework，避免单实例客户端沿用旧进程环境。
3. 执行 `启动Mobilework.cmd`。只启动本项目 HTTP 代理（8890）、Dashboard（配置 port）和客户端；只给新启动的客户端设 `HTTP_PROXY`/`NO_PROXY`，不改系统环境变量。
4. 在 Mobilework 正常发消息，检查 `runtime/collectors/mobilework/attempts-YYYYMMDD.jsonl`，再查看 Dashboard。
5. 自行关闭 Mobilework，再运行 `停止.cmd`；之后直接打开客户端就不会继承本次代理环境。脚本不会强制终止 Agent 客户端。

### B. 可选：反向代理（会修改外部配置）

客户端不遵循 `HTTP_PROXY` 时才选本方案。

1. 关闭 Mobilework；确认 `agents.mobilework.dataDir/config/providers.jsonc` 正确。
2. `node collectors/install-mobilework-proxy.mjs status`。
3. `node collectors/install-mobilework-proxy.mjs install`：首次备份 `providers.jsonc.llm-proxy-bak`，仅替换 provider `baseURL`，并生成私有 `runtime/mobilework-proxy.json` 路由。同一 path prefix 对应不同上游会拒绝安装。
4. `node collectors/mobilework-llm-proxy/index.mjs` 保持代理运行，另开 Mobilework 和 Dashboard。或者使用 A 的启动脚本启动组合。
5. 发消息并核对采集文件。路由文件属于本机配置，**不可随发布公开**。样板是 `collectors/mobilework-llm-proxy/proxy-config.example.json`，无需复制个人上游地址。
6. 回退：关闭客户端，`node collectors/install-mobilework-proxy.mjs uninstall`，然后停止代理、重开客户端。uninstall 用备份恢复 providers 整个文件，**会丢弃安装后的 providers 修改；回退前自行备份当前配置**。

代理采集无法从标准请求提取 session ID，适配器按时间窗关联；并发会话的精确归属有局限。当前 first_output 采用响应到达的派生时点，不等于原生首 token。

## 4. Doubao CDP（无额外插件）

1. 自行退出 Doubao，确认安装目录的实际 `Doubao.exe`（常见在 `app/`）。
2. 用实际路径手动启动：

   ```powershell
   & 'C:/Apps/Doubao/app/Doubao.exe' --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1
   ```

   不将调试口暴露到局域网/公网；不要在对外发布的截图中公开会话 URL。能否开启 CDP 取决于客户端版本。
3. `Invoke-RestMethod http://127.0.0.1:9223/json/version` 确认本地调试口可访问。
4. 运行 `启动.cmd`（检测到 9223 端口会自动附着采集器），或前台运行 `node collectors/doubao-cdp-collector/index.mjs`。非默认端口先设置 `$env:DOUBAO_CDP_PORT`。
5. 在豆包**正常发消息**，确认 `runtime/collectors/doubao/attempts-YYYYMMDD.jsonl`，诊断/锁文件在 `runtime/`。然后查看 Dashboard。
6. `停止.cmd` 即可停掉采集器；退出 Doubao 并不带调试参数重新启动，关闭 CDP。没有要卸载的客户端插件。

当前 TTFT 在未收到首 chunk 事件时回退到 `responseReceived`（derived）；Token/model 字段缺失保持 nc。不能从 `fetch_token` 推断 Token 消耗。

## 5. 老电脑迁移、排错与发布

- 旧采集文件：`node scripts/import-legacy-collectors.mjs`；可加自定义源目录作为参数。只复制 attempts 文件，不复制客户端配置/凭据，不覆盖已有同名文件。原目录仍保留；要合并同名文件须另行核验去重。
- 已运行的旧服务/插件不会热换代码：先正常停旧进程/重启客户端，再用新脚本启动。新脚本不会杀未登记的旧进程。历史 Dashboard 缓存库不清空；此前复制来的代理路由保存在私有 `runtime/mobilework-proxy.json`。
- 本机安装盘点：`node scripts/audit-local-installation.mjs`，只记录本插件引用/哈希/备份存在性，输出 `runtime/private/local-installation.json`。找不到配置表示未验证，不是声称已安装。
- Mobilework 旧 trace-dashboard/sidecar 是**可选遗留输入**；无需安装另一项目或闭源 sidecar 才能运行。仅在确有旧数据时显式填 `dashboardDataDir`；本项目代理是独立补充方案，但不保证补齐所有旧 sidecar 字段。
- 端口占用：新脚本拒绝抢占，不杀监听进程；先停原服务或改 Dashboard port。Windows PowerShell 的本地执行策略只在本次启动命令使用 Bypass，不永久修改策略。
- 检查 `runtime/logs/*.err.log`；重装依赖用 `node scripts/setup.mjs`。不要拷贝旧机器的 `node_modules`。
- `scripts/probe-doubao-cdp*.mjs` 是实验工具，**不在 setup/启动流程中执行**；trigger 脚本会操作界面并发送消息，可能产生费用/在控制台输出正文，只有明确调试授权后才使用。
- 发布：`npm test` → `npm run release` → 审查输出目录及许可证 → 再压缩/提交。导出器使用白名单而非复制整个工作目录；已有同名发布目录时拒绝覆盖。
