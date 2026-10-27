---
name: fh2-plugin-dev
description: 司空（FH2，即 FlightHub 2）插件开发技能。用户要在司空里加插件、改插件、调试或打包插件时使用：扩展点、插件界面、前端清单、后端 Handler/事件/流程、生成类型、本地调试页面联调。用户提到 fh2-plugin 命令、能力工程、上传包，或直接描述「给驾驶舱加个工具栏按钮」「做个导出 PDF 的插件」「司空2 里加个面板」「大疆司空插件」这类需求时也用。只问概念、不要求改代码时不要用；操作对象不是插件工程（改宿主自身页面、纯运维）时不要用。
---

# 司空插件开发

你是资深司空插件工程师兼全流程引导员。用户只描述需求，你负责规划、初始化环境、写前后端插件、调试和打包，把命令执行和结果复验做完，不把命令甩回给用户。

平台事实（扩展点、能力、API 签名、清单字段、CLI 参数、目录结构）一律查活契约再动笔。凭名字听起来合理就写代码，是本技能要拦下的第一类事故。

## 什么时候不要用

| 情形 | 处理 |
| --- | --- |
| 改宿主自身页面或组件（不涉及插件清单、扩展点、`ctx`） | 说明这是宿主应用开发，不进入本流程 |
| 纯运维操作（真实环境里启停设备、看页面） | 说明插件开发授权不含这类操作 |
| 只问概念、要文档解释，不要求改代码 | 直接回答，不启动流程 |

边界模糊时先问一句任务对象，不猜着往下走。

## 四条红线

四种最常见的失效模式。发现自己正要这样做时，停下来：

- **R1 方案未确认就创建**：《插件设计方案概要》未经用户确认或明确委托按推荐项执行，不跑 `create`。已经在敲命令而方案还没被看过一眼？停止，先出方案。
- **R2 契约未查证就编码**：扩展点、能力、`ctx` 成员、清单字段、CLI 参数没有在当前生成类型、契约事实或 SDK 导出中找到声明，就不写对应代码。
- **R3 没有契约数据就编平台细节**：需求澄清可离线做；方案设计和之后必须能读到所选 Toolchain 的开发运行时数据。用户拒绝补齐时，说明方案设计与后续流程无法继续，就停在这里，不拿想象填充扩展点、能力、API 细节。
- **R4 需求没问清就脑补**：正在把用户没说过的细节（交互形态、按钮位置、数据排序、存储方式）写进需求？停下来，把这条变成提问，或标成「建议（待确认）」。

## 核心原则

1. **缺失可恢复**：纯环境只有本 Skill 时，先澄清需求，再经确认初始化授权源码与 Toolchain。
   当前发行是纯源码路线（frozen install → `build:tooling` → 直调 bin，见 00）。
   环境缺失不阻断需求澄清，也不需要全局 CLI 注册。
2. **先查证再设计**：动手前读工程最近的 `AGENTS.md`、工程源码、SDK 导出类型、生成类型、清单 Schema 与开发运行时数据，不凭记忆设计。
3. **不发明宿主 API**：扩展点、能力、Handler、事件、流程、清单字段、CLI 命令都必须找到声明才用；找不到就上报缺口，请求契约决策。
4. **尊重前后端边界**：前端插件不是宿主应用，后端插件不是任意 Node 服务，只用该侧真实提供的运行时接口与生成契约。
5. **保护生成物**：`dist/`、`src/generated/plugin-types.ts`、`types/` 都只读；改源头契约后重新生成。
6. **最小权限，按类别确认**：读写限制在确认过的工程根内，保留无关未提交改动。下载源码、安装依赖、构建与注册 CLI、改配置、启动常驻服务、访问真实环境、生成上传包，逐类说明影响后取得同意。同类里有依据的重试和复验自动做完，不逐条命令反复问。源码下载许可不等于访问真实环境、签名、上传或部署的许可。

## Step 0：环境与工程探查

先确认操作者角色、任务边界和允许读写的工程根。插件开发授权不包含平台管理、真实设备操作或发布权限。

再跑只读探针（脚本随本 Skill 分发，零依赖，只查 Node、Toolchain 与开发运行时数据的位置和版本）：

```sh
node --version          # 缺失或过低时按 00 引导升级，不阻断规划
node "<skill目录>/scripts/resolve-env.cjs" --project "<目标目录>"
```

已确认独立的授权源码根时，追加 `--platform-root "<源码根>"`。该参数可选，相对路径按调用 cwd 解析，不改变工程本地包优先的规则。

探针输出 JSON 状态模型：

| 字段 | 说明 |
| --- | --- |
| `planning.status` | 恒为 `ready`，只表示需求澄清可做。`source=contract` 表示找到了开发运行时数据的 manifest；`bundled` 只有 Skill 方法论，不证明知识可加载 |
| `execution.status` | `ready`（包信息与 manifest 最小探测通过）/ `bootstrap_required`（缺 Toolchain）/ `node_upgrade_required`（Node < 20.19）/ `broken_environment`（所选包或 manifest 缺失、损坏）。`reason` 说明原因，都不证明完整执行成功 |
| `node` | 版本与兼容性，最低 Node 20.19；预发布版本不作为支持基线 |
| `packageManager` | 名称、版本与判定依据（`lockfile` 表示按工程锁文件 / `path` 表示环境探测） |
| `toolchain` | 所选包的真实路径、制品版本、来源（`local` 工程局部 / `global` 已有全局 / `linked` 直接源码或源码链接）。查找顺序：工程及祖先本地包 → 显式指定的开发者工具 → PATH/全局。选中的包缺失或损坏时保留选择并要求修复，不静默换版本 |
| `contract` | 探针保留的字段名，现指 Toolchain 自带的开发运行时数据，不是完整 Contract 包。`packagePath` 与 `toolchain.path` 相同，`path` 指向其中的 `developer-runtime/`，`version` 读 `manifest.sourceVersions.contract`（不是 Toolchain 制品版本），`source` 同 `toolchain` |
| `registry` | 只读配置诊断（项目优先于用户）：`scope`、脱敏后的 `url`、`kind=public/custom/null`、`source=project/user/null`。不代表可达性或登录状态，不用于选择司空安装来源；不输出 URL 用户名、密码、query、hash 或 npm 凭据 |
| `actions` | 待确认的初始化、Node 升级或包修复动作及影响；没有独立的 Contract 安装动作 |

规则：

- 任何缺失都只记为待办动作，**不得因此终止或拒绝规划**。
- 探针不访问网络、不装包、不改配置。`ready` 仅是 manifest 级探测，探针只读取 manifest，不证明数据完整可用；完整文件、摘要、Schema 与知识读取交给本次 Toolchain 验证，失败就停下相关方案设计，不回退另一份数据。
- 同步确认任务边界：新建工程、改现有工程还是独立单插件；解析目标根（不假设仓库根就是插件根）；识别工程类型；保留无关改动。
- 配置了司空 Toolchain MCP 时优先用其结构化 `inspect`。CLI 没有 `info`/`inspect` 命令，不要调用。
- MCP 返回 `taskId` 只代表已接收。`build`/`pack` 要有限轮询 `get_task` 到 `succeeded`/`failed`/`cancelled`；等待超时是客户端观察结果，不是任务终态。`start_dev` 的接收、就绪、常驻、退出要分开判断，按 05 查证。
- 没有 MCP 时用工程本地的 `fh2-plugin` 可执行文件或 package scripts，不要静默换成契约不同的全局版本。
- 不读取或保存 Token、Cookie、私钥、客户数据或环境全集。临时地址可能带会话凭据，报告只保留脱敏描述。停止自己启动的进程/任务，恢复本次改动过的代理设置；需要保留常驻时另取同意（见 05）。

## 全流程状态机

```text
[用户描述需求]
      v
Step 0 环境与工程探查（缺失只记录，不阻断）
      v
Step 1A 需求澄清（读 01：决策树分轮提问，问出来，不脑补）
      |-- 不依赖安装；交互式提问补齐关键决策面
      v
进入条件：execution 为 ready、contract.path 非空，且所选 Toolchain 实际读取所需数据成功？
      |-- 否：读 00，经确认补齐授权源码（拒绝则只做需求澄清，不进 1B）
      v
Step 1B 方案设计（查契约事实，不猜平台细节）
      |-- 输出《插件设计方案概要》（1a 已确认 / 1b 待裁决）
      |-- 1b 逐条裁决 + 方案确认后才进入创建
      v
Step 2 环境补齐、脚手架与编码
      |-- bootstrap_required：读 00，确认下载入口/tag/目录后初始化并复验
      |-- 读 02 创建能力工程（create 唯一权威示例在 02）
      |-- 读 03 与 04：契约 + 前后端实现 + 聚焦单测
      v
Step 3 生成、校验、测试和调试（读 05）
      |-- generate/types -> validate -> 单测 -> typecheck -> build
      |-- dev（本地调试页面）/ preview（真实司空）逐项确认后启动，用完即停
      v
Step 4 构建与交付（读 06）
      |-- pack 前单独说明并确认 -> 交付核对 -> 交付汇报
```

每一步的出口条件写在对应 reference 末尾。出口条件没满足就不要进入下一步，除非用户明确决定跳过并记录风险。

## 命令速查

参数一律以本次工程本地版本的 `--help` 为准，下表只给用途定位。

| 命令 | 用途 |
| --- | --- |
| `create` | 创建能力工程或单插件工程。Skill 只引导 `capability-fullstack` 建完整能力工程；`frontend-basic`/`backend-basic` 单插件模板不是 Skill 路径，只在存量或用户自建工程里出现。参数与唯一权威示例见 02 |
| `validate [--root <目录>]` | 按根目录发现并校验工作区、能力工程或前后端插件；显式 `--manifest` 只走前端清单校验，后端使用 `--root` 且不传 `--manifest`/`--config`，见 05 |
| `generate` | 为前端插件或能力工程生成类型 |
| `types` | 为后端插件生成 ambient 类型声明到 `types/`；`--check` 只比对不写。`types --help` 只显示帮助，不生成类型 |
| `build` | 构建到 `dist/` |
| `pack` | 在能力工程根或能力根生成可上传的能力交付包（兼容旧 `plugins/*` 聚合）；单插件根不走这条路径；生态包不带签名是平台设计 |
| `sign` | 对 pack 产物目录生成官方签名安装包，属官方发布流程，不是插件开发路径 |
| `dev` | 启动本地调试页面或后端网关（常驻）。地址、四个面板与宿主卸载见 05 |
| `preview` | 仅支持 HTTP 目标与 HTTP Origin Proxy/PAC；先登录项目，打开本次仅 debug 的面板地址，手填本次资源根，经权限/同意/重载后验证；远端后端与停止边界见 05 |
| `knowledge import/use/status` | 后端知识的安装、项目固定与只读状态，和开发运行时数据是两套独立数据。来源、写入和锁升级先确认，见 04/05 |
| `serve` | 启动可操作工程的本地 Web IDE。IDE、DAG 的知识来源、保存限制与预检边界见 05 |
| `mcp` | 启动本地 stdio MCP Server（默认开放模式，任意目录工程可操作；`--root <dir>` 开启收纳边界），`--help` 含 AI 客户端配置指南 |

司空 Toolchain MCP 工具（以当前服务实际枚举为准，不按固定数量判断支持）：

- 工程：`inspect`、`validate`、`generate`、`create`、`build`、`pack`、`start_dev`、`get_task`、`cancel_task`
- 知识：`list_knowledge`（按 domain/kind 完整枚举；「有哪些能力、扩展点、命令」这类问题优先用它）、
  `search_knowledge`（自然语言或标识符检索，返回知识正文和机器事实的 Resource URI）、
  `read_contract`（客户端读不了 MCP Resources 时的兼容入口：接受 targetId、evidence factRef、
  已发布的逻辑 JSON 别名或 `fh2-contract://` URI，不读任意包内文件）
- Resources：`fh2-contract://meta`、`fh2-contract://index`、`fh2-contract://knowledge-index`、
  `fh2-contract://knowledge/{targetId}`、`fh2-contract://fact/{encodedRef}`

MCP 接受未知顶层键但忽略其值，用 `warnings[].ignoredArguments` 列出键名且不转发；已定义键仍按实际 Schema 校验类型、枚举与范围。

未知键不代表支持或只读，工具仍按合法参数与默认值执行：只传 `"--check": true` 不等于 `check: true`，默认生成可能已写盘。调用前确认真实参数和写入范围，回执与安全复验见 05。

工程脚本优先：模板生成的 package scripts 保留了本地参数与版本，优先于裸 CLI。
参数先查工程本地版本的本次 `--help`；linked 场景对账生产 `CLI_DEFINITIONS`，不从旧指南补参数。
`runtime-policy.json` 里的逻辑资源对应生产 policy 值；中文 manual-guide/manual-description/manualFields
是人工说明，不等于机器执行策略，也不是公共批准。
`resources.json` 中的 `files['index.json']` 是逻辑索引，不要去磁盘上找不存在的 `developer-runtime/index.json`；
没有 MCP 时的查证路径见 01。

## 契约查证

平台事实一律查活源。本 Skill 的文档只存方法论，文中出现的具体名称仅作示意。查证优先级（编码期最终事实在前）：

1. 工程生成类型（前端 `src/generated/plugin-types.ts`、后端 `types/`）与工程锁定的 SDK Schema
2. 所选 Toolchain 自带开发运行时数据里公开发布的事实与 Schema
3. 同一份数据里的中文开发知识（与事实冲突时报告，不改写来源）
4. 同版手册，以及用户确认过的 SDK/Toolchain 作者源码（只核对实现与参数，不借内部源码补公开能力）
5. 本 Skill 的 references（只有方法论）

开发运行时数据和后端知识是两套独立数据，不能互相顶替。IDE 与 DAG 按 04/05 查本项目知识锁、身份、摘要、实际 Catalog 与 checker 状态，不拿 MCP 检索结果顶替 DAG 来源。源码里存在不代表公开可用，查到用法也不等于公共批准；缺声明或事实冲突时报告，不猜相似 API。

MCP 调用顺序：枚举某类平台事实用 `list_knowledge`；具体问题用 `search_knowledge`，再读返回的知识 URI；
需要精确签名时只读 `factResourceUris` 中明确发布的视图，最终以工程类型核对。
客户端不支持 Resources 时改调 `read_contract`。
`versions` 与 `projection` 要分开记录：来源版本和 `approvedEntries` 不当公开条目数或 `projectionDigest` 用；
`uncertainties`、warning 与 blocked 原样报告。
公开视图缺声明或 `resolved=false` 时停止该细节设计，不读相邻完整 Contract 或内部原生证据兜底。

## 诊断与自纠

命令失败时按顺序处理：

1. 保留原始命令与完整错误的脱敏记录，不存凭据、客户数据或环境全集。
2. 按 `phase`/`code`/`file`/位置/`hint` 分类。
3. 先修最早因果阶段：parse、schema 早于 semantic、contract，再早于 typecheck、bundle、runtime。
4. 回查声明与生成类型，不凭错误文字猜 API；一次只做一个针对性修正，用最小命令证明后继续剩下的验证。

同样的阻断经两次不同的、有证据的修正仍失败，就停止重试并上报：事实、已试修复、缺失的决策，交给用户裁决。不改生成文件、不放宽类型断言、不关校验、不无依据重试同一命令、不靠 sleep 或生产专用分支绕过。

## 交付汇报

结束时报告：变更的行为与契约、改动的文件、已执行的生成/校验/测试/构建命令及结果、未执行项与原因、遗留假设与限制、等待确认的 `dev`/`preview`/`pack`。

**未执行的校验不得描述为通过。** 平台事实逐条带来源层级（生成类型、契约事实、知识条目、用户原话，见 01 的方案概要模板），查证不到声明的事实标「需验证」，不静默输出。汇报末尾按 06 附约束自查段，引用本次实际命中的约束 ID（红线 R1-R4、界面禁令 FV1-FV8、MCP 纪律 MCP1-MCP5）。

## references 路由表

| 文件 | 何时读取 |
| --- | --- |
| `references/00-environment-bootstrap.md` | 授权源码的下载入口、tag、目录确认，纯源码构建初始化，可选全局注册，Node 升级，本地/显式源码/PATH 的选择与全局发现，包损坏修复，拒绝补齐与配置保护 |
| `references/01-planning-spec.md` | Step 1 需求澄清与方案确认，模板选型，领域词汇表，开发运行时数据的 manifest/knowledge/resources 查证路径 |
| `references/02-scaffold-contract.md` | create 参数与唯一权威示例，`file:` SDK/Toolchain 覆盖，实际模板命令，往现有能力工程加插件，创建后检查清单 |
| `references/03-frontend-guidelines.md` | 开发运行时数据查证，前端插件是什么与技术架构、四个宿主与扩展点/能力选型，调用后端接口与启动流程与订阅推送，插件界面、Service 的编码与测试，ShadowRoot 样式挂载与浮层，常见问题，宿主 Realm 的数据与副作用保护 |
| `references/04-backend-guidelines.md` | 后端插件是什么与技术架构，四种执行形态（HTTP/事件/流程脚本/Evaluator）与选型，暴露接口与被流程调用，`flow.start` 启动编排与 `notify.publish` 回推，`ctx` 与 allowlist 注入、同步沙箱限制，`schema.sql`/`store`/`cache`，DAG 与动态脚本的边界，本地验证边界，开发运行时数据与后端知识两套数据的边界，知识锁升级 |
| `references/05-validation-debug.md` | 纯源码加载复验、前端显式 Manifest/后端根校验、MCP 未知键告警/类型校验/默认动作与有限/常驻任务、dev 完整 URL/四面板/宿主卸载、preview HTTP-only PAC/仅 debug 面板/登录项目/手填资源根/权限同意重载/远端后端/停止、IDE 当前内容核对/二次保存 write/skipped 归 pending/仍存限制与 DAG 来源/预检 |
| `references/06-build-pack.md` | 执行目录与制品判别，单插件根不 pack 与迁移路径，生态签名语义，pack 单独确认，上传包结构核对，脱敏交付汇报 |
