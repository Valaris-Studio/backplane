// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { gsap } from "gsap";
import { useTranslation } from "react-i18next";
import { useParams, useSearchParams } from "react-router-dom";
import { Columns3, Plus, Snowflake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { AgentStatusBar } from "./AgentStatusBar";
import { BoardFilterBar } from "./BoardFilterBar";
import { CardDetailSheet } from "./CardDetailSheet";
import { CreateCardDialog } from "./CreateCardDialog";
import { CreateColumnDialog } from "./CreateColumnDialog";
import { DependencyValidationPanel } from "./DependencyValidationPanel";
import { KanbanCard, type CardDensity } from "./KanbanCard";
import { KanbanColumn } from "./KanbanColumn";
import { KanbanTableView } from "./KanbanTableView";
import { useBoard, useUnfreezeBoard } from "../api/use-boards";
import { useCardDetail } from "../api/use-card-detail";
import { useDeleteColumn, useUpdateColumn } from "../api/use-columns";
import {
  useBoardDependencies,
  useBoardDependencyValidation,
} from "../api/use-dependencies";
import { useBoardAgentIds } from "../hooks/use-board-agent-ids";
import { useBoardFilters } from "../hooks/use-board-filters";
import { useCreateCardHotkey } from "../hooks/use-create-card-hotkey";
import { DependencyHighlightProvider } from "../hooks/use-dependency-highlight";
import { useKanbanDnd } from "../hooks/use-kanban-dnd";
import { cn } from "@/lib/utils";
import { CARD_SEARCH_PARAM } from "../utils/card-link";
import { columnSortableId } from "../utils/column-sortable";
import { Skeleton } from "@/components/ui/skeleton";
import { slideIn, staggerChildren } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { Card, Column } from "@/types/kanban";
import { Badge } from "@/components/ui/badge";

// The overlay ghost is not clickable; a module constant keeps KanbanCard's
// memo boundary intact instead of handing it a fresh arrow each frame.
function noop() {}

// The drag-overlay "pick up": the card scales up and tilts into its carry
// angle while the shadow blooms, mirroring the shadow grammar of KanbanCard's
// drop-settle tween so lift → carry → settle read as one physical system.
// Exported for tests.
export function DragGhost({
  card,
  boardId,
  density = "comfortable",
}: {
  card: Card;
  boardId: string;
  density?: CardDensity;
}) {
  const reducedMotion = useReducedMotion();
  const ghostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ghostRef.current;
    if (!element || reducedMotion) return;
    // Only NUMBERS are tweened: gsap's complex-string interpolator would tween
    // every number inside a color-mix()/var() shadow string (including the 900
    // in the token name, emitting invalid CSS mid-tween) — so the deep shadow
    // lives on a static overlay whose opacity rides the --pickup-shadow var.
    const tween = gsap.fromTo(
      element,
      { scale: 1, rotate: 0, "--pickup-shadow": 0 },
      {
        scale: 1.04,
        rotate: 1.5,
        "--pickup-shadow": 1,
        duration: 0.18,
        ease: "power2.out",
      },
    );
    return () => { tween.kill(); };
  }, [reducedMotion]);

  return (
    // Static tilt fallback when the tween is skipped (reduced motion).
    <div ref={ghostRef} className={reducedMotion ? "w-80 rotate-1" : "relative w-80"}>
      {reducedMotion ? null : (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0",
            density === "compact"
              ? "rounded-[min(var(--radius-cap),var(--radius-md))]"
              : "rounded-[min(var(--radius-cap),calc(var(--radius-lg)+0.05rem))]",
          )}
          style={{
            boxShadow:
              "0 28px 48px -24px color-mix(in oklab, var(--color-brand-900) 55%, transparent)",
            opacity: "var(--pickup-shadow, 0)",
          }}
        />
      )}
      <KanbanCard card={card} boardId={boardId} density={density} onClick={noop} />
    </div>
  );
}

// Overlay ghost for column reorder: just the header strip (name + count),
// mirroring ColumnHeader's look. Deliberately NOT the full column — rendering
// the whole card list in the overlay would be heavy and visually noisy; the
// in-flow columns already animate to preview the new order.
function ColumnDragGhost({ column }: { column: Column }) {
  return (
    <div className="w-80 overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.15rem))] border border-primary/60 bg-background shadow-glow">
      <div className="flex items-center gap-1.5 border-b border-border/70 bg-card px-3 py-2">
        <span className="truncate text-sm font-semibold text-foreground">
          {column.name}
        </span>
        <Badge variant="outline">{column.cards.length}</Badge>
      </div>
    </div>
  );
}

// Shown whenever the board is frozen (columns view AND empty state). The only
// action is Unfreeze, and only the workspace OWNER gets it — freezing is an
// ownership-level control, so `role === "owner"` deliberately, not `isAdmin`
// (which collapses admin+owner). Cold blue-grey palette: same banner grammar
// as CostAlertBanner, but "frozen" reads cold, not amber-alarm.
function FrozenBanner({ slug, boardId }: { slug: string; boardId: string }) {
  const { t } = useTranslation();
  const { role, isLoading } = useWorkspaceAdmin(slug);
  const unfreezeMutation = useUnfreezeBoard(slug, boardId);
  const canUnfreeze = !isLoading && role === "owner";

  return (
    <div
      role="alert"
      className="rounded-[min(var(--radius-cap),var(--radius-lg))] border border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
        <Snowflake className="h-4 w-4 shrink-0" aria-hidden />
        <span className="font-medium">{t("kanban.frozen.bannerTitle")}</span>
        <span className="text-sky-800 dark:text-sky-200">
          {t("kanban.frozen.bannerBody")}
        </span>
        {canUnfreeze ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => unfreezeMutation.mutate()}
            disabled={unfreezeMutation.isPending}
          >
            {t("kanban.frozen.unfreeze")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function BoardView() {
  const { t } = useTranslation();
  const { slug = "", boardId = "" } = useParams();
  const { data: board, isLoading } = useBoard(slug, boardId);
  const boardAgentIds = useBoardAgentIds(slug, board?.id ?? boardId);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const cardParam = searchParams.get(CARD_SEARCH_PARAM);

  // URL → sheet: ?card=<id> is the shareable source of truth. It opens the
  // sheet on mount and on every param change (deep links, back/forward).
  // selectedCardId is deliberately NOT cleared when the param disappears so
  // the sheet keeps its content through the close animation. The sheet waits
  // for the board data, and a STALE param (deleted card, mispasted agent
  // reference) is stripped instead of stranding an empty sheet shell.
  useEffect(() => {
    if (!cardParam) {
      setSheetOpen(false);
      return;
    }
    if (!board) return;
    const exists = board.columns.some((column) =>
      column.cards.some((card) => card.id === cardParam),
    );
    if (exists) {
      setSelectedCardId(cardParam);
      setSheetOpen(true);
    } else {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete(CARD_SEARCH_PARAM);
          return next;
        },
        { replace: true },
      );
    }
  }, [cardParam, board, setSearchParams]);
  const selectedCard = useMemo<Card | null>(() => {
    if (!selectedCardId || !board) return null;
    for (const column of board.columns) {
      const hit = column.cards.find((c) => c.id === selectedCardId);
      if (hit) return hit;
    }
    return null;
  }, [selectedCardId, board]);
  // The board payload carries description EXCERPTS (summary mode), so the sheet
  // reads the one open card in full before handing it to the rich-text editor.
  const { card: hydratedCard, isDetailLoaded } = useCardDetail(
    slug,
    boardId,
    selectedCard,
    sheetOpen,
  );
  const [columnDialogOpen, setColumnDialogOpen] = useState(false);
  const [hotkeyCardDialogOpen, setHotkeyCardDialogOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const columnsRef = useRef<HTMLDivElement>(null);

  const updateColumn = useUpdateColumn(slug, boardId);
  const deleteColumn = useDeleteColumn(slug, boardId);

  const {
    filteredColumns,
    visibleCount,
    totalCount,
    boardSortActive,
    view,
    columnCounts,
    labelOptions,
    assigneeOptions,
  } = useBoardFilters({
    boardId,
    columns: board?.columns ?? [],
  });

  // Compact is the board layout at a smaller card size — same columns, same
  // dnd, same WS updates — so it flows through every board branch below.
  const density: CardDensity =
    view.viewMode === "compact" ? "compact" : "comfortable";

  // The dependency tree only renders in the table view under the dependency
  // sort. Fetch the edges lazily for exactly that case.
  const treeMode =
    view.viewMode === "list" && view.controls.sortId === "dependency";
  const { data: dependencyEdges } = useBoardDependencies(slug, boardId, treeMode);

  // Validation surfaces in the table view only. Don't fetch in the plain
  // board (grid) view.
  const validationEnabled = view.viewMode === "list";
  const { data: validation } = useBoardDependencyValidation(
    slug,
    boardId,
    validationEnabled,
  );

  const {
    sensors,
    collisionDetection,
    activeCard,
    activeColumn,
    overColumnId,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  } = useKanbanDnd(slug, boardId, board);

  // List view reads best sorted by dependency. Switch the still-default
  // `manual` sort to `dependency` on first entry; leave any deliberate user
  // choice untouched.
  useEffect(() => {
    if (view.viewMode === "list" && view.controls.sortId === "manual") {
      view.controls.setSortId("dependency");
    }
  }, [view.viewMode, view.controls]);

  useEffect(() => {
    if (isLoading || reducedMotion) return;
    // Cap the column entrance too: a board with many columns shouldn't slide
    // them in for seconds. First ~8 columns animate, the rest snap in.
    const tween = staggerChildren(
      columnsRef.current,
      "[data-stagger-item]",
      slideIn,
      { axis: "x", stagger: 0.05, duration: 0.22, offset: 18, maxStaggered: 8 },
    );
    // progress(1) BEFORE kill — a bare mid-flight kill strands columns at
    // autoAlpha 0 (same failure class as the card entrance, see KanbanColumn).
    return () => { tween?.progress(1).kill(); };
  }, [board?.columns.length, isLoading, reducedMotion]);

  // The `n` shortcut targets the board's leftmost column, NOT the leftmost
  // VISIBLE one: a filter that hides the first column shouldn't silently
  // retarget a shortcut whose tooltip promises "the leftmost column".
  const hotkeyTargetColumn = useMemo(() => {
    if (!board || board.columns.length === 0) return null;
    return [...board.columns].sort((a, b) => a.position - b.position)[0];
  }, [board]);

  // Matches the add-card button's own availability: it is REMOVED on a frozen
  // board, so the keyboard must not offer the mutation either.
  const openHotkeyCardDialog = useCallback(() => setHotkeyCardDialogOpen(true), []);
  useCreateCardHotkey(
    hotkeyTargetColumn !== null && board?.is_frozen !== true,
    openHotkeyCardDialog,
  );

  // Sheet → URL: opening pushes ?card=<id> (back button closes the sheet),
  // closing strips it with replace so dismissals don't pile up in history.
  // Declared above the early returns (and memoized) because KanbanColumn hands
  // these straight to KanbanCard's memo boundary — a fresh identity per render
  // would re-render every card on the board.
  const focusCardById = useCallback(
    (cardId: string) => {
      setSelectedCardId(cardId);
      setSheetOpen(true);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(CARD_SEARCH_PARAM, cardId);
        return next;
      });
    },
    [setSearchParams],
  );

  const handleCardClick = useCallback(
    (card: Card) => focusCardById(card.id),
    [focusCardById],
  );

  const handleSheetOpenChange = useCallback(
    (open: boolean) => {
      setSheetOpen(open);
      if (!open) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.delete(CARD_SEARCH_PARAM);
            return next;
          },
          { replace: true },
        );
      }
    },
    [setSearchParams],
  );

  const handleRenameColumn = useCallback(
    (columnId: string, name: string) => updateColumn.mutate({ columnId, name }),
    [updateColumn],
  );

  const handleDeleteColumn = useCallback(
    (columnId: string) => deleteColumn.mutate(columnId),
    [deleteColumn],
  );

  // Sorting in the render body handed every column a new array identity on each
  // of dnd-kit's per-pointer-move re-renders.
  const sortedColumns = useMemo(
    () => [...filteredColumns].sort((a, b) => a.position - b.position),
    [filteredColumns],
  );

  if (isLoading) {
    return (
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton
            key={index}
            className="h-[36rem] w-80 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]"
          />
        ))}
      </div>
    );
  }

  if (!board) {
    return <p className="text-muted-foreground">{t("boards.notFound")}</p>;
  }

  const isFrozen = board.is_frozen === true;

  return (
    // data-frozen is the CSS hook for the frozen card treatment (see index.css).
    <div
      data-frozen={isFrozen ? "true" : undefined}
      className="flex h-full min-h-0 flex-col gap-3"
    >
      {/* AgentStatusBar filters in-flight executions by comparing their UUID
          board_id against this prop — unlike the route/CRUD endpoints below
          (which resolve a slug server-side), that's a client-side string
          comparison, so it needs the board's canonical id, not the raw
          route param.
          boardAgentIds scopes the badges to this board's runners: the
          workspace metrics list the bar reads has no board axis of its own. */}
      <AgentStatusBar
        slug={slug}
        boardId={board.id}
        boardAgentIds={boardAgentIds}
      />
      {isFrozen ? <FrozenBanner slug={slug} boardId={boardId} /> : null}
      <BoardFilterBar
        controls={view.controls}
        visibleCount={visibleCount}
        totalCount={totalCount}
        labelOptions={labelOptions}
        assigneeOptions={assigneeOptions}
        viewMode={view.viewMode}
        onViewModeChange={view.setViewMode}
      />
      {validationEnabled ? (
        <DependencyValidationPanel
          validation={validation}
          onFocusCard={focusCardById}
        />
      ) : null}
      <DependencyHighlightProvider slug={slug} boardId={boardId}>
      {view.viewMode === "list" ? (
        <KanbanTableView
          columns={sortedColumns}
          columnCounts={columnCounts}
          onCardClick={handleCardClick}
          slug={slug}
          boardId={boardId}
          isFrozen={isFrozen}
          treeMode={treeMode}
          edges={dependencyEdges ?? []}
        />
      ) : board.columns.length === 0 ? (
        // A board starts with no columns, and the bare drag surface gives a
        // first-time user nothing to act on — name the next step instead.
        <div
          data-testid="board-empty-state"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border/60 px-6 py-12 text-center"
        >
          <Columns3 className="h-8 w-8 text-muted-foreground/70" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              {t("kanban.emptyBoard.title")}
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("kanban.emptyBoard.description")}
            </p>
          </div>
          {!isFrozen ? (
            <Button
              type="button"
              size="sm"
              className="gap-2"
              onClick={() => setColumnDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
              {t("kanban.emptyBoard.action")}
            </Button>
          ) : null}
        </div>
      ) : (
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          ref={columnsRef}
          className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-4"
        >
          <SortableContext
            items={sortedColumns.map((column) => columnSortableId(column.id))}
            strategy={horizontalListSortingStrategy}
          >
          {sortedColumns.map((column) => (
            <div key={column.id} data-stagger-item className="flex min-h-0">
              <KanbanColumn
                column={column}
                columns={board.columns}
                slug={slug}
                boardId={boardId}
                onRenameColumn={handleRenameColumn}
                onDeleteColumn={handleDeleteColumn}
                onCardClick={handleCardClick}
                isFrozen={isFrozen}
                isDropTarget={overColumnId === column.id}
                isDragActive={activeCard != null}
                boardSortActive={boardSortActive}
                density={density}
                doneGateOverride={board.enforce_done_merge_gate}
                visibleCount={columnCounts[column.id]?.visible ?? 0}
                totalCount={columnCounts[column.id]?.total ?? 0}
              />
            </div>
          ))}
          </SortableContext>
          {!isFrozen ? (
            <button
              type="button"
              onClick={() => setColumnDialogOpen(true)}
              className="flex h-40 w-80 flex-shrink-0 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/60 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
              {t("columns.createTitle")}
            </button>
          ) : null}
        </div>
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {activeCard ? (
              <DragGhost card={activeCard} boardId={boardId} density={density} />
            ) : activeColumn ? (
              <ColumnDragGhost column={activeColumn} />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      )}
      </DependencyHighlightProvider>
      <CardDetailSheet
        card={hydratedCard}
        columns={board.columns}
        slug={slug}
        boardId={boardId}
        open={sheetOpen}
        onOpenChange={handleSheetOpenChange}
        onOpenCard={focusCardById}
        isFrozen={isFrozen}
        isDetailLoaded={isDetailLoaded}
      />
      <CreateColumnDialog
        slug={slug}
        boardId={boardId}
        existingColumns={sortedColumns}
        open={columnDialogOpen}
        onOpenChange={setColumnDialogOpen}
      />
      {/* The `n` shortcut's own dialog instance. Each KanbanColumn owns one for
          its own add-card button; reaching into the first column's private
          state just to open it from here would be a longer wire for the same
          dialog. Mounted only while open so the board isn't carrying a second
          card form on every render. */}
      {hotkeyTargetColumn && hotkeyCardDialogOpen ? (
        <CreateCardDialog
          slug={slug}
          boardId={boardId}
          columnId={hotkeyTargetColumn.id}
          columns={board.columns}
          existingCards={hotkeyTargetColumn.cards}
          open={hotkeyCardDialogOpen}
          onOpenChange={setHotkeyCardDialogOpen}
        />
      ) : null}
    </div>
  );
}
