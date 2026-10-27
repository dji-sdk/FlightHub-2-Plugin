# 05 校验、调试与诊断（Validation & Debug）

何时读取：Step 3 的本次帮助/类型生成、前后端校验分流、测试、构建、MCP 参数告警与任务、HTTP preview 手动闭环、dev、IDE 保存回执与仍存限制、DAG 来源与诊断。

前置条件：前后端实现完成（或需增量验证时也可单独使用）。

## 开发者工具与实际加载

工程内用实际本地 CLI/scripts，查所选包真实路径、版本及同包开发运行时数据。
探针 `ready` 只检查 manifest 最小字段，不验证文件/hash/Schema/知识；按 01 精确读取所需数据，并执行本次 Toolchain 的适用生成/校验。
损坏时报原始脱敏诊断，按 00 恢复同版来源，不安装完整 Contract、不读任意内部文件兜底。

开发者工具的初始安装按 00 纯源码路线：工具根目录 `pnpm install --frozen-lockfile` 后 `pnpm build:tooling`。
再直调 `packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs` 复验本次帮助和实际开发运行时数据读取，不要求全局注册。
插件新工程没有锁时按实际 `create --install`/README 安装；工程本地包优先于探针 `--platform-root`。
模板命令位置见 02，Capability 后端成员不能假设有自己的 scripts；根前端 `test` 不证明后端业务测试。
所需事实不查不猜：缺声明按 01 标注需验证，不静默输出。

## 验证序列（窄而可靠，按序执行）

1. `generate`：前端/Capability 类型（优先工程 `generate` script）。
2. `types`：后端 ambient 类型（后端工程/成员才需要）。
3. `validate`：按目标插件/Capability/工作区根发现并校验；显式 Manifest 与后端根的分流见下文。
4. 聚焦单测：只跑与变更相关的 vitest。
5. typecheck：`tsc --noEmit` / `vue-tsc --noEmit`（模板 scripts）。
6. `build`：受影响范围。

优先 package scripts（保留本地参数与版本）。全量回归仅在共享 SDK/Toolchain 变更、跨多成员变更或用户要求时执行，使用所选副本实际 scripts；不要求内部 Engine/宿主作者源码或维护流水线。

依赖前置：`validate` 需要从工程解析 SDK；依赖未安装时报"无法从项目根解析 SDK"类错误。此时先安装依赖再 validate，禁止绕过版本解析。错误码、退出码与诊断含义以契约 tooling 诊断目录与实际输出为准，不预存清单。

### validate 的前后端分流

先查本次 `validate --help`，再核对实际目标目录与清单侧别；路径相对 `--root`，`--root` 相对调用 cwd：

- 不传 `--manifest` 时按根目录发现工作区、Capability 或插件；校验后端源码使用 `fh2-plugin validate --root <后端插件目录>`，不传 `--manifest` 或 `--config`。
- 显式 `--manifest` 会跳过上下文发现，直接走前端清单校验，不是前后端通用入口；即使文件也叫 `fh2-plugin.json`，也不能拿后端清单传给它。
- Capability 根需要自定义 Rsbuild config 时，必须用 `--manifest` 指定一个前端插件；这个结果不代表其他成员或后端已校验。

## 类型生成纪律

- 先核对本地版本本次 `fh2-plugin types --help` 与其他适用命令帮助；帮助只读，不执行生成，帮助成功不等于生成完成。
- 每次改 Manifest/schema/handler/event/workflow 声明后必须重新生成。
- 审查生成 diff：意外删除、路径变化、类型放宽都要查明原因。
- 有 check 模式时用其确认生成物是最新的。
- 生成文件报错 → 修源头契约；禁止改生成文件。

## MCP 任务模型（配置了 FH2 Toolchain MCP 时）

### 参数与未知键告警

所有 MCP 工具接受未知顶层键（passthrough），但只消费实际 Schema 已定义的参数，未知键不会转发给 CLI 或服务。
结果的 `structuredContent.warnings[].ignoredArguments` 是本次请求中排序后的未知键名；JSON 文本与追加文本提示也保留告警，不回显未知值。
知识工具的 `resource_link` 仍需正常读取，不能因告警丢掉原结果或资源链接。

已定义参数的类型、枚举和范围校验仍生效，错误会拒绝调用，不因另有未知键而放行。
例如 `check` 必须是布尔值，`mode` 必须符合工具枚举，`port` 必须是整数；路径边界与服务层校验也仍需通过。
以当前工具 Schema 为准，不把 CLI 的字段名、字符串布尔值或范围直接套给 MCP。

未知参数告警在工具执行后附加，**不表示请求被拒绝、支持该参数或执行只读**。
工具仍按已定义参数与默认值执行：`generate` 只传 `"--check": true` 会忽略该键，缺省 `check` 按生成处理，可能已经写盘；真正只检查要传 `check: true`。
同理，`"--root"` 不是 MCP 的 `path`，被忽略后仍按服务默认根操作。
调用前确认真实字段、目标根和写入授权；收到告警后先核对结果、磁盘或任务是否已受理，再在原授权内修正参数复验，不直接重复可能有副作用的动作。不保存未知值或凭据。

### 任务状态

任务纪律表（ID 供交付汇报约束自查引用）：

| ID | 阶段 | 判断依据 |
| --- | --- | --- |
| MCP1 | build/pack 有限任务 | taskId 只代表已接收；有界轮询 get_task 到 succeeded/failed/cancelled，再核对诊断、版本与产物 |
| MCP2 | start_dev 接收 | 保存任务身份、根与授权；queued/running 不证明就绪 |
| MCP3 | dev 就绪 | 当前客户端真实提供的启动输出/URL及相应健康检查，不从 taskId 或端口占用推断 |
| MCP4 | dev 常驻 | 就绪后继续联调/看诊断，不等待 succeeded；--no-watch 只构建一次，服务仍常驻 |
| MCP5 | dev 退出 | 只取消自己的任务，确认清理；正常停止按 cancelled，异常退出按真实结果，不当有限任务成功 |

等待超时是客户端观察结果，不是新增任务终态。
当前 get_task 快照没有日志正文或 URL 字段，拿不到就绪证据就写未验证，不猜日志/URL API，也不另启第二个 dev。
区分传输成功和结果状态 ok；ok=true 仍需检查 Diagnostics。
路径按实际 open/contained 模式解析，但只操作用户确认的根；无 MCP 用本地 CLI/scripts，不静默更换全局版本。

## 本地调试

### dev（本地调试页面）

按本次 `dev --help` 与实际工程核对根、成员、watch 和 Gateway 模式，说明构建写入、常驻、端口及可能的真实 Gateway 访问，按确认制度获用户同意后启动。
后端单成员/backend-only 可只启 Gateway，不要求出现前端四面板。
本地 Mock 后端不执行真实 Workflow，不证明生产依赖就绪。

需要固定驾驶舱路由时，先核对工作区根 `package.json` 是否有 `dev:cockpit`，再用所选包管理器运行该脚本。
成员目录的同名脚本只调试该插件，不能假定任意子目录都命中根脚本；旧工程仍可按本次帮助显式指定能力根。
失败输出中的位置提示只辅助定位，不替代原错误或改变输入规则；核对实际目标，不自动改目录或重跑有副作用的命令。

使用本次 CLI 打印的完整 URL，保留组织/项目路径、query 与 hash，不只打开 origin，不手拼固定 ID/端口或复用旧会话。分开验证首次 build、服务健康、激活/界面与业务结果。

| 面板 | 核对内容 |
| --- | --- |
| 插件 | 当前加载成员、版本、启用状态与健康，不把已安装当激活成功 |
| Host | 当前页面需要与实际挂载状态、手动卸载/恢复反馈 |
| 场景 | 本次 Mock/Proxy/全栈模式与模拟输入，不当目标环境结果 |
| 诊断 | 插件/Host/阶段的构建、activate/runtime/view/dispose；资源是记录时快照 |

Host invisible 非卸载：页面不可见不等于宿主已卸载。
先核对本次路由/生命周期事实，再看 Host 面板的"当前页面需要"和"挂载状态"，观察切换或经确认的卸载/恢复反馈。
诊断资源快照不是当前计数；需要释放证据时使用本次契约/现有检查，拿不到就写未验证，不猜资源 API。
结束时停止自己的进程/任务，确认端口与 watcher 清理；经同意保留则报告仍常驻。

### preview（真实司空受控预览）

按本次 `preview --help` 与实际用法核对，单独确认构建、真实环境访问、浏览器打开、PAC 配置和常驻/清理影响后启动。
仅支持完整 HTTP URL，通过 HTTP Origin Proxy/PAC 预览；HTTPS、证书及 `--local-protocol` 路线已撤项，不再使用 `--cert`/`--key` 或旧证书环境配置。
不安装证书、不忽略证书告警、不擅自将 HTTPS 目标改为 HTTP。目标须支持插件调试，用户须有登录与项目访问权限；地址不能带用户名或密码。

Preview 只替换本地前端，后端仍是目标环境已安装版本，不是本地后端或本地调试页面；分别核对身份、版本和业务依赖。
后端插件目录不支持 preview。受限代理只允许选定 HTTP Origin（协议、域名和端口），其他来源拒绝，PAC 对其他来源走 DIRECT；不提供 HTTPS 隧道或保证 WebSocket 联调。

同 ID 远端插件走资源覆盖（overlay），未安装插件走获准的临时运行（temporary），两者都不等于正式安装。
overlay 只替换远端已声明的图标资源；本地新增 SVG 不能补旧安装清单。先核对声明与资源，元数据升级另获授权，不放宽宿主规则。

1. 从确认的前端插件或 Capability 根启动，使用本次 CLI 分别打印的 SwitchyOmega PAC 地址、调试面板地址和请手动填写的插件来源 URL。
   保持进程运行，先配置并启用本次 PAC；命令不会替你修改浏览器代理。
2. 在同一 HTTP Origin 先由用户登录目标环境并进入目标项目，再打开本次完整调试面板地址，保留项目路径、query 与 hash。
   面板地址仅设置 `fh2-plugin-debug=1`，不预填 `fh2-plugin-preview-source` 或 `fh2-plugin-preview-session`，不自动启用来源。
   需退出登录或切换账号时由用户亲自处理，Toolchain/Skill 不代登录、退出或读取凭据。
3. 在宿主面板手动填写本次终端打印的完整插件来源 URL，即本次会话的资源根 URL。
   它不是 Entry JS、单插件 Manifest、调试面板地址或 PAC 地址；不沿用旧来源，不手拼端口/session。
4. 由宿主面板校验来源和插件清单、展示插件权限；用户核对权限并勾选临时运行同意（consent）后，确认并按面板提示重载。
   工具链不代确认，不改写宿主校验、权限或同意规则；拿不到目标环境证据就写未验证，不为说明修改 Host。
5. 分开核对本地构建/代理就绪、宿主实际加载/激活和业务结果。
   只有本次会话路径的插件清单与资源来自本地，普通页面与接口仍转发目标环境；本地 ready 或浏览器打开不等于宿主已加载，更不证明真实 Workflow 成功。
   默认 watch 持续重建，`--no-watch` 只构建一次但代理仍常驻；插件 ID 变化需重启 preview，并重新手填本次资源根、校验、同意与重载。
6. 用完停止自己的 preview（CLI 按 Ctrl+C），在宿主面板禁用本地预览，恢复本次 PAC/代理设置，确认端口、watcher 与会话清理。
   需保留常驻另获同意；不假设停止本地服务会自动禁用浏览器或宿主配置。

完整 PAC/资源根 URL 可能含 session 凭据，报告/基线只存安全描述，不复制完整会话 URL、Token、Cookie 或私钥。上述是操作说明，不是自动生成的参数规则或公共批准。

### serve / IDE 与 DAG（可选）

serve 提供本机 Web IDE 和可操作工程的 API，不是只读文档页。核对本次 `serve --help`、根与版本，经同意常驻/写入后启动，用本次打印地址，用完即停，不保存首页 Token。

先核对本地命令存在，再在已确认根执行只读查证：

```sh
fh2-plugin knowledge --help
fh2-plugin knowledge status --root <已确认根> --json
```

开发运行时数据与 backend knowledge 是两套独立数据。
对照 status 和 IDE"检查依据"的知识锁、knowledgeId、bundleDigest、Worker revision、contractsVersion、local、checkerAvailable、问题与 Catalog 来源。
未固定/缺失/摘要不符/实际 builtin-snapshot 回退原样报告，不拿 MCP 检索结果冒充 DAG Catalog。
每次 import/use 或知识锁升级先说明身份、摘要与兼容影响并显式同意，安装不等于固定，不跟随最新版本；数据目录、支持数量与版本从本次输入取，不写死。

DAG 预检非执行。浏览器结构/引用反馈与服务端默认内置目录的快速预检不等于同版本权威 Workflow checker，当前权威 checker 仍缺失；没有本地错误不证明真实流程、设备副作用、部署或公共成熟度。源码存在/查到用法不是公共批准，不添加相似 API 猜测。

### IDE 保存回执与限制

文本编辑器 Ctrl/Cmd+S 请求保存当前文件；默认还会在停止输入约 1 秒后自动保存，设置里可关闭。
工作流视图的「保存」请求 DAG 保存（当前工作流及其引用的脚本和清单），
「更多 → 保存全部改动（N）」才扩大范围。
逐个核对回执覆盖的路径、提交内容、磁盘 revision 与当前编辑内容，不能只看保存按钮或绿色节点。

成功回执只推进**已提交内容**的磁盘基线。保存期间继续编辑的当前内容仍未保存，不能把已落盘的旧内容当成已保存当前内容；核对剩余 dirty 内容后再请求下一次保存。
新文件首次 `create` 成功后，当前文档标记 `existsOnDisk=true` 并保存 revision；继续编辑的第二次保存走带 `expectedDiskHash` 的 `write`，不再重复 `create`。这只修复该状态路径，不能承诺每份新文件或整批保存成功。

服务端按脚本 → 清单 → 工作流有序保存，失败即停；`FH2_IDE_SAVE_SKIPPED` 表示后续项根本未执行，当前协调器归入 `pending`，不再混进 `failed`。
分别核对 `saved`、`failed`、`conflicted`、`pending` 和 `partial`；已经成功的文件不会自动回滚，未落盘内容继续保留。
不能把 pending 当已尝试写入或把 partial 当全失败/全成功；响应丢失时先核对磁盘，无法核对就报告结果未知，不盲重试整批。

用法源的问题 ID 仍保留用于对账，但旧 manual-guide 可能尚未更新。按当前实际消费逻辑与回执区分已修正和仍存限制，不把旧“待修复”文字当当前行为，也不因此宣布 reviewed Bundle 或开发资产审核已完成：

| 用法源问题 ID | 当前状态与动作 |
| --- | --- |
| IDE_SAVE_DETACHED_SCRIPT | 已修正：检查器里编辑的脚本（含没有独立标签页的）纳入保存计划；仍以回执中出现的路径为准，未出现就核对版本与磁盘 |
| IDE_SAVE_NEW_FILE_STATE | 状态路径已修正：首次 create 成功后推进存在状态和基线，二次保存走 write；若仍遇到 FH2_IDE_ALREADY_EXISTS，保留编辑并核对当前版本、回执和磁盘，不反复点保存 |
| IDE_SAVE_TASK_BARRIER | 部分修正：任务入口先保存全部改动，但新文件仍可能先读磁盘报 404、输入框草稿未提交。先请求 DAG 保存，再核对所有相关路径与磁盘；未确认完整落盘不直接启动任务 |
| IDE_SAVE_SKIPPED_RECEIPT | 分类已修正：FH2_IDE_SAVE_SKIPPED 归 pending（未执行），不归普通 failed；按回执逐项核对已写/失败/未执行，不假设全部回滚 |

保留外部磁盘冲突、部分保存与任务屏障限制；DAG 保存及回执分类修正不替代跨进程事务、同版本权威 checker 或浏览器完整交互验证。

## 来源分层

参数核对本次帮助/生产 `CLI_DEFINITIONS` 数据，MCP 参数核对实际工具 Schema 与消费逻辑；`runtime-policy.json` 核对生产 policy 值。
manual-guide/manual-description/manualFields 是人工说明，不宣称机器自动生成、执行保证或 public 批准。
旧指南与当前消费行为冲突时分别报告当前行为和待同步项，不用旧提议类型补事实。
新 profile、源码修复和测试成功不代表旧 Bundle 已更新；仍存限制、uncertainties 和 blocked 随结论报告，公共表达仍需独立人工确认。

## 诊断与自纠

失败时按序：

1. 保留原始命令与完整错误/结构化 Diagnostic 的脱敏记录；不保存凭据、客户数据或环境全集。
2. 按 `phase`、`code`、`file`、位置、`hint` 分类。
3. 先修最早因果阶段：parse/schema → semantic/contract/code → typecheck/bundle/runtime 验证。
4. 回读相关声明与生成类型；不凭错误文字猜 API。
5. 一次一个针对性修正，用能证明它的最小命令复验。
6. 修复后恢复剩余验证序列。
7. 同一阻断经两次不同的、基于证据的修正仍失败 → 停止重试并上报：报告事实、已试修复、缺失决策，交用户裁决。

禁止绕过：改生成文件、宽类型断言、禁用校验、无依据重试同一命令、timing sleep、生产专用测试分支。

## 出口条件

- [ ] generate/types → validate → 聚焦单测 → typecheck → build 全部通过（或有用户明确豁免项）。
- [ ] 发行身份、纯源码构建、所选 CLI 与同包数据已按适用范围核对，manifest 探测未冒充完整加载/知识/应用验证。
- [ ] validate 前端显式 Manifest 与后端根分流已核对；MCP 合法参数/默认写入及未知键告警已核对，没有把忽略参数当只读或拒绝执行。
- [ ] 有限任务终态与 start_dev 接收/就绪/常驻/退出分开报告，缺证据写未验证。
- [ ] dev/preview/serve 自己的端口/任务/watcher/PAC 已清理，或经同意保留并说明。
- [ ] dev 四面板/完整 URL/宿主卸载与 preview HTTP-only/PAC/登录项目/手填资源根/权限同意重载/远端后端边界已按适用范围核对，ready 未冒充宿主加载。
- [ ] IDE/DAG 来源、锁、预检、二次保存 write/pending 回执与仍存保存限制已查证，当前内容落盘已核对，没有未经授权的锁升级或公共保证。
- [ ] 诊断过程中发现的所有契约缺口已上报或修复。

## 反模式

- 把 MCP `taskId` 当成功证据。
- 等 start_dev 成功终态才判就绪，把页面隐藏当宿主卸载，把诊断快照当当前资源计数。
- 把 MCP 未知键当已支持参数或只读开关，收到 warning 不核对已发生的写入/任务就重复执行。
- 手拼 PAC/会话地址、期待面板链接预填来源，Preview 当本地后端，知识安装当固定或预检当真实运行。
- 相信“保存全部”全部成功，把旧内容已落盘当当前内容已保存、pending 当写入失败或 partial 当已回滚，隐去仍存限制，或把 manual guide 当机器执行策略。
- 校验失败就放宽类型或改生成物。
- 不看 phase 顺序瞎修。
- dev/preview 不经确认就启动，或用完不清理。
- 同一命令原样重试。
