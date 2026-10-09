# Doubao CDP Collector

实现与原始 package 在当前目录；无需额外 npm 包或用户目录插件副本。使用 Node.js 24.x，前提是客户端开启仅本机可达的 CDP。

安装、使用、检查采集文件与回退：见项目 `docs/deployment.md` 第 4 节。

默认输出：`runtime/collectors/doubao/attempts-YYYYMMDD.jsonl`；锁/诊断同属项目 `runtime/`。没有首 chunk 事件时 TTFT 回退为 derived 响应时间；缺失 usage/model 不推断。
