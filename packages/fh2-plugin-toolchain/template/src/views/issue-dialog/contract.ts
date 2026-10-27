// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginViewClient } from 'fh2-plugin-sdk/view'
import { definePluginView } from 'fh2-plugin-sdk/view'
import type { IssueSeverity } from '../issue-panel/contract'

export interface IssueDialogInput {
  readonly title: string;
  readonly description: string;
  readonly severity: IssueSeverity;
}

export interface IssueDialogState {
  readonly pending: boolean;
}

interface IssueDialogContract {
  state: IssueDialogState;
  methods: {
    cancel: () => void;
    submit: (input: IssueDialogInput) => void;
  };
}

export const issueDialogView = definePluginView<IssueDialogContract>('issue-dialog')
export type IssueDialogClient = PluginViewClient<IssueDialogContract>
