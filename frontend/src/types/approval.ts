// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "auto_approved";

export type ApprovalCategory =
  | "deletion"
  | "bulk_change"
  | "permission_change"
  | "schema_change"
  | "deployment"
  | "external_action"
  | "skill_publication";

export interface Approval {
  id: string;
  agent_id: string;
  agent_name: string | null;
  workspace_id: string;
  board_id: string | null;
  category: ApprovalCategory;
  action_description: string;
  action_payload: Record<string, unknown>;
  risk_score: number;
  status: ApprovalStatus;
  decided_by_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  expires_at: string;
  execution_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalDecision {
  decision: "approved" | "rejected";
  reason: string;
}
