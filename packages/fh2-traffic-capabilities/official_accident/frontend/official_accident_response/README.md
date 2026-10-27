# 事故快处插件

## 这个插件在做什么

事故快处横跨三个前端 Host：Project 接收和签收警情，Message 选择设备与路线并提交派遣，Cockpit 在飞机
到达后提供“抵近目标”和沿路网返航。Project 与 Message 仅通过动态可选的 `alert-flow` Service 协作；
专业航线预览由三个 Host 直接消费平台级 `platform:wayline-preview`，不依赖 Project Runtime。

阅读代码建议从 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 开始，再依次查看：

1. `src/workflow/workflow-status.ts`：后端状态对应什么用户动作。
2. `src/workflow/incident-actions.ts`：签收和打开派遣。
3. `src/workflow/dispatch-session.ts`：设备、路线、派遣和失败恢复。
4. `src/hosts/*/activate.ts`：工作流如何接入三个 Host。

真实迁移中的交警行业插件，当前已经具备：

- Message 派遣卡片 View（由 Project 列表「立即派遣」经 `alert-flow` Service 打开，不订阅 WS）。
- Project 事故路由、侧栏入口和事故列表 View。
- 平台级 `platform:wayline-preview` 复用宿主 `AutoWaylineMap` 呈现复杂航线，Project、Message、Cockpit
  可独立消费；Cockpit 缺少该能力时仅降级为无地图预览，返航面板、规划与执行仍可用。
- 设备加载、真实路线规划（`/plugin-scene/route-planning/plan`）、WPMZ 坐标解析预览、
  航线入库（`/plugin-scene/route-planning/register`）和派遣提交。
- Cockpit SDK v8 入口、事故事件状态联动、右键“抵近目标”、激光测距飞行与 tools 投影诊断。
- 多视角入口由 `enableMultiAngle` 配置控制，默认关闭。

## 事故快处接口

- 警情列表：`POST /plugin-scene/data-store/events/query`，固定查询 `source=cascade`、`eventType=警情`；
  活动警情通过 `status: ['unacknowledged', 'acknowledged', 'handling']` 一次拉取；query 状态使用 7 态：
  未签收、已签收、处置中、已完成、已超时未签收、已忽略、已终止。列表只通过 HTTP 轮询获取
  （每 10 秒一次），不订阅 `msgbox_send/map_alert` WS。
- Cockpit 事件：从 `platform:location` 的 URL query 读取 `pluginEventId`，通过
  `GET /plugin-scene/data-store/events/{pluginEventId}` 轮询；`handling` 继续轮询并开放抵近，
  `completed/terminated` 停止轮询并开放抵近，
  `ack_timeout/ignored` 停止轮询并隐藏入口，瞬时失败保留最近有效状态后重试。
- 坐标契约：警情坐标只从 `rawPayload.lat/lng` 读取（number 或数字字符串），`poi` 字段已废弃不再读取；
  缺失坐标（含 `(0,0)`）的警情不可派遣。已签收警情可在卡片 ⌖ 弹层补录坐标：单文本框，格式
  `纬度,经度`（与地图右键菜单「获取并复制经纬度」的复制格式一致，粘贴后校验十进制格式与范围，
  经度 `-180~180`、纬度 `-90~90`，小数位数不限），提交走
  `POST /plugin-scene/data-store/events/update` 把 `lat/lng` 合并回 rawPayload 并保留原字段；
  补录成功后不可二次修改（弹层变只读 + Controller 拒绝）。
- 地图右键「获取并复制经纬度」（对齐原生事故快处）：Project 激活时经 `platform:map.registerContextMenuItem`
  注册「位置」分组菜单项；宿主渲染菜单并在点击后严格地形拾取坐标回调插件，插件组合
  `platform:clipboard.writeText` 复制 `纬度,经度`。拾取失败提示重试；剪贴板失败提示手动记录；
  两项能力任一缺失时不注册菜单。
- 工作流状态：`GET /flows/{flowName}/incidents/{eventId}/status`，默认流程为
  `accident-response-cascade`；响应不含 `incidentStatus`（后端已删除该字段），`executed`/`skipped`
  可能为 `null`，前端动作只由 `awaitingSignal` 和 `currentStep` 决定。
- 路线规划：`POST /plugin-scene/route-planning/plan`，起点为设备实时坐标，终点为警情坐标；
  `workspace_id` 传 `projectId`（禁飞区避让）、`height` 传警情 `fly_alt`、`takeoff_ref_altitude` 传机场海拔、
  `speed` 固定传 `10`。规划器未就绪（503/50001）提示「路线规划服务未就绪」；业务码 11001/11002
  分别提示固定中文文案，其余网关/业务错误一律使用通用兜底文案，不透传后端 message/detail
  （网关错误响应不强制包含 `data` 字段）。
- 航线入库：`POST /plugin-scene/route-planning/register`，点击「立即派遣」时对选中航线显式注册，
  自动命名 `事故快处-<警情标题>-<HHmmss>`，重名自动加 `-2` 后缀重试一次；注册失败派遣中止并回到待派遣。
- 候选航线预览坐标由 `platform:wpmz.parseCoordinates` 解析 WPMZ 下载地址得到；解析失败或无下载地址的
  航线只在地图上画起飞点和事故点，不画航线。
- 沿路网返航门槛固定为 `projectId + pluginEventId + 飞机在空中 + drone.pose + dock.position`，不读取事件
  状态。真实宿主直接透传 Cockpit SDK 的 `dock.position`；插件仅在调用路线接口时将
  `longitude/latitude/height` 转换为 `lng/lat/height`，其中缺失机场高度按 `0` 处理。
- 人工反馈：`POST /plugin-scene/data-store/events/update`，提交原 `rawPayload` 合并
  `correction_note`；已签收/处置中卡片显示入口，已有反馈时文案为「修改反馈」并回显，最多 300 字。
- 忽略：仅已签收警情可用，发送 `ignore` 信号；成功后状态进入 `ignored` 并从活动列表移除。
- 人工信号：仅发送 `acknowledge`、`route_selected`、`ignore`，请求体只包含
  `payload`，不发送 `by`。`location_provided` 已随「补录走 event 接口」删除。
- `route_selected` 仅在 Message 卡片点击“立即派遣”后发送；payload 只传三个必填字段：
  `projectUuid`（来自警情 `project_uuid`/Project 上下文）、`dockSn`（所选设备）和
  `waylineUuid`（航线注册所得），不携带其他字段。
  设备和路线必须都已选择才允许派遣：设备默认不选，选中设备后自动规划路线并默认选第一条；
  未选齐时「立即派遣」禁用，Entry 侧 `dispatch()` 同步拒绝。派遣成功后显示成功通知并关闭 Message 卡片。
- 路线规划完成后会下载每条航线的 `wpmz_url` 并解析坐标，全部完成后才关闭「规划中」（与原生一致）；
  下载/解析失败不阻断派遣，但会在诊断日志输出 routeId、耗时、失败原因（只记录 host，不记录带签名
  的完整 URL）。`wpmz_url` 不可达（如内网地址/CORS）属后端问题，插件侧表现为地图仅显示起终点。
- 设备列表按到警情点的距离升序排列（距离近的排前面）。
- 媒体库、飞行记录入口保留但禁用，等待后端接口。

## 加载到本地宿主环境

先构建同级的交通抓拍插件，再用事故插件启动唯一的 Dev Server。`--plugins-dir ..` 会把三个交通插件的
父目录映射到同一个 `/plugins/` 路径：

```bash
pnpm --filter @traffic-capabilities/official-traffic-capture build
pnpm --filter @traffic-capabilities/official-accident-response exec fh2-plugin dev --port 5175 --plugins-dir ..
```

如果本机报 `EMFILE: too many open files, watch`，改用不监听模式：

```bash
pnpm --filter @traffic-capabilities/official-accident-response exec fh2-plugin dev --no-watch --port 5175 --plugins-dir ..
```

在 宿主页面 DevTools Console 执行一次，然后刷新：

```js
localStorage.setItem(
  'fh2.plugin-platform.local-plugin-base-url',
  [
    'http://127.0.0.1:5175/plugins/accident-response-plugin/dist/',
    'http://127.0.0.1:5175/plugins/traffic-capture-plugin/dist/',
  ].join(','),
)
location.reload()
```

旧的单 URL 配置仍然有效；多个 URL 按声明顺序串行安装，单个地址失败只输出控制台错误并继续安装后续插件。

刷新后控制台应先后出现：

- `[plugin-platform] 开始加载本地插件`
- `[plugin-platform] 本地插件安装成功`，分别包含
  `official_accident_response` 和 `official_traffic_capture`
- Message/Project Host 进入时的 `FH2 INFO` 激活日志

本地插件配置存在时，宿主 Engine 诊断级别会从 `warn` 自动提升为 `debug`；未配置时
仍保持 `warn`。如果上述日志完全没出现，先确认正在运行的 main-app 已重新编译，并在
当前页面 origin 下检查 `localStorage.getItem('fh2.plugin-platform.local-plugin-base-url')`。

加载成功后，Project 侧边栏会出现“事故快处”；Message 插件卡片只在收到
BizCode `msgbox_send` 且 `message.name === 'map_alert'` 时出现。原生卡片链路保留，
联调期同一消息会同时弹出原生卡片和插件卡片。

取消本地插件加载：

```js
localStorage.removeItem('fh2.plugin-platform.local-plugin-base-url')
location.reload()
```

## Cockpit SDK v8 人工联调

前置条件：URL 带有效 `pluginEventId`，事件已进入 `handling/completed/terminated`，当前飞机在空中且直播已
就绪；否则右键“抵近目标”按业务规则保持隐藏。

进入 Cockpit 后先在控制台筛选 `Cockpit SDK 运行时契约`。main-app 会只读检查正式 d.ts 声明的
Entry、Client Domain、State 字段和关键方法签名；`missing/typeMismatches/signatureGaps/stateReadErrors`
表示需处理的协议差异，日志首段中文清单可直接复制给 SDK 同学；`unobservable` 仅表示当前 nullable
状态或空集合无法展开验证，不算失败。

1. 从事故卡片派遣进入 Cockpit，确认 Footer 出现“事故快处”，页面重复进入/离开后不重复注册。
2. 在直播黑边右键，确认提示“点击位置不在有效直播画面内”，插件回调、云台和飞行请求均不触发。
3. 在有效画幅右键“抵近目标”，确认 Host 先经 `tools.screenToVideo()` 交付归一化点，再调用
   `payload.gimbal.lookAt()`；只有收到新的 `payload.laser` 状态事件后才继续。
4. 确认飞行目标来自激光 GPS，主仓仍请求 `/flight-tasks/fly-to-points`；控制台
   `[accident-response][cockpit-tools]` 只输出 tools 投影与激光目标的水平/高度误差，不参与飞行决策。
5. 让 `getGeometrySnapshot()` 返回空或投影报错，确认仍按激光目标飞行；让激光 5 秒内不更新，确认不发送飞行请求。
6. 离开 Cockpit 或触发 SDK unloading，确认 Footer/右键菜单、订阅和 Client 都被释放，旧回调不再执行。

本联调不修改宿主仓；SDK 类型直接来自
宿主驾驶舱 SDK 类型定义。
