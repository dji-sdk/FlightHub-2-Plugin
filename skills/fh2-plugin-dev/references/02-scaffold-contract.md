# 02 脚手架与契约设计（Scaffold & Contract）

何时读取：Step 2，创建能力工程、检查生成物、设计前后端契约。

前置条件：Step 1 方案已确认；插件化开发者工具已初始化；所选 Toolchain 与开发运行时数据已按 00/01 实际复验。
只有 manifest 探测 `ready` 不算复验完成。

## 工程创建

本文件是 create 的唯一权威示例处，其他 references 只指到这里。

Skill 只引导创建完整能力工程；`frontend-basic` / `backend-basic` 单插件模板不是 Skill 路径（拓扑依据见 01），
本文件不提供它们的创建示例。

```sh
node "<源码根>/packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs" create exp_demo --platform-root "<源码根>" --template capability-fullstack --package-manager pnpm --install
```

参数以本次源码 bin 的 `create --help` 和生产参数定义为准；退出语义核对契约 `tooling.command.create` 的已审核说明，
不把 manual metadata 当机器执行策略。读法：

- 位置参数是**目录**，不是 ID。
- `--template` 三值：`capability-fullstack`、`frontend-basic`、`backend-basic`。
  不给时：带能力类参数取 `capability-fullstack`；带 `--plugin-id` 取 `frontend-basic`；
  其余情况交互模式会询问（默认 `capability-fullstack`），非交互模式取 `capability-fullstack`。
- `--capability-id`：能力 ID，省略时取目录名（`basename`）。
- `--frontend-plugin-id`、`--issues-plugin-id`、`--backend-plugin-id`：前端、现场问题、后端三个插件 ID。
  省略时默认 `<capId>_frontend`、`<capId>_issues`、`<capId>_backend`。
- `--plugin-id`：单插件 ID。能力模板里等同 `--frontend-plugin-id`，两者不能同时给。
- `--name`：展示名称。
- `--package-manager`：`pnpm`、`npm`、`yarn`（Classic 1.22.x）。
- `--platform-root`：指定已初始化的授权源码根。根 name、SDK/Toolchain 包布局和 `examples/` 保持不变，
  不依赖下载文件夹名。实际 bin 也会给出源码定位提示；不改用 `dist/cli.js` 或未发布基线放行来代替。
- `--install` 与 `--no-install` 互斥。`--install` 在 create 内部装依赖并复验类型；
  `--no-install` 跳过，后续补 `install` + `generate`。
- 单插件模板非交互创建必须显式给目录和 `--plugin-id`。
- 不覆盖非空目录；目标目录有内容时先报告并确认。

ID 规则与校验以 create 的实际校验和契约 tooling 机器事实为准（`official_`/`exp_` 前缀只为示意）。

`capability-fullstack` 生成的结构：根 `packages.json`（平台上传清单）+ `<capId>/` 能力目录。
能力目录里有 `capabilities.json`、前后端插件和 mock 数据。模板自带示例插件，按方案增删（见下节）。

## 往现有能力工程加插件

加插件不是新建工程：create 不支持向现有工程追加插件。能力工程按**目录发现制**找插件：

- 能力目录的 `frontend/<id>/` 与 `backend/<id>/` 下的插件清单被自动发现，不靠 `capabilities.json` 声明。
  `capabilities.json` 只装名称和描述。
- 目录名必须与清单里的插件 ID 一致。不一致是强校验错误，validate 会直接报出来。

加插件、加能力、删示例插件各怎么做：

- **加插件**：把插件目录放到 `<cap>/frontend/<id>/` 或 `<cap>/backend/<id>/`。
  - 目录名与清单里的插件 ID 一致。
  - 依赖/覆盖对齐已有插件的本地 `file:` SDK/Toolchain 引用。
  - 完成后 validate 复验新插件被发现并通过。
- **加整个能力**：新建 `<capId>/`（`capabilities.json` + 插件目录），并在能力工程根 `packages.json` 的
  `capabilityIds` 登记。
  - 双向一致：漏登记、或登记了不存在的目录，都报错。
- **删示例插件**：先经用户确认，再删对应插件目录，然后 validate 复验。
  - 纯前端或纯后端组合，只留所需一侧的插件；空容器目录按 validate 实际提示处理。

结构边界以实际 validate/discovery 报错与契约机器事实为准，本节只是路径指引。

## 创建后检查清单

create 成功后逐项核验。生成结构以实际产物与契约机器事实为准，不预存清单。

1. 能力元数据与方案一致：`capabilities.json` 的名称、描述对得上。
2. 前端插件的 `fh2-plugin.json` 对得上方案：`extensions[].point`、`permissions` 一致。
   后端插件的 `fh2-plugin.json` 也对得上：入口、`allowlist` 一致。
   Manifest 字段是否合法交给 validate，不把能力元数据当插件 Manifest。
3. 前后端插件的入口文件和生成类型都在，路径以实际工程为准。
4. 读模板 README 和 package scripts，核对本次要用的 generate/types、validate、build、dev、test 入口和执行位置。
   不假设每个模板都有全部命令；缺哪条，写明原因。
5. 依赖/覆盖只含本地 `file:` SDK/Toolchain。pnpm 的覆盖在 `pnpm-workspace.yaml`，npm/yarn 用各自字段。
   不写完整 Contract 覆盖。`.npmrc` 留空或沿用用户确认的公共 registry，模板不注入私有 scope。
   核对实际解析包内的 `developer-runtime/`、应用输出和固定资源，不只看版本字符串。
6. 在工程根重跑探针：`execution.status === 'ready'`、`contract.path` 非空、
   `contract.packagePath === toolchain.path`，版本取所选包 manifest。
   探针只证明 manifest 能读，不等于完整加载；实际读取所需知识后再执行生成/校验。

## 实际模板命令

新工程首次安装由 `create --install` 完成，或按生成 README 用所选包管理器执行 `install`。
没有锁文件时不加 frozen；授权源码根的发行安装才用 `--frozen-lockfile`。
安装后优先工程本地的 CLI/scripts，不静默切全局。

| 位置 | 现有入口 | 限制 |
| --- | --- | --- |
| 前端插件根（含存量独立单插件工程） | `generate`、`validate`、`test`、`tsc`、`lint`、`build` | `dev`/`preview` 常驻需确认；单插件根不执行 pack（见 06） |
| 后端插件根 / 存量独立后端单插件工程 | `generate`、`types`、`types:check`、`validate`、`tsc`、`build`、`dev` | 没有默认 `test` 或 `pack` script；业务修改仍要补聚焦测试 |
| 能力工程根 | 根 scripts 经 `--root <capabilityId>` 调用 generate/validate/build/dev/preview/pack | `test` 只跑已有前端插件的测试，不等于后端业务验证 |
| 能力后端插件 | 没有插件级 `package.json`；类型与构建走能力工程根的本地 CLI（显式 `--root`） | 不要照抄不存在的插件级 `pnpm run pack` |

模板 README/scripts 是执行位置的事实，逐个核对，不把上表当所有版本通用的快照。
授权源码目录移动或升级时按 00 明确确认，并刷新所有 `file:` 路径、覆盖和安装结果；不自动升级其他工程。

## 契约设计（跨端）

- **单一权威契约**：同一个 payload 只定义一次。平台支持类型生成时，从契约源生成或导入类型。
  禁止前后端各写一份接口，让它们漂移。
- 改现有插件时，先在源码里找到既有调用/事件契约，不要另起炉灶。
- 契约变更影响公共或跨端 API 时，把变更压到最小，并在同一条端到端功能里更新所有直接消费方。
- 平台没有支持的桥接或类型生成路径时停下来，请求平台契约决策；禁止自造 ad hoc 传输层。
- 契约优先级：当前源码与生成类型 > 导出声明 > Manifest Schema 与宿主契约 > 结构化诊断 > 示例。
  引用示例前先验证其中的 API 仍然存在。

## 前后端职责切分

先判需要哪一侧，再决定要不要拆两个插件：

| 需求 | 结论 |
| --- | --- |
| 只在宿主界面里贡献位置、渲染面板、与宿主交互 | 纯前端插件 |
| 要持久化数据、访问外部系统、跑几十秒以上的任务、定时执行 | 必须有后端插件 |
| 前端要查数据或提交命令 | 前后端各一个插件，接口只定义一次 |
| 同一插件在多个宿主之间要互通 | Service，插件内部协议 |

要点：

- 前端插件负责：扩展点（Point）贡献、插件界面（View）渲染、呈现性 state、宿主交互。
- 后端插件负责：Handler 的查询与命令、事件、流程、数据持久化（`schema.sql`）。
- 同一个插件跨宿主的通信走 Service。Service 是插件内部协议，业务契约由插件自己的共享模块持有。
  前端到后端的数据走后端插件契约，不要和 Service 混用。
- 调用面固定：同步走 `/plugin/invoke`，编排走 `/flows/*`，不另造 ad hoc 传输层（写法见 03/04）。

## 出口条件

- [ ] create 用授权源码根成功生成能力工程，本文件的创建后检查清单 1-6 全部通过。
- [ ] manifest 探测与实际读取分开记录，不把探针通过当完整加载。
- [ ] 前后端契约草案已落成代码里的单一权威定义，或明确标注待复验项。
- [ ] 契约有公共或跨端影响时，已获用户确认。

## 反模式

- 不显式给 `--template`，依赖 Toolchain 的隐式默认模板。
- 在空目录里手写初始化文件，不走 create。
- 用单插件模板新建"交付用"工程：没有能力工程结构，pack 产物不可上传。
  往已有能力工程加插件时，不走加插件路径而另起炉灶。
- 前后端各定义一份 payload 接口。
- 按想象中的部署模型往 Manifest 里加字段；字段合法性以 validate 与契约 Schema 为准。
- 手写 `src/generated/` 或 `types/` 下的文件。
- 写完整 Contract 覆盖、模板私有 scope，或用未发布基线放行来掩盖缺少授权源码定位。
- 在能力后端插件上跑不存在的 scripts，或把能力工程根的前端测试说成后端业务验证。
