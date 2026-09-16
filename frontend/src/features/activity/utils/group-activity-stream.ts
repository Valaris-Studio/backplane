// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Activity } from "@/types/activity";

// A run of fewer than this many consecutive identical churn cycles isn't a
// "storm" — leave those rows visible rather than hiding them behind a toggle.
const MIN_CYCLES_TO_COLLAPSE = 2;

// Scheduler churn (reserve → claim → unassign loop) is always agent-attributed
// and its summary starts with one of these verbs. Matching on the leading verb
// (not a substring) keeps "reserved card…" churn distinct from a human note
// that happens to mention the word. Lowercased before test. en + es.
const CHURN_VERBS = [
  "reserved",
  "claimed",
  "unassigned",
  "released",
  "shed",
  // es
  "reservó",
  "reservada",
  "reclamó",
  "liberó",
  "desasignó",
];

// A churn cycle repeats these roles per card. We collapse on entity_id alone
// (the loop is the repetition), so role is informational, surfaced in the group.
type StreamCycle = {
  kind: "cycle";
  entityId: string;
  count: number; // number of full reserve/claim/unassign cycles, ~= items/3
  items: Activity[]; // the underlying rows, newest-first
  startedAt: string; // earliest event in the burst
  endedAt: string; // latest event in the burst
  resolved: boolean; // a terminal state-transition for this card follows the burst
  resolvedBy?: Activity; // the transition that closed it
};

type StreamEvent = {
  kind: "event";
  activity: Activity;
  isStateTransition: boolean;
};

export type ActivityStreamItem = StreamCycle | StreamEvent;

function churnVerb(summary: string): string | null {
  const first = summary.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
  return CHURN_VERBS.includes(first) ? first : null;
}

/** Scheduler reserve/claim/unassign noise — agent-attributed, churn verb. */
export function isChurn(a: Activity): boolean {
  return !!a.agent_id && churnVerb(a.summary) !== null;
}

/**
 * A state transition is the row that actually moves the card's lifecycle:
 * a column move, park, approval, creation, or deletion. These dominate the
 * feed and terminate churn bursts. Anything else (incl. agent churn and plain
 * field edits) is not a transition.
 */
export function isStateTransition(a: Activity): boolean {
  if (isChurn(a)) return false;
  if (a.action === "created" || a.action === "deleted" || a.action === "moved" || a.action === "archived") {
    return true;
  }
  // `parked`/`approved`/`merged` ride on action=updated; detect by leading verb.
  const verb = a.summary.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
  return ["parked", "approved", "merged", "rejected", "aprobó", "fusionó", "rechazó"].includes(verb);
}

/**
 * Turn the flat reverse-chronological activity list into a stream where
 * consecutive same-card churn cycles collapse into one expandable group, each
 * group flagged resolved when a later state-transition for that card closed it,
 * and every remaining row tagged as a state-transition or not (for ranking).
 *
 * Input and output are both newest-first; ordering is preserved.
 */
export function groupActivityStream(activities: Activity[]): ActivityStreamItem[] {
  const items: ActivityStreamItem[] = [];
  let i = 0;

  // Newest state-transition seen so far while walking newest→oldest. A churn
  // burst is "resolved" by the most recent transition that sits ABOVE it (i.e.
  // happened after the burst), which is exactly the last transition we passed.
  let lastTransitionAbove: Activity | undefined;

  while (i < activities.length) {
    const current = activities[i]!;

    if (isChurn(current)) {
      // Greedily consume the maximal run of churn on the SAME card.
      const entityId = current.entity_id;
      let j = i;
      while (j < activities.length && isChurn(activities[j]!) && activities[j]!.entity_id === entityId) {
        j += 1;
      }
      const run = activities.slice(i, j);
      const cycles = countCycles(run);

      if (cycles >= MIN_CYCLES_TO_COLLAPSE) {
        const timestamps = run.map((a) => a.created_at).sort();
        items.push({
          kind: "cycle",
          entityId,
          count: cycles,
          items: run,
          startedAt: timestamps[0]!,
          endedAt: timestamps[timestamps.length - 1]!,
          resolved: !!lastTransitionAbove && lastTransitionAbove.entity_id === entityId,
          resolvedBy:
            lastTransitionAbove && lastTransitionAbove.entity_id === entityId
              ? lastTransitionAbove
              : undefined,
        });
      } else {
        for (const a of run) {
          items.push({ kind: "event", activity: a, isStateTransition: false });
        }
      }
      i = j;
      continue;
    }

    const transition = isStateTransition(current);
    if (transition) lastTransitionAbove = current;
    items.push({ kind: "event", activity: current, isStateTransition: transition });
    i += 1;
  }

  return items;
}

/**
 * The newest state-transition timestamp in the stream — the boundary between
 * "current" and "historical/resolved" activity for the stale divider. null when
 * the feed has no lifecycle transition at all.
 */
export function lastMeaningfulTransition(activities: Activity[]): Activity | null {
  for (const a of activities) {
    if (isStateTransition(a)) return a;
  }
  return null;
}

// One cycle = the reserve→claim→unassign trio. Count distinct cycles by the
// number of times the leading churn verb repeats its most frequent value, but
// a simpler robust proxy is ceil(rows / verbs-per-cycle). We count by the
// number of "reserved"/"reservó" markers (one per cycle start); fall back to
// rows when no explicit reserve marker is present.
function countCycles(run: Activity[]): number {
  const reserves = run.filter((a) => {
    const v = churnVerb(a.summary);
    return v === "reserved" || v === "reservó" || v === "reservada";
  }).length;
  return reserves > 0 ? reserves : run.length;
}
