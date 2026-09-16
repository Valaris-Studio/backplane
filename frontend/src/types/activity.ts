// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type ActivityAction =
  | "created"
  | "updated"
  | "deleted"
  | "moved"
  | "uploaded"
  | "archived"
  | "added_member"
  | "removed_member"
  | "dependency_added"
  | "dependency_removed"
  | "dependencies_replaced";

export type ActivityEntityType = "board" | "column" | "card" | "note" | "resource" | "definition" | "channel" | "git_repo" | "workspace" | "member" | "agent";

export interface Activity {
  id: string;
  workspace_id: string;
  board_id: string | null;
  actor_id: string;
  actor_name: string | null;
  actor_email: string | null;
  agent_id: string | null;
  entity_type: ActivityEntityType;
  entity_id: string;
  action: ActivityAction;
  summary: string;
  // Optional during the additive rollout; present as null on legacy records.
  message_key?: string | null;
  message_params?: Record<string, unknown> | null;
  // Absent on the trimmed `summary=true` rows the feed fetches, present on a
  // full read. Optional so a consumer must handle "not asked for" rather than
  // trusting a field the feed never receives; the timeline replay engine has
  // its own snapshot-bearing type (features/timeline/types.ts).
  changes?: Record<string, unknown> | null;
  via_api_key: string | null;
  // Resolved title of entity_id, for entity types with a route (card, note).
  // null for title-less types and for deleted/unresolvable entities.
  entity_title: string | null;
  created_at: string;
}

export interface ActivityFilters {
  entity_type?: ActivityEntityType;
  action?: ActivityAction;
  search?: string;
}
