// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { DeveloperRuntimeProjection, DeveloperRuntimeResources } from '../../developer-runtime/types.js'

/** 索引驱动的 MCP 知识消费模型。domain/kind 来自运行投影，不在 Toolchain 写死。 */

export type KnowledgeDomain = string
export type KnowledgeKind = string

export interface ContractVersions {
  readonly contract: string;
  readonly contractsVersion: string;
  readonly knowledgeStatus: string;
  readonly contractStatus: string;
  readonly approvedEntries: number;
  readonly contractDigest: string;
  readonly bundleDigest: string;
}

export interface KnowledgeEntry {
  readonly targetId: string;
  readonly domain: KnowledgeDomain;
  readonly kind: KnowledgeKind;
  readonly localId: string;
  readonly document: string;
  readonly sourceFactDigest: string;
  readonly content: {
    readonly summary: string;
    readonly developerAction: string;
    readonly useCases: readonly string[];
    readonly examples: readonly string[];
  };
  readonly evidence: readonly string[];
  readonly uncertainties: readonly string[];
}

export interface KnowledgeBundle {
  readonly contractRoot: string;
  readonly entries: readonly KnowledgeEntry[];
  readonly domains: readonly string[];
  readonly kinds: readonly string[];
  readonly rootIndexPath: string;
  readonly knowledgeIndexPath: string;
  readonly versions: ContractVersions;
  readonly resources: DeveloperRuntimeResources;
  readonly projection: DeveloperRuntimeProjection;
}

export interface SearchKnowledgeItem {
  readonly targetId: string;
  readonly domain: KnowledgeDomain;
  readonly kind: KnowledgeKind;
  readonly snippet: string;
  readonly summary: string;
  readonly resourceUri: string;
  readonly factResourceUris: readonly string[];
}

export interface SearchKnowledgeInput {
  readonly query: string;
  readonly domain?: KnowledgeDomain | undefined;
  readonly kind?: KnowledgeKind | undefined;
  readonly limit?: number | undefined;
}

export interface SearchKnowledgeResult {
  readonly items: readonly SearchKnowledgeItem[];
  readonly total: number;
}

export interface ListKnowledgeInput {
  readonly domain?: KnowledgeDomain | undefined;
  readonly kind?: KnowledgeKind | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

export interface ListKnowledgeItem {
  readonly targetId: string;
  readonly domain: KnowledgeDomain;
  readonly kind: KnowledgeKind;
  readonly summary: string;
  readonly resourceUri: string;
}

export interface ListKnowledgeResult {
  readonly items: readonly ListKnowledgeItem[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly nextOffset?: number;
}

export interface ContractDocument {
  readonly ref: string;
  readonly resourceUri: string;
  readonly mimeType: 'application/json';
  readonly value: unknown;
  readonly resolved: boolean;
  readonly warning?: string;
}

export function parseTargetId (targetId: string): { domain: string; kind: string; localId: string } | undefined {
  const firstDot = targetId.indexOf('.')
  if (firstDot <= 0) return undefined
  const secondDot = targetId.indexOf('.', firstDot + 1)
  if (secondDot <= firstDot + 1 || secondDot === targetId.length - 1) return undefined
  return {
    domain: targetId.slice(0, firstDot),
    kind: targetId.slice(firstDot + 1, secondDot),
    localId: targetId.slice(secondDot + 1),
  }
}
