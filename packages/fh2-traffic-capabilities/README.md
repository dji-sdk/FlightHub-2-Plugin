# 交通警务 Capability 工作区

每个 Capability 目录同时管理前端 Cockpit 插件和后端 TypeScript 插件；目录成员关系由
`frontend/` 与 `backend/` 表达，迁移期跨端名称由可选 `migration-links.json` 审计。

工作区根是纯 Capability 容器：包身份只在根级 `packages.json`（平台上传清单）声明一次，
各 Capability 根不再有自己的 `packages.json` 或 `package.json`，也不产生 `node_modules`。

## 目录

```text
packages.json        # 平台上传包清单（packageId + capabilityIds，唯一事实源）
official_accident/   # 事故快处 + 警情派发
official_parking/    # 违停巡逻 + 示教航线
official_capture/    # 交通违法抓拍
```

## 构建与打包

这是作者源码工作区，不是直接安装到平台或 Worker 的运行包。工作区根不设
`package.json`，不能在这里单独执行依赖安装。先取得固定版本的完整插件化开发者工具：
保留根 `package.json` 的 `name: fh2-plugin-platform`、SDK/Toolchain 的包名目录、
`examples/` 和同版运行输入；仅复制本目录不能补齐 `workspace:*` 依赖。
源码 ZIP 不需要 `.git` 或 `git init`。

使用 **Node 20.19 或更高**（推荐 22 LTS 及以上）和随附的 **pnpm 10.15.0**，在工具根目录执行：

```sh
export FH2_TOOLS="$(pwd -P)"
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm link:toolchain
```

根级安装会解析 SDK、Toolchain 和业务成员的 workspace 依赖；第三方依赖来自已配置的
registry，不需要安装 FH2 npm 包或完整 Contract。`link:toolchain` 构建开发工具和 Web IDE、
装配包内 Mock Host 资源后注册 CLI，不签名、不上传、不部署。注册冲突和自定义 prefix
按 `node scripts/public-source/link.mjs --help` 处理，不静默覆盖其他工具。
用根级 `public-distribution.json` 的来源 revision 与内容摘要记录本次源码身份，保持
工具目录路径稳定。

初始化后，在交通工作区根使用 CLI：

```sh
cd "$FH2_TOOLS/packages/fh2-traffic-capabilities"
fh2-plugin build
fh2-plugin pack
```

不注册全局 CLI 时，先在工具根目录完成 `pnpm build:tooling`，再使用公开 bin 入口明确
选择业务根，而不是借用其他仓库的总构建脚本或 `dist/cli.js`：

```sh
node "$FH2_TOOLS/packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs" pack \
  --root "$FH2_TOOLS/packages/fh2-traffic-capabilities"
```

从单个能力目录运行，只构建或打包该能力（上传包清单自动从父工作区 `packages.json`
派生，`packageId` 与行业包一致、`capabilityIds` 仅含该能力）：

```sh
cd "$FH2_TOOLS/packages/fh2-traffic-capabilities/official_capture"
fh2-plugin build
fh2-plugin pack
```

行业根的 `pack` 输出 `release/official_traffic_police/` 与
`release/official_traffic_police.zip`。能力根的 `pack` 输出只包含该能力的可上传
staging tree（`release/<packageId>/` 位于能力目录内）。两种打包均会先完成构建；上传树
不包含 `src/`、测试文件、`node_modules/` 或构建报告。

在单个前端或后端插件目录运行 `fh2-plugin pack` 只生成独立插件交付物，不是完整
Capability 上传单元。行业工作区或能力根生成的是未签名 ZIP；`UPLOAD_READY` 只表示
归档已生成，不代表获准发布。签名密钥及签名、上传、发布操作由授权操作人员按独立
发布流程管理，不属于公开源码初始化步骤，也不随本工作区提供。

## 运行时下发边界

插件管理服务的上传、发布输入，以及 Worker 的运行时下发输入，必须只使用 `pack` 生成的
staging tree 或已发布 Release 中的 runtime assets。不得向插件管理服务或 Worker 下发作者
源码目录，包括后端 `handlers/**/*.ts`、`events/**/*.ts`、`adapters/**/*.ts`、`shared/**/*.ts`
以及前端 `src/`；Worker 只加载后端的 `plugin.json`、`scripts/`、`workflows/`、`schema.sql`
等运行时资产。

后端开发时可在
`official_capture/backend/official_traffic_capture_backend/` 运行：

```sh
cd "$FH2_TOOLS/packages/fh2-traffic-capabilities/official_capture/backend/official_traffic_capture_backend"
pnpm run check
pnpm run typecheck
```

`schema.sql` 是后端运行时实体与 DDL 的唯一事实源；变更不生成业务 TypeScript 类型。`dev` 会在成功重建后刷新 Host ambient 声明。

更改后端 allowlist 或入口 import 图时，可在该插件根运行 `fh2-plugin types` 更新本插件
`types/`，不重新生成 SDK 的上游类型。Toolchain 的 `developer-runtime/` 和 Mock Host
资源须随同版 Toolchain 保留；移动或升级工具目录后，核对本地依赖并显式重装、生成、
校验与构建，不能只更新全局 CLI 就假定业务工程已经刷新。

Mock、静态校验和打包成功不证明真实 Worker、网络 API 或设备运行安全。涉及真实环境、
媒体、航线或硬件操作时，仍须取得对应权限并完成目标环境及现场安全验证。
