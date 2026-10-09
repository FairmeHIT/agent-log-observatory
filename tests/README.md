# Tests

项目根目录运行 `npm test`（Node 24.x）。

- normalizer/redaction/adapters/collector-reader：原有 83 项指标、契约和脱敏测试。
- portability：12 项 JSONC、Unicode/空格/相对路径、本地配置报错、模拟客户端插件/代理安装回退、冲突拒绝、项目内采集输出、离线依赖和启停边界测试。

新便携性测试只写忽略提交的 `runtime/portability-tests/`，不修改真实 Agent 配置；保留失败诊断，不广泛递归删除用户路径。

完整部署验证：`npm run release` 后，在导出目录运行 `node scripts/setup.mjs`、`npm test`。这不等于真实 Agent 跨版本/跨机器采集兼容验证。
