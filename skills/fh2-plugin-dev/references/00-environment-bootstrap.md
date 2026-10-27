# 00 授权源码环境初始化

何时读取：授权源码初始化（当前发行只有纯源码一条路线）、可选全局注册、Node 升级、
探针报 `bootstrap_required` / `broken_environment`，或用户要求修复环境。

## 前置条件

- Step 0 已完成：操作者角色、允许读写的工程根与授权边界已确认。
- Node 缺失时先做只读检查：探针本身需要 Node，这一步不能跳过。

## 状态解读

| execution.status | 含义与动作 |
| --- | --- |
| `bootstrap_required` | 未找到 Toolchain；确认授权源码来源和目录后初始化 |
| `node_upgrade_required` | Node < 20.19 或非支持版本；确认后升级，需求澄清照常进行 |
| `broken_environment` | 所选包信息或包内 manifest 缺失/损坏；按 `reason` 修复该副本，不静默换另一版本 |
| `ready` | 包信息与开发运行时数据 manifest 最小探测通过；仍需真实 CLI 和知识读取复验 |

探针 `contract` 保留字段名，现指所选 Toolchain 的 `developer-runtime/`（开发运行时数据）。
`packagePath` 与 Toolchain 实际路径一致，`version` 来自 `manifest.sourceVersions.contract`。
它只检查 JSON、格式标识和来源版本，不验证完整文件清单、摘要、Schema、知识或本地调试页面可用性；
完整验证由本次 Toolchain 执行。

## 确认与保护

1. 说明操作者角色和允许操作的根；读取源码下载许可不授予平台管理、真实环境、签名或部署权限。
2. 汇总动作、实际命令、目标目录、网络/锁文件影响、构建写入和 CLI 注册影响，按类别取得同意。
3. 同类内执行有依据的修复与复验；跨目录、替换全局注册、改配置或扩大网络访问时重新确认。
4. 用户拒绝时明确告知方案设计及之后流程无法继续，并询问是否授权补齐；仍拒绝就只保留需求澄清，不自动安装或反复施压。
5. 报告脱敏诊断和未执行项；不读取或保存凭据、环境全集或客户数据，保留无关未提交改动和旧的有效副本。

源码缺失不是拒绝澄清需求的理由。安装和修复由 Skill 在用户同意的范围内完成，不只甩命令；
需要管理员权限、登录、PATH 生效或来源/版本选择时，请用户亲自处理并等待复验。

## 补齐 Node 和 pnpm

- 最低 Node 20.19，授权源码主链使用 pnpm 10.15.0。
  更高版本是否支持仍以该发行说明和实际测试为准，不以探针数值比较承诺所有平台。
- 检查用户已有的 nvm/fnm/volta/Homebrew 等渠道，说明版本切换影响后确认安装。
  例如在已有 nvm 时使用 `nvm install 20.19.0`、`nvm use 20.19.0`。没有安全渠道或需管理员权限时转交用户，不擅自 sudo。
- 核对 `node --version`、`pnpm --version` 和下载副本的 `packageManager`。
  Corepack 等补齐动作需确认，不擅自改全局包管理器或 npm 配置。

## 授权源码首次初始化

首次只有本 Skill 时，先问清三项，不猜版本标签或 FH2 npm 安装坐标：

1. 公开仓库源码目录（https://github.com/dji-sdk/FlightHub-2-Plugin），或用户已经取得的副本。
2. 固定 tag/commit 与内容身份；下载归档无 Git 时按发行记录核对，不能要求 `git init`。
3. 稳定保存目录、允许的下载/安装网络与构建范围；与待创建业务工程分开。全局 CLI 注册独立可选，不作为初始化前置。

缺固定版本时标待确认，不以"最新版"、内部维护仓或 FH2 npm 包替代。
官方发行保留根 `package.json`（name 为 `fh2-plugin-platform`）、`packages/fh2-plugin-sdk/`、
`packages/fh2-plugin-toolchain/` 和 `examples/`，不依赖解压后的文件夹名。
核对该副本的 README、交付说明、workspace、lockfile、LICENSE/NOTICE 和实际根 scripts；
它必须带同版开发运行时数据及固定资源输入，不要求完整 Contract、Engine 或原生宿主作者源码。

当前发行按**纯源码**交付：初始化统一为 frozen install → `pnpm build:tooling` → 直调授权源码 bin 复验。
交付不含预构建产物、检查器或其清单；若发行说明另述特殊路线，以该发行说明为准并如实记录差异，
不以有无 `dist/` 猜路线。

### 纯源码初始化

核对 Node/pnpm 后，在用户确认的授权源码根执行：

```sh
pnpm install --frozen-lockfile
pnpm build:tooling
node "<源码根>/packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs" --help
```

`build:tooling` 使用发行根已有脚本从源码构建 SDK、Toolchain、Web IDE 并组装固定资源；
不要求补入私有 Contract、Engine 或宿主源码。安装成功、构建成功、CLI 帮助和实际所需开发运行时数据读取分别取证；
构建失败不靠改清单或数据摘要让校验通过，也不静默跳过。
构建成功后仍以真实 CLI 和实际开发运行时数据读取复验，不能把帮助输出或探针 `ready` 当作数据完整的证明。

初始化的 `install` 不要求从 registry 获取 FH2 包。frozen 失败时保留首错，
不去掉 frozen、不重写发行锁来掩盖依赖漂移。初始化完成后无需注册 CLI，在已确认工程目标上显式探测授权源码：

```sh
node "<skill目录>/scripts/resolve-env.cjs" --project "<目标目录>" --platform-root "<源码根>"
```

`--platform-root` 可选，相对路径按调用 cwd 解析；省略时保留原本地/PATH/全局发现行为。
探针不执行交付检查器或构建。首次初始化不安装 Skill，Skill 安装布局见 [README.md](../README.md)。

### 可选全局注册

确有全局 CLI 需求时，单独说明注册影响并取得同意，工具就绪后使用发行根已有直接注册脚本。当前发行命令为：

```sh
node scripts/public-source/link.mjs
fh2-plugin --help
```

该脚本只注册已有构建，不重新构建。`pnpm link:toolchain` 会先构建工具，
不放进初始化的默认步骤，不用于替代标准初始化。
注册冲突、权限或 PATH 问题按本次发行脚本帮助处理，不删除其他工具，不自动覆盖已有全局版本；
未选择注册不算初始化缺项。

创建工程时使用实际 bin，保留其源码定位行为；在已确认的业务父目录执行，
模板与 ID 按方案确定（一律 `capability-fullstack` 能力工程结构，见 01/02）。
不得改用 `dist/cli.js` 代替 bin 的源码定位行为；显式 `--platform-root` 保证使用确认的源码根。
`--install` 会在新工程写入依赖和锁，并执行类型复验；新工程没有锁时不强行使用 frozen。
方案和安装未确认时不 create。创建命令与参数核对见 02。

## 已有工程与升级

- 工程内以本地 CLI/scripts 为准。全局 A 与工程本地 B 可共存；记录实际解析路径、制品版本、来源契约版本和数据摘要，
  不只比较版本字符串。
- 缺 Toolchain 时，先初始化用户确认的授权源码，读现有 `package.json` 与覆盖配置，
  确认后将 SDK/Toolchain 改为该源码的本地 `file:` 依赖。
  pnpm 的传递覆盖位于 `pnpm-workspace.yaml`，npm/yarn 使用现有对应字段；只引用 SDK/Toolchain，不加 Contract 分支。
- 保持工程现有包管理器。重新安装、生成与校验后重跑探针和真实知识读取；
  包中应包含 `developer-runtime/`、应用输出和固定资源输入，不能靠读取别处的完整 Contract 修复。
- 移动/升级前确认新来源、固定版本和发行路线，保留旧副本与现有改动；
  先按新发行的纯源码构建路线初始化并复验，再核对每个 `file:` 路径和覆盖，显式重装、生成、验证。
  不自动更新所有工程，也不假定复制式安装会立即失效或自动刷新。
- 解除 CLI 注册是单独授权动作，按当前源码的 `unlink:toolchain` script 操作；
  只解除自己的注册，不删业务工程，不声称自动恢复之前的安装。

## manifest 或包损坏

报告所选路径与 `reason`。manifest 缺失/损坏时，确认后从同一用户确认的源码版本恢复开发运行时数据，
或修复/重装该本地 Toolchain；不手写 manifest、版本或数据摘要让校验通过。
包信息损坏同样只修复确认的副本；禁止宽泛删目录、清空缓存或保留损坏局部而切全局。

选择顺序是工程及祖先的本地包 → 显式 `--platform-root` 指定的开发者工具 → PATH/全局。
`toolchain.source=linked` 表示直接源码或源码链接，输出仍使用 `schemaVersion: 3`，不新增来源枚举。

局部包目录/链接已存在但 `package.json` 缺失、不可读或链接悬空时，探针保留所选路径，
报 `broken_environment` / `toolchain_package_json_invalid`，动作是 `repair_toolchain`。要点：

- 能解析时报告 realpath，悬空时保留局部链接路径。
- 只有局部安装确实不存在，才继续查祖先和显式授权源码，再查 PATH/全局。
- 显式授权源码要核对根 `package.json` 身份 `fh2-plugin-platform` 与固定 Toolchain 包位置；
  该选择缺失、包名错误或开发运行时数据损坏时保留选择并要求修复，不回退全局版本。
- PATH realpath 指向官方 `bin/fh2-plugin.mjs` 时，该 bin 的包身份与包根元数据同样必须有效；
  其他祖先必须先证明包身份，不能因无关 `package.json` 损坏误报 Toolchain。探针不解析任意 shell wrapper 命令。

局部安装不存在且 PATH 未绑定具体包时（例如 `PNPM_HOME` 的非软链 shim），
全局发现按 `npm root -g`、`pnpm root -g` 顺序查包元数据。要点：

- 记住首个损坏候选并继续找有效候选，全部无有效候选才报告首个损坏路径及修复动作。
- 这不是替换已选中的局部/PATH 包；选中有效包后 manifest 缺失/损坏仍阻断，不改选其他 root。
- 全局发现不证明 wrapper 实际执行同一包，需按所报路径复验。

探针重跑成功后，再核对本次 bin/本地 CLI 的帮助、生成/校验和所需知识读取。
`index.json` 是 `resources.json.files` 中的逻辑别名，不是磁盘文件；查证路径见 01。
若完整加载仍失败，保留该失败并停止相关设计，不把 manifest 探测通过称为环境全部就绪。

## registry 诊断

探针保留项目/用户 `.npmrc` 的只读诊断，用于发现已有通用或 scope 配置。
`kind=public/custom/null` 不判内外网、可达性或登录状态，也不推荐安装通道；不联网探测。
URL 用户名、密码、query、hash 脱敏，其他 npm 凭据不输出。

授权源码不需要私有 scope 或 FH2 registry 登录。第三方依赖沿用用户已有配置；
失败时报告依赖类别和脱敏原因，不能自动改 registry、写 Token 或索取凭据。
需要认证时由用户按其提供方流程处理，不代输、不读取、不保存。

## 出口条件

- [ ] 来源入口、固定 tag/commit/归档身份、稳定源码目录、发行路线与操作类别已确认。
- [ ] Node/pnpm 满足该发行要求，所选 Toolchain 路径和来源正确。
- [ ] 纯源码 `build:tooling` 初始化已完成；未静默跳过构建失败，全局注册未作为前置。
- [ ] 探针 `execution.status === 'ready'` 且 `contract.path` 非空，未把 manifest 探测称为完整加载。
- [ ] 实际 CLI 及所需开发运行时数据知识读取已成功；缺少的验证明确标未验证或阻断。
- [ ] 没有完整 Contract 安装、私有 scope 配置、全局静默覆盖或凭据泄露。
- [ ] 拒绝、失败、重试、未执行和用户亲自处理事项已如实汇报。

## 反模式

- 缺环境就拒绝澄清需求，或用 Skill 方法论补出平台 API。
- 猜下载地址/tag，用 FH2 npm 包或内部维护仓替代授权源码。
- 为安装改 registry/写凭据，frozen 失败后去掉约束或重写锁让校验通过。
- 用强制全局 link 代替授权源码初始化，或在构建失败时静默跳过复验。
- 未确认就下载、安装、link、改配置或删目录；用 sudo 强装全局工具。
- 只看到 manifest 就声称完整数据、本地调试页面或 DAG 已可用。
- 安装完整 Contract、借私有目录兜底，或修改数据摘要掩盖损坏。
