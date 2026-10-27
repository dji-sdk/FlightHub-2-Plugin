# 变道抓拍算法验证模拟器（traffic-capture-plugin）

`test-pages/lane-change-sim` 是本插件 `src/hosts/cockpit/lane-change/detector-core.ts` 的可视化调试器。参考 宿主原生测试页同形态实现 的交互形态重建，但算法契约以**当前插件版 detector** 为准：

- LINE 硬触发 = 有效轨迹的底边 `40%～60%` 中央带边界主动到达/穿入有限标注线段，或中央带静态压线满 `LINE_OCCUPY_MS`。动态穿线不要求跨后额外深入或等待，真实浅穿回退也触发。
- POLYGON 硬触发 = bbox 几何中心进入区域，或重叠面积比达到 `POLYGON_OVERLAP_T_FULL`。
- core 只输出最终触发事件（`processFrame` 返回值），没有 candidate / cancel / approach 阶段；事件日志也只有 `TRIGGER`。
- 互斥与重复上报由 episode 清除（`EPISODE_CLEAR_MS`）和 prune tombstone（`REPORTED_TOMBSTONE_MS`）控制。

页面为两个独立 tab（`SimTabs.vue`）：**合成场景模拟器**（原有页面）与**真机录像验证**（见下文）。

## 快速启动

在插件目录内：

```bash
pnpm sim
```

默认入口：`http://localhost:35430/sim`。

本页面是独立调试页：不写入 `fh2-plugin.json`，不进入正式插件构建产物（`dist/`），产物独立输出到 `dist-sim/`（已 gitignore）。

核心测试：

```bash
pnpm test                      # 含场景冒烟 + replay 解析
pnpm vitest run test-pages/    # 仅测试页用例
```

## 真机录像验证 tab

上传 DJI 机载录像 MP4，在真实录像画面上画标注并回放生产 detector，验证真实违章是否可检出。数据链路：

```
MP4 上传 → dev 中间件 ffmpeg -map 0:d:0 抽 djmd 数据轨
  → sim/djmd/parser.ts（protobuf 解析并识别 field13 AI 检测 payload）
  → sim/djmd/to-replay.ts（仅检测帧转 NDJSON，保留原视频时间轴）
  → replay-source 既有解析 + 生产 toCoreBBoxes 过滤链 → detector-core
```

使用流程：

1. 控制条「上传机载 MP4 提取检测数据」（或把文件拖进画布）；
2. 摘要面板确认检测帧数 / 目标数 / valid 均值；`valid 0 avg` 时勾选「显示被过滤目标」诊断真实 type/state；
3. 在视频画面上手绘 LINE/POLYGON（快捷键与合成页一致）；
4. 播放 / 单步 / 拖进度条（拖动会重置 core 并从 0 追赶离散帧），观察触发红闪与事件日志。

实现要点：

- 普通视频元数据包不送入 detector；field13 检测 payload 按连续检测序号回放，时间仍按原始 `frame_index / fps` 对齐。
- bbox 坐标即录像画面归一化（万分比 / 10000），无需直播 4:3 坐标映射。
- djmd `obj_type="car"` 与旧数字值 `0` 均显式映射为 cockpit 车辆类型 `3`；未知类型原样保留并被生产过滤，原始分布记在 meta `djmd.rawTypeCounts`。
- 数字状态 0～7 与真实宿主映射一致，其中 2/3 分别为 `vision-beacon-fused` / `auxiliary-tracked`。
- 摘要分别展示原始 djmd packets、AI frames、detector fps；画布显示最近一次 AI 结果，有效空结果会清空 bbox。
- 同一 bbox ID 在 `TRACKER_TIMEOUT_MS` 内短暂漏检时续接位置轨迹；漏检时间不计入静态占线、离开去抖或 episode 清除。
- 暂停后画标注会重建 Core 并自动重放到当前时刻，无需手工从录像起点再次播放。
- 视频用 objectURL 本地播放（无需服务端 Range），由 SimClock 驱动，漂移超 250ms 再校正；倍速超过浏览器上限 16x 时视频降速、判定不受影响。
- 区域与 bbox 坐标都在视频画面归一化空间；画布按 object-fit: contain 渲染，鼠标交互经 `sim/video-layout.ts` letterbox 双向映射，黑边点击无效。
- 「显示被过滤目标」灰虚线渲染未通过 type/state 白名单的目标并标注其 type/state，只影响画面不影响判定。

环境依赖：本机需安装 ffmpeg/ffprobe（缺省时接口返回 503 与安装提示）；录像必须包含 djmd 数据轨（无轨返回明确错误）。仅 `pnpm sim` dev server 提供 `/sim-api/extract`，不进入插件构建产物。

## 页面结构

与参考页一致的左右布局：左侧标注、参数与日志，右侧 cockpit 直播式画布 + 场景/播放控制。

- `App.vue`：cockpit 直播式全屏布局与 `SimRunner` 生命周期。
- `sim/runner.ts`：虚拟时钟、参数、frame source 调度与 core 创建（`paramsOverride` 注入）。
- `sim/frame-source.ts`：合成轨迹数据源；keyframe 插值后转生产 `CarTargetLike`，复用 `target-filter.ts` 的类型/状态白名单。
- `sim/replay-source.ts`：解析 DebugPanel 导出的 B 模式 SEI NDJSON，并把旧数字协议（state 1/4/6/7、万分比 box）映射为插件字符串协议。
- `sim/replay-analysis.ts`：统计录制帧率、目标数、ID 生命周期、bbox 尺寸等摘要。
- `scenarios/presets.ts`：真实道路透视模型、预设区域、车辆轨迹（每场景多车同场 + 3-4 FPS 离散帧）。
- `components/`：画布（道路/标注/bbox/手绘）、控制（场景/播放/倍速/进度/录制加载）、参数、事件日志、标注面板。UI 全部为原生控件，不引入组件库与 Sass。

## 使用流程

1. 选择场景，如 `单实线·慢速左→右变道`、`单导流区·压角进入`、`混合·主路实线 + 右侧导流区 + 多车`。
2. 调整参数（面板只暴露当前 core 真实生效的参数）。
3. 点击播放或单步，观察 bbox 与区域关系；触发车辆红闪 1 秒。
4. 事件日志点击可跳转到触发帧；`复制定位日志` 输出场景、参数、区域与事件流。
5. 手绘 LINE/POLYGON 后 runner 重建 core 并从头回放。
6. 内置 3 份 30s 录制可直接在场景下拉选择；`加载录制` 可导入新的 `.ndjson`。

## 录制回放

- 回放是离散帧数据；画面 hold 最近帧，detector 只在录制帧时间点被调用。
- 录制里 20m 数据约 3-4 FPS、p95 帧间隔 ~0.85s；同 ID 在 1.5s 内按首尾有效 bbox 连接，中间空帧和 source seq 跳号只中断持续计时。
- 录制默认只含 bbox；触发事件需手绘 LINE/POLYGON 或加载带 `regionsSnapshot` 的录制。

## 参数说明

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `TRACKER_TIMEOUT_MS` | `1500` | 同 ID 稀疏轨迹最长缺失时间；prune 时对已上报 (objId × region) 落 tombstone |
| `MIN_TRACKER_AGE_FRAMES` | `3` | 观测不足 N 帧不参与判定（ghost 过滤） |
| `LINE_OCCUPY_MS` | `1000` | footprint 静态压线触发 `line-occupy` 时长 |
| `LINE_OCCUPY_MAX_FRAME_MOVE` | `0.003` | 帧位移上限，过滤沿线行驶的移动压框 |
| `LINE_OCCUPY_MAX_TOTAL_MOVE` | `0.006` | 占线窗口内总位移上限 |
| `LINE_OCCUPY_DISTANCE_TOLERANCE` | `0.006` | 静态 footprint 近线及 episode 接触清除容差，不参与动态跨线 |
| `LINE_MIN_NORMAL_MOVE` | `0.0005` | 跨前累计主动法向位移下限；进入此接近范围后冻结来源，不是跨后深入门槛 |
| `LINE_MIN_ACTIVE_MOVE_SHARE` | `0.5` | 主动位移占阈值点 signed-distance 变化的最低比例，抑制尺寸变化和标线漂移 |
| `LINE_OCCUPY_CENTER_DISTANCE_MAX` | `0.012` | 底边中央带到线绝对距离上限（沿用历史参数名） |
| `POLYGON_OVERLAP_T_FULL` | `0.5` | 重叠面积比判 `fully-inside` 阈值 |
| `POLYGON_OVERLAP_DEBOUNCE_MS` | `200` | polygon 离开去抖 |
| `EPISODE_CLEAR_MS` | `1000` | 已上报 episode 连续明确清除后才能重新上报 |
| 数据源扰动 | `0` | `positionSigma` / `sizeSigma` / `dropoutRate` / `stateOverride` 只影响模拟器输入 |

## 参数反哺 core

滑块只影响 `SimRunner` 创建 core 时传入的 `paramsOverride`，不会自动改生产默认值。反哺顺序：

1. 确认参数影响的契约（穿线/占线/进入/去抖）。
2. 修改生产默认改 `detector-core.ts` 的 `DEFAULT_DETECTOR_PARAMS`。
3. 同步更新 `detector-core.test.ts` 与 `scenarios/scenario-smoke.test.ts` 的期望值。
4. 更新本 README。

## 场景清单（触发数锁定）

| ID | 名称 | 期望 |
| --- | --- | --- |
| `line-straight-left` | 单实线·左外车道直行 | 0 |
| `line-slow-cross` | 单实线·慢速左→右变道 | 1 `line-enter` |
| `line-late-cross` | 单实线·近端急变道 | 1 `line-enter` |
| `line-half-press` | 单实线·半压后回正 | 1 `line-enter` |
| `line-hug-truck` | 单实线·大车贴线直行 | 0（移动压框不触发） |
| `line-occupy-stationary` | 单实线·静止车辆压线 | 1 `line-occupy` |
| `line-occupy-slow-ride` | 单实线·缓慢沿线行驶 | 0 |
| `line-horizontal-center-cross` | 路口横向道路·上下变道 | 1 `line-enter` |
| `line-intersection-dual-cross` | 十字路口·竖向与横向实线 | 2 `line-enter` |
| `line-multi-parallel` | 多车·多实线同时违规 | 3 `line-enter` |
| `line-diagonal-concurrent-traffic` | 斜拍道路·贴线大小车并发变道 | 6 `line-enter` |
| `line-multi-same-time` | 多车·车流中单车变道 | 1 `line-enter` |
| `poly-avoid` | 单导流区·主路正常绕行 | 0 |
| `poly-corner` | 单导流区·压角进入 | 1 `polygon-enter` |
| `poly-edge-overlap` | 单导流区·边缘重叠中心未进入 | 0 |
| `poly-cross` | 单导流区·误入穿越 | 1 `polygon-enter` |
| `poly-stay` | 单导流区·驶入并停留 | 1（持续占用不重复上报） |
| `poly-stutter` | 单导流区·压角丢帧 | 1 |
| `real-low-fps-line-cross` | 低帧率实线穿越 | 1 |
| `real-burst-gap-prune` | 长间隔 prune 后重新穿线 | 1（tombstone 阻止重复） |
| `real-id-fragment-ghosts` | 短生命周期 ghost | 0 |
| `real-dense-traffic-single-violation` | 密集车流中单车违规 | 1 |
| `mixed-realistic-main-road-exit` | 混合·实线 + 导流区 + 多车 | 2 |

十字路口场景的竖线只画路口上方进口段、横线只画右侧出口段：纵向车道的车会正常穿过横向道路，横线横跨整幅画面会让背景车也穿线触发。这是拓扑约束，不是算法约束。

斜拍并发场景使用等比例正方形视口，三条实线从左下向右上延伸，所有车辆单向上行：

- **左→右**：橙色车辆由右下角先接触，随后 `u=0.6` 中央带边界跨线。
- **右→左**：紫色车辆由左下角先接触，随后 `u=0.4` 中央带边界跨线。
- 车辆先贴线直行，按固定 seed 生成的重叠窗口变道，再沿目标车道直行。
- 默认无噪声，可用参数面板加入扰动；将位置/尺寸扰动设为 0 可确实关闭噪声。
- 基准回放 0.84s 无事件，2.80s 四辆进入中央带，3.08s 其余两辆进入；结束时合计 6 次且只命中对应实线。

测试独立核对中央带边界开始侧/结束侧、触发时刻、全程可见、并发车不重叠、20 组噪声以及沿路直行零事件。
生产算法只让中央带两个边界点形成移动穿线证据；角点、同侧退开及无主动位移的尺寸变化不能触发。

## 二维几何与即时触发回归（2026-09-23，覆盖阶段 208 跨侧容差语义）

- `bottom-edge-sweep.ts` 用线性约束区间求交计算 `u=0.4/0.6` 两个阈值点与有限线段接触，不做离散采样。
- `detector-core.ts` 分别保存两个阈值点的来源侧和真实接触，再检查累计主动位移；
  bbox 几何中心、底边中点和角点均不作为并联兜底。静态占线要求有限线段到达中央带。
- 动态跨线移除 `0.006` 深入门槛，只使用 `1e-10` 数值误差，不按车框尺寸缩放阈值。
  接近标线时冻结跨前运动基准，避免高帧率下每帧刷新来源、将累计运动退化为单帧位移。
  已跨侧但缺少主动运动证据的接触仍被消费，不能用之后的无关运动补报。
- 导流区仍为中心进入或面积比达到 50%；Turf 交集按 Polygon/MultiPolygon 累计，外环减内环。
- `line-crossing.test.ts`：36 个方向 × 5 种 bbox × 双向 × 11 个端点偏移 × 3 个切向位移，
  共 11880 组，与独立中央带阈值点 oracle 对照；另验证反向标注、共线拆段、重复点及整体平移。
- 1080 组中部跨线和 1080 组同侧直行覆盖 33/100/280ms；既有浅角慢变道还覆盖 4ms。
- `line-crossing-sensitivity.test.ts`：框宽 `0.008/0.013/0.04/0.16/0.30` 双向浅穿、末帧穿线、
  浅穿回退，以及同一慢速轨迹按 4/33/100/280ms 采样、不均匀采样和不同抽帧起点。
- 20m 接近两倍变焦录制 + 标线 `(0.5103810743395379,0.5044658806716684)` →
  `(0.5569912181148382,0.2015005359056806)`：ID 168 在 5.835s 触发，ID 423 在最后有效帧
  26.773s 触发，各一次；修改静态容差不改变它们的动态触发时刻。
- 三帧预热、同 ID 1500ms 续接及 episode 去重保持原契约；首次出现已越线或缺失超过续接窗口
  仍不保证检出。静态占线的帧率依赖与 Polygon 跨帧穿越不属于本次修复。
- 原录像 ID 1002 的中心误报固化为回归；完整 1912 AI 帧重放中该 ID 无事件。
  横线正例 ID 987 在 50.817s 由底边证据触发（旧中心分支曾提前在 50.550s 触发）。
- 新录像 ID 378 的角点误报固化为回归：全轨迹最多 24.14% 底边越线，未进入中央带，不触发。

## 与生产逻辑的关系

模拟器直接调用插件生产 detector core 与 target 过滤（`target-filter.ts`），但输入是虚拟 bbox 和归一化标注点。生产侧还包含：

- geo 标注投影到屏幕（`scene-geometry` Capability）。
- 检测帧、遥测、录像、截图、上报与一轮一抓拍 gate（controller.ts）。
- 视角变化 reset 与 view settle。

生产联调时看 `src/hosts/cockpit/lane-change/controller.ts`。
