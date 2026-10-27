# 违停巡逻插件（official_parking_patrol）

从宿主原生仓迁移的违停巡逻前端：任务面板、抓拍记录、证据预览、
返航倒计时与安全结束任务。架构与目录职责见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

Mock 数据源由 config `enableMock` 控制，默认 **true**（联调演示基线）：内置剧本模拟器
驱动完整链路，点击 Cockpit Menubar「违停抓拍」逐阶段推进（下发任务 → 初检 → 复检 →
证据回传 → 返航倒计时；该按钮仅在 Mock 模式贡献，真实模式不显示）。接入真实后端时将
default 改回 false，或由宿主经 Engine `setConfig` 注入 override（`EngineInstance extends
PluginRegistry`，门面已透传该方法，当前宿主前端未接调用入口）。

```sh
pnpm --filter @traffic-capabilities/official-parking-patrol build   # 构建
pnpm --filter @traffic-capabilities/official-parking-patrol test    # 单测
pnpm --filter @traffic-capabilities/official-parking-patrol tsc     # 类型检查
```
