# official_accident_plugin

此后端包从 Worker sample `official_classify_accident` 迁入，保留级联警情采集 Adapter、两份 Workflow、Connection、allowlist 和 Adapter I/O 契约。

## 开发

```bash
pnpm types
pnpm check
pnpm build
pnpm pack
```

`adapters/cascade-ingest.ts` 是原 `cascade-ingest.js` 的 TypeScript ESM 版。构建时工具链会把 import/export Bundle 为 Worker 可执行的普通 JavaScript，并将运行时脚本路径重写为 `scripts/adapter.js`。

采集窗口结束时间通过普通业务入参 `windowTo` 显式接入 `run.now`，脚本读取
`input.windowTo`，不依赖 `ctx.now` 自动注入，也不使用本机时间兜底。该方式兼容现有
Worker 的 I/O 校验与投影，不需要修改 Worker 或放宽平台保留键规则。

## Worker Host 边界

Worker 中的 Go 自定义 `classify_accident` capability 仍归 Worker Host/Go 实现所有，本 Capability 不迁移、不替代也不打包该实现。当前 `workflows/cascade-ingest.json` 和 `workflows/accident-response-cascade.json` 都没有引用 `plugin.classify_accident` 或其他 `classify_accident` action；若未来流程需要该能力，必须由 Worker Host 继续显式装配并通过 Worker 发布门禁。
