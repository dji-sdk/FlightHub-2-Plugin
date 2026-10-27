# 警情派遣插件

## 这个插件在做什么

手动警情派遣插件：在 Project 侧边栏注册「警情派遣」入口，点击后在 panel 渲染
一个表单（地址 / 纬度 / 经度），点击「派发警情」把一条手工构造的事故快处警情 POST 到
事件中心。单 Host（project）、单 View，无 Service、无轮询。

## 接口

- 派发警情：`POST /plugin-scene/data-store/events`（插件内 `ctx.apiCall` 传入，不带
  `/plugin-api` 前缀；Engine 网关最终请求 `/plugin-api/plugin-scene/data-store/events`）。
- 请求体固定字段：`eventType: '警情'`、`source: 'cascade'`、`priority: 'low'`、
  `status: 'unacknowledged'`、`notifyOn: ['unacknowledged']`、`poi: { lat: 0, lng: 0 }`。
- 前端构造字段：
  - `eventId`：`MANUAL-EVENT-<YYMMDD>-<HHMMSS>-<6位随机数>`（如 `MANUAL-EVENT-260826-153012-300005`）；
  - `occurredAt`：提交时的当前时间 ISO 字符串。
- `rawPayload` 只包含 `address` / `lat` / `lng`，坐标转字符串。

## 表单校验

- 地址非空；纬度 `-90 ~ 90`；经度 `-180 ~ 180`；只接受十进制数字（拒绝科学计数法、逗号等）。
- 校验失败在字段下方内联提示，不发起请求。
- 提交结果内联展示：成功显示构造的 `eventId`，失败显示后端/网络错误文案。

## 构建

```bash
pnpm --filter @traffic-capabilities/official-alert-dispatch build
pnpm --filter @traffic-capabilities/official-alert-dispatch test
```

Mock 网关暂未提供 `POST /plugin-api/plugin-scene/data-store/events` 端点；`fh2-plugin dev`
联调时该接口返回 404，表单会展示内联错误。
