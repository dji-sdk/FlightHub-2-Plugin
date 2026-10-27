# 示教航线插件

`official_wayline_teach` 只负责人工示教录点、航点编辑、截图对象上传和航线生成。插件不申请飞控或云台控制能力，也不执行巡逻、返航和急停。

## 后端契约

插件通过 `ctx.apiCall` 调用统一入口 `POST /plugin/invoke`，固定使用后端插件 ID `official_patrol_teach`：

- `h_teach_getRouteStatus`：按 `flight_id` 仅恢复 `recording` 路线；`generated` 路线不进入录制恢复。
- `h_teach_enterRoute`：首次录点时创建路线；HTTP 409 表示当前航次已有路线。
- `h_teach_deleteRoute`：删除路线及其航点。
- `h_teach_appendWaypoint`、`h_teach_updateWaypoint`、`h_teach_deleteWaypoint`：航点 CRUD。
- `h_teach_createScreenshotSTS`：按路线和航点获取临时 STS 与对象键。
- `h_teach_attachScreenshot`：对象上传成功后提交 `waypoint_id/object_key/bytes/file_id`。
- `h_teach_generateWayline`：按持久化选中航点生成 KMZ/WPML，传入名称和路线级双速度。

航点数据采用 WGS84 `height`、相机偏航 `camera_yaw`、云台俯仰、焦距与 AI 状态；不使用相对高度、机头朝向、航点级速度、严管路段或重新生成。

录点前通过 `cockpit:ai-config` 的 `ensure` 保证车辆 AI 识别开启（目标类型精确替换为 `vehicle`）：已开启则直接录点；未开启先自动开启，成功后用刷新的遥测快照录点，失败则提示用户手动开启，不创建后端路线。

插件把接口返回的临时 STS、bucket、object key 和 Blob 交给 `platform:object-upload`，由 Host 使用 S3 SDK 上传。该能力不限制插件或 MIME，单文件上限为 1 GiB；示教业务自身仍限制 JPEG 单图 2MB、单路线截图累计 80MB。STS 凭证只在本次调用期间使用，不得写入日志或持久化。

## 模拟开关

插件配置 `enableMock` 默认关闭。开启后所有示教 API 和截图上传都使用页面内存模拟；关闭后只调用正式接口，不自动降级。模拟数据刷新即清空，生成结果会以 `mock-*` 标识，不能用于真实飞行。

每次录点都会通过插件日志记录插件本地组合快照的来源、采集时间、设备/架次及高度、云台、焦距和 AI 状态，便于定位驾驶舱数据时序问题；日志不记录经纬度值。
