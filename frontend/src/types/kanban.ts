// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type CardType = "task" | "bug" | "feature" | "issue";

// Mirrors backend Priority (models/kanban/card.py) — `none` is the server-side
// default, so it arrives on ordinary cards and must be renderable everywhere.
export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export type ParticipantRole = "hero" | "viewer" | "stakeholder" | "helper";

export type ColumnType = "backlog" | "active" | "review" | "done" | "blocked";

export interface CardParticipant {
  user_id: string;
  agent_id: string | null;
  role: ParticipantRole;
  added_at: string;
  user: { id: string; name: string; email: string; avatar_url: string | null };
  agent: { id: string; name: string; agent_type: string } | null;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  card_type: CardType;
  priority: Priority;
  position: number;
  column_id: string;
  participants: CardParticipant[];
  due_date: string | null;
  status: string | null;
  labels: string[] | null;
  // Derived server-side: true iff a pending ApprovalRequest references this
  // card. See backend CardRead.has_pending_approval.
  has_pending_approval?: boolean;
  pending_approval_id?: string | null;
  // Derived runner-presence enum (see backend attach_agent_presence). Drives
  // the card's robot indicator and the "agent activity" sort option.
  agent_presence?: "none" | "eligible" | "touched" | "suspended" | "active";
  active_execution_id?: string | null;
  last_agent_activity_at?: string | null;
  // UX-3: authoritative PR URL + branch. Null on cards predating the
  // rollout; readers should fall back to parsing the description footer.
  pr_url?: string | null;
  branch_name?: string | null;
  // Inline dependency summary so the board-view chip renders without a
  // per-card round trip. The dedicated GET /dependencies endpoint still
  // owns the full bidirectional list in the card detail sheet.
  depends_on_count?: number;
  blocks_count?: number;
  dependency_status?: "ready" | "blocked" | "unblocked";
  created_at: string;
  updated_at: string;
}

export interface CardDependencyRead {
  satisfied?: boolean;
  card_id: string;
  depends_on_card_id: string;
  depends_on_title: string | null;
  depends_on_status: string | null;
  depends_on_column_type: string | null;
  created_at: string;
  created_by: string;
}

export interface CardDependenciesView {
  depends_on: CardDependencyRead[];
  blocks: CardDependencyRead[];
}

// Board-level edge list for the table tree view: `card_id` depends on
// `depends_on_card_id`. Bare ids — the client already holds the card data.
export interface BoardDependencyEdge {
  card_id: string;
  depends_on_card_id: string;
}

// Backend dependency-validation report. A board is `ok` when there are no
// cycles, no conflicts (a card ready/done while it still depends on an
// unsatisfied card), and no orphans (an edge pointing off the board).
export interface DependencyCycle {
  card_ids: string[];
  titles: string[];
  summary: string;
}

export interface DependencyConflict {
  card_id: string;
  title: string;
  unsatisfied_dependency_ids: string[];
  unsatisfied_dependency_titles: string[];
  summary: string;
}

export interface DependencyOrphan {
  card_id: string;
  depends_on_card_id: string;
  card_on_board: boolean;
  depends_on_on_board: boolean;
  summary: string;
}

export interface BoardDependencyValidation {
  ok: boolean;
  cycles: DependencyCycle[];
  conflicts: DependencyConflict[];
  orphans: DependencyOrphan[];
}

export interface Column {
  id: string;
  name: string;
  position: number;
  board_id: string;
  column_type: ColumnType | null;
  cards: Card[];
  created_at: string;
  updated_at: string;
}

export interface Board {
  id: string;
  // Null until backfill migration runs in every environment.
  slug: string | null;
  name: string;
  description: string;
  tags: string[];
  workspace_id: string;
  // Optional (not required) so pre-freeze fixtures/caches stay valid; readers
  // must treat absence as not-frozen.
  is_frozen?: boolean;
  frozen_at?: string | null;
  created_at: string;
  updated_at: string;
  // Batched stats from the list endpoint (mirror of Workspace counts);
  // absent on single-board responses, which don't compute them.
  card_count?: number | null;
  column_count?: number | null;
  last_activity_at?: string | null;
  // BP-005 additive fetch-gating flags. `loop_configured` is on every board
  // response; `has_definition` is computed on list + detail only (null
  // elsewhere). Absent = old backend — readers must fall back to fetching.
  loop_configured?: boolean;
  has_definition?: boolean | null;
  // Tri-state done-merge-gate override: null inherits the workspace flag, true
  // enforces on this board regardless, false turns it off. Optional so
  // pre-override fixtures/caches stay valid. Resolve it with resolveDoneGate —
  // never read it against the workspace flag by hand.
  enforce_done_merge_gate?: boolean | null;
}

export interface BoardDetail extends Board {
  columns: Column[];
}

export interface CardMoveRequest {
  column_id: string;
  position: number;
}
