# 04 后端插件开发指南（Backend Guidelines）

何时读取：实现或修改后端插件（HTTP 接口处理函数、事件、流程、数据实体、后端测试）。

前置条件：工程已创建且检查清单通过；所需事实已实际查证，探针能读清单不等于知识已完整加载。

## 后端插件是什么

后端插件是部署在平台 Worker 上的一组同步函数，**不是一个服务进程**：没有进程、没有端口、没有常驻内存。

它在工程里是清单加源码目录，`build` 编成 `dist/`，平台只安装 `dist/`：

```text
fh2-plugin.json + handlers/ events/ adapters/ workflows/ shared/ schema.sql
  │  fh2-plugin build
  ▼
dist/plugin.json（运行时清单）+ dist/scripts/{handlers,events,adapter}.js + workflows/ + schema.sql
  │  部署：部署方执行 schema.sql 建表 → 安装 dist/ 登记入口与流程
  ▼
触发（HTTP 调用 / 事件消息 / 流程步骤 / 定时）→ Worker 装载脚本 → 沙箱执行 handle(input, ctx)
```

**沙箱是同步的**：运行时没有事件循环，`async`/`await` 与计时器在构建期就被拒绝（见「源码限制」）。

所以"等一会儿再做""跑很久再回结果""失败隔几秒重试"这类需求，一律交给流程编排，而不是在脚本里自己搓。

目录、产物、字段都以本次 `build` 实际产物与生成 `types/` 为准；本文只说明职责与选型，不预存快照。

## 组成部分（目录即契约）

| 路径 | 职责 | 谁维护 |
| --- | --- | --- |
| `fh2-plugin.json` | 源清单：ID、版本、`allowlist`、`events[]`、`scripts[]`、`evaluators[]`、`flows[]`、`entities[]`、`connections[]`、`eventStatuses[]` | 手写 |
| `handlers/<domain>/<file>.ts` | HTTP 接口处理函数，**自动发现**，不写进清单 | 手写 |
| `events/<name>.ts` | 事件消费方，由清单 `events[].consumer[].handler` 引用 | 手写 |
| `adapters/<name>.ts` | 流程脚本，由清单 `scripts[].path` 引用 | 手写 |
| `evaluators/<name>.js` | 条件求值脚本，由清单 `evaluators[].path` 引用（**无目录发现**） | 手写 |
| `workflows/<name>.json` | 流程（DAG）定义，由清单 `flows[]` 引用 | 手写 |
| `shared/` | 三种入口共用的业务逻辑与纯函数 | 手写 |
| `schema.sql` | 存储的唯一事实源：表与列 | 手写 |
| `types/*.d.ts` | 生成的世界类型，只读 | 生成 |
| `dist/` | 构建产物，只读 | 生成 |

构建产物固定三份脚本，对应三种注入面，**不共享 chunk**：`scripts/handlers.js`、`scripts/events.js`、`scripts/adapter.js`。

### HTTP 入口名从路径派生

普通 export 必须位于 `handlers/<domain>/`，目录用小写 kebab-case，export 用 lowerCamelCase：

| 源码 | 运行时入口名 | 调用方可用写法 |
| --- | --- | --- |
| `handlers/lane-change/start-mode.ts` + `export function startMode` | `h_laneChange_startMode` | `laneChange.startMode`、`laneChange_startMode`、`h_laneChange_startMode` |

不符合约定时构建直接失败，报 `FH2_BACKEND_HANDLER_NAME_INVALID`（不是运行时 404）。

**改文件路径等于改接口名**，调用方跟着断，把它当接口契约管理。清单 `scripts[]`、`events[]` 认领过的入口不会再登记成 HTTP 入口。

## 执行环境：ctx 与全局能力

两个方向要分清，它们和前端相反：

- **`ctx`（第二参数）只装请求事实**，没有任何能力：`idempotencyKey`、`now`、`pluginVersion`、`requestId`、`scriptId`、`stableId(scope)`。
- **能力是按 `allowlist` 注入的全局对象**，直接按名字调用，不经 `ctx`。没申报时不是权限错误，而是 `xxx is not defined`。

| 全局对象 | 需要的能力 |
| --- | --- |
| `store` | `data:read` / `data:write` |
| `cache` | `cache:read` / `cache:write` |
| `media` | `media:read` / `media:write` |
| `flow` | `flow:start` |
| `notify` | `notify:publish` |
| `connector` | `egress:fetch` / `integration:write` / `integration.gis:read` |
| `platform` | `config:get` / `event:write` / `geo.segment:read` |
| `wayline` | `wayline:generate` |
| `screenshot` | `screenshot:issueupload` / `screenshot:signurl` |
| `objectTrack` | `track:read` |
| `video` | `video:process` |
| `log` | 恒可用，不需要申报 |

`ctx.requestId` 在 workflowAdapter 里恒为空串；`ctx.idempotencyKey` 在适配器里来自 `run.idempotencyKey` 接线。

**脚本级 allowlist 是覆盖不是合并**：`scripts[].allowlist` 非空时只用它，不再叠加插件级 `allowlist`。

能力全集共 19 个，按能力 ID 与其开放形态以 `search_knowledge`（domain=backend）实际枚举为准；本文不抄清单。

`ctx.stableId(scope)` 用幂等键派生稳定 ID，**取不到幂等键时直接抛契约错**，平台不会生成随机值兜底。

## 源码限制（同步沙箱）

构建期静态校验，命中即失败并给诊断码。这些不是风格建议，是硬约束：

| 禁止 | 诊断码 | 替代做法 |
| --- | --- | --- |
| `async` / `await` | `FH2_BACKEND_ASYNC_FORBIDDEN` | 同步写完；长任务交流程 |
| `setTimeout` / `setInterval` / `setImmediate` | `FH2_BACKEND_TIMER_FORBIDDEN` | 延迟用流程 `delaySec` 或 `flow.start` |
| 动态 `import()` | `FH2_BACKEND_DYNAMIC_IMPORT_FORBIDDEN` | 顶层静态相对导入 |
| `require(...)` | `FH2_BACKEND_REQUIRE_FORBIDDEN` | ESM 相对导入 |
| `eval` / `new Function` | `FH2_BACKEND_EVAL_FORBIDDEN` | 写普通函数或查表 |
| `import.meta` | `FH2_BACKEND_IMPORT_META_FORBIDDEN` | 不依赖模块元信息 |
| `node:` 内置模块 | `FH2_BACKEND_NODE_IMPORT_FORBIDDEN` | 用宿主注入的能力 |
| 裸包名导入（不以 `./` `../` 开头） | `FH2_BACKEND_BARE_IMPORT_FORBIDDEN` | 相对导入插件内 `shared/` |
| evaluator 用 `import`/`export` | `FH2_BACKEND_EVALUATOR_ESM_UNSUPPORTED` | evaluator 写普通 JS |

校验范围是入口源码加 `shared/`，`*.d.ts` 排除。构建目标 es2015、`format: iife`、`platform: neutral`。

**由此推出一条设计纪律**：业务代码只做"一次调用能做完的事"，把时间维度（等待、重试、轮询、超时）交给流程。

## 四种执行形态怎么选

| 形态 | 登记方式 | 谁触发 | 超时 | 重试 | 幂等键 |
| --- | --- | --- | --- | --- | --- |
| httpHandler | `handlers/**` 自动发现 | 前端一次调用 | 固定 5000ms | 平台不重试 | 调用方 `Idempotency-Key` |
| eventHandler | 清单 `events[].consumer[]` | 平台消息 | 固定 30000ms | 有界，按错误类 ack/discard/requeue | 消息 `event_id` |
| workflowAdapter | 清单 `scripts[].path` | 流程 `run_script` 步骤 | 平台工作流活动超时减余量 | 平台工作流活动，默认 5 次 | `run.idempotencyKey` |
| evaluator | 清单 `evaluators[].path` | 只能被 `run_script` 引用 | 同适配器 | 同适配器 | 同上 |

选型只需问三个问题：

1. **是不是有人在等**？是 → HTTP 入口，但只能 5 秒内给出结果。
2. **是不是平台发生了什么**？是 → 事件消费方，记住消息可能来两次。
3. **要不要跨请求、跨天、重放、等人**？要 → 流程编排，业务计算放进 `run_script` 的脚本。

`evaluator` 不是独立入口：它没有目录发现，只能被流程引用，且 `allowlist` 恒为空（只有 `log` 能用）。

### 事件入口的"返回什么决定消息去哪"

事件消费方**必须返回对象**。返回 `undefined`、裸 `return` 或不返回，会被当成可重试错误，耗尽后丢弃。

| 结果 | 消息处置 | 什么时候用 |
| --- | --- | --- |
| 正常返回对象（如 `{}`） | 确认，不重投 | 已处理或正常过滤 |
| 抛 `NOT_FOUND` / `DUPLICATE` / `CONFLICT` | 确认，不重投 | 业务上"这条不用处理"，如没命中任何记录 |
| 抛 `INVALID_ARGUMENT` 等契约错 | 丢弃，不重投 | 消息本身有问题，重投一万次也一样 |
| 其他错误或非对象返回 | 有界重试，耗尽后丢弃 | 系统抖动 |

多个消费方各自独立重试，整条消息按"重新入队 > 丢弃 > 确认"取最坏结果。重试次数与死信保存由部署方配置，插件清单不管这些。

**这条最实用**：正常的"没命中"要显式抛业务档，别让它落到重试路径上白跑几轮。

## 暴露接口：被谁调、怎么调

后端对前端只暴露**一个统一端点**，靠 `handler` 名字区分接口：

```text
前端 ctx.apiCall('/plugin/invoke', { method: 'POST', body: { pluginId, handler, input } })
        │  网关自动拼 /plugin-api 前缀、自动带插件 token
        ▼
后端 POST /plugin/invoke → 按 (pluginId, handler) 找到 handle(input, ctx) 执行
```

要点：

- 请求体顶层**只接受** `pluginId`、`handler`、`input` 三个字段，多写返回 `40001`。
- `pluginId` 写**后端插件**的 ID，不是前端插件 ID。
- `input` 平台不校验、不裁剪，原样交给 `handle(input, ctx)`；参数校验是后端自己的事。
- 返回值**必须是对象**，原样放进响应 `data`。返回标量、数组或什么都不返回会被当系统错误。
- `handler` 三种写法都能寻址（见上文派生表），但工程内统一挑一种，不混用。

`input` 的形状就是前后端的共享契约：只定义一次（共享模块或类型生成源），前端不另写一份。

### 失败怎么表达

用 `throw { code, message }` 表达失败，**错误码决定平台怎么处理**：

| 你抛的 `code` | 平台返回 | 语义 | 调用方该做什么 |
| --- | --- | --- | --- |
| `INVALID_ARGUMENT` / `UNKNOWN_FIELD` / `PERMISSION_DENIED` 等契约错 | HTTP 400 + `40006` | 参数或寻址不合法 | 改请求，不要重试 |
| `NOT_FOUND` / `DUPLICATE` / `CONFLICT` | HTTP 200 + `20001` | 业务结果，不是故障 | 按业务逻辑处理 |
| 其他错误码，或不抛 `code` | HTTP 503 + `50301` | 系统抖动 | 用同一幂等键退避重试 |

`store` 的失败信封**不会**自动提升成失败响应：要让调用失败必须显式抛（如 `throw result.error`）。

这与前端的成功判据一致：只有 `code === 0` 是成功，`data` 才有值。

### 幂等

调用方在请求头带 `Idempotency-Key`，脚本里读 `ctx.idempotencyKey`，用 `ctx.stableId(scope)` 派生稳定业务 ID。

写操作必须传业务稳定键（来自业务事实：谁、何时、对什么），读操作不传。键要在请求**之前**生成并可复用。

### 本地怎么调

单后端 `dev` 起来后按本次打印的地址调用 `POST /plugin-api/plugin/invoke`，请求头带本次打印的调试凭据。

**本地错误码与正式网关不等价**：本地模拟器用字符串错误码、限制也不同，前端可能显示"网关响应格式无效"。
所以错误映射的结论要在真实网关验证，不要在插件里加字符串码兼容分支。

本地调试凭据只用于该本地会话，不写进报告，也不复用到其他环境。

## 被流程编排调用

流程里的 `run_script` 步骤调用清单 `scripts[]` 声明的脚本：

| 字段 | 说明 |
| --- | --- |
| `name` | 寻址键，流程 `inputs.script` 填它 |
| `path` | 源码路径，构建后改写为 `dist/scripts/adapter.js` 里的入口 |
| `entry` | 导出函数名，缺省 `handle` |
| `allowlist` | 非空时**覆盖**插件级 allowlist |
| `io` | 入参/出参投影，类型为 `string`/`number`/`bool`/`object`/`array` |

`io` 不是文档，是运行期约束：**出参只有 `outputs` 里声明过的键会进黑板**，其余丢掉。

步骤的入参写法决定脚本怎么拿到值：

```text
"inputs": {
  "script": { "const": "lane-change-postprocess" },
  "event_id": { "from": "trigger.event_id" },
  "intervalSec": { "from": "run.intervalSec" }
}
```

`{const: 值}` 是常量，`{from: 引用}` 指向上游。`run.now` 提供本次执行的时间：**不要在脚本里自己取当前时间**，重放时会对不上。

## 启动流程与回推前端

这是"接口装不下的活儿"的完整回路，三段拼起来才能用：

```text
前端点击 → POST /flows/{flowName}/start
        → 流程按 needs 执行步骤（可等待人工信号，可跨天）
        → 步骤里的 run_script 调后端脚本
        → 后端 notify.publish 广播 → 前端 ctx.ws.onBizCode 收到 → 刷新界面
```

### 从代码里启动流程

`flow.start(flowName, bizID, seed)`，需要 `flow:start`。`job` 触发轴的流程**只能**被它启动。

三条纪律：

1. **bizID 要带够业务维度**。同一流程、同一 bizID 只会有一条实例；bizID 太粗会撞已完成的实例，流程再也起不来。
2. **`already: true` 不是错误**，是重复投递的正常表现，正是幂等想要的。
3. **seed 的键名必须与流程里 `trigger.<key>` 引用完全一致**，且在流程的 `seed` 里列过。

真实例子（事件消费者在视频回调到达后启动后处理作业）：bizID 用 `event_id:video_file_id` 两段拼，因为同一事件换一段视频要起新流程。

### 把结果推回前端

`notify.publish({ channel, to, bizCode, subCode, data })`，需要 `notify:publish`，走平台共享 WebSocket 广播。

它是 best-effort：返回 `delivered` / `skipped` / `skipReason` / `failReason`，投递失败不抛错。所以关键状态要有可查的落点（存储里的一行、事件状态、流程 status），不能只靠推送。

**`bizCode` 是跨插件契约**：前端 `ctx.ws.onBizCode('<bizCode>', handler)` 订阅同一个字符串。改一侧不改另一侧不会报任何错，只是界面永远不更新。这是最难查的一类问题，两侧字符串要收进共享常量。

## 数据：schema.sql / store / cache

三层各管一件事，先选层再写代码：

| 需求 | 用哪层 |
| --- | --- |
| 长期保存、要按条件精确查询、要唯一约束 | `schema.sql` + `store` |
| 短期加速、窗口期去重、可丢 | `cache` |
| 必须"只建一次"的并发安全 | `store.createIfAbsent` + 唯一键 |
| 只是临时算一下 | 不要落盘，算完返回 |

`schema.sql` 是存储契约的唯一事实源，写一份，三处派生：类型生成读它出实体类型，构建投影进 `dist/plugin.json`，
部署时由部署方执行它建真实表（**平台不会自动建表**，漏跑 DDL 的表现是能装载、首次访问数据报 `STORAGE_ERROR`）。

四条硬规则：

1. 物理表名 = `plugin_db_` 加实体名，前缀由平台拼；前缀里**没有 pluginId**，跨插件同名实体会撞表。
2. 业务值按字符串写入（`store` 数据面是字符串），布尔存 `'1'`/`'0'`，数字自己转换。
3. 时间存毫秒时间戳的**定宽 13 位字符串**，字符串比较才等价于数值比较，范围筛选与排序才正确。
4. 平台列（`id`、`created_at`、`updated_at`、`tenant_id`）由平台维护：必须写进 DDL，但业务代码不写也不用同名字段。

`store` 只有六个方法：`query` / `count` / `insert` / `update` / `delete` / `createIfAbsent`。

**没有 `get` 和 `put`**：按主键查一条用 `query` + 小 `limit`，空列表自己翻成业务失败；删除按条件删，不按 id 删。

**失败不抛异常**，返回 `{ok: false, error}` 信封：先判 `ok`，按需转成业务失败。`update` 返回 `affected`，条件更新里 `affected === 1` 才算抢占成功。

查询写法是"字段 → 算子"的对象，顶层字段之间是 AND（**不支持 OR**，需要 OR 就拆多次查询在脚本里合并）。
分页、排序、算子的具体上限与全集按 `search_knowledge` 查数据存储契约，本地模拟器的分页与排序不等价于生产。

`cache` 是**共享键空间**，平台不加插件名前缀，唯一性由插件自己保证：

- 键要带插件与业务前缀，否则会与别的插件互踩。
- `setnx` 只能做有 TTL 的窗口期去重，**永久去重必须用 `store` 的唯一索引**。
- 缓存可以随时丢，不能作为"是否已处理"的唯一凭据。

## 流程编排（DAG）

流程解决"时间维度"的问题：跨请求、跨天、要等人工、要重放、要幂等重试。这是它存在的唯一理由。

先判断该不该用：

| 场景 | 用流程吗 |
| --- | --- |
| 一次查询或一次写入，几百毫秒 | 不用，HTTP 入口 |
| 下发任务后要轮询到终态（几十分钟） | 用 |
| 要等用户签收、选路、确认 | 用 |
| 失败要隔一段时间重试，且重试边界可定义 | 用 |
| 定时采集 | 用 |
| 只是算一个字段、判一个分支 | 不用，脚本或 evaluator |

### 三要素

一个流程 JSON 只有三块：`name`、`trigger`、`steps`。

| 触发轴 | 谁启动 | 典型场景 |
| --- | --- | --- |
| `api` | HTTP `POST /flows/{名}/start` | 前端按钮、其他服务调用 |
| `schedule` | 平台按 `intervalSec` 定时 | 每 30 秒采集一次 |
| `stream` | 平台事件消息到达 | 警情产生后启动处置 |
| `bizNotify` | 业务任务系统的通知 | 任务下发后启动巡逻 |
| `job` | **只能**被 `flow.start` 启动 | 后处理作业 |

**没声明 `api` 轴的流程，start 端点拒绝**（是"不允许"不是"不存在"）。所以要给前端按钮用的流程，必须声明 `api` 并给出 `seed`。

### 步骤

步骤字段以本次 DAG 契约查证为准，稳定语义是这几条：

- `needs` 声明依赖，构成依赖图而不是步骤链；没有 `needs` 的是起点。
- `trigger` 决定上游没成功时要不要跑：默认 `allSucceeded`，只认 `succeeded`；`allDone` 把失败、超时、跳过也算跑过。
- **收尾节点必须用 `allDone`**：否则上游一步超时，收尾步会被"连坐跳过"，事情停在半截。
- `when` 是条件跳过，算子只有 `eq`/`ne`/`in`/`exists`/`blank`/`present` 六个；判步骤终态用 `steps.<id>.$state`。
- `inputs` 用 `{const}` 与 `{from}` 显式声明数据流，**没有隐式黑板**：步骤之间只能通过 `steps.<id>.<出参>` 取。
- `delaySec` 是等待，`await` 是等人工信号（可 `provides` 出参、可 `interruptedBy` 中断），两者语义不同。
- `timeoutSec` 有上限（当前 3600 秒），`maxAttempts` 只能在平台默认值上**往下调**。

步骤终态五种：`succeeded` / `failed` / `skipped` / `timedOut` / `interrupted`。判"正常结束"时别只认 `succeeded`。

### 平台动作

流程能调的平台动作是封闭的，业务脚本只能通过 `run_script` 间接参与：

| 动作 | 干什么 |
| --- | --- |
| `dispatch_mission` | 下发飞行任务 |
| `query_flight_task` | 轮询飞行任务到终态 |
| `return_home` | 返航 |
| `run_script` | 调插件自己的脚本 |
| `spawn_agent` | 拉起设备侧 Agent |
| `update_event_status` | 回写事件状态 |
| `wait_signal` | 等外部信号 |

**控制飞行只能通过平台动作**，脚本碰不到飞控：这是安全隔离，不是能力缺失。想把业务判断加进飞行链路，就写 `run_script` 产出参数，再由 `dispatch_mission` 下发。

动作的入参/出参字段按 `search_knowledge` 查动作契约，不凭名字猜。

## 动态脚本与 Evaluator

这一节回答"业务逻辑放哪一层"。判据三行：

1. **要不要有"什么时候跑、跑几次、失败怎么办"**？→ 要 = 流程编排；不要 = 脚本。
2. **流程里要不要写业务计算**？→ 要 = `run_script` + `scripts[]`；不要 = 纯平台动作编排。
3. **只是一个布尔判定或取值**？→ `evaluators[]`，但它能力受限，只适合纯计算。

### 脚本（`scripts[]` + `run_script`）

脚本是流程里的**一步**，所以重试、超时、幂等都由这一步的语义决定，脚本自己不做这些。

- `io` 是双向投影：**只有 `io.inputs` 声明过的键会递进来，只有 `io.outputs` 声明过的键会进黑板**，其余静默丢弃。
- 抛错会让这一步失败并按 `maxAttempts` 重试；重试期间 `run.idempotencyKey` 不变，用它去重。
- 脚本不能知道自己在第几次重试里，也不该依赖"上次跑到哪了"：把进度写进 `store`，用幂等键判断。
- 契约错与业务错的抛出不重试；只有可重试类错误会重试，分类以 `search_knowledge` 查到的脚本错误语义为准。

### Evaluator

`evaluators[]` 声明一个条件求值脚本，被 `run_script` 之外的判定点引用：

- **没有目录发现**，必须在清单里显式声明 `path`。
- **`allowlist` 恒为空**：只能 `log`，拿不到 `store`/`cache` 等任何能力。
- 是**普通 JS 原样复制**进产物，不走 TS 编译，所以不允许 `import`/`export`（`FH2_BACKEND_EVALUATOR_ESM_UNSUPPORTED`）。
- 因此它只适合纯函数式的判定，不适合有副作用的业务逻辑。

要访问数据、要写库、要调外部系统的"判定"，写进 `scripts[]` 而不是 `evaluators[]`。

## 开发运行时数据与后端知识分流

**结论**：开发运行时数据与后端知识是两套数据，身份、摘要、来源和状态分别查证，不能互相代替。

开发运行时数据用于上述公开事实与说明；后端知识是 IDE/DAG 实际消费的另一套独立知识与项目锁。

要点：

1. 两套数据分别看身份、摘要、来源和状态。探针 contract.path 非空不证明 DAG 知识已固定。
2. 先核对本次本地 `knowledge --help`，再按 05 做只读 status。
3. `import` 只安装不改锁，`use` 只固定已安装身份。每次 import/use 或知识锁升级，都先说明确切来源、身份、摘要、兼容性与影响并取得显式同意；不跟随最新版本自动升级。

DAG 节点、I/O、DSL 与脚本归属按本次实际来源查证。Workflow 同版本权威 checker 仍然缺失，编辑或快速预检没有错误，不证明执行或部署。

用法源里的保存已知问题照原样保留，不承诺全部成功。没有同版本事实或来源冲突时，停下相关编码；不拿另一套数据或相似 API 猜接线。

## 契约查询流程（写代码前必走）

本文件不预存后端结构树、注册函数签名与运行时能力清单。它们以契约为唯一事实源：

1. MCP `search_knowledge`（domain=backend）按语义检索：入口（entrypoint）、动作（action）、触发器（trigger）、流程语言、宿主 API、运行时限制。
2. 读取知识 Resource 的 `developerAction`/`examples`；需要签名、参数、枚举时读 `factResourceUris` 明确发布的事实。未解析事实保留 null/false/warning，缺声明就停止，不用完整 Contract 或内部 Worker 源码补齐。
3. 编码期的最终事实是**本工程生成的 `types/`**、本地 file: SDK/backend 与 `fh2-plugin.json` 声明；核对同版开发运行时数据，不从较新全局版本推断支持。
4. 工程结构以 `create` 实际产物为准（目录、成员、`schema` 类文件都以生成工程为准，本文件不预存清单）。
5. 无 MCP 时按 01 读同包 `knowledge.json`、`resources.json` 的精确映射、`backend.json` 与 `schemas/`；不另维护一份后端知识，不查磁盘 index。

本文给的形态、选型与纪律是稳定的；具体字段、方法签名与错误码枚举一律走上面这条流程。

## 本地验证边界

本地能验和不能验要分清，否则会在跑不通的链路上反复试错：

| 能力 | 本地 `dev` | 说明 |
| --- | --- | --- |
| HTTP 入口调用 | 能 | 起后端 Gateway 后可 `curl` 或前端调用 |
| 事件消费方 | 能 | 投本地事件 fixture，但本地不证明并发、独立重试、确认与死信处置 |
| 脚本纯逻辑 | 能 | 单元测试直接调 `shared/` |
| `store` 数据面 | 能 | 本地内存数据面，含 fixtures |
| 查询排序与分页 | 部分 | 对象式 `orderBy` 与分页在本地不等价，不能据此断言"最新一条"或历史列表 |
| 错误码映射 | 部分 | 本地可能给字符串码；正式 `40006`/`20001`/`50301` 要在真实网关验 |
| invoke 顶层校验 | 部分 | 本地可能接受多余字段，不能证明正式 `40001` 拒绝行为 |
| `flow.start` / `notify` / `media` 等 | **不能** | 本地运行时只注入数据面与连接，其余全局不存在 |
| 流程 `start` 端点 | **不能** | 本地 Gateway 只有流程状态与信号的替身，没有 start 路由 |
| 流程端到端 | 不能 | 必须 `preview` 真实环境或 proxy 模式 |

所以"业务流程跑通了"这句话要带证据：本地通过只能说明单步逻辑对。
编排、异步回推、消息重放与依赖恢复都要在已部署环境验，并请部署方确认插件版本、流程已装载、`schema.sql` 已执行。

## 稳定纪律（与具体 API 无关）

- **Manifest 条目与导出同步**：声明的入口与实现的导出名一一对应，改名一起改；不同步由 validate 暴露并按 05 自纠。
- **强类型边界**：输入、输出、上下文只用生成类型上真实存在的成员；不假设 Node 全局、HTTP 服务器、不受限文件系统或网络。
- **受控通道**：网络与系统能力只走宿主注入的受控通道（以生成 `types/` 与后端契约机器事实为准）；不起 Express/HTTP 服务，不直连外网绕过。
- **单一契约定义**：前后端共享 payload 只定义一次（工程共享模块或类型生成源），后端不另写一份。
- **业务逻辑可单测**：纯逻辑与上下文交互分离，打桩测试上下文边界。
- **验证位置正确**：后端单插件没有默认 `test`/`pack` script，能力工程的后端成员也没有自己的 package.json；按 02 或实际 README，用能力工程根目录的本地 CLI 指定成员。根 `test` 只覆盖前端，业务修改要单独补测，不报未执行项通过。

## 示例

错误：在后端起 Express/HTTP 服务器并 `fetch` 外网。这发明了 Node 服务与不受限外呼，越出 Worker 契约（具体边界以生成类型与后端契约为准）。

错误：在 HTTP 入口里 `setTimeout` 轮询一个几十秒的任务。沙箱没有事件循环，构建期就被拒绝；正解是 `flow.start` 起流程，轮询放进 `query_flight_task` 步。

正确（一条完整回路）：

1. 读后端 Manifest、生成 `types/`、相邻现有 HTTP 入口；不确定的动作或触发器语义用 `search_knowledge` 查证。
2. 业务逻辑写进 `shared/`，三种入口都只做"取参数 → 调共享逻辑 → 返回"。
3. 需要长耗时的部分：`handlers/` 里的入口先落一条记录并 `flow.start`，流程用 `run_script` 调 `adapters/` 里的脚本。
4. 脚本跑完调 `notify.publish` 广播 `bizCode`，前端 `ctx.ws.onBizCode` 收到后刷新。
5. 单测共享逻辑与入口打桩，跑后端 validate → typecheck → build。

## 出口条件

- [ ] 后端 Manifest 校验通过；`types`/生成命令已执行且 diff 审查无意外。
- [ ] 新逻辑有聚焦单测且通过；typecheck 通过。
- [ ] 不手改 `types/`；无越界运行时假设（未用生成类型之外的成员）。
- [ ] 四种执行形态的选型有理由：长耗时、需重放或等人的逻辑没有塞进 HTTP 入口。
- [ ] 入口返回值是对象，失败按错误码三档分类抛出；写操作有业务稳定幂等键。
- [ ] 前后端调用的 `pluginId`、`handler` 名、`input` 形状与前端一致，且只定义一次。
- [ ] 涉及流程时：`bizID` 带够业务维度，`seed` 键名与 `trigger.<key>` 对齐，收尾步用 `allDone`。
- [ ] 涉及推送时：`bizCode` 在两侧来自同一共享常量，且有可查的落点而不只靠推送。
- [ ] 本地验证结论写明边界：哪些只在 `preview` 或真实环境验过，哪些只是本地单步通过。
- [ ] 开发运行时数据与后端知识两套数据分开查证；涉及 IDE/DAG 时已查独立知识身份、版本、摘要与预检边界，没有未经授权的知识锁升级。

## 反模式

- 在后端起 HTTP 服务或直连外网。
- 用 `setTimeout` / `setInterval` 轮询或"过一会儿再做"，或写 `async` 函数等 Promise。
- 在 HTTP 入口里做几十秒以上的活儿，指望超时前跑完。
- 用 `cache` 做永久去重，或给缓存键不加插件前缀。
- 依赖 `store` 的失败信封自动变成失败响应。
- 流程收尾步用默认 `allSucceeded`，上游一超时就整段跳过。
- 流程里靠书写顺序隐式满足依赖，而不是写 `needs`。
- 脚本里自己取当前时间，而不是用 `run.now`。
- 改了 `notify.publish` 的 `bizCode` 没改前端订阅，或反过来。
- `bizID` 太粗导致流程撞已存在实例、永远起不来。
- 使用未在生成类型中声明的上下文成员。
- Manifest 条目与导出函数名不同步。
- 手改 `types/` 让校验通过。
- 前后端各写一份 payload 定义。
- 把契约语义记在脑里直接写码（跳过查证流程）。
