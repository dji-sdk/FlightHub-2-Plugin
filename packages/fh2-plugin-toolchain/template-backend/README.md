# __BACKEND_PLUGIN_ID__（后端插件引导示例）

这个插件演示一条最短的"记录生命周期"，三种入口共用同一条数据路径。

## 插件化开发者工具依赖与授权

先从 https://github.com/dji-sdk/FlightHub-2-Plugin 取得固定 tag/commit 的源码，在工具根目录执行
`pnpm install --frozen-lockfile`，再执行 `pnpm link:toolchain`；最低 Node 20.19。
创建使用该源码的 `packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs` 并传
`--platform-root <源码根>`。依赖/覆盖只使用本地 `file:` SDK/Toolchain，Toolchain 自带
`developer-runtime/` 运行投影，不另装完整 Contract，不要求 FH2 公共 npm 包或私有 registry 登录。
第三方依赖沿用你已有的 registry 配置，模板不注入私有 scope。

保留稳定源码目录；移动或升级后先构建新源码，再核对本工程/工作区的 `file:` 路径与覆盖，
显式重装、生成和校验，不自动升级其他工程。若作为 Capability 后端成员，本目录没有
自己的 `package.json`，本地 CLI 由工作区根依赖提供；独立后端模板则使用自身的 scripts。

下载/安装、CLI 注册、常驻服务、真实环境和打包各自确认授权。下方只用于本地 Mock，
不使用真实设备或客户数据；使用本次打印地址和调试凭据，不在报告保存 Token、会话 URL、
Cookie 或私钥。完成后 Ctrl+C 停止自己的 Gateway 与 watcher，并确认端口清理。

## 三种入口，一张表看全

| | 谁触发 | 源码在哪 | 重试语义 | 幂等靠什么 |
|---|---|---|---|---|
| HTTP Handler | 前端一次调用 | `handlers/example/*.ts` | 用户在等，平台不自动重试 | 业务键 `record_key` 唯一索引 |
| Event 消费方 | 平台事件 | `events/example-created.ts` | **至少一次**投递，消息可能来两次 | 同上 + 条件状态推进 |
| Workflow Adapter | 流程 JSON 的 `run_script` 步 | `adapters/example-script.ts` | 按流程重试策略执行，持久化出参不当临时数据 | 同上 |

三种入口都调 `shared/records.ts` 的同一份逻辑，是"能力=代码 / 编排=配置"的落点：
**业务逻辑住代码，入口只决定"怎么被触发"**。

## 十分钟跑一圈（本地，不碰任何真实环境）

```bash
# 在 Capability 根目录：确认后起独立后端 Dev Gateway（供本地 curl 调试，不带浏览器同源门禁）
pnpm exec fh2-plugin dev --root backend/__BACKEND_PLUGIN_ID__
# 只使用本次打印的 Gateway URL 和调用凭据
```

另开终端，将本次打印的 Gateway URL 和调试凭据仅用于该本地会话；不要复用历史端口或令牌。
以下占位值需用本次输出替换，`mock/events/` 路径相对 Capability 根：

```bash
FH2_DEV_URL='<本次打印的后端 Dev Gateway URL>'
FH2_PLUGIN_TOKEN='<本次打印的本地调用凭据>'

# Handler 新建一条记录（用点分名 example.create 调用）
curl -s -XPOST "$FH2_DEV_URL/plugin-api/plugin/invoke" \
  -H "x-plugin-token: $FH2_PLUGIN_TOKEN" -H 'content-type: application/json' \
  -d '{"pluginId":"__BACKEND_PLUGIN_ID__","handler":"example.create","input":{"record_key":"demo-1","title":"第一条"}}'
# → data.created = true

# 再调一次：幂等命中（created=false，不会出第二条）
# 使用相同输入重放上一次 Handler 请求

# 投一条事件给 Event 消费方（data 是业务字段；body 使用 mock/events/ fixture）
curl -s -XPOST "$FH2_DEV_URL/plugin-api/mock/backend/event" \
  -H 'content-type: application/json' \
  -d @mock/events/example-created.json
# → data.status = "handled"（建行 + 条件推进，一步做完）

# 同一个业务键、换一个消息 id 再投一条，验证至少一次投递的重放：
curl -s -XPOST "$FH2_DEV_URL/plugin-api/mock/backend/event" \
  -H 'content-type: application/json' \
  -d '{"id":"evt-2","type":"example.created","data":{"record_key":"from-event-1","title":"事件来的"}}'
# → created=false、status 仍是 handled，零副作用

# 看列表（按 source 筛出事件创建的记录）
curl -s -XPOST "$FH2_DEV_URL/plugin-api/plugin/invoke" \
  -H "x-plugin-token: $FH2_PLUGIN_TOKEN" -H 'content-type: application/json' \
  -d '{"pluginId":"__BACKEND_PLUGIN_ID__","handler":"example.list","input":{"source":"event"}}'

# 取不存在的一条：检查 NOT_FOUND 错误信封
curl -s -XPOST "$FH2_DEV_URL/plugin-api/plugin/invoke" \
  -H "x-plugin-token: $FH2_PLUGIN_TOKEN" -H 'content-type: application/json' \
  -d '{"pluginId":"__BACKEND_PLUGIN_ID__","handler":"example.get","input":{"record_key":"nope"}}'

# 看本地 Mock 内存记录（id/tenant_id/created_at/updated_at 由平台注入）
curl -s "$FH2_DEV_URL/plugin-api/mock/backend/state"

unset FH2_PLUGIN_TOKEN FH2_DEV_URL
```

这组请求验证 Handler 调用与错误信封、事件投递与幂等重放、store 的写入形状。

完整 Capability 的 Workbench 前后端联调用工作区根实际 `dev` script（pnpm 示例为 `pnpm run dev`）；
独立后端只启动 Gateway，不要求出现前端页面。
那条路的 `/plugin-api/*` 有浏览器同源门禁，curl 直打会被拒，调试后端请用上面的独立 Gateway。

Workflow（`workflows/example-flow.json`）本地 dev 不执行。仅在另获目标环境授权且部署/版本
前置满足后，才按获准契约使用 `POST /flows/example-flow/start`，不能把本地预检称为真实执行。
流程的两步设计演示**显式接线**与**幂等重放**：
第一步从 `trigger.record_key` 接参建记录，第二步把第一步的出参
`steps.create-record.id` 接成自己的 `record_key` 再跑一遍 —— 第二步回 `created=false`
就是幂等性的可观测证据。

## 目录导读（每个文件教一件事）

```text
fh2-plugin.json         声明入口与能力申报（allowlist）；build 后产物为 dist/plugin.json，不写 entities
schema.sql             存储契约唯一事实源：产物 entities 与建库 DDL 同源；不生成 TypeScript 业务字段模型
tsconfig.json          本目录自包含的类型检查（strict），编辑器与 tsc 都用它
types/                 fh2-plugin types 生成（勿手改）：按运行形态声明 Host ambient 全局
handlers/example/      HTTP Handler 入口：create / list / get
events/                Event 消费方入口：example.created
adapters/              Workflow Adapter 入口：example-script
shared/                三种入口共用的业务逻辑（records / store / validation / time）
workflows/             流程 JSON（编排=配置）
tests/                 有意义的业务修改应补聚焦测试；validate 不代替业务测试，模板不带默认测试文件
```

## 数据怎么流

```text
HTTP body / 事件 data / 流程接线 -> 入口函数(input, ctx) -> shared/records.ts -> shared/store.ts（解信封）-> store（平台注入）
```

三条纪律，从 schema 到响应是一条线：

- **列名就是 JS 里写的名字，一律 snake_case**（`record_key`，不是 `recordKey`）。
  平台按"你写的名字"原样透传给存储；一处 snake 一处 camel，会出现"带筛选时某几列静默变空白"。
- **毫秒时间戳存 13 位定宽字符串**（`shared/time.ts` 的 `msText`）。
  store 现阶段按字符串读写；字符串比较只在定宽时等价于数值比较，排序/时间窗筛选都靠它。
- **入口只做接线，业务住 shared**。三种入口的注入面不同（见 `types/*.d.ts` 的"世界"划分），
  shared 文件能看见的全局 = 所有 import 它的入口的交集 —— 这是工具链算出来的，不是口头约定。

## 纪律清单（抄进你自己的插件）

1. **幂等是入场券**：写靠 `createIfAbsent` + 业务唯一键，改靠"判据进 filter 的条件 update"
   （`markHandled` 的 affected 计数）。不要用"先查再写"代替原子幂等，否则有并发重复风险。
2. **错误用业务信封**：`throw { code, message }`，code 用稳定值域
   （`INVALID_ARGUMENT` / `NOT_FOUND` / `CONFLICT` / `INTERNAL`）。
   消费方靠 code 分流，"没有"与"出错"是两种展示。
3. **事件入口处理无关事件**：不属于本插件的事件返回空对象；重试/失败语义按所选运行投影查证。
4. **能力申报式授权**：`allowlist` 没申报的能力，沙箱里那个全局**根本不存在**（不是 null）。
   `log` 除外（三路恒注入）。
5. **sandbox 是同步的**：没有 `async`、没有计时器。要延迟/重试，交给 Workflow
   （`delaySec`、步骤重试策略是编排层的事）。

## 改它的时候

```bash
# 在后端插件目录，使用该工程/工作区的本地 CLI：
pnpm exec fh2-plugin types
pnpm exec fh2-plugin types --check
pnpm exec fh2-plugin validate
pnpm exec fh2-plugin build
```

完整 Capability 的 generate/validate/build/test/pack 按工作区根 README/scripts 执行。
后端成员没有自己的 scripts，独立后端模板也没有默认 `test` 或 `pack` script；不能把前端
成员测试称为后端业务测试。打包先单独确认，只生成未签名行业包，不自动签名、上传或部署。
命令位置和包管理器以生成工程实际 scripts 与本地 CLI 帮助为准，不推断成员拥有同名脚本。

- 加一个 Handler = `handlers/<domain>/<action>.ts` 里写普通 `export function <action>`，
  build 自动派生稳定入口名 `h_<domain>_<action>`；不需要在 fh2-plugin.json 登记。
- 加一列 = 改 `schema.sql`；已有环境的迁移需另获管理员授权并按目标环境的迁移规范执行，
  不把本地 Mock 成功当真实数据库迁移证明。
- 交付部署前由相应角色按获准部署说明处理存储和流程依赖；Skill 不自动访问目标库或执行 DDL。

## 入口命名（三种名字指向同一个实现）

`handlers/example/create.ts` + `export function create` → 运行时入口 `h_example_create`。
调用方三种写法都认：`h_example_create` / `example_create` / `example.create`。
