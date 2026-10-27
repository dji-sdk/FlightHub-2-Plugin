# 交通抓拍插件（变道抓拍 / 行人上路抓拍）

Cockpit 业务插件，演示两种抓拍模式的完整闭环。建议按下面顺序阅读：

```text
fh2-plugin.json                        # 扩展/视图/权限声明
→ src/plugin.ts                        # Host 分发入口
→ src/hosts/cockpit/activate.ts        # 组合根：env → 两个领域模块 → capture 模块
→ src/hosts/cockpit/runtime-env.ts     # 能力获取、上下文、Mock|HTTP 数据源切换、告警
→ src/hosts/cockpit/lane-change/       # 变道领域：API/Mock/controller/records/preview/module
→ src/hosts/cockpit/person-road/       # 行人领域：API/Mock/controller/records/preview/module
→ src/hosts/cockpit/mock-runtime.ts    # 显式组合两个 Mock API 与共享 WS
→ src/hosts/cockpit/capture/           # controls/records-host/preview-host/map-preview/module
→ src/views/capture-records/           # 父 View + 两个领域子面板（仅父 View 是 Manifest Entry）
→ src/views/capture-evidence-preview/  # 父 View + 两个领域子预览（仅父 View 是 Manifest Entry）
```

## 目录结构

```text
src/
├── shared/          # 真正共享的 invoke transport、响应解析、告警、GeoPoint 与模式常量
├── hosts/cockpit/
│   ├── lane-change/ # 变道抓拍领域及独立 records/preview 状态
│   ├── person-road/ # 行人上路领域及独立 records/preview 状态
│   └── capture/     # 父级设置、记录/预览 Host 与显式组合模块
└── views/           # Manifest 父 View Entry；领域子组件静态打入对应父 Entry
```

## 两种模式

**违章变道抓拍**：`cockpit:telemetry` 遥测 + 手动标注画布（geo 锚定/归一化降级）+
检测核心判定压实线/导流区 → 截取实时码流画面 → `h_laneChange_createEvent` 上报 → 按
`event_key` 合并记录。驾驶舱列表和预览只展示违章发生时保存的实时码流截图，不等待返航后
才能生成的前/中/后三帧与视频证据。

**行人上路抓拍**：检测帧挑选行人目标 → SPZ 稳定跟踪 → 远景/近景拍照 → 码流截图 →
切录像 → 临时记录 + 告警；15s 超时 / 目标丢失 / K 键跳过进入 finalize（停录像 → 停
跟踪 → 变焦与 lookAt 恢复 → 切回拍照）。手动操作自动关闭；控制权丢失挂起。

两模式通过 `capture/controls.ts` 的单一模式切换队列互斥（开启前关闭另一模式），共享：

- **组合设置面板**（Footer Toolbar 入口 Popover）：双开关 + 告警配置（总开关/弹窗/音效）
- **统一记录入口**（左栏 `capture-records`）：父 View 只负责 Tab 切换，两类记录使用完全独立的
  DTO、状态、卡片和样式；点击卡片
  reveal 独立 SubLive 预览 Tab；行人列表展示 `latest_photo.preview_url`、详情展示
  `latest_photo.original_url`，“查看全部”通过宿主 `platform:navigation` 打开 tracking 的媒体文件夹；
  行人列表只展示当前 Session 的 Tracking，变道展示实时码流截图，
  并联动地图照片图钉
- **告警 Toast**：直播区顶部，5 秒自动消失，点击打开记录面板

## Mock 后端（enableMock）

`enableMock=true` 时插件内使用内存 Mock 后端，**只替代 HTTP/WS/媒体数据源**：

- 实现行人上路、变道两个领域 API 与 `PluginWsApi` 正式契约，
  Controller、Detector、View 与真实模式完全一致，不存在旁路剧本。
- 相机、SPZ、AI Detection、遥测、直播画面始终走真实宿主 Capability。
- 行人 `h_illegalRoad_startTracking` 后依次回传远景、近景证据图并各推送一次
  `illegal_road_capture/media_added`；变道 Mock 只保存事件，驾驶舱仍使用实时码流截图。
- 行人接口按 Session/Tracking 生命周期返回 `resumed`、`open_tracking`、
  `close_reason` 与 `latest_photo`。
- 行人 Tracking/Session 的 `started_at/ended_at` 与变道事件 `crossed_at` 优先使用
  `cockpit:telemetry.drone.timestamp`；飞机时间缺失时回退浏览器时间并记录诊断日志。
- 前端不为 Handler 生成幂等键，也不自动重试 `start-tracking`；失败时结束当前抓拍轮次。
- 后端就绪后把配置改为 `enableMock=false` 并刷新即可切换真实接口，业务代码零改动。

真实宿主本地联调配置（localStorage `fh2.plugin-platform.local-plugin-config`）：

```json
{
  "official_traffic_capture": {
    "enableMock": true
  }
}
```

## 构建

```sh
pnpm --filter @traffic-capabilities/official-traffic-capture build
```

`enableMock` 当前默认开启；接入真实后端时显式改为 `false`。
航次/项目切换时先结束旧模式、清空旧会话记录，再按新上下文恢复。

## 算法测试页（独立调试）

`test-pages/lane-change-sim/` 是变道 detector-core 的可视化调试器（双 tab：合成场景
模拟器 + 真机录像验证——上传 DJI 机载 MP4 由 dev 中间件抽取 djmd 检测数据轨，在真实
录像画面上画标注回放生产 detector），在插件目录执行 `pnpm sim` 启动，访问
`http://localhost:35430/sim`。独立于插件构建（输出 `dist-sim/`，不写入 Manifest、
不进正式产物；真机录像 tab 需本机 ffmpeg），详见其
[README](./test-pages/lane-change-sim/README.md)。
