# FH2 插件开发工具包

FH2 插件底座是司空（FlightHub 2）的深度定制入口。与把司空能力接到外部系统的开放接口不同，插件可以直接改造宿主：把自己的界面、接口和流程装进团队页、计划库、消息中心和驾驶舱，交付成行业专属的产品。

这套源码提供插件 SDK、Toolchain、Web IDE、工程模板、官方能力示例和 AI 开发 Skill；本地调试用的 Mock Host 以预构建资源形式随包提供。

**许可**：Apache-2.0，见 `LICENSE`、`NOTICE` 和 `THIRD-PARTY-NOTICES.md`。

- 源码与反馈：<https://github.com/dji-sdk/FlightHub-2-Plugin>
- 开发手册（147 页）：<https://o0igrlv91l.apifox.cn/>

## 📋 关键特性

1. **深度改造宿主**：前端插件可装入团队页、计划库、消息中心和驾驶舱四类宿主，覆盖 11 个扩展点、29 项平台能力；界面跑在 Shadow DOM 里，入口跑在隔离 iframe / realm 中。
2. **前后端一体**：前端插件自带 Vue 3，后端插件用 TypeScript 写 HTTP 接口、事件处理和数据存储，两侧共享同一份类型契约。
3. **本地闭环，不依赖真机**：Mock Host Workbench 复刻四类宿主，本地后端网关带进程内存储，没有设备和司空账号也能把面板点通。
4. **AI 辅助开发**：`fh2-plugin-dev` Skill 带需求澄清、方案确认、改码和自查流程；Web IDE 内含流程编排画布，可在浏览器里改工程、连线并保存。
5. **一条命令交付**：`validate → build → pack` 产出可上传的能力包。
6. **官方能力示例**：3 个业务能力（事故快处、交通抓拍、违停巡逻）、5 个前端插件和 4 个后端插件，覆盖警情派发与示教航线，含 Mock 数据。
7. **手册与工具同版本**：147 页开发手册覆盖概念、扩展点、API、调试、发布与安装回滚。

## 源码开放范围

SDK、Toolchain、Web IDE、工程模板和官方能力示例都是完整源码，可以读、可以改、可以重新构建。

Mock Host（本地调试用的四类宿主页面）和它内嵌的插件运行时 Engine 是固定版本的预构建资源（Engine / SDK / Toolchain 均为 1.0.0，见 `packages/fh2-plugin-toolchain/runtime-assets/mock-host/manifest.json`），随包提供、不从本仓源码重建；升级时整套一起换，不要只替换其中一部分。司空宿主本身也不在本仓。

## 🚀 快速开始

1. [环境准备](https://o0igrlv91l.apifox.cn/9576299m0)：装 Node、构建工具链、定义 `fh2-plugin` 短命令。
2. [第一个插件](https://o0igrlv91l.apifox.cn/9576253m0)：在本地驾驶舱打开面板并打包。
3. [后端插件](https://o0igrlv91l.apifox.cn/9576254m0)：写一个可调用的 HTTP 接口。
4. [全栈闭环](https://o0igrlv91l.apifox.cn/9576255m0)：表单 → 接口 → 存储 → 刷新读回。
5. [安装、升级与回滚](https://o0igrlv91l.apifox.cn/9577292m0)：把包传到司空并验证。

## 🛠 辅助开发

1. [AI 开发 Skill](https://o0igrlv91l.apifox.cn/9576257m0)：让 AI 按手册流程改代码。
2. [Web IDE](https://o0igrlv91l.apifox.cn/9576344m0)：浏览器里打开工程、保存改动。
3. [流程编排（DAG）](https://o0igrlv91l.apifox.cn/9576256m0)：多步任务、外部信号与下发。
4. [本地开发与调试](https://o0igrlv91l.apifox.cn/9576343m0)：Mock Host、日志与链路。

## 📦 下载

源码在本仓库：`Code → Download ZIP` 解压，或 `git clone`。需要复现固定版本时 checkout 对应 tag/commit，不要用移动的 latest。ZIP 解压即可，不需要 `.git`。

## 第一次跑起来

需要 Node **≥ 20.19**（推荐 22 LTS）和一个浏览器。pnpm 由 corepack 按仓库声明的版本（10.15.0）提供，不用全局安装。

```sh
export FH2_TOOLS="$(pwd -P)"
corepack enable                 # 每台机器执行一次
pnpm install --frozen-lockfile
pnpm build:tooling              # 构建 SDK、Toolchain 与 Web IDE
pnpm link:toolchain             # 注册 fh2-plugin（已在上面构建过）
fh2-plugin --help
```

本目录是开发者工具，不是插件工程；插件命令要在工程根执行，或用 `--root` 指定。注册与 pnpm 版本问题见[快速入门排错](https://o0igrlv91l.apifox.cn/9576342m0)。

## 建一个插件

在工具包之外的可写目录执行：

```sh
fh2-plugin create exp_demo --template capability-fullstack --platform-root "$FH2_TOOLS" --package-manager pnpm --install
cd exp_demo && pnpm run dev
```

| 模板 | 生成什么 |
| --- | --- |
| `capability-fullstack` | 完整能力工作区：两个前端插件、一个 TypeScript 后端插件和 Mock 数据 |
| `frontend-basic` | 一个前端插件，含面板与弹窗示例 |
| `backend-basic` | 一个独立 TypeScript 后端插件 |

生成的工程用 `file:` 指向本地 SDK / Toolchain，并有自己的锁文件。完整参数见[工具链命令行参考](https://o0igrlv91l.apifox.cn/9576380m0)。

## 打包与上传

在工程根执行 `pnpm run pack`，终端会打印 `UPLOAD_READY` 和 ZIP 路径。打包默认先构建，不上传、不签名、不部署；上传、安装和回滚见[安装、升级与回滚](https://o0igrlv91l.apifox.cn/9577292m0)。

## 包里有什么

目录名可以改，但相对路径要保留，根 `package.json` 的 name 保持 `fh2-plugin-platform`：

```text
<源码根>/
|-- package.json / pnpm-workspace.yaml / pnpm-lock.yaml / public-distribution.json
|-- packages/fh2-plugin-sdk/          插件作者 API
|-- packages/fh2-plugin-toolchain/    fh2-plugin 命令、developer-runtime、runtime-assets/mock-host
|-- packages/fh2-traffic-capabilities/ 官方能力示例
|-- skills/fh2-plugin-dev/            AI 开发 Skill
|-- docs/cn/90.plugin-development/    手册源文件
`-- examples/
```

`public-distribution.json` 记录版本、内容摘要和各层校验信息与逐文件哈希。报问题时附上它。

## 本地界面

`fh2-plugin serve` 在本机地址开 Web IDE，以启动它的系统用户身份运行，不是文件系统沙箱也不是权限系统。需要 MCP 时用 `pnpm exec fh2-plugin mcp --root .`。

Skill 要单独装，`link:toolchain` 不代装，完整目录在 `skills/fh2-plugin-dev/`；安装步骤见[安装与复验](https://o0igrlv91l.apifox.cn/9576258m0)。

## 版本与升级

工具包放在固定位置。全局注册的版本和工程内的版本可以共存，重建或重链不会自动更新已有工程；升级前先停掉服务、保留改动、记下 tag 与哈希，再按工程的包管理器重装、生成、校验、构建。`pnpm check:source` 校验固定运行时与资源，`pnpm clean` 只删生成产物。版本兼容性见[版本兼容性](https://o0igrlv91l.apifox.cn/9576394m0)。

## ❓ 常见问题

先看[常见问题](https://o0igrlv91l.apifox.cn/9576397m0)和[常见问题排查](https://o0igrlv91l.apifox.cn/9576352m0)；报错码含义见[错误码](https://o0igrlv91l.apifox.cn/9576395m0)。

## 💬 问题反馈

使用中遇到问题、Bug 或功能需求，欢迎在[仓库 Issue](https://github.com/dji-sdk/FlightHub-2-Plugin/issues) 反馈。

## 继续读

- [开发手册](https://o0igrlv91l.apifox.cn/)：环境准备、第一个插件、打包与安装
- [SDK README](packages/fh2-plugin-sdk/README.md)、[Toolchain README](packages/fh2-plugin-toolchain/README.md)
- [官方能力示例](packages/fh2-traffic-capabilities/README.md)
- [Skill 说明](skills/fh2-plugin-dev/README.md)
