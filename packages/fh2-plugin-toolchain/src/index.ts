// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export { CLI_COMMANDS } from './cli-commands.js'
export type { CliCommand } from './cli-commands.js'
export {
  discoverCapability,
  discoverCapabilityFrontendOnly,
  discoverCommandContext,
  discoverIndustryCapabilityWorkspace,
  tryDiscoverCommandContext,
} from './capability/discovery.js'
export { CapabilityError } from './capability/types.js'
export type {
  BackendPluginContext,
  BackendPluginProject,
  CapabilityMetadata,
  CapabilityProject,
  CommandContext,
  FrontendPluginContext,
  FrontendPluginProject,
  IndustryCapabilityWorkspaceProject,
} from './capability/types.js'
export {
  formatCapabilityValidationResult,
  validateCapability,
} from './capability/validate.js'
export type {
  CapabilityValidationDiagnostic,
  CapabilityValidationResult,
} from './capability/validate.js'
export {
  BackendContractError,
  readBackendPluginContract,
  validateBackendPlugin,
} from './backend/contract.js'
export type {
  BackendContractDiagnostic,
  BackendPluginValidationResult,
  BackendRuntimeKeys,
  WorkerBackendConnection,
  WorkerBackendConnectionRequirement,
  WorkerBackendEntity,
  WorkerBackendEvaluator,
  WorkerBackendEvent,
  WorkerBackendEventConsumer,
  WorkerBackendField,
  WorkerBackendPluginManifest,
  WorkerBackendScript,
} from './backend/contract.js'
export { buildBackendPlugin } from './backend/build.js'
export type { BackendBuildAsset, BackendPluginBuildOptions, BackendPluginBuildResult } from './backend/build.js'
export { buildCapability, buildIndustryCapabilityWorkspace, watchCapability } from './capability/build.js'
export type {
  CapabilityBackendWatcher,
  CapabilityBuildEvent,
  CapabilityBuildOptions,
  CapabilityBuildResult,
  CapabilityBuildWatchSession,
  IndustryCapabilityWorkspaceBuildCapabilityResult,
  IndustryCapabilityWorkspaceBuildEvent,
  IndustryCapabilityWorkspaceBuildOptions,
  IndustryCapabilityWorkspaceBuildResult,
} from './capability/build.js'
export {
  buildReportPath,
  createBuildReportCandidate,
  digestBuildDirectory,
  discardBuildReportCandidate,
  removeBuildReport,
  writeBuildReport,
} from './capability/build-report.js'
export type { BuildReport, BuildReportCandidate, BuildReportPluginEntry } from './capability/build-report.js'
export { runCapabilityDev } from './capability/dev.js'
export type { CapabilityDevOptions } from './capability/dev.js'
export { CapabilityBackendRuntime } from './dev/capability-backend-runtime.js'
export { packCapability, packIndustryCapabilityWorkspace } from './capability/pack.js'
export type {
  CapabilityPackOptions,
  CapabilityPackResult,
  IndustryCapabilityWorkspacePackOptions,
  IndustryCapabilityWorkspacePackResult,
} from './capability/pack.js'
export { createDeterministicZip, CapabilityZipError } from './capability/zip.js'
export type { ZipEntry } from './capability/zip.js'
export { createPluginBuildRunner } from './build/runner.js'
export { PluginBuildError } from './build/types.js'
export type {
  BuildDiagnostic,
  BuildPhase,
  PluginBuildEvent,
  PluginBuildRunnerOptions,
  PluginBuildSession,
} from './build/types.js'
export { BUILD_HELP, runBuildCommand } from './commands/build-command.js'
export type { BuildCommandOptions, BuildSignalSource } from './commands/build-command.js'
export { DEV_HELP, parseDevArguments, runDevCommand } from './commands/dev-command.js'
export type {
  DevCommandOptions,
  DevSignalSource,
  ParsedDevArguments,
  WorkbenchDistPaths,
} from './commands/dev-command.js'
export { runGenerateCommand } from './commands/generate-command.js'
export type { GenerateCommandOptions } from './commands/generate-command.js'
export { PACK_HELP, runPackCommand } from './commands/pack-command.js'
export type { PackCommandOptions } from './commands/pack-command.js'
export {
  PREVIEW_HELP,
  parsePreviewArguments,
  resolvePreviewTarget,
  runPreviewCommand,
  withPluginDebugQuery,
} from './commands/preview-command.js'
export type {
  ParsedPreviewArguments,
  PreviewCommandOptions,
  PreviewSignalSource,
} from './commands/preview-command.js'
export { runValidateCommand } from './commands/validate-command.js'
export type { CommandWriter, ValidateCommandOptions } from './commands/validate-command.js'
export { SERVE_HELP, parseServeArguments, runServeCommand } from './commands/serve-command.js'
export type {
  ParsedServeArguments,
  ServeCommandOptions,
  ServeSignalSource,
} from './commands/serve-command.js'
export {
  IdeAssetsMissingError,
  injectIdeBootstrap,
  isWatchIgnored,
  resolveWebIdeDist,
  startIdeServer,
} from './serve/ide-server.js'
export type { IdeServer, IdeServerOptions } from './serve/ide-server.js'
export { describeWorkspace, runIdeBuild, runIdeValidate } from './services/ide/project.js'
export type { CapabilityBridgeOptions } from './services/ide/project.js'
export { resolveIdeSchemas, resolveToolchainPackageRoot } from './services/ide/schemas.js'
export type { ResolveIdeSchemasOptions } from './services/ide/schemas.js'
export {
  isIgnoredTreeEntry,
  readWorkspaceFile,
  readWorkspaceTree,
  resolveWorkspacePath,
  writeWorkspaceFile,
} from './services/ide/files.js'
export type { ReadWorkspaceTreeOptions, ResolvedWorkspacePath } from './services/ide/files.js'
export { IDE_ERROR_STATUS, IDE_SCHEMA_VERSION, IdeRequestError, ideFailure, ideSuccess } from './contracts/ide.js'
export type {
  IdeBuildData,
  IdeDiagnostic,
  IdeDiagnosticPhase,
  IdeErrorCode,
  IdeFileData,
  IdeFsEvent,
  IdeSchemaEntry,
  IdeSchemasData,
  IdeTreeData,
  IdeTreeNode,
  IdeValidateData,
  IdeWorkspaceData,
  IdeWriteData,
} from './contracts/ide.js'
export { GeneratedTypesPathError, writeGeneratedTypes } from './generate/write-generated-types.js'
export type { GeneratedFileResult, WriteGeneratedTypesOptions } from './generate/write-generated-types.js'
export { buildDistManifest, loadManifest, ManifestError, resolveSdkVersion } from './manifest.js'
export type { BuildDistManifestOptions, DistViewAsset } from './manifest.js'
export {
  discoverIndustryPluginRoots,
  packIndustryPlugins,
  packFrontendPlugin,
  PluginPackError,
  verifyFrontendPluginPackage,
} from './pack/index.js'
export type {
  FrontendPluginPackageManifest,
  FrontendPluginRuntimeManifest,
  PackIndustryPluginsOptions,
  PackIndustryPluginsResult,
  PackFrontendPluginOptions,
  PackFrontendPluginResult,
  PluginPackDiagnostic,
} from './pack/index.js'
export { runSignCommand } from './commands/sign-command.js'
export type { SignCommandOptions } from './commands/sign-command.js'
export { PluginSignError, loadSigningKeys, signPluginPackage } from './sign/index.js'
export type {
  PackageSignature,
  PluginSignDiagnostic,
  SignPluginPackageOptions,
  SignPluginPackageResult,
  SigningKeys,
} from './sign/index.js'
export {
  formatValidationIssue,
  formatValidationResultJson,
  formatValidationResultText,
  sortValidationDiagnostics,
  validateSourceManifest,
} from './validate/index.js'
export type {
  SdkValidationContext,
  SourceManifestSnapshot,
  ValidateSourceManifestOptions,
  ValidationDiagnostic,
  ValidationPhase,
  ValidationResult,
} from './validate/index.js'

// ── 后端插件知识包（计划 §B2）：安装、固定与解析 ──
//
// 导出它们是为了让 e2e 纵切与将来的 MCP 工具复用同一套实现，
// 而不是各自再写一遍摘要校验 —— 那正是「第二事实源」的起点。
export {
  KnowledgeInstallError,
  computeBundleDigest,
  findInstalled,
  importKnowledge,
  knowledgeCacheRoot,
  listInstalled,
} from './knowledge/install.js'
export { KnowledgeLockError, lockFilePath, readLock, writeLock } from './knowledge/lock.js'
export {
  describeContents,
  loadPlatformCatalog,
  readKnowledgeSchema,
  resolveKnowledgeStatus,
  resolveProjectKnowledge,
} from './knowledge/resolve.js'
export type {
  CatalogSource,
  InstalledKnowledge,
  KnowledgeLock,
  KnowledgeManifest,
  KnowledgeStatus,
  PlatformCatalog,
} from './contracts/knowledge.js'
