// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus } from "lucide-react";
import { ColumnHeader } from "./ColumnHeader";
import { CreateCardDialog } from "./CreateCardDialog";
import { KanbanCard, type CardDensity } from "./KanbanCard";
import { Button } from "@/components/ui/button";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { gsap } from "gsap";
import { scaleIn, staggerChildren } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { newIdsSince } from "../utils/new-ids";
import { useUpdateColumn } from "../api/use-columns";
import { sortCards, useColumnSort } from "../hooks/use-column-sort";
import { columnSortableId } from "../utils/column-sortable";
import type { Card, Column, ColumnType } from "@/types/kanban";

interface Props {
  column: Column;
  columns: Column[];
  slug: string;
  boardId: string;
  onRenameColumn: (columnId: string, name: string) => void;
  onDeleteColumn: (columnId: string) => void;
  onCardClick: (card: Card) => void;
  // True when the board-level DnD hook has resolved this column as the drop
  // target. The column's own `isOver` only fires when the pointer is over the
  // column's droppable zone (not a card inside it), so we take the broader
  // signal from the hook so hovering a card still highlights its parent column.
  isDropTarget?: boolean;
  // True while any card on the board is being dragged. Drives the "available
  // drop zones" treatment — columns that aren't the current target get a
  // subtler highlight to emphasise where the user IS aiming.
  isDragActive?: boolean;
  // When the board-level filter bar has selected a non-manual sort, the column
  // hands off ordering to the board: it renders cards in the (already-sorted)
  // order received and disables its own per-column sort dropdown so users
  // aren't fighting two sources of truth.
  boardSortActive?: boolean;
  // Counts surfaced in the column header so users see filters are active.
  // `visibleCount` is the post-filter card count for THIS column; `totalCount`
  // is the unfiltered count. When equal, the header shows just a single
  // number (current behavior).
  visibleCount?: number;
  totalCount?: number;
  // Frozen board: the add-card affordance is REMOVED (not disabled — the
  // frozen banner explains why); column reorder AND card drags are disabled at
  // their draggables, which is what prevents drag activation now that the
  // sensor list is length-stable (see use-kanban-dnd).
  isFrozen?: boolean;
  // Card density for this column's cards. Compact keeps the column tree, the
  // dnd wiring and the WS updates identical — only the card body shrinks.
  density?: CardDensity;
  // Passed straight to ColumnHeader's done-gate badge — the board's
  // enforce_done_merge_gate override, sourced from the board detail BoardView
  // already holds.
  doneGateOverride?: boolean | null;
}

export function KanbanColumn({
  column,
  columns,
  slug,
  boardId,
  onRenameColumn,
  onDeleteColumn,
  onCardClick,
  isDropTarget = false,
  isDragActive = false,
  boardSortActive = false,
  visibleCount,
  totalCount,
  isFrozen = false,
  density = "comfortable",
  doneGateOverride,
}: Props) {
  const updateColumn = useUpdateColumn(slug, boardId);
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const [sortMode, setSortMode] = useColumnSort(boardId, column.id);
  const reducedMotion = useReducedMotion();
  const cardsRef = useRef<HTMLDivElement>(null);
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: { type: "column" },
  });
  // Column reorder: the WRAPPER is the sortable node (it translates while
  // siblings reorder), but activation listeners live on the header only so
  // card drags inside the body never start a column drag.
  const {
    attributes: sortableAttributes,
    listeners: sortableListeners,
    setNodeRef: setSortableNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
  } = useSortable({
    id: columnSortableId(column.id),
    data: { type: "column-reorder", column },
    disabled: isFrozen,
  });

  // Dedupe by id as a seatbelt: optimistic updates + WS refetches can briefly
  // deliver a cache where the same card appears twice (e.g. a 429 partial
  // refetch arriving mid-mutation). A dup here would crash dnd-kit's
  // SortableContext and trigger React's "duplicate key" warning. Keep the
  // first occurrence — later entries are almost always the same row.
  // Memoized so the card array keeps its identity across the parent re-renders
  // dnd-kit fires on every pointer move — a fresh array here would defeat
  // KanbanCard's memo boundary by rebuilding SortableContext's items too.
  const sortedCards = useMemo(() => {
    const seen = new Set<string>();
    const deduped = column.cards.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    // When the board filter bar imposes a non-manual sort, the cards arrive
    // pre-sorted in board order; re-applying the per-column sort would override
    // and confuse the user. The header's sort dropdown is also disabled.
    return boardSortActive ? deduped : sortCards(deduped, sortMode);
  }, [column.cards, boardSortActive, sortMode]);

  // SortableContext rebuilds its context value whenever `items` changes
  // IDENTITY (not contents), and every useSortable consumer reads that value —
  // so a fresh array here re-renders every card in the column even when the
  // order is untouched (e.g. a WS patch to one card). Reuse the previous array
  // whenever the id sequence is unchanged.
  const cardIdsRef = useRef<string[]>([]);
  const nextCardIds = sortedCards.map((card) => card.id);
  const cardIds =
    nextCardIds.length === cardIdsRef.current.length
    && nextCardIds.every((id, i) => id === cardIdsRef.current[i])
      ? cardIdsRef.current
      : (cardIdsRef.current = nextCardIds);
  // Stable change signal for the entrance effect: re-run when the SET of cards
  // changes, not on every render. Extracted so eslint can check it statically.
  const cardIdsKey = cardIds.join(":");

  // Remembers which card ids have already animated in, so a re-render caused by
  // a WS event or optimistic update animates ONLY the genuinely-new cards
  // instead of re-flashing the whole column. null = not yet mounted.
  const seenIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (reducedMotion) {
      seenIdsRef.current = new Set(cardIds);
      return;
    }
    const container = cardsRef.current;
    if (!container) return;

    const firstMount = seenIdsRef.current === null;
    const newIds = newIdsSince(cardIds, seenIdsRef.current);
    seenIdsRef.current = new Set(cardIds);

    if (firstMount) {
      // Initial entrance: capped staggered reveal so a tall column doesn't
      // trickle cards in for seconds. Only the first ~12 animate (tight 0.025s
      // step), the rest snap in. Worst-case ≈ 0.16 + 0.025*11 ≈ 0.44s, flat
      // regardless of card count.
      const tween = staggerChildren(container, "[data-stagger-item]", scaleIn, {
        stagger: 0.025,
        duration: 0.16,
        maxStaggered: 12,
      });
      // progress(1) BEFORE kill: the entrance starts cards at autoAlpha 0, so a
      // bare mid-flight kill (card set changing right behind a mount, e.g. a
      // sort flip when returning from the list view) strands them invisible.
      return () => { tween?.progress(1).kill(); };
    }

    if (newIds.length === 0) return; // reorder / update / removal — no entrance

    // A card (or a few) just arrived — e.g. a runner moved one in, or a create.
    // Animate just those, leaving the rest untouched (no whole-column flash).
    const selector = newIds.map((id) => `[data-card-id="${id}"]`).join(",");
    const targets = gsap.utils.toArray<HTMLElement>(selector, container);
    if (!targets.length) return;
    const tween = scaleIn(targets, { stagger: 0.025, duration: 0.16 });
    return () => { tween?.progress(1).kill(); };
    // cardIdsKey is the content-change signal; `cardIds` is read fresh inside
    // (intentionally not a dep — we re-run on content change, not identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardIdsKey, reducedMotion]);

  // Read through a ref so a caller passing a fresh `onCardClick` each render
  // doesn't invalidate the handler map (and with it every card's memo).
  const onCardClickRef = useRef(onCardClick);
  onCardClickRef.current = onCardClick;

  // One stable callback per card id. `onCardClick(card)` needs the card object,
  // so it can't collapse to a single shared handler — but each card's handler
  // must keep its identity, which is what KanbanCard's React.memo depends on.
  // The card is read from a ref rather than captured, so a WS patch to ONE card
  // doesn't hand its untouched siblings new callbacks (and re-render them).
  const cardsByIdRef = useRef(new Map<string, Card>());
  cardsByIdRef.current = new Map(sortedCards.map((card) => [card.id, card]));

  const clickHandlersRef = useRef(new Map<string, () => void>());
  for (const id of clickHandlersRef.current.keys()) {
    if (!cardsByIdRef.current.has(id)) clickHandlersRef.current.delete(id);
  }
  for (const id of cardsByIdRef.current.keys()) {
    if (clickHandlersRef.current.has(id)) continue;
    clickHandlersRef.current.set(id, () => {
      const card = cardsByIdRef.current.get(id);
      if (card) onCardClickRef.current(card);
    });
  }
  const cardClickHandlers = clickHandlersRef.current;

  // The column's own `useDroppable.isOver` fires only when the pointer lands
  // directly on the column droppable (not a card child). We OR it with the
  // board-level `isDropTarget` so hovering a card still highlights its column.
  const highlightActive = isOver || isDropTarget;

  return (
    <div
      ref={setSortableNodeRef}
      style={{
        transform: CSS.Translate.toString(transform) ?? undefined,
        transition,
      }}
      aria-dropeffect={isDragActive ? "move" : undefined}
      data-drop-target={highlightActive ? "true" : undefined}
      className={cn(
        // Columns fill the board canvas, so any surface tone above the base
        // read as a lighter "board background" than the rest of the console.
        // Consolidate to the app background itself — the border (not a fill)
        // carries the column boundary, matching the pipeline role cards and the
        // overview/graph views, all of which sit on --color-background.
        "flex h-full w-80 flex-shrink-0 flex-col overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.15rem))] border border-border/75 bg-background shadow-soft transition-[border-color,box-shadow,transform,background-color] duration-150",
        // Passive "drop zone available" treatment while any drag is in flight.
        // Subtler than the active target so the eye can quickly find where
        // the drop WILL land. No scaling/shadow changes here — we reserve
        // those for the active target.
        isDragActive && !highlightActive && "border-dashed border-border/80",
        // Active drop target: strong ring, bold primary border, tinted
        // background, lifted shadow. No scale transform — it would shift card
        // positions mid-drag and confuse the user about where their drop lands.
        highlightActive && [
          "border-primary",
          "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
          "shadow-glow",
          "bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-primary)_10%,var(--color-surface-1)_90%),color-mix(in_oklab,var(--color-primary)_4%,var(--color-surface-2)_78%))]",
        ],
      )}
    >
      <div
        ref={setActivatorNodeRef}
        {...sortableAttributes}
        {...sortableListeners}
        className={cn(!isFrozen && "cursor-grab active:cursor-grabbing")}
      >
        <ColumnHeader
          name={column.name}
          columnType={column.column_type}
          cardCount={column.cards.length}
          slug={slug}
          visibleCount={visibleCount}
          totalCount={totalCount}
          onRename={(name) => onRenameColumn(column.id, name)}
          onTypeChange={(newType: ColumnType | null) =>
            updateColumn.mutate({ columnId: column.id, column_type: newType })
          }
          onDelete={() => onDeleteColumn(column.id)}
          sortMode={sortMode}
          onSortChange={setSortMode}
          sortDisabled={boardSortActive}
          doneGateOverride={doneGateOverride}
        />
      </div>
      <ScrollArea ref={setNodeRef} className="min-h-0 flex-1 px-3 pb-3 pt-3">
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          <div
            ref={cardsRef}
            className={cn("flex flex-col", density === "compact" ? "gap-1.5" : "gap-3")}
          >
            {sortedCards.map((card) => (
              <div key={card.id} data-stagger-item data-card-id={card.id}>
                <KanbanCard
                  card={card}
                  boardId={boardId}
                  isFrozen={isFrozen}
                  density={density}
                  onClick={cardClickHandlers.get(card.id)!}
                />
              </div>
            ))}
            {sortedCards.length === 0 && column.cards.length > 0 ? (
              // Column has cards but filters hid them all — render a placeholder
              // so the column doesn't visually collapse and the user can see
              // their filters are doing something here.
              <div className="rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                {t("kanban.filterBar.noMatchesInColumn")}
              </div>
            ) : null}
          </div>
        </SortableContext>
      </ScrollArea>
      {!isFrozen ? (
        <div className="p-3 pt-0">
          <RichTooltip i18nKey="kanban.addCardButton" side="top" className="w-full">
            <Button
              variant="surface"
              size="sm"
              className="w-full justify-start"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-4 w-4" />
              {t("columns.addCard")}
            </Button>
          </RichTooltip>
        </div>
      ) : null}
      {createPortal(
        <CreateCardDialog
          slug={slug}
          boardId={boardId}
          columnId={column.id}
          columns={columns}
          existingCards={sortedCards}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />,
        document.body,
      )}
    </div>
  );
}
