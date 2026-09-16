// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MergeQueueEntry, MergeQueueState } from "@/types/merge-queue";

// Mirrors backend/app/config.py MERGE_QUEUE_STALE_THRESHOLD_SECONDS. Duplicated
// rather than fetched because no client-facing config endpoint exposes it; the
// same mirroring precedent is STALE_THRESHOLD_DAYS in kanban/utils/stuckReasons.
// If the backend default moves, move this with it — a panel that disagrees with
// board health is worse than one that says nothing.
export const MERGE_QUEUE_STALE_THRESHOLD_SECONDS = 300;

// Mirrors _MERGE_QUEUE_ACTIVE_STATES in backend/app/services/kanban/board_health.py.
// Terminal states are never stale: a failed entry is already loud, and a merged
// one is finished.
const STALEABLE_STATES: readonly MergeQueueState[] = ["queued", "merging"];

export type StaleClassification = "worker_stalled" | "entry_failing";

/**
 * How long the entry has been stuck in the queue, in seconds.
 *
 * Measured from `first_enqueued_at`, NOT `enqueued_at`: `re_enqueue` bumps the
 * latter to the back of the FIFO on every retry, so a continuously-churning
 * entry looks permanently fresh through it. Rows predating migration 088 carry
 * a null `first_enqueued_at` and fall back — same rule the backend applies.
 */
export function queueAgeSeconds(entry: MergeQueueEntry, now: number): number {
  const origin = entry.first_enqueued_at ?? entry.enqueued_at;
  return Math.max(0, Math.floor((now - new Date(origin).getTime()) / 1000));
}

/**
 * Null when the entry is healthy; otherwise which flavour of stuck it is.
 *
 * Mirrors BoardHealthService._compute_merge_queue_health so the panel, the
 * /health payload, and the merge_queue.stale event all agree.
 */
export function classifyStaleEntry(
  entry: MergeQueueEntry,
  now: number,
): StaleClassification | null {
  if (!STALEABLE_STATES.includes(entry.state)) return null;
  if (queueAgeSeconds(entry, now) < MERGE_QUEUE_STALE_THRESHOLD_SECONDS) return null;

  return entry.attempt_count > 0 || entry.error_message ? "entry_failing" : "worker_stalled";
}
