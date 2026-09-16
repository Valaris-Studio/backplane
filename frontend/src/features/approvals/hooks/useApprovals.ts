// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalKeys } from "@/lib/query-keys";
import { useWebSocket } from "@/hooks/use-websocket";
import { useDomainSync } from "@/hooks/useDomainSync";
import {
  fetchApprovals,
  fetchApproval,
  decideApproval,
} from "../api/approvals";
import type { ApprovalDecision, ApprovalStatus } from "@/types/approval";

export function useApprovals(slug: string, status?: ApprovalStatus) {
  const { status: wsStatus } = useWebSocket();

  useDomainSync("approval", approvalKeys.all(slug));

  return useQuery({
    queryKey: approvalKeys.list(slug, status),
    queryFn: () => fetchApprovals(slug, status),
    refetchInterval: wsStatus === "connected" ? false : 30_000,
  });
}

export function useApproval(slug: string, approvalId: string) {
  return useQuery({
    queryKey: approvalKeys.detail(slug, approvalId),
    queryFn: () => fetchApproval(slug, approvalId),
    enabled: !!approvalId,
  });
}

export function useDecideApproval(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      approvalId,
      ...decision
    }: ApprovalDecision & { approvalId: string }) =>
      decideApproval(slug, approvalId, decision),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: approvalKeys.all(slug),
      });
    },
  });
}
