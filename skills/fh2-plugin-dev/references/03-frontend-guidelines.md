# 03 前端插件开发指南（Frontend Guidelines）

何时读取：实现或修改前端插件（Manifest、扩展点（Point）、插件界面、插件入口、跨宿主通信服务、前端测试）。

前置条件：工程已创建且检查清单通过；所需事实已按 01 查证，探针能读 manifest 不等于知识已完整加载。

## 前端插件是什么

前端插件是一段被宿主页面装进去的界面与行为代码，**不是独立网页**：不拥有路由、不自己建连接、不持 token。

同一份代码会在多个宿主里各自激活一次，每个宿主给它一份 `ctx`。所以"这段逻辑在哪个宿主跑"永远显式判断。

```text
宿主页面 → PluginHost/Runtime 载入 dist → plugin.js 调 activate(ctx)
        → contribute() 贡献扩展 → provide() 提供服务
        → 宿主点 render → View 挂进该点的容器（ShadowRoot 内）
```

## 技术架构概览

| 层 | 是什么 | 在哪 |
| --- | --- | --- |
| 宿主页面 | 司空里的产品页面，提供容器与能力 | 宿主 |
| PluginHost / Runtime | 载入插件、校验权限、注入 `ctx`、回收资源 | 引擎 |
| 插件入口 | 一次激活的装配代码，按 `ctx.host.id` 分流 | `src/plugin.ts` + `src/hosts/<host>/activate.ts` |
| 扩展贡献 | 往宿主预留位置放东西 | `src/hosts/<host>/*.ts` |
| 插件界面 | 自己渲染的 UI，跑在宿主 Realm 的 ShadowRoot 里 | `src/views/<viewId>/` |
| 跨宿主服务 | 同一插件多个宿主之间的协议 | `src/services/` |

四个宿主：`cockpit`（驾驶舱）、`plan`（计划）、`message`（消息）、`project`（项目）。

Entry 运行时按宿主不同：`cockpit` 用 `isolated-realm`，其余三个用 `isolated-iframe`。这只表达传输与性能策略，不代表信任等级。

宿主 ID 与运行时随平台契约变化，以生成 `plugin-types.ts` 与 `search_knowledge` 实际枚举为准。

## 组成部分（目录即契约）

| 路径 | 职责 |
| --- | --- |
| `fh2-plugin.json` | 源清单：`id`、`entry`、`permissions`、`extensions[]`、`views`、`contributes`、`config` |
| `src/plugin.ts` | 唯一入口，`definePlugin({ activate })`，只做宿主分流 |
| `src/hosts/<host>/activate.ts` | 该宿主的装配：取能力、贡献扩展、注册服务 |
| `src/views/<viewId>/contract.ts` | View 的 state 与 methods 契约（两侧共享的类型） |
| `src/views/<viewId>/index.ts` | `defineView`，把契约与 Vue 组件接起来 |
| `src/views/<viewId>/mount.ts` | 把 Vue 应用挂进 ShadowRoot 容器 |
| `src/views/<viewId>/*.vue` | 界面本身 |
| `src/shared/` | 跨宿主共用的纯逻辑与 API 封装 |
| `src/generated/plugin-types.ts` | 生成的世界类型，只读 |
| `dist/` | 构建产物，只读 |

两条依赖方向硬规则：

1. **入口不导入 Vue**：Vue 只属于 View 产物，入口带上 Vue 是构建错误的方向。
2. **View 不进 `plugin.ts`**：View 由宿主按扩展点需要加载，不在入口提前 import。

**一 View 一入口**：每个 View 生成独立的 View JS，同插件的 View 可共享 chunk，但不跨插件、不从宿主取框架。

## 两个 ctx：Entry 与 View

它们不是同一个东西，混用是最常见的编译期与运行期错误来源。

Entry 的 `ctx` 成员较多，稳定分组：

| 分组 | 成员 |
| --- | --- |
| 身份 | `plugin`、`host`、`locale`、`config`、`permissions` |
| 生命周期 | `lifecycle`、`timers` |
| 宿主交互 | `extensions`、`capabilities`、`services`、`views` |
| 数据 | `storage`、`blobs` |
| 通道 | `events`、`ws`、`apiCall` |
| 观测 | `logger` |

View 的 `ViewMountContext` 只有挂载相关成员：`viewId`、`mountElement`、`styleTarget`、`overlayElement`、`port`、`locale`、`direction`、`theme`。

**View 拿不到 `ctx`**：没有能力、没有网络、没有存储。它与入口之间只走 `definePluginView` 的 typed channel（state 与 methods）。所以数据在入口算，View 只呈现。

## 扩展点：往哪放东西

扩展点是宿主预留的界面位置，目录封闭，只能从这里挑。当前 11 个，分布在四个宿主。

按贡献方式分两类：

| 类型 | 契约里有 | 典型用途 |
| --- | --- | --- |
| 动作型 | `onTrigger` | 工具栏按钮、菜单项、飞行动作，点了执行一件事 |
| 界面型 | `render: () => ViewHandle` | 面板、覆盖层、表单区块、侧栏条目，渲染一块 UI |

选哪个点的判断顺序：

| 想做什么 | 选 |
| --- | --- |
| 一个可点的按钮，触发一段逻辑或打开面板 | 动作型点（工具栏、菜单栏、飞行动作、右键菜单） |
| 一块常驻或可收起的面板 | 界面型点（左面板、左下栏、子直播页签、侧栏） |
| 叠在视频/地图上的一层 | `live-overlay`，注意 `interactive` 与 `overlayLevel` |
| 弹窗式提醒 | 消息宿主的弹窗点，或 `platform:dialog` 能力 |
| 往表单里加字段或校验 | 计划宿主的表单扩展点 |

具体点位 ID、宿主归属、字段名与是否可 `reveal` 走 `search_knowledge`（kind=point）查证，不凭记忆写。

字段归属三分法：

- **static 写清单**：安装后不可变，决定位置与锚点；改了要重新安装。
- **state 由 `contribute()` 给初值**：之后用句柄 `update()` 改。
- **method 由宿主回调**：`contribute()` 传入函数，宿主在特定时机调用。

两条运行期事实：

- **多贡献排序** = 插件装载顺序 × 清单内声明顺序，**与各插件 `activate()` 完成先后无关**。不要指望"先激活的先显示"。
- **`contribute()` 只能在激活的登记阶段调用**：激活流程走完后再调会被拒绝；激活失败时本次贡献原子回滚。

## 能力：能做什么

能力是宿主提供的功能面，按清单 `permissions` 声明后获取。当前 29 个，分四族：

| 族 | 数量 | 覆盖什么 |
| --- | --- | --- |
| `platform:*` | 15 | HTTP、WebSocket、平台事件、存储、导航、位置、通知、弹窗、地图、设备、上传、航线预览等 |
| `cockpit:*` | 12 | 上下文、遥测、相机、云台、检测、飞控、飞行任务、智能跟踪、直播指针、场景几何、快捷键、AI 配置 |
| `plan:*` | 1 | 计划表单上下文 |
| `project:*` | 1 | 项目上下文 |

获取与降级：

- 一律 `ctx.capabilities.get(id)`，返回 `undefined` 是**正常路径**：可用性随宿主、授权与运行域变化。
- 判 `undefined` 分支即可，不要用 try/catch 兜"没权限"。
- 四个平台基础能力是 **facade**，不走 `capabilities.get`：
  `platform:http` → `ctx.apiCall`、`platform:websocket` → `ctx.ws`、
  `platform:events` → `ctx.events`、`platform:storage` → `ctx.storage` 与 `ctx.blobs`。
- 权限最小化：只申请实际用到的能力。

具体能力 ID、成员签名与可用宿主走 `search_knowledge`（kind=capability）查证，本文不抄清单。

## 调用后端

后端插件和前端插件是**两个独立插件**，靠接口约定对上。三条路，按"要不要等结果"选：

| 目的 | 调用 | 需要什么 |
| --- | --- | --- |
| 同步取数据、提交一次写 | `ctx.apiCall('/plugin/invoke', ...)` | 清单 `platform:http` |
| 启动一条长流程、投人工信号、查编排进度 | `ctx.apiCall('/flows/...')` | 同上，流程侧要声明对应触发轴 |
| 接收后端主动推送 | `ctx.ws.onBizCode('<bizCode>', ...)` | 清单 `platform:websocket` |

### 同步调用接口

```ts
const response = await ctx.apiCall('/plugin/invoke', {
  method: 'POST',
  body: { pluginId: BACKEND_ID, handler: 'laneChange.startMode', input: { project_id: projectId } },
  idempotencyKey: `lane-change:${projectId}`,
})
```

四条硬规则：

1. **endpoint 单个 `/` 开头**，不带 `/plugin-api` 前缀，不写域名，不自己塞 token。违反会被拦并报 `PLUGIN_NETWORK_BLOCKED`。
2. **`pluginId` 是后端插件 ID**，不是当前前端插件 ID；两者的 ID 通常不同。
3. **成功返回完整信封** `{code, message, data}`，`data` 自己取；**失败不会以返回值到达**，网关业务码非零时直接抛 `PluginError`（`code: PLUGIN_GATEWAY_ERROR`）。
4. **写操作带业务稳定幂等键**，读操作不带。键来自业务事实，请求前生成，重试时复用同一个。

`handler` 名是从后端源码路径派生的，三种写法都能寻址，但工程内挑一种统一用。名字改了就 404，把它当接口契约。

body 三形态：JSON 值、`Blob`/`File`（单文件有上限）、受控 multipart（文件数与总量有上限）。`GET` 不能带 body。

### 启动流程与投信号

| 目的 | 调用 |
| --- | --- |
| 启动（条件：流程声明了 `api` 轴） | `POST /flows/{flowName}/start`，body `{ bizId?, correlationId?, trigger? }` |
| 启动（按业务 ID 寻址） | `POST /flows/{flowName}/incidents/{bizId}/start` |
| 投信号（对应流程里的 `wait_signal`） | `POST /flows/{flowName}/incidents/{bizId}/signals/{signal}` |
| 查编排进度 | `GET /flows/{flowName}/incidents/{bizId}/status` |

要点：

- 同样经 `ctx.apiCall`，endpoint 写法同上。
- **`bizId` 要稳定且能跨重试复用**：同一 `bizId` 重复启动返回 `already: true`，不会起第二条。
- **没声明 `api` 轴的流程，start 端点会拒绝**；只靠事件或定时触发的流程没有人工入口。
- **status 是编排进度，不是业务状态**：它告诉你跑到哪一步、在等哪个信号，业务数据要另查。
- `flowName` 从 `config` 读（清单 `config` 声明），不硬编码在逻辑里。

### 接收后端推送

```ts
const subscription = await ctx.ws.onBizCode<{ id: string }>('illegal_road_capture', (event) => {
  if (event.subBizCode !== 'media_added') return
  refresh(event.data)
})
```

- 只能订阅，不能建连、不能发送、不能控制重连；连接与订阅集合由宿主管理。
- `bizCode` 必须与后端 `notify.publish` 的 `bizCode` **完全一致**。改一侧不改另一侧不会报错，只是界面永不更新。
- 把 `bizCode` 收进共享常量，两侧引用同一个来源。
- 推送是 best-effort：**关键状态要能靠查询兜底**，不能只依赖收到推送。

### 工程里怎么组织

一份封装，全工程共用，不要在每处调用点重复拼请求：

| 放什么 | 为什么 |
| --- | --- |
| `BACKEND_ID` 常量 | 后端插件 ID 只有一个来源 |
| `invoke(handler, input)` 薄封装 | endpoint 与 body 形状只写一次 |
| `unwrapApiData` | 信封解包与"缺 code/缺 data"的报错统一 |
| `isPluginError` 分类 | 业务码与系统错误分开处理，展示不同文案 |
| 后端 `bizCode` 常量 | 与后端共享同一字符串 |

封装形状不唯一，重要的是两点：**失败统一在异常分支处理**、**写操作带业务稳定幂等键**。

接口的 `input` 形状是前后端的共享契约，只定义一次，前端不另写一份。

### 本地能不能验

- 本地 `dev` 下同步接口调用**能打通**（后端 Gateway 同时起来）。
- 启动流程与流程端到端**本地跑不通**：本地 Gateway 只有流程状态与信号的替身，没有 start 路由；
  本地后端运行时也不注入流程与推送能力。
- 所以"流程跑通了"必须在 `preview` 真实环境或 proxy 模式下才有证据，本地通过只说明前端请求形状对。

## 契约查询流程（写代码前必走）

本文件不预存 API 名称、签名与语义。它们以契约为唯一事实源：

1. MCP `search_knowledge` 按语义检索目标契约（如「工具栏点位」「弹窗能力」「插件服务」），或按 kind（point/capability/…）过滤。
2. 读取返回的知识 Resource URI：`developerAction` 给出正确接入方式，`examples` 来自契约（可直接参考，区别于本文件的示意）。
3. 需要签名、字段、枚举时读取 `factResourceUris` 明确发布的事实；`resolved=false`、warning 或缺声明时停止该细节，不用整个文件或内部宿主源码补齐。
4. 编码期的最终事实是**本工程的生成类型**（`src/generated/plugin-types.ts`）与本地 file: SDK；开发运行时数据必须核对同版来源，不从全局较新知识推断本工程支持。
5. 无 MCP 时按 01 读取同包 `knowledge.json` 与 `resources.json` 的精确逻辑映射；磁盘上不存在的 index 不查，知识不复制，也不回退完整 Contract。

宿主交互语义：扩展点的声明参数、能力的获取入口与不可用语义、跨宿主通信服务的生命周期与重连、插件界面的呈现与渲染判定标记。以上全部按上述流程查证，本文只给形态与选型，不预记字段。

## View 运行域纪律（宿主 Realm 共享执行）

**事实**：插件界面（代码侧叫 View，入口是 `defineView`）统一运行在宿主 Realm 的 ShadowRoot 中。ShadowRoot 只隔离 UI/CSS，JavaScript 仍与宿主共享。
插件入口的运行时拦截（移除存储入口、网络 Guard）不覆盖 View，官方也不提供 View Guard。
写 View 代码时按「与宿主共享一个房间」要求自己：纪律是唯一防线。

禁令表（替代方案的用法走契约查询流程，此处只指路）。每条带约束 ID：编码时命中哪条，就在交付汇报的约束自查段引用哪个 ID（见 06）：

| ID | 危险操作 | 危害 | 官方替代 |
| --- | --- | --- | --- |
| FV1 | 浏览器存储读写清（`localStorage`/`sessionStorage`/`document.cookie`/`indexedDB`，含 `localStorage.clear()`） | 与宿主同源共享：clear 清掉宿主数据，读取可窃取宿主数据 | `ctx.storage` / `ctx.blobs` + `platform:storage` 权限 |
| FV2 | 裸 `fetch` / `XHR` / `WebSocket` | 绕过网关与登录态，违反平台契约 | `ctx.apiCall`（唯一 HTTP 出口）；订阅 `ctx.ws` |
| FV3 | monkey-patch `window` / `document` / 原型 | 同 Realm 直接破坏宿主与其他插件 | 无替代，禁止 |
| FV4 | 操作自身 ShadowRoot 之外的 DOM | 破坏宿主 UI | 只操作 View 自身根内 DOM |
| FV5 | `location` 赋值 / `history.pushState` / `window.open` / `alert`/`confirm`/`prompt` | 劫持导航、阻塞宿主线程 | `platform:navigation` / `platform:dialog` 能力 |
| FV6 | 全局监听器 / timer / Observer 不清理 | 插件卸载后泄漏并继续影响宿主 | 全部注册到资源跟踪；卸载时 dispose |
| FV7 | 向 `document` 注入全局样式 / 改全局 CSS 变量 | 样式逃逸 ShadowRoot 隔离，污染宿主 | 样式限定在自身 ShadowRoot |
| FV8 | 裸 `postMessage` / 监听宿主全局事件读取数据 | 任意投递与数据侧信道 | 走契约通道与声明能力 |

**规则（一句话）**：View 的样式与浮层一律挂进自身 ShadowRoot 内的契约目标。`ctx.styleTarget`（组件库 / CSS-in-JS 样式挂载点）接样式，
`ctx.overlayElement`（弹层浮层目标，与挂载点同一 ShadowRoot）接浮层。两者是 `ViewMountContext` 的 SDK 契约成员，由引擎创建并随 View 清理。

**默认行为（两条）**：组件库默认把样式挂 `document.head`、弹层 teleport 到 `document.body`。这两个默认目标都在 View 的 ShadowRoot 之外，不改就会落到宿主全局。

**违规映射**：这两条默认行为是无样式与弹层逃逸的直接原因，必须显式改向契约目标；不改就同时产生 FV4/FV7 违规。相关症状的快速定位见「常见问题」。

## Plugin Entry 写法纪律（激活与生命周期）

职责定位：Manifest 回答「贡献什么」，插件入口回答「行为如何实现」。

**activate(ctx) 纪律：只做接入**：

- 按 `ctx.host.id` 创建当前宿主的共享 Controller。Controller 是按 `ctx.host.id` 复用的普通对象，不是框架类；同 Runtime 的多个扩展共享 Controller 与句柄。
- 按契约决定贡献：契约含 state/method 时必须 `contribute()` 提供初值与行为；契约为空就不注册任何东西（后台逻辑直接在 activate 启动）。
- 能力获取一律处理 `undefined`：能力可用性随宿主与授权变化（部分能力对 runtime/Realm 有要求），不可用返回 `undefined` 是正常路径；直接判 `undefined` 分支，try/catch 是多余的。
- 业务状态（数据缓存、轮询、订阅）活在插件入口的 Controller 里，View 只负责呈现。View 被宿主卸载重建时，Controller 必须保持原样。

**dispose 纪律：只做业务收尾**：

- 需要业务动作（停设备、通知后端）才返回 `dispose({ reason })`；不需要时什么都不返回。
- **资源释放不写代码**：监听器、timer、订阅、句柄交给资源跟踪统一释放；手写释放循环是反模式。
- 停用后贡献句柄的 `update()` 是 no-op 不抛错，清理流程不依赖它报错。

**边界**：

- Entry Guard（拦截裸网络、审计 cookie 访问）是防误用护栏，不是沙箱。不要依赖「平台会拦」写越界代码。
- 句柄与能力不跨 Host/Runtime 传递（扩展点与能力属于当前 PluginHost）。
- 跨界数据必须满足 `PluginValue`（可序列化值集）：DOM 节点、框架实例、宿主对象、函数都不能传；View 与入口之间走 typed channel，不共享内存。
- View 挂载由宿主 ViewOutlet 或贡献句柄承担（reveal、openView 类句柄用法走契约查证）；不存在全局视图打开 API，不发明。

## 其余稳定纪律

- **不发明宿主 API**：任何注册、获取、订阅调用必须能在生成类型或契约机器事实中找到声明；「名字听起来合理」不是证据。
- **呈现性数据不钉死**：可变文案与状态用运行期 state，静态配置才用 static；字段契约以查证为准。
- **权限最小化**：只申请实现实际用到的能力。
- **改 Manifest 后必须重新生成类型**并审查 diff（见 05）。
- **保护生成物**：`src/generated/`、`dist/` 只读；报错修源头契约再生成。
- **View 自包含**：View 的框架与依赖打进插件自身构建产物，不从宿主或跨插件复用。
- **测试不断言业务文案**：以契约层信号（声明、state 形状、方法语义）为准，沿用模板 `tests/` 既有写法补聚焦单测。
- **前后端只用一个调用面**：同步走 `/plugin/invoke`，编排走 `/flows/*`，不另造 ad hoc 传输层。

## 示例

正确：给现有驾驶舱插件加工具栏按钮：

1. 读工程 `fh2-plugin.json` 与 `src/generated/plugin-types.ts`，确认目标点位的 state/static 契约；不确定时用 `search_knowledge` 查证。
2. 更新 Manifest 扩展项与激活代码，重新 generate，审查生成 diff。
3. 补聚焦单测，跑 validate → typecheck → build。

正确：按钮点击后提交给后端并刷新界面：

1. `shared/api/` 里已有 `invoke()` 封装与 `BACKEND_ID`，直接复用。
2. `activate.ts` 里把封装传进 Controller，Controller 负责取参、调用、更新 state。
3. 写操作补业务稳定幂等键；失败在异常分支按 `isPluginError` 分类处理。
4. 若后端要跑很久，改为启动流程 + 订阅 `bizCode` 推送，不在前端轮询。

错误：凭想象调用未在任何声明与契约中出现过的注册 API（如自编的 `host.toolbar.register(...)`）。查证不到就不是可用接口。

错误：在 View 里直接 `ctx.apiCall` 或读 `localStorage` 拿数据。View 没有 `ctx`，数据应由入口取好再通过 typed channel 下发。

## 常见问题

按症状快速定位根因与修复；修复后按出口条件复验，不以「看起来好了」收尾：

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| 组件库组件渲染无样式 | 样式默认挂 `document.head`，不穿透 View 的 ShadowRoot | 样式挂载点改到 `ctx.styleTarget`（组件库的样式挂载配置；具体 prop 名以工程安装版本实际 API 为准，如 naive-ui 的样式挂载 prop） |
| Select / Modal 等弹层无样式或定位错乱 | 弹层默认 teleport 到 `document.body`，逃出 ShadowRoot 且越出 FV4 | 浮层改挂 `ctx.overlayElement` |
| 想用组件库「全局样式」组件兜底无样式问题 | 此类组件直接写 `document.body` 的全局样式（如 naive-ui `NGlobalStyle`），属宿主全局副作用 | 不用；样式问题回到挂载目标解决（FV7） |
| 加了扩展项但界面上没有 | 清单没声明该 point、或不属于当前宿主 | 核对清单 `extensions[].point` 与本次打开的宿主 |
| 插件停用了界面还在跑 | 业务逻辑写在 View 里，随宿主页面残留 | 逻辑收回入口 Controller，View 只呈现（FV6） |
| 多宿主之间状态串了 | 用了模块级可变全局 | 状态放进按 `ctx.host.id` 复用的 Controller |
| `PLUGIN_NETWORK_BLOCKED` | endpoint 带了 `/plugin-api` 前缀、写成完整域名、或用了裸 `fetch` | 改成单 `/` 开头的业务路径，统一走 `ctx.apiCall` |
| 调用后端报 `PLUGIN_GATEWAY_ERROR` | 网关业务码非零：`pluginId` 错、`handler` 名不存在、参数不合法 | 核对后端插件 ID 与 `handler` 派生名，按网关码分类；改请求不要盲目重试 |
| 启动流程返回不允许 | 该流程没声明 `api` 触发轴 | 流程侧加 `api` 轴与 `seed`，只靠事件/定时的流程没有人工入口 |
| 订阅了推送但界面不更新 | `bizCode` 两侧不一致，或流程在本环境没真跑 | 收进共享常量对齐两侧；确认环境能执行流程而非只有本地 dev |
| `capabilities.get()` 拿到 `undefined` | 该能力在当前宿主/授权/运行域不可用 | 走 `undefined` 降级分支；核对清单权限与宿主归属 |

## 出口条件

- [ ] Manifest 与激活代码通过工程 `validate`；类型已重新生成且 diff 无意外。
- [ ] 新逻辑有聚焦单测且通过；typecheck（`tsc`/`vue-tsc --noEmit`）通过。
- [ ] View 代码过禁令表自查（FV1-FV8）：存储/网络/DOM 边界/全局监听清理/全局样式，均无宿主全局副作用。
- [ ] activate/dispose 分工符合纪律：业务收尾在 dispose，资源释放交给资源跟踪。
- [ ] 未手改任何生成物；引用来自所选同版开发运行时数据，没有内部源码兜底或未解析事实冒充支持。
- [ ] 后端调用面统一：同步走 `ctx.apiCall('/plugin/invoke')`，编排走 `/flows/*`，没有自造传输层。
- [ ] 写操作有业务稳定幂等键；失败在异常分支按网关码分类处理，不把失败当返回值。
- [ ] 涉及流程或推送时：`flowName` 来自 `config`，`bizCode` 与后端来自同一共享常量，关键状态有查询兜底。
- [ ] 验证结论写明环境边界：哪些在本地 `dev` 验过，哪些只在 `preview` 或真实环境验过。

## 反模式

- 在 View 里用浏览器存储（包括 `localStorage.clear()` 这类「看似清理」的操作）。
- View 里裸网络请求或 monkey-patch 全局。
- 组件库样式/弹层挂在 ShadowRoot 外（head/body）导致无样式或污染宿主，再用全局样式组件兜底。
- 依赖「平台会拦」的侥幸心理。Entry 的拦截不覆盖 View，Guard 也不是沙箱。
- 在 dispose 里手写资源释放循环。
- activate 里堆业务收尾逻辑，或跨 Host 传递句柄。
- 在 View 里调 `ctx.apiCall` 或直接用 `ctx`（View 没有）。
- endpoint 自己拼 `/plugin-api` 前缀或写完整域名。
- 把 `pluginId` 写成前端插件自己的 ID。
- 写操作不带幂等键，靠"应该不会重试"。
- 在多个调用点各拼一份请求与解包逻辑，`bizCode` 各处硬编码。
- 在前端轮询后端来代替流程与推送。
- 猜扩展点 ID、权限名、`ctx` 方法、宿主注册 API。
- 把契约语义记在脑里直接写码（跳过查证流程）。
- 呈现文案钉死在静态配置。
- 假设宿主提供框架或跨插件复用 View 产物。
- 通过宽类型断言让校验通过。
- 手改 `src/generated/plugin-types.ts`。
