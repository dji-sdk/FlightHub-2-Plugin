// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginViewClient } from 'fh2-plugin-sdk/view'
import { definePluginView } from 'fh2-plugin-sdk/view'

export type IssueSeverity = 'low' | 'medium' | 'high'
export type IssueStatus = 'new' | 'acknowledged' | 'resolved'

export interface IssueRecord {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: IssueSeverity;
  readonly status: IssueStatus;
}

export interface IssuePanelState {
  readonly issues: readonly IssueRecord[];
  readonly error: string;
}

interface IssuePanelContract {
  state: IssuePanelState;
  methods: {
    requestCreate: () => void;
    acknowledgeIssue: (input: { id: string }) => void;
    resolveIssue: (input: { id: string }) => void;
    dismiss: () => void;
  };
}

export const issuePanelView = definePluginView<IssuePanelContract>('issue-panel')
export type IssuePanelClient = PluginViewClient<IssuePanelContract>
