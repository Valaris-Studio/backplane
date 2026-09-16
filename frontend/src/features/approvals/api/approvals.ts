// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";
import type { Approval, ApprovalDecision, ApprovalStatus } from "@/types/approval";

function getBasePath(slug: string) {
  return `/workspaces/${slug}/approvals`;
}

export async function fetchApprovals(slug: string, status?: ApprovalStatus) {
  const params = status ? { status } : undefined;
  const { data } = await api.get<Approval[]>(getBasePath(slug), { params });
  return data;
}

export async function fetchApproval(slug: string, approvalId: string) {
  const { data } = await api.get<Approval>(`${getBasePath(slug)}/${approvalId}`);
  return data;
}

export async function decideApproval(
  slug: string,
  approvalId: string,
  decision: ApprovalDecision,
) {
  const { data } = await api.post<Approval>(
    `${getBasePath(slug)}/${approvalId}/decide`,
    decision,
  );
  return data;
}
