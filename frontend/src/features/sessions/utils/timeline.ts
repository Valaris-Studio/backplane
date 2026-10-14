// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SessionCallItem, SessionTurn } from "@/types/agent-session";

export type TimelineEntry =
  | { type: "call"; item: SessionCallItem }
  | { type: "subagent"; item: SessionCallItem }
  | { type: "run"; key: string; items: SessionCallItem[] }
  | { type: "idle"; key: string; seconds: number };

export interface TimelineTurn {
  turnIndex: number;
  prompt: SessionCallItem | null;
  stats: SessionTurn | null;
  entries: TimelineEntry[];
}

// Reads and searches that succeeded and touched no work are the bulk of a
// session and the least interesting part of it.
const ROUTINE_TOOL = /^(read|grep|glob|ls|list_?dir|list_?files|view|search|find|rg)$/i;
// More than this many routine calls in a row collapse behind one row.
const ROUTINE_RUN_VISIBLE = 3;
const ROUTINE_RUN_KEEP = 1;
const IDLE_GAP_SECONDS = 5 * 60;

export function isRoutineCall(item: SessionCallItem): boolean {
  return (
    item.kind === "tool" &&
    item.outcome === "succeeded" &&
    item.work_refs.length === 0 &&
    ROUTINE_TOOL.test(item.name ?? "")
  );
}

function collapseRoutineRuns(entries: TimelineEntry[]): TimelineEntry[] {
  const collapsed: TimelineEntry[] = [];
  let run: SessionCallItem[] = [];

  const flush = () => {
    if (run.length > ROUTINE_RUN_VISIBLE) {
      run.slice(0, ROUTINE_RUN_KEEP).forEach((item) => collapsed.push({ type: "call", item }));
      const hidden = run.slice(ROUTINE_RUN_KEEP);
      collapsed.push({ type: "run", key: `run-${hidden[0]?.key}`, items: hidden });
    } else {
      run.forEach((item) => collapsed.push({ type: "call", item }));
    }
    run = [];
  };

  for (const entry of entries) {
    if (entry.type === "call" && isRoutineCall(entry.item)) {
      run.push(entry.item);
      continue;
    }
    flush();
    collapsed.push(entry);
  }
  flush();
  return collapsed;
}

// Waiting on a subagent or a long-running call is not idle time.
function busyUntil(item: SessionCallItem): number {
  const start = Date.parse(item.started_at);
  return Math.max(
    Date.parse(item.ended_at),
    item.duration_ms !== null ? start + item.duration_ms : start,
    item.subagent ? Date.parse(item.subagent.last_event_at) : start,
  );
}

// Items arrive in occurrence order; each prompt opens a turn (turn 0 is
// whatever ran before the first prompt). An idle stretch shows where it
// happened: inside a turn, or closing the turn before the next prompt.
export function buildTimeline(items: SessionCallItem[], turnStats: SessionTurn[]): TimelineTurn[] {
  const statsByTurn = new Map(turnStats.map((turn) => [turn.turn_index, turn]));
  const turns: TimelineTurn[] = [];
  let previousEnd: number | null = null;

  for (const item of items) {
    let turn = turns.at(-1);
    if (!turn || turn.turnIndex !== item.turn_index) {
      turn = { turnIndex: item.turn_index, prompt: null, stats: statsByTurn.get(item.turn_index) ?? null, entries: [] };
      turns.push(turn);
    }

    const start = Date.parse(item.started_at);
    if (previousEnd !== null && (start - previousEnd) / 1000 > IDLE_GAP_SECONDS) {
      const idle: TimelineEntry = { type: "idle", key: `idle-${item.key}`, seconds: (start - previousEnd) / 1000 };
      const closingTurn = item.kind === "prompt" ? turns.at(-2) : turn;
      (closingTurn ?? turn).entries.push(idle);
    }
    previousEnd = Math.max(previousEnd ?? 0, busyUntil(item));

    if (item.kind === "prompt") turn.prompt = item;
    else turn.entries.push({ type: item.kind === "subagent" ? "subagent" : "call", item });
  }

  return turns.map((turn) => ({ ...turn, entries: collapseRoutineRuns(turn.entries) }));
}

export function runToolCounts(items: SessionCallItem[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  items.forEach((item) => counts.set(item.name ?? "", (counts.get(item.name ?? "") ?? 0) + 1));
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function mergeCallPages(pagesNewestFirst: { items: SessionCallItem[]; turns: SessionTurn[] }[]) {
  const seen = new Set<string>();
  const items: SessionCallItem[] = [];
  const turns = new Map<number, SessionTurn>();
  for (const page of [...pagesNewestFirst].reverse()) {
    page.items.forEach((item) => {
      if (seen.has(item.key)) return;
      seen.add(item.key);
      items.push(item);
    });
    page.turns.forEach((turn) => turns.set(turn.turn_index, turn));
  }
  return { items, turns: [...turns.values()] };
}
