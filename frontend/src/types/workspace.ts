// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Batched aggregates from the list endpoint (welcome screen). Absent on the
  // single-workspace endpoints, so optional.
  board_count?: number | null;
  card_count?: number | null;
  // Newest activity timestamp (MAX over the workspace's activity log). The real
  // "recently active" sort key — moves on every board/card edit, unlike
  // updated_at which only changes when the workspace row itself is renamed. Null
  // when the workspace has no activity yet (sort falls back to updated_at).
  last_activity_at?: string | null;
}

export interface WorkspaceCreate {
  name: string;
  slug: string;
}
