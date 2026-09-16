// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BoardDetail, Card } from "@/types/kanban";
import type { WebSocketEvent } from "@/lib/websocket";

// Outcome of trying to fast-path a card event onto the cached board:
//   - a BoardDetail → apply it to the cache (the change merged losslessly)
//   - "consistent"  → the cache ALREADY reflects this event (duplicate twin or
//                     our own optimistic update echoed back). Do nothing AND
//                     suppress the fallback refetch — there's nothing to fetch.
//   - "refetch"     → can't merge (created/updated diff, or a card we don't
//                     hold). Fall through to the authoritative GET /boards/{id}.
export type ReconcileResult = BoardDetail | "consistent" | "refetch";

// The board fast-path reconciler. Given the cached BoardDetail and an incoming
// card WS event, return the change to apply, "consistent", or "refetch".
//
// Why a reconciler instead of blindly merging the payload: the backend's
// activity payload is a human-readable DIFF, and `after_state` is the PARTIAL
// timeline snapshot (snapshot_card — no description/due_date/pr_url/dependency
// counts, and a flattened participant shape that doesn't match CardRead).
// Overwriting a cached card with after_state would silently drop fields. So we
// only patch the structural changes we can apply WITHOUT discarding data:
//   - moved   → relocate the EXISTING cached card (full data) to the new
//               column + position read from the event. Instant, lossless.
//   - deleted → drop the card by id. No data needed.
//   - created → refetch (snapshot lacks the full card).
//   - updated → refetch (partial snapshot would drop fields).
// Both the bridge (`card.moved`) and the `activity.card.moved` twin land here.

function actionOf(event: WebSocketEvent): string | null {
  // Prefer the explicit payload.action (always present on activity events);
  // fall back to the last dotted segment of the event name for bridge events.
  const fromPayload = event.payload?.action;
  if (typeof fromPayload === "string") return fromPayload;
  const parts = event.event.split(".");
  return parts[parts.length - 1] ?? null;
}

function cardIdOf(event: WebSocketEvent): string | null {
  const id = event.payload?.entity_id;
  return typeof id === "string" ? id : null;
}

interface MoveTarget {
  columnId: string;
  position: number | null;
}

// The destination column + position for a move, drawn from after_state first
// (authoritative post-move state) then the changes diff (column only).
function moveTargetOf(event: WebSocketEvent): MoveTarget | null {
  const after = event.payload?.after_state as
    | { column_id?: unknown; position?: unknown }
    | undefined;
  if (after && typeof after.column_id === "string") {
    return {
      columnId: after.column_id,
      position: typeof after.position === "number" ? after.position : null,
    };
  }
  const changes = event.payload?.changes as
    | { column_id?: { new?: unknown } }
    | undefined;
  const newCol = changes?.column_id?.new;
  if (typeof newCol === "string") {
    return { columnId: newCol, position: null };
  }
  return null;
}

function applyMove(board: BoardDetail, event: WebSocketEvent): ReconcileResult {
  const cardId = cardIdOf(event);
  const target = moveTargetOf(event);
  if (!cardId || !target) return "refetch";

  // Pull the existing card (with its full data) out of whatever column holds it.
  let existing: Card | undefined;
  for (const col of board.columns) {
    const found = col.cards.find((c) => c.id === cardId);
    if (found) {
      existing = found;
      break;
    }
  }
  if (!existing) return "refetch"; // unknown card — refetch is authoritative

  const targetColumn = board.columns.find((c) => c.id === target.columnId);
  if (!targetColumn) return "refetch"; // unknown destination — refetch

  const nextPosition = target.position ?? existing.position;

  // Already in the target column at the target position — the cache reflects
  // this move (a duplicate twin event, or our own optimistic update echoed
  // back). Nothing to apply, and nothing a refetch would add.
  if (existing.column_id === target.columnId && existing.position === nextPosition) {
    return "consistent";
  }

  const movedCard: Card = {
    ...existing,
    column_id: target.columnId,
    position: nextPosition,
  };

  const columns = board.columns.map((col) => {
    const without = col.cards.filter((c) => c.id !== cardId);
    if (col.id !== target.columnId) {
      return without.length === col.cards.length ? col : { ...col, cards: without };
    }
    const cards = [...without, movedCard].sort((a, b) => a.position - b.position);
    return { ...col, cards };
  });

  return { ...board, columns };
}

function applyDelete(board: BoardDetail, event: WebSocketEvent): ReconcileResult {
  const cardId = cardIdOf(event);
  if (!cardId) return "refetch";
  let removed = false;
  const columns = board.columns.map((col) => {
    const without = col.cards.filter((c) => c.id !== cardId);
    if (without.length !== col.cards.length) removed = true;
    return without.length === col.cards.length ? col : { ...col, cards: without };
  });
  // Card already absent — a duplicate delete twin, or we never held it. Either
  // way the cache is consistent with "this card isn't here"; no refetch needed.
  return removed ? { ...board, columns } : "consistent";
}

export function reconcileBoardEvent(
  board: BoardDetail,
  event: WebSocketEvent,
): ReconcileResult {
  const action = actionOf(event);
  switch (action) {
    case "moved":
      return applyMove(board, event);
    case "deleted":
      return applyDelete(board, event);
    // created/updated and anything else: the payload can't be merged losslessly.
    default:
      return "refetch";
  }
}
