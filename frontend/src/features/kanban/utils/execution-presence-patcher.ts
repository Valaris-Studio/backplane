// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BoardDetail, Card } from "@/types/kanban";
import type { WebSocketEvent } from "@/lib/websocket";

// Mirrors the backend `BUDGET_SUSPENDED_LABEL` in services/kanban/card.py. A
// parked card must read `suspended`, not `touched`, once its run ends.
const BUDGET_SUSPENDED_LABEL = "budget-suspended";

const TERMINAL_EVENTS = new Set(["execution.completed"]);
const ACTIVATING_EVENTS = new Set(["execution.started"]);

// Advisory mid-run telemetry: the execution is still in flight, so the card's
// presence is ALREADY correct and there is nothing to patch — but there is also
// nothing to refetch for, since no board-rendered field derives from a warning.
// Distinguished from "cannot apply" (which must refetch) so a warning storm
// from a struggling runner doesn't reintroduce the per-event board GET.
const INERT_EVENTS = new Set(["execution.warning"]);

type Presence = NonNullable<Card["agent_presence"]>;

// What `attach_agent_presence` would recompute for a card whose execution just
// ended. Precedence there is active > suspended > touched > eligible > none;
// with no in-flight execution left, a card that has just been worked always has
// an agent-authored activity row, so it settles on `touched` — unless it is
// budget-suspended, which outranks it.
function presenceAfterTerminal(card: Card): Presence {
  return (card.labels ?? []).includes(BUDGET_SUSPENDED_LABEL)
    ? "suspended"
    : "touched";
}

function stringField(payload: WebSocketEvent["payload"], key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
}

// Compute the card's new presence fields from an execution lifecycle event, or
// null when this event should not change the cached card at all.
function nextPresence(
  event: WebSocketEvent,
  card: Card,
): Pick<Card, "agent_presence" | "active_execution_id"> | null {
  const executionId = stringField(event.payload, "execution_id");

  if (ACTIVATING_EVENTS.has(event.event)) {
    if (!executionId) return null;
    return { agent_presence: "active", active_execution_id: executionId };
  }

  if (TERMINAL_EVENTS.has(event.event)) {
    // A late terminal event from a PREVIOUS execution must not clear the
    // indicator for the run that is happening right now.
    const current = card.active_execution_id;
    if (current && executionId && current !== executionId) return null;
    return {
      agent_presence: presenceAfterTerminal(card),
      active_execution_id: null,
    };
  }

  return null;
}

// Apply an execution lifecycle event to the cached board by rewriting the
// presence fields of the one card it names. Returns the next BoardDetail, or
// null when the event cannot be applied (no card_id, card absent from the
// cache, or an event that carries no presence transition) — callers fall back
// to the authoritative board GET, which recomputes presence server-side.
export function patchExecutionPresence(
  board: BoardDetail,
  event: WebSocketEvent,
): BoardDetail | null {
  // Inert before the card lookup: a warning changes nothing whether or not the
  // named card is cached, so it must never reach the refetch fallback.
  if (INERT_EVENTS.has(event.event)) return board;

  const cardId = stringField(event.payload, "card_id");
  if (!cardId) return null;

  for (const column of board.columns) {
    const index = column.cards.findIndex((c) => c.id === cardId);
    if (index < 0) continue;

    const card = column.cards[index]!;
    const patch = nextPresence(event, card);
    if (!patch) return null;
    if (
      card.agent_presence === patch.agent_presence &&
      (card.active_execution_id ?? null) === patch.active_execution_id
    ) {
      return board; // already correct — suppress the refetch without churning
    }

    const cards = [...column.cards];
    cards[index] = { ...card, ...patch };
    return {
      ...board,
      columns: board.columns.map((col) =>
        col.id === column.id ? { ...col, cards } : col,
      ),
    };
  }

  return null; // card not in this board's cache
}
