// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Card, Column } from "@/types/kanban";
import type { ExecutionSummary } from "@/features/agents/api/agents";
import type { StageConfig } from "@/features/agents/api/pipelineConfig";

export type StuckReasonKey =
  | "blockedColumn"
  | "needsAdvisor"
  | "noHero"
  | "awaitingPrompt"
  | "requestChanges"
  | "recentFailures"
  | "stale";

// Staleness threshold: if `updated_at` hasn't moved in this many days AND no
// execution has touched the card, surface the generic stale reason. 7 days
// matches the scheduler's default rework cutoff and the staleness alert.
export const STALE_THRESHOLD_DAYS = 7;

// Recent-failure window: executions whose `started_at` falls inside this many
// hours count toward the "consecutive failures" scheduler backoff reason. The
// backend backoff itself resets faster, but operators care about the pattern.
const FAILURE_WINDOW_HOURS = 24;

// Minimum failure count to surface the reason at all. A single failure is
// normal noise — we flag two or more in the window.
const FAILURE_MIN_COUNT = 2;

export interface StuckReason {
  key: StuckReasonKey;
  // Data needed to hydrate the i18n string for this reason (e.g., count,
  // days). Kept flat so the consumer can spread it into `t(key, values)`.
  values?: Record<string, number | string>;
}

export interface StuckReasonsInput {
  card: Card;
  column: Column | null;
  // Filter upstream to executions that affect this card. The util does NOT
  // re-filter — it trusts the caller to scope correctly so the "recent
  // failures" count reflects this card only.
  cardExecutions: ExecutionSummary[];
  awaitingPromptCount: number;
  latestReview: "approve" | "request_changes" | null;
  // Current pipeline stages, used to gate reasons that reference pipeline
  // primitives (e.g., `noHero` only makes sense if some stage actually claims
  // as `hero`). Undefined or empty means we fall back to conservative defaults
  // — surface the reason rather than hide a real blocker.
  pipelineStages?: StageConfig[];
  now?: Date;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function hoursBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return ms / (1000 * 60 * 60);
}

function isDoneColumn(column: Column | null): boolean {
  return column?.column_type === "done";
}

function hasHero(card: Card): boolean {
  return (card.participants ?? []).some((p) => p.role === "hero");
}

/**
 * Derives the user-facing list of reasons a card may be stuck. Pure function —
 * callers supply scoped data; we compose the reasons in a stable order.
 *
 * Order matters: we surface the most actionable reasons first. A blocked
 * column is the single root cause that masks every other reason; a stuck-loop
 * park has one precise fix (remove the needs-advisor label) so it leads
 * everything else; awaiting prompts are the next-most-direct fix; reviewer
 * request_changes is a directive for a specific role; recent failures are
 * diagnostic; staleness is the catch-all when nothing else applies.
 */
export function computeStuckReasons(input: StuckReasonsInput): StuckReason[] {
  const {
    card,
    column,
    cardExecutions,
    awaitingPromptCount,
    latestReview,
    pipelineStages,
  } = input;
  const now = input.now ?? new Date();
  const reasons: StuckReason[] = [];

  // Done cards are by definition not stuck. Skip everything.
  if (isDoneColumn(column)) return [];

  if (column?.column_type === "blocked") {
    reasons.push({ key: "blockedColumn" });
  }

  // Stuck-loop park: the reviewer loop repeated the same feedback and the
  // scheduler skips this card for reviewer/coder until the label is removed.
  if (card.labels?.includes("needs-advisor")) {
    reasons.push({ key: "needsAdvisor" });
  }

  // `hero` is a pipeline-DSL primitive, not a role name. But not every user's
  // pipeline claims with `hero` — some may use only `helper` claims. If the
  // pipeline is available and no stage claims as hero, flagging "no hero" is
  // a false positive. When we can't see the pipeline, stay conservative and
  // surface the reason.
  const pipelineUsesHero =
    !pipelineStages ||
    pipelineStages.length === 0 ||
    pipelineStages.some((s) => s.claim?.participant_role === "hero");
  if (pipelineUsesHero && !hasHero(card)) {
    reasons.push({ key: "noHero" });
  }

  if (awaitingPromptCount > 0) {
    reasons.push({
      key: "awaitingPrompt",
      values: { count: awaitingPromptCount },
    });
  }

  if (latestReview === "request_changes") {
    reasons.push({ key: "requestChanges" });
  }

  const recentFailureCount = cardExecutions.filter((exec) => {
    if (exec.status !== "failed") return false;
    if (!exec.started_at) return false;
    const startedAt = new Date(exec.started_at);
    if (Number.isNaN(startedAt.getTime())) return false;
    return hoursBetween(startedAt, now) <= FAILURE_WINDOW_HOURS;
  }).length;

  if (recentFailureCount >= FAILURE_MIN_COUNT) {
    reasons.push({
      key: "recentFailures",
      values: { count: recentFailureCount },
    });
  }

  // Staleness is the fallback. We only surface it if no other reason did, so
  // operators see the actionable signals first.
  if (reasons.length === 0) {
    const updatedAt = new Date(card.updated_at);
    if (!Number.isNaN(updatedAt.getTime())) {
      const daysSinceUpdate = daysBetween(updatedAt, now);
      const hasRecentExec = cardExecutions.some((exec) => {
        if (!exec.started_at) return false;
        const startedAt = new Date(exec.started_at);
        return !Number.isNaN(startedAt.getTime()) &&
          daysBetween(startedAt, now) < STALE_THRESHOLD_DAYS;
      });
      if (daysSinceUpdate >= STALE_THRESHOLD_DAYS && !hasRecentExec) {
        reasons.push({
          key: "stale",
          values: { days: daysSinceUpdate },
        });
      }
    }
  }

  return reasons;
}
