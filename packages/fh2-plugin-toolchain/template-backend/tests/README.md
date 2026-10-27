# 后端插件测试

`pnpm run validate` 已覆盖结构契约：manifest schema、workflow 接线、脚本入口、模块策略
（禁止 Node 内置/裸包 import、禁止动态 import 与计时器 —— 沙箱没有 Event Loop）。

业务行为测试（Handler 幂等、事件重放、错误信封）放在这里，优先隔离纯逻辑并打桩生成类型中
真实存在的上下文边界；不要调用未公开的 Toolchain 内部类来代替插件测试。

开发者工具创建的独立后端模板没有默认 `test` script，Capability 工作区根的 `test` 只运行已有
前端成员测试。需要测试依赖/脚本时先说明并确认，在实际工程配置后运行，不虚报后端已经通过。
本地 Gateway 的调用和状态复验按上级 README，用本次打印地址，不保存调试凭据；本地结果不代
目标环境或真实 Workflow 执行。

本模板不带测试文件；`types/` 是生成物，勿手改。用本地 CLI 的 `fh2-plugin types --check`
核对是否过期，命令位置和包管理器以实际生成的 README/scripts 为准。
