// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useCallback } from "react";
import {
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type CollisionDetection,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  closestCenter,
  getFirstCollision,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { Card, Column, BoardDetail } from "@/types/kanban";
import { calculatePosition } from "../utils/position";
import { useOptimisticCardMove } from "./use-optimistic-card-move";
import { useReorderColumns } from "./use-reorder-columns";

/**
 * Multi-column sortable collision detection.
 *
 * `closestCorners` (the previous strategy) measures to the nearest corner of
 * any droppable. Cards and columns both register as droppables, so a drop
 * over column X could resolve to a card in column Y whose corner happened to
 * be closer — producing the "moved from Done to Done" bug when the user tries
 * to drop on an adjacent column.
 *
 * This strategy matches the dnd-kit recommendation for kanban boards:
 *   1. `pointerWithin` — if the pointer is inside any droppable, use it.
 *      This is the authoritative signal because it reflects user intent.
 *   2. `rectIntersection` — when the pointer briefly leaves all droppables
 *      (e.g., over a gap between columns), pick whichever droppable the drag
 *      rect overlaps.
 *   3. Fall back to the closest COLUMN only (not cards) so we never target
 *      the wrong column via a near-miss card corner.
 */
function buildKanbanCollisionDetection(
  columnIds: Set<string>,
): CollisionDetection {
  return (args) => {
    const activeId = args.active?.id;
    // Column drags only ever target other column header sortables — resolving
    // against card/body droppables would fight the horizontal sortable preview.
    if (args.active?.data.current?.type === "column-reorder") {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (c) => c.data.current?.type === "column-reorder",
        ),
      });
    }
    // Exclude the dragged card itself from collision targets. With the
    // sortable strategy, the active card's rect follows the pointer, so
    // pointerWithin can resolve to the active card — causing same-column
    // reorder drops to be treated as "drop onto self" and no-op'd.
    // Column header sortables are excluded too: a card can never drop on a
    // header, and letting pointerWithin resolve to one would no-op the move.
    const withoutActive = args.droppableContainers.filter(
      (c) => c.id !== activeId && c.data.current?.type !== "column-reorder",
    );
    const scoped = { ...args, droppableContainers: withoutActive };
    const pointerCollisions = pointerWithin(scoped);
    if (pointerCollisions.length > 0) return pointerCollisions;
    const rectCollisions = rectIntersection(scoped);
    if (rectCollisions.length > 0) return rectCollisions;
    const columnOnly = closestCenter({
      ...scoped,
      droppableContainers: withoutActive.filter((c) =>
        columnIds.has(String(c.id)),
      ),
    });
    const first = getFirstCollision(columnOnly);
    return first ? columnOnly : [];
  };
}

export function useKanbanDnd(
  slug: string,
  boardId: string,
  board: BoardDetail | undefined,
) {
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [activeColumn, setActiveColumn] = useState<Column | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const moveMutation = useOptimisticCardMove(slug, boardId);
  const reorderMutation = useReorderColumns(slug, boardId);

  // The sensor is passed unconditionally: `useSensors` filters falsy entries
  // INTERNALLY, so a conditional null shortens the returned array, and
  // DndContext spreads it into a hook dependency list — a length flip on a
  // mounted context trips React's "final argument changed size between
  // renders". Frozen boards instead disable drag at the draggables
  // (`useSortable({ disabled })` in KanbanColumn/KanbanCard), with the
  // is_frozen guard in handleDragEnd as the backstop.
  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 5 },
  });
  const sensors = useSensors(pointerSensor);

  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const columnIds = new Set(board?.columns.map((c) => c.id) ?? []);
      return buildKanbanCollisionDetection(columnIds)(args);
    },
    [board?.columns],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type === "column-reorder") {
      setActiveColumn(data.column as Column);
      return;
    }
    const card = data as Card | undefined;
    if (card) setActiveCard(card);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over?.id;
    if (!overId) return;

    const overData = event.over?.data.current;
    if (overData?.type === "column") {
      setOverColumnId(overId as string);
    } else if (overData?.type === "card") {
      setOverColumnId(overData.column_id as string);
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveCard(null);
      setActiveColumn(null);
      setOverColumnId(null);

      // Belt-and-braces with the disabled draggables: a synthetic/late drag-end
      // on a frozen board must never fire a mutation.
      if (!over || !board || board.is_frozen || !active.data.current) return;

      // Column drags must never fall through to the card path below — the
      // unconditional `as Card` cast there would fire a bogus card move.
      if (active.data.current.type === "column-reorder") {
        const sourceId = (active.data.current.column as Column).id;
        const targetData = over.data.current;
        // Pointer lands on either another header sortable ("column-reorder")
        // or a column-body droppable ("column") — both resolve to a column.
        const targetId =
          targetData?.type === "column-reorder"
            ? (targetData.column as Column).id
            : targetData?.type === "column"
              ? (over.id as string)
              : null;
        if (!targetId || targetId === sourceId) return;

        const orderedIds = [...board.columns]
          .sort((a, b) => a.position - b.position)
          .map((col) => col.id);
        const from = orderedIds.indexOf(sourceId);
        const to = orderedIds.indexOf(targetId);
        if (from === -1 || to === -1 || from === to) return;

        reorderMutation.mutate({ column_ids: arrayMove(orderedIds, from, to) });
        return;
      }

      const card = active.data.current as Card;
      const overData = over.data.current;
      let targetColumnId: string;
      let targetCardId: string | null = null;

      if (overData?.type === "column") {
        targetColumnId = over.id as string;
      } else if (overData?.type === "card") {
        targetColumnId = overData.column_id as string;
        targetCardId = over.id as string;
      } else {
        return;
      }

      const targetColumn = board.columns.find(
        (col) => col.id === targetColumnId,
      );
      if (!targetColumn) return;

      const sortedCards = [...targetColumn.cards]
        .filter((c) => c.id !== card.id)
        .sort((a, b) => a.position - b.position);

      let position: number;

      if (targetCardId) {
        const overIndex = sortedCards.findIndex((c) => c.id === targetCardId);
        if (overIndex === -1) {
          position = calculatePosition(
            sortedCards[sortedCards.length - 1]?.position,
          );
        } else {
          const isSameColumn = card.column_id === targetColumnId;
          const isDraggingDown =
            isSameColumn && card.position < sortedCards[overIndex]!.position;

          if (isDraggingDown) {
            const at = sortedCards[overIndex]?.position;
            const after = sortedCards[overIndex + 1]?.position;
            position = calculatePosition(at, after);
          } else {
            const before = sortedCards[overIndex - 1]?.position;
            const at = sortedCards[overIndex]?.position;
            position = calculatePosition(before, at);
          }
        }
      } else {
        position = calculatePosition(
          sortedCards[sortedCards.length - 1]?.position,
        );
      }

      // Same-column no-ops. Two cases:
      //   1. User dropped in the same column on the *column background* (no
      //      target card). Ignoring avoids a pointless move-to-bottom write.
      //   2. User dropped on the card itself. Same column + same card id.
      // A same-column reorder onto a DIFFERENT card still falls through.
      if (card.column_id === targetColumnId) {
        if (!targetCardId || targetCardId === card.id) return;
        if (card.position === position) return;
      }

      moveMutation.mutate({
        cardId: card.id,
        column_id: targetColumnId,
        position,
      });
    },
    [board, moveMutation, reorderMutation],
  );

  const handleDragCancel = useCallback(() => {
    setActiveCard(null);
    setActiveColumn(null);
    setOverColumnId(null);
  }, []);

  return {
    sensors,
    collisionDetection,
    activeCard,
    activeColumn,
    overColumnId,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  };
}
