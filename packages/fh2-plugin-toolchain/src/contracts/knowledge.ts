// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 后端插件知识包的共享契约：Node 侧、浏览器侧和 CLI 都从这里取类型，不各维护一份 DTO。
 *
 * 知识包由 worker 仓的 `pluginknowledge build` 产出，是**平台契约的唯一事实来源**：
 * 平台动作 I/O、触发轴声明面、Host 能力面、DSL 词法、Schema 与类型提示。
 *
 * ★★ 本文件只描述形状，不做校验也不读盘：`src/knowledge/*` 负责安装与解析，
 * `src/workflow/*` 负责把它翻成画布语义。浏览器侧只 import 类型。
 *
 * ⚠️ 本文件不得出现 `checkerPath` 一类的可执行路径字段。浏览器拿得到的任何字符串
 * 都不能被服务端当二进制去执行 —— 那是方案 §3.2.2 明确点掉的攻击面。
 */

/** 知识包里一份载荷文件的身份（knowledge.json 的 files[]）。 */
export interface KnowledgeFileDigest {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * 同一源码构建的某平台 checker 制品引用。
 *
 * ⚠️ 本轮 `checkers` 恒为空数组（计划 §1.2）。空数组是**显式的「没有」**，
 * 不是「有一个默认的」：界面必须据此说明「无同版本权威 checker」。
 */
export interface KnowledgeCheckerRef {
  readonly target: string;
  readonly archive: string;
  readonly archiveSha256: string;
  readonly binarySha256: string;
  readonly protocolVersion: number;
}

/** `knowledge.json` 的内容。字段与 worker 的 pluginknowledge.Manifest 一一对应。 */
export interface KnowledgeManifest {
  readonly formatVersion: number;
  readonly knowledgeId: string;
  readonly workerRevision: string;
  /** true = 出自脏工作区或拿不到 revision，**不是可发布的 release**。 */
  readonly local?: boolean;
  readonly contractsVersion: string;
  readonly gojaVersion: string;
  /** Toolchain 能否消费这份知识包；不等同插件协议版本。 */
  readonly toolchainProtocolVersion: number;
  readonly files: readonly KnowledgeFileDigest[];
  readonly checkers: readonly KnowledgeCheckerRef[];
}

/** 本 Toolchain 能消费的知识包格式与协议版本。不匹配时拒绝安装，不尽力解析。 */
export const SUPPORTED_KNOWLEDGE_FORMAT_VERSION = 1
export const SUPPORTED_TOOLCHAIN_PROTOCOL_VERSION = 1

/** 项目根的 `backend-plugin-knowledge.lock.json`。 */
export interface KnowledgeLock {
  readonly formatVersion: number;
  readonly knowledgeId: string;
  /**
   * `sha256(knowledge.json 原始字节)`。它同时绑定文件清单与 checker 清单。
   *
   * ★ 与 worker 的 `bundleDigest` 同值：worker 那侧对规范化后的 knowledge.json
   * 字节求哈希，而它写盘的就是同一批字节，故本侧直接哈希文件即可，
   * 不必在 TS 里重建 Go 的 JSON 规范化（重建出来的一定会漂）。
   */
  readonly bundleDigest: string;
}

export const KNOWLEDGE_LOCK_FILENAME = 'backend-plugin-knowledge.lock.json'
export const KNOWLEDGE_LOCK_FORMAT_VERSION = 1

/** 一份已安装在 Toolchain 受控缓存里的知识包。 */
export interface InstalledKnowledge {
  readonly knowledgeId: string;
  readonly bundleDigest: string;
  /**
   * 缓存里的绝对目录。
   *
   * ⚠️ **不得下发给浏览器**：它是本机路径，对前端无用，且把它塞进 API 回包等于
   * 鼓励前端拼路径回传。`KnowledgeStatus` 里没有这个字段是刻意的。
   */
  readonly directory: string;
  readonly manifest: KnowledgeManifest;
}

/** 知识包里按用途分组的可读内容清单（给界面说明「这份知识带了什么」）。 */
export interface KnowledgeContents {
  readonly docs: readonly string[];
  readonly catalogs: readonly string[];
  readonly schemas: readonly string[];
  readonly types: readonly string[];
  readonly examples: readonly string[];
  readonly hasSkill: boolean;
  readonly hasProvenance: boolean;
  readonly hasVerification: boolean;
}

/**
 * `GET /api/knowledge` 的回包：当前固定的是哪份知识、它带了什么、缺什么。
 *
 * ★★ `checkerAvailable` 恒为 false 的这一轮里，它必须出现在回包里而不是被省略：
 * 界面要能说出「无同版本权威 checker，本地预检不等于可部署」。
 * 省掉这个字段就等于让界面自己编一个默认值。
 */
export interface KnowledgeStatus {
  /** 项目 lock 指定并已成功解析到的那份；未固定或解析失败时缺省。 */
  readonly active?: {
    readonly knowledgeId: string;
    readonly bundleDigest: string;
    readonly workerRevision: string;
    readonly contractsVersion: string;
    readonly gojaVersion: string;
    readonly local: boolean;
    readonly contents: KnowledgeContents;
  };
  /** 缓存里所有已安装的知识身份（供「切版本」下拉；不含路径）。 */
  readonly installed: readonly {
    readonly knowledgeId: string;
    readonly bundleDigest: string;
    readonly workerRevision: string;
    readonly local: boolean;
  }[];
  /** 项目是否写了 lock 文件。false 时编辑器用内建快照，必须明确提示。 */
  readonly locked: boolean;
  /** 本轮恒为 false：没有同版本权威 checker，界面不得显示「可部署/已验证」。 */
  readonly checkerAvailable: false;
  /**
   * 阻止使用这份知识的原因（lock 指到未安装的身份、摘要不符、协议版本不支持……）。
   * 空数组 = 无阻断。⚠️ 非空时界面必须停止结构化编辑并引导安装/切换，不静默降级。
   */
  readonly problems: readonly string[];
}

/** 引用路径的一个根（catalog/language.json 的 refRoots）。 */
export interface KnowledgeRefRoot {
  readonly name: string;
  readonly syntax: string;
  readonly closed: boolean;
  readonly summary: string;
}

/** 动作/脚本的一个 I/O 字段（catalog/actions.json 的 inputs/outputs）。 */
export interface KnowledgeField {
  readonly name: string;
  readonly type: string;
  readonly required?: boolean;
  /**
   * 出参语义：true = 每次都产；false = 这次不一定产（worker 的 `From` 非空）。
   * 画布据此把下游引用标成「需 when 守护」。
   *
   * ⚠️ 入参上这个字段没有意义（worker 侧对入参恒为 true），别拿它当「入参必给」读。
   */
  readonly always?: boolean;
  readonly fields?: readonly KnowledgeField[];
}

/** 一个平台受审动作（catalog/actions.json）。 */
export interface KnowledgeAction {
  readonly name: string;
  /** 面向插件开发者的中文名；未提供时界面回落显示机器名 name。 */
  readonly displayName?: string;
  readonly owner: string;
  readonly capability?: string;
  readonly kind: string;
  readonly isFlight?: boolean;
  /** `default` 吃默认重试；`none` 非幂等故不重试；`not-applicable` 不跑 activity。 */
  readonly retry: string;
  readonly heartbeating?: boolean;
  /** `catalog` / `script-contract` / `await-provides`：这一步的 I/O 从哪来。 */
  readonly ioResolution: string;
  readonly inputs?: readonly KnowledgeField[];
  readonly outputs?: readonly KnowledgeField[];
  readonly notes?: readonly string[];
}

/** 一个触发轴（catalog/triggers.json）。 */
export interface KnowledgeTriggerAxis {
  readonly name: string;
  readonly summary: string;
  readonly declaredFields?: readonly {
    readonly name: string;
    readonly type: string;
    readonly required?: boolean;
    readonly summary?: string;
  }[];
  readonly seedKeys?: readonly string[];
  /**
   * 平台已知 seed 键的值类型（键 → 类型名）。worker 知识导出目前不带这一项
   * （trigger.facts 只导键名）—— 字段留着，等导出补上后无需改消费方。
   */
  readonly seedTypes?: Readonly<Record<string, string>>;
  /** seed 键名由调用方/插件自己起，不是平台词表 —— 界面给自由输入而不是下拉。 */
  readonly seedKeysOpen?: boolean;
  /** seedKeys 里「声明了也可能不播」的那些：引用它们的必填入参要黄标。 */
  readonly seedNotGuaranteed?: readonly string[];
  readonly seedGuarantee: string;
  readonly matchFields?: readonly string[];
  readonly notes?: readonly string[];
}

/** DSL 词法与执行策略（catalog/language.json）。 */
export interface KnowledgeLanguage {
  readonly refRoots: readonly KnowledgeRefRoot[];
  readonly stepStates: readonly string[];
  readonly stateKey: string;
  readonly stepKinds: readonly string[];
  readonly triggerModes: readonly string[];
  readonly conditionOps: readonly string[];
  readonly providedTypes: readonly string[];
  readonly extraKeysModes: readonly string[];
  readonly maxRefDepth: number;
  readonly pluginActionPrefix: string;
  readonly runRoot: readonly KnowledgeField[];
  readonly stepPolicy: Readonly<Record<string, number>>;
}

/** Host 能力面（catalog/host-api.json）。本轮只透传，不在浏览器侧解释语义。 */
export interface KnowledgeHostApi {
  readonly grantableCapabilities: readonly string[];
  readonly methods: readonly {
    readonly path: string;
    readonly summary: string;
    readonly authorization: { readonly mode: string; readonly capabilities?: readonly string[] };
    readonly signatureStatus: string;
    readonly returns: { readonly type: string; readonly errorMode: string };
    readonly idempotent?: boolean;
    readonly limitations?: readonly string[];
  }[];
  readonly cache?: {
    readonly readCapability: string;
    readonly writeCapability: string;
    readonly readMethods: readonly string[];
    readonly writeMethods: readonly string[];
  };
}

/**
 * 这份 Catalog 从哪来 —— **必须随数据一起下发**。
 *
 * ★★ 为什么它不是可选的诊断信息：`builtin-snapshot` 是手抄自 worker 的快照，
 * 它可能已经与 worker 漂移。界面把两种来源显示成同一个样子，就等于把
 * 「可能已过期的手抄」冒充成「与 worker 版本绑定的事实」——那正是本方案要消灭的。
 */
export type CatalogSourceKind = 'knowledge' | 'builtin-snapshot'

export interface CatalogSource {
  readonly kind: CatalogSourceKind;
  /** knowledge 时是 knowledgeId；builtin-snapshot 时是手抄对账基准串。 */
  readonly revision: string;
  /** builtin-snapshot 时说明为什么没用上知识包（未安装？摘要不符？）。 */
  readonly reason?: string;
}

/** 从固定知识包解出的平台契约集合。 */
export interface PlatformCatalog {
  readonly actions: readonly KnowledgeAction[];
  readonly triggers: readonly KnowledgeTriggerAxis[];
  readonly language: KnowledgeLanguage;
  readonly hostApi: KnowledgeHostApi;
  readonly source: CatalogSource;
}

/** CLI/HTTP 的知识操作结果。 */
export interface KnowledgeApiResult {
  readonly ok: boolean;
  readonly knowledgeId?: string;
  readonly bundleDigest?: string;
  readonly messages: readonly string[];
}
