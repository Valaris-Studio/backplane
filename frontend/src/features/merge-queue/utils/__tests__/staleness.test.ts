// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  MERGE_QUEUE_STALE_THRESHOLD_SECONDS,
  classifyStaleEntry,
  queueAgeSeconds,
} from "../staleness";
import type { MergeQueueEntry, MergeQueueState } from "@/types/merge-queue";

const NOW = new Date("2026-08-13T12:00:00Z").getTime();

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function entry(overrides: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    id: "entry-1",
    repo_id: "repo-1",
    integration_branch: "self-improve-2",
    card_id: "card-1",
    pr_url: "https://github.com/acme/repo/pull/1",
    pr_branch: "loop2/thing",
    workspace_id: "ws-1",
    enqueued_at: minutesAgo(1),
    first_enqueued_at: minutesAgo(1),
    state: "queued" as MergeQueueState,
    attempt_count: 0,
    error_message: null,
    merged_at: null,
    ...overrides,
  };
}

describe("queueAgeSeconds", () => {
  it("measures from first_enqueued_at, not the FIFO-bumped enqueued_at", () => {
    // The hot-retry shape: re_enqueue bumps enqueued_at to the back of the
    // FIFO on every attempt, so it always looks fresh. first_enqueued_at is
    // the real stuck-duration clock (backend migration 088).
    const churning = entry({
      enqueued_at: minutesAgo(1),
      first_enqueued_at: minutesAgo(90),
    });

    expect(queueAgeSeconds(churning, NOW)).toBe(90 * 60);
  });

  it("falls back to enqueued_at when first_enqueued_at is null (pre-088 rows)", () => {
    const legacy = entry({ enqueued_at: minutesAgo(42), first_enqueued_at: null });

    expect(queueAgeSeconds(legacy, NOW)).toBe(42 * 60);
  });

  it("never reports a negative age for a clock-skewed future timestamp", () => {
    const skewed = entry({ first_enqueued_at: new Date(NOW + 60_000).toISOString() });

    expect(queueAgeSeconds(skewed, NOW)).toBe(0);
  });
});

describe("classifyStaleEntry", () => {
  it("returns null below the threshold", () => {
    const fresh = entry({
      first_enqueued_at: new Date(
        NOW - (MERGE_QUEUE_STALE_THRESHOLD_SECONDS - 30) * 1000,
      ).toISOString(),
    });

    expect(classifyStaleEntry(fresh, NOW)).toBeNull();
  });

  it("classifies a churning entry with attempts as entry_failing", () => {
    const failing = entry({
      first_enqueued_at: minutesAgo(30),
      enqueued_at: minutesAgo(1),
      attempt_count: 7,
      error_message: "merge conflict in app.py",
    });

    expect(classifyStaleEntry(failing, NOW)).toBe("entry_failing");
  });

  it("classifies a persisted error with zero attempts as entry_failing", () => {
    const errored = entry({
      first_enqueued_at: minutesAgo(30),
      attempt_count: 0,
      error_message: "boom",
    });

    expect(classifyStaleEntry(errored, NOW)).toBe("entry_failing");
  });

  it("classifies an untouched aged entry as worker_stalled", () => {
    const untouched = entry({
      first_enqueued_at: minutesAgo(30),
      attempt_count: 0,
      error_message: null,
    });

    expect(classifyStaleEntry(untouched, NOW)).toBe("worker_stalled");
  });

  // The backend only ever computes staleness over ("queued", "merging")
  // (_MERGE_QUEUE_ACTIVE_STATES). Flagging any other state here would make the
  // panel contradict board health and the merge_queue.stale event.
  it.each(["merged", "conflict", "failed", "blocked_pending_consolidation"] as const)(
    "never flags %s — only queued/merging are staleable, mirroring the backend",
    (state) => {
      const aged = entry({
        state,
        first_enqueued_at: minutesAgo(600),
        attempt_count: 9,
        error_message: "boom",
      });

      expect(classifyStaleEntry(aged, NOW)).toBeNull();
    },
  );

  it("flags a long-running merging entry — a wedged merge is the loudest case", () => {
    const wedged = entry({ state: "merging", first_enqueued_at: minutesAgo(45) });

    expect(classifyStaleEntry(wedged, NOW)).toBe("worker_stalled");
  });
});
