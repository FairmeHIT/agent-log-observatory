# runtime：私有运行产物

**只有本文件和 `sqlite3.exe` 随发布分发。** 其他内容都可包含本机路径、真实会话/采集历史，不要提交或公开。

默认目录：`collectors/<agent>/attempts-YYYYMMDD.jsonl`、`logs/`、`processes/`、`tmp/`、`npm-cache/`、`private/`，以及缓存 `observatory.db*`、资源快照、代理路由、采集器锁/诊断。

目录缺失会在使用时创建。不要在服务运行时删除 DB/WAL、PID 或锁文件。运行缓存不是依赖原件；依赖原件在 `vendor/`。

SQLite CLI 的版本/哈希/来源状态见 `vendor/manifest.json` 与 `docs/dependency-inventory.md`。
