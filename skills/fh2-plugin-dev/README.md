# 安装 fh2-plugin-dev

这是给司空插件开发者用的 Skill。客户端装 Skill、装 Toolchain 是两件独立的事：授权源码里的 bin 可以直接用，不要求全局注册；反过来，注册 CLI 也不会让 AI 客户端自动发现 Skill。

## 来源与版本

从 https://github.com/dji-sdk/FlightHub-2-Plugin 选一个固定 tag/commit，或直接提供已经拿到的源码目录。不要求司空公共 npm 包，也不引导登录私有 registry。

保留源码版本和内容身份。拿到源码的授权不等于签名、发布、部署或访问真实环境的授权。

发行源码里的 Skill 目录是 `skills/fh2-plugin-dev/`。不要只装 `SKILL.md`，它引用的文件和零依赖探针必须一起可用：

```text
fh2-plugin-dev/
|-- SKILL.md
|-- README.md
|-- references/
|   |-- 00-environment-bootstrap.md
|   |-- 01-planning-spec.md
|   |-- 02-scaffold-contract.md
|   |-- 03-frontend-guidelines.md
|   |-- 04-backend-guidelines.md
|   |-- 05-validation-debug.md
|   `-- 06-build-pack.md
`-- scripts/
    `-- resolve-env.cjs
```

发行副本里可能还有 `tests/`，它不是客户端发现 Skill 的前置条件。维护者规则、内部知识采集与审批、完整 Contract 都不属于消费安装内容。

## 客户端布局

先确认用哪个客户端、装项目级还是用户级、具体装到哪个目录，再检查父目录和已有同名 Skill。不自动覆盖，不改用户的全局配置。OpenCode 的目录名必须与 frontmatter 的 `name: fh2-plugin-dev` 一致：

| 客户端范围 | 目标入口 |
| --- | --- |
| OpenCode 项目级 | `<项目>/.opencode/skills/fh2-plugin-dev/SKILL.md` |
| OpenCode 用户级 | `~/.config/opencode/skills/fh2-plugin-dev/SKILL.md` |
| Claude Code 项目级 | `<项目>/.claude/skills/fh2-plugin-dev/SKILL.md` |
| Claude Code 用户级 | `~/.claude/skills/fh2-plugin-dev/SKILL.md` |

把上面整个目录装到确认好的 `fh2-plugin-dev/` 位置，保持相对层级。其他客户端按它自己的发现规则选路径，不套一个猜出来的位置。OpenCode 装完或升级后要退出并重新启动客户端，再确认它能发现并加载 `fh2-plugin-dev`；已经在跑的会话仍然使用启动时加载的旧内容。

## 首次复验

1. 客户端能加载 `fh2-plugin-dev`，入口里每条 references 路由都存在且可读。
2. 触发验证：新开对话逐条测试下表，期望行为见「期望标志」列。任何一条不匹配，都说明没装好或没加载对。

| 测试输入 | 期望标志 |
| --- | --- |
| 「给驾驶舱加个工具栏按钮」 | 进入 Step 1A 需求澄清提问（分轮、带推荐项），而不是直接跑 `create` |
| 「司空插件的扩展点怎么加」 | 同上，进入需求澄清；扩展点细节要到 01 的查证路径里查，不凭记忆答 |
| 「司空2 里做个导出 PDF 的插件」 | 识别为插件需求，进入 Step 1A，不先问「你说的是哪个产品」 |
| 「`fh2-plugin validate` 怎么用」 | 查本次工程本地版本的 `--help` 与 01 的查证路径，不凭记忆报参数 |
| 「帮我改宿主登录页的按钮」 | 判域不适用：说明这是普通宿主应用开发，不进入插件流程 |
| 「初始化 Toolchain」 | 走 00 的纯源码路线（frozen install → `build:tooling`），不猜下载地址，不用 `pnpm link:toolchain` |

3. 在 Node 20.19 或该发行明确支持的更高版本下运行只读探针：

```sh
node "<安装目录>/scripts/resolve-env.cjs" --project "<已确认目标目录>"
```

4. 没有 Toolchain 时出现 `bootstrap_required` 是正常的，不算 Skill 安装失败。按入口 Step 0 和 00 经确认完成授权源码初始化。当前发行只有纯源码一条路线。

5. 纯源码路线是 `pnpm install --frozen-lockfile` → `pnpm build:tooling` → 直接运行源码 bin 的 `--help`。不要求完整 Contract、Engine 或真实宿主作者源码，不把 `pnpm link:toolchain` 当默认初始化。

6. 已确认源码时复跑探针，显式指向该目录：

```sh
node "<安装目录>/scripts/resolve-env.cjs" --project "<已确认目标目录>" --platform-root "<源码根>"
node "<源码根>/packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs" --help
```

7. 对照本次实际 Toolchain 路径和 `developer-runtime/manifest.json` 的来源版本。工程本地包优先于显式源码；探针只读 manifest，不证明完整知识、Schema 或应用可用，实际命令和知识读取必须另行复验。

全局注册是独立的可选动作。工具健康检查做完之后，用发行根自带的直接注册脚本，例如 `node scripts/public-source/link.mjs`，它只注册已有构建。不要把注册当成 Skill 安装，也不要因此重复触发构建。

Skill 安装、Node 与依赖安装、CLI 注册、客户端配置、常驻服务、真实环境访问，分别取得同意。报告只存脱敏状态，不保存凭据、会话 URL、私钥、客户数据或环境全集；用完停掉自己启动的服务和 watcher。

## 升级与卸载

升级前确认新的源码身份、发行路线和目标目录，保留用户已有修改，再按纯源码构建路线初始化并复验。

移动或升级源码不会自动刷新工程里的 `file:` 依赖包。路径、覆盖、重装和工程验证按 00 单独确认。Skill 升级后要重新核对全部 references 和探针，并重启客户端；不要因为 CLI 版本变了就自动替换所有 Skill 副本。

卸载只移除用户明确确认过的消费目录或注册，不删业务工程、源码或其他工具。
