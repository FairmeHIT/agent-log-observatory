# vendor：可复现依赖与原始文件

必须随 clone/完整发布分发，不从开发者用户目录寻找替代品。

- `npm/`：正在使用的两个 npm 包的本地重打包 tgz；setup 离线安装。
- `licenses/`：归档包的 MIT 授权原文。
- `archives/`：2026-10-04 便携化改造之前的插件/采集器/安装脚本原件；历史参考，不作为安装入口。
- `manifest.json`：SHA-256、版本、大小、来源说明；`npm run doctor` 检查。

更新依赖时：核验来源/许可证 → 替换 tgz → 同步 package/lockfile 和 manifest → 干净目录离线 setup → 运行测试。不要只替换 node_modules 或复制其他电脑编译的绑定。

详见 `docs/dependency-inventory.md` 与 `THIRD_PARTY_NOTICES.md`。
