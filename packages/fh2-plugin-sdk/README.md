# fh2-plugin-sdk

插件作者用的 API：插件清单契约、入口与扩展、界面、跨宿主通信，以及 Catalog 元数据和类型生成器。

它随工具包一起提供，不需要单独安装。

**许可**：Apache-2.0，见仓库根 `LICENSE` 与 `NOTICE`。

## 📋 提供什么

| 导入 | 用途 |
| --- | --- |
| `fh2-plugin-sdk` | 清单契约、`definePlugin`、界面状态与 View 入口、跨宿主服务 |
| `fh2-plugin-sdk/view` | 只给界面用的 View 契约 |
| `fh2-plugin-sdk/backend` | 后端插件的脚本上下文、入口与 Host API 类型 |
| `fh2-plugin-sdk/catalog` | 公开的扩展点与能力元数据 |
| `fh2-plugin-sdk/generator` | 工程类型生成，供工具链调用 |
| `fh2-plugin-sdk/schema/manifest.schema.json` | 前端清单 JSON Schema |
| `fh2-plugin-sdk/runtime-contract.json` | 清单与平台运行协议版本 |

## 🚀 怎么用

插件工程由 `fh2-plugin create` 生成，工程里的 `pnpm run generate` 会把类型写到 `src/generated/`。手写代码时按这两层分开：

```ts
// 入口能拿到 ctx（扩展点、能力、受管网络）；界面是独立的 Vue 3 bundle，拿不到 ctx
import { createViewState, definePlugin, definePluginView } from 'fh2-plugin-sdk'
```

完整写法、扩展点清单和状态同步见[第一个插件](https://o0igrlv91l.apifox.cn/9576253m0)与[界面与状态](https://o0igrlv91l.apifox.cn/9576277m0)。

## 版本与兼容

SDK 与 Toolchain 随同一份源码发布，版本一致；平台运行协议是单独的版本号（见 `runtimeContract.platformVersion`）。工程依赖用本地 `file:` 指向这份源码，因此升级 SDK 等于换源码目录，不会自动改动已有工程。

`src/backend/` 里少量文件头记录的重新生成命令属于维护溯源，不是给你的安装步骤；工程类型由 `fh2-plugin generate` 生成。

## 边界

类型检查只保证形状对，不授予运行时权限，也不证明接口在目标环境可用。真实设备与部署环境要另外验证；打包成功同样不代表已获准发布。选定版本的来源与摘要记录在工具包根的 `public-distribution.json`。

## 继续读

- [开发手册](https://o0igrlv91l.apifox.cn/)：环境准备、扩展点、API 参考
- [Toolchain README](../fh2-plugin-toolchain/README.md)
- [工程根 README](../README.md)
