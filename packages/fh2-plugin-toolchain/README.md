# fh2-plugin-toolchain

`fh2-plugin` 命令行工具：创建插件工程、生成类型、校验、构建、打包、本地调试，外加 Web IDE、Mock Host Workbench 和本地 MCP Server。

它只在你的机器上跑：不托管插件、不上传安装包、不代替部署验收。

**许可**：Apache-2.0，见仓库根 `LICENSE` 与 `NOTICE`。

## 📋 关键特性

1. **一条命令走完全流程**：`create → generate → validate → build → pack`。
2. **本地就能跑起来**：`dev` 起 Mock Host（团队页、计划库、消息、驾驶舱四类宿主）和本地后端网关，没有真机和司空账号也能把面板点通。
3. **三个界面一套引擎**：CLI、Web IDE（`serve`）、MCP（`mcp`）共用同一套工程服务和任务执行。
4. **产物对齐平台**：构建产出 `dist/` 清单与前端 View 资源，`pack` 按工程类型组装上传包。
5. **报错能定位**：校验和构建都给错误码、文件行列和期望值，不用猜是哪一层出的问题。

## 🚀 快速开始

在工具包根目录（有 `package.json` 和 `public-distribution.json` 的那层）：

```sh
export FH2_TOOLS="$(pwd -P)"
corepack enable
pnpm install --frozen-lockfile
pnpm build:tooling
pnpm link:toolchain
fh2-plugin --help
```

在工具包**之外**的目录建工程：

```sh
fh2-plugin create exp_demo --template capability-fullstack \
  --platform-root "$FH2_TOOLS" --package-manager pnpm --install
cd exp_demo
pnpm run dev
```

`link:toolchain` 依次校验固定运行时与资源、构建 SDK/Toolchain/Web IDE、把 Mock Host 资源装配进 Toolchain、用 `npm link` 注册 `fh2-plugin`。不想动全局目录时，直接调用 `node "$FH2_TOOLS/packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs"`；用 bin 入口，不要用 `dist/cli.js`。

## 命令一览

| 命令 | 做什么 |
| --- | --- |
| `create` | 生成完整能力工作区或单插件工程 |
| `generate` / `types` | 生成前端类型、后端 ambient 类型 |
| `validate` | 校验能力或前后端插件的源码清单 |
| `build` | 构建到 `dist/` |
| `pack` | 组装可上传的包（不签名、不上传） |
| `dev` | 构建并启动 Mock Host 本地调试页 |
| `preview` | 在真实司空里受控预览本地前端资源 |
| `serve` | 在本机启动 Web IDE |
| `mcp` | 启动本地 stdio MCP Server，给 AI 客户端接入 |
| `knowledge` | 安装、固定、查询后端插件知识包 |

完整参数见[工具链命令行参考](https://o0igrlv91l.apifox.cn/9576380m0)。

## 打包产物

| 在哪个根执行 `pack` | 产物 |
| --- | --- |
| 行业 Capability 工作区（`packages.json`） | 聚合该工作区所有能力的行业包 ZIP |
| Capability 根（`capabilities.json`） | 能力上传 ZIP，内含 `packages.json` |
| 插件目录（`fh2-plugin.json`） | 单个前端或后端运行包 |

打包默认先构建，不上传、不签名、不部署。看到 `UPLOAD_READY` 只说明 ZIP 生成了；上传与安装见[安装、升级与回滚](https://o0igrlv91l.apifox.cn/9577292m0)。

### 真实环境预览（仅 HTTP）

`preview` 仅支持 HTTP 目标，通过本机受限 HTTP Origin Proxy 和本次会话的 PAC
预览本地前端。操作说明以源码 `src/tooling-contract/usage.ts` 中的 `CLI_USAGE.preview`
为依据；当前参数和默认值请运行 `fh2-plugin preview --help` 查看，本段不另列参数表。
不支持 HTTPS 目标；无需本地证书，不要安装证书、关闭浏览器安全检查或擅自把 HTTPS 目标改为 HTTP。

在已安装构建依赖的前端插件或 Capability 工程中运行。目标环境必须已有插件调试支持，
且你有登录和项目访问权限。先在同一 HTTP Origin（协议、域名和端口）登录并进入目标项目。
将下例占位 URL 替换为浏览器中实际项目页的完整 HTTP 地址，保留项目路径和页面路由；
不要只用站点根地址，否则登录或路由重定向可能丢失调试参数。地址中不得包含用户名或密码。

```sh
fh2-plugin preview --root . --fh2-url 'http://fh2.example.test/organization/org_demo/project/project_demo#/team' --no-open
```

1. 保持命令进程运行，把终端打印的 PAC 地址填入浏览器代理扩展（例如 SwitchyOmega）的
   PAC 模式，应用并启用本次 PAC。命令不会自动修改浏览器代理设置。
2. 确认同一 Origin 已登录并进入目标项目，再打开终端打印的完整调试面板地址。
   该链接保留项目路径和页面路由，仅添加 `fh2-plugin-debug=1`，不预填 source 或 session，
   也不会自动填写或启用插件来源。
3. 在宿主调试面板手动填写本次打印的“请手动填写的插件来源URL”，即本次会话的资源根 URL。
   它不是 Entry JS 或某个插件的 Manifest URL，也不是调试面板地址或 PAC 地址；不要沿用旧会话资源根。
4. 由目标宿主校验来源和插件清单、展示权限；核对权限并勾选临时运行同意后，
   再确认并按面板提示重载。工具链不代登录、代确认、授予权限或改变宿主调试规则。
5. 结束时按 Ctrl+C 退出，在宿主面板禁用本地预览，并关闭临时 PAC、恢复原代理设置。
   不要在报告中保留凭据或会话 URL；插件 ID 变化后须重启 preview，并重新手填资源根、校验和确认。

启动“就绪”（phase `ready`）仅表示本地前端构建和 HTTP 代理已就绪，不代表目标宿主已加载插件，
更不代表生产工作流已运行。普通页面和业务请求仍转发到目标环境，只有本次来源路径提供本地前端资源；
Capability preview 的后端使用目标环境已安装的版本，不运行本地后端，也不是 Mock Workbench。
本地文档测试不证明真实宿主登录、插件激活或生产加载，仍需在获授权的目标环境验证。

## 环境要求

Node **≥ 20.19**（推荐 22 LTS），pnpm **10.15** 由 corepack 按仓库声明提供。Web IDE 的端口占用检测在 Linux 上需要 `lsof` 与 `ps`（`procps`），Windows 用系统 PowerShell。

## ❓ 常见问题

- `ERR_PNPM_UNSUPPORTED_ENGINE`：pnpm 版本不对，用 `corepack enable` 或 `npx -y pnpm@10.15.0`。
- `fh2-plugin: command not found`：还没注册，或注册目录不在 `PATH`；也可以直接调 bin 入口。
- `EADDRINUSE`：先释放端口，或换端口启动，不要同时跑多个 dev。

## 继续读

- [开发手册](https://o0igrlv91l.apifox.cn/)：环境准备、第一个插件、打包与安装
- [工程根 README](../README.md)
- [SDK README](../fh2-plugin-sdk/README.md)
