# releases：发布导出

运行 `npm run release`，生成独立目录 `agent-log-observatory-<version>/` 及文件哈希清单。已有同名目录时拒绝覆盖，以免误删旧交付。

导出包含源码、脱敏 fixture、通用配置、依赖归档和 SQLite；不包含个人配置、真实日志、DB、node_modules 或运行产物。

在导出目录执行 `node scripts/setup.mjs`、`npm test`，再人工核查隐私和许可证；通过后可打包该目录，而不是打包整个工作目录。实际输出忽略提交；本说明保留。
