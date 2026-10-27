# official_traffic_capture_backend（schema.sql 驱动 TS 版）

这是交通违法抓拍的 TypeScript 后端实现，包含 handler、事件和后处理业务行为，并演示 SQL 为唯一存储事实源的链路：

```text
schema.sql -> runtime manifest entities / DDL
业务代码 -> shared/store.ts -> store('字符串实体名')
```

`fh2-plugin.json` 刻意不含 `entities`。工具链从根目录唯一的 `schema.sql` 推导运行时 manifest 实体；它不再生成 EntityMap 或 repository facade。业务代码用显式字符串实体名，通用 `shared/store.ts` 只负责解 Store 错误信封。

## 开发

```bash
pnpm types       # 按 allowlist 与源码调用形态刷新 Host ambient 声明；schema.sql 变更不需要执行
pnpm check       # 校验后端源码与清单
pnpm typecheck   # TypeScript 类型检查
pnpm build       # 生成 dist/
pnpm run pack    # 生成 release/ 和 zip
```

`shared/store.ts` 是手写、schema 无关的通用封装，统一解 `StoreResult` 错误信封。业务代码显式传入实体名：

```ts
const tracking = queryStore('illegal_road_tracking', { id: { eq: trackingId } }, { limit: 1 })
```

`shared/media.ts` 使用了常规 TypeScript `enum StoredMediaType`。当前工具链允许 enum，并会在 bundle 时正常编译；它不再需要用 `as const` 规避源码校验。

## 存储约束

- `schema.sql` 是唯一的存储事实，DDL 必须在 `平台任务服务` 使用的数据库执行。
- 业务字段按当前 Store 运行时事实均以字符串读写；毫秒时间戳使用 13 位定宽字符串。
- 所有涉及项目归属的查询和更新均带 `project_id` 条件，避免跨项目读取。
