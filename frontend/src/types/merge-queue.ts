// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mirrors `MergeQueueEntryRead` (backend/app/schemas/merge_queue.py) and the
// closed state enum in backend/app/models/agents/merge_queue.py.
export type MergeQueueState =
  | "queued"
  | "merging"
  | "merged"
  | "conflict"
  | "failed"
  | "blocked_pending_consolidation";

export interface MergeQueueEntry {
  id: string;
  repo_id: string;
  integration_branch: string;
  card_id: string;
  pr_url: string;
  pr_branch: string;
  workspace_id: string;
  enqueued_at: string;
  // When the entry FIRST entered the queue. `enqueued_at` is the FIFO position
  // and gets bumped to the back on every retry, so only this is a usable
  // stuck-duration clock. Null for rows predating backend migration 088.
  first_enqueued_at?: string | null;
  state: MergeQueueState;
  attempt_count: number;
  error_message?: string | null;
  merged_at?: string | null;
}
