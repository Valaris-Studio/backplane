// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Lock,
  Link2,
  MoreVertical,
  RotateCcw,
  Trash2,
  Unlink,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDeleteCard } from "../api/use-cards";
import { useBulkSetDependencies } from "../api/use-dependencies";
import { useOptimisticCardMove } from "../hooks/use-optimistic-card-move";
import {
  CARD_TYPE_TEXT,
  CARD_TYPE_TINT,
  PRIORITY_TEXT,
  PRIORITY_TINT,
} from "../utils/card-visuals";
import { priorityLabel } from "../utils/priority-label";
import {
  buildColumnDependencyForest,
  flattenForest,
} from "../utils/dependency-tree";
import { computeColumnMove } from "../utils/list-move";
import type { BoardDependencyEdge, Card, Column } from "@/types/kanban";

interface KanbanTableViewProps {
  columns: Column[];
  columnCounts: Record<string, { visible: number; total: number }>;
  onCardClick: (card: Card) => void;
  slug: string;
  boardId: string;
  /** Frozen board: row draggables are disabled and drag end is a no-op. */
  isFrozen?: boolean;
  /** When true, rows within each column nest by dependency (blockers first). */
  treeMode?: boolean;
  /** All board dependency edges — required for treeMode. */
  edges?: BoardDependencyEdge[];
}

// Table layout uses a fixed grid template so every group's rows align under one
// shared header. Every non-title track is a FIXED width (not `auto`): an auto
// last column sized to each row's own content — wide for the "Deps" header,
// narrow for a "—" cell — which shifted the flexible title column and knocked
// every header out of line with its data below it. Columns drop progressively
// at small breakpoints (the table also lives in an overflow-x-auto scroller as
// a final fallback): assignee and due date hide first. The trailing 3rem track
// is the per-row actions menu and is present at every breakpoint.
const GRID_COLS =
  "grid-cols-[minmax(0,1fr)_4rem_3rem] sm:grid-cols-[minmax(0,1fr)_5rem_5rem_4rem_3rem] lg:grid-cols-[minmax(0,1fr)_5rem_5rem_8rem_6rem_4rem_3rem]";

export function KanbanTableView({
  columns,
  columnCounts,
  onCardClick,
  slug,
  boardId,
  isFrozen = false,
  treeMode = false,
  edges = [],
}: KanbanTableViewProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const moveMutation = useOptimisticCardMove(slug, boardId);

  // A small activation distance keeps a plain click on a row firing the row's
  // onClick (open the sheet); only a 5px drag begins a column move. The sensor
  // is passed unconditionally: `useSensors` filters falsy entries INTERNALLY,
  // so a conditional null shortens the array, and the DndContext below (which
  // stays mounted across a freeze flip) spreads it into a hook dependency list
  // — React then errors that the final argument changed size between renders.
  // Frozen boards disable the row draggables instead.
  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 5 },
  });
  const sensors = useSensors(pointerSensor);

  // Title lookup spanning the whole board so cross-column dependent references
  // can render a name rather than a bare id.
  const cardTitleById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const col of columns) for (const c of col.cards) map.set(c.id, c.title);
    return map;
  }, [columns]);

  function handleDragStart(event: DragStartEvent) {
    setActiveCard((event.active.data.current as Card | undefined) ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveCard(null);
    if (isFrozen) return;
    const card = event.active.data.current as Card | undefined;
    const targetColumnId = event.over?.id as string | undefined;
    if (!card || !targetColumnId) return;
    const move = computeColumnMove(
      card.id,
      card.column_id,
      targetColumnId,
      columns,
    );
    if (move) moveMutation.mutate(move);
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveCard(null)}
    >
    <div className="flex-1 overflow-auto pb-4">
      <div className="min-w-[34rem] space-y-4">
        {columns.map((column) => {
          const isCollapsed = collapsed[column.id] === true;
          const count = columnCounts[column.id]?.visible ?? column.cards.length;
          return (
            <ColumnSection
              key={column.id}
              columnId={column.id}
              isDragActive={activeCard != null}
            >
              <button
                type="button"
                onClick={() =>
                  setCollapsed((prev) => ({ ...prev, [column.id]: !isCollapsed }))
                }
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
                )}
                <span className="text-sm font-semibold text-foreground">
                  {column.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("kanban.table.columnHeader", { count })}
                </span>
              </button>

              {!isCollapsed ? (
                <div role="table" aria-label={column.name}>
                  <div
                    role="row"
                    className={cn(
                      "grid items-center gap-3 border-b border-border/40 px-3 py-1.5 text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground",
                      GRID_COLS,
                    )}
                  >
                    <span role="columnheader">{t("kanban.table.headers.title")}</span>
                    <span role="columnheader" className="hidden sm:block">
                      {t("kanban.table.headers.type")}
                    </span>
                    <span role="columnheader" className="hidden sm:block">
                      {t("kanban.table.headers.priority")}
                    </span>
                    <span role="columnheader" className="hidden lg:block">
                      {t("kanban.table.headers.assignee")}
                    </span>
                    <span role="columnheader" className="hidden lg:block">
                      {t("kanban.table.headers.due")}
                    </span>
                    <span role="columnheader" className="justify-self-end">
                      {t("kanban.table.headers.dependencies")}
                    </span>
                    <span role="columnheader" aria-hidden />
                  </div>

                  {column.cards.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-muted-foreground">
                      {t("kanban.table.noCards")}
                    </p>
                  ) : treeMode ? (
                    flattenForest(
                      buildColumnDependencyForest(column.cards, edges, cardTitleById),
                    ).map((node) => (
                      <TableRow
                        // A multi-blocker card repeats across the forest; key on
                        // depth too so React keeps each occurrence as its own row.
                        key={`${node.card.id}:${node.depth}:${node.isRepeat ? "r" : ""}`}
                        card={node.card}
                        onClick={onCardClick}
                        slug={slug}
                        boardId={boardId}
                        depth={node.depth}
                        crossColumnDependents={node.crossColumnDependents}
                        isRepeat={node.isRepeat}
                        otherBlockerTitles={node.otherBlockerTitles}
                        isFrozen={isFrozen}
                      />
                    ))
                  ) : (
                    column.cards.map((card) => (
                      <TableRow
                        key={card.id}
                        card={card}
                        onClick={onCardClick}
                        slug={slug}
                        boardId={boardId}
                        isFrozen={isFrozen}
                      />
                    ))
                  )}
                </div>
              ) : null}
            </ColumnSection>
          );
        })}
      </div>
    </div>
    {createPortal(
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className="max-w-sm truncate rounded-md border border-border/70 bg-popover px-3 py-2 text-sm font-medium shadow-panel">
            {activeCard.title}
          </div>
        ) : null}
      </DragOverlay>,
      document.body,
    )}
    </DndContext>
  );
}

function ColumnSection({
  columnId,
  isDragActive,
  children,
}: {
  columnId: string;
  isDragActive: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId });
  return (
    <section
      ref={setNodeRef}
      className={cn(
        "overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-border/70 bg-card/50 shadow-soft transition-colors",
        isDragActive && isOver && "border-primary/60 bg-primary/5",
      )}
    >
      {children}
    </section>
  );
}

function TableRow({
  card,
  onClick,
  slug,
  boardId,
  depth = 0,
  crossColumnDependents = [],
  isRepeat = false,
  otherBlockerTitles = [],
  isFrozen = false,
}: {
  card: Card;
  onClick: (card: Card) => void;
  slug: string;
  boardId: string;
  depth?: number;
  crossColumnDependents?: { id: string; title: string | null }[];
  isRepeat?: boolean;
  otherBlockerTitles?: string[];
  isFrozen?: boolean;
}) {
  const { t } = useTranslation();
  const hero = card.participants?.find((p) => p.role === "hero");
  const isOverdue =
    card.due_date != null &&
    new Date(card.due_date) < new Date(new Date().toDateString());

  // A multi-blocker card renders multiple times in tree mode; suffix the
  // draggable id with depth so dnd-kit ids stay unique across occurrences.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${card.id}:${depth}`,
    data: card,
    disabled: isFrozen,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="row"
      tabIndex={0}
      onClick={() => onClick(card)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(card);
        }
      }}
      className={cn(
        "grid cursor-pointer items-center gap-3 border-b border-border/30 px-3 py-2 text-sm transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none",
        isDragging && "opacity-40",
        GRID_COLS,
      )}
    >
      <span
        role="cell"
        className="flex min-w-0 items-center font-medium text-foreground"
        title={card.title}
      >
        {/* Indentation + connector glyph express the blocker→dependent nesting.
            depth 0 = root blocker; deeper = cards that depend on it. */}
        {depth > 0 ? (
          <span
            aria-hidden
            className="flex shrink-0 items-center text-muted-foreground"
            style={{ paddingLeft: `${(depth - 1) * 1.1}rem` }}
          >
            <CornerDownRight className="mr-1 h-3.5 w-3.5" />
          </span>
        ) : null}
        <span className={cn("min-w-0 truncate", isRepeat && "text-muted-foreground")}>
          {card.title}
        </span>
        {isRepeat ? (
          <span
            className="ml-2 inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[0.6rem] text-muted-foreground"
            title={
              otherBlockerTitles.length > 0
                ? t("kanban.table.repeatTooltip", { blockers: otherBlockerTitles.join(", ") })
                : t("kanban.table.repeatTooltipGeneric")
            }
          >
            <RotateCcw className="h-2.5 w-2.5" aria-hidden />
            {t("kanban.table.repeatBadge")}
          </span>
        ) : null}
        {crossColumnDependents.length > 0 ? (
          <span
            className="ml-2 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[0.6rem] text-muted-foreground"
            title={t("kanban.table.crossColumnDeps", {
              count: crossColumnDependents.length,
            })}
          >
            ↗{crossColumnDependents.length}
          </span>
        ) : null}
      </span>

      <span role="cell" className="hidden min-w-0 sm:block">
        <Tag tint={CARD_TYPE_TINT[card.card_type]} className={CARD_TYPE_TEXT[card.card_type]}>
          {t(`cards.types.${card.card_type}`)}
        </Tag>
      </span>

      <span role="cell" className="hidden min-w-0 sm:block">
        <Tag tint={PRIORITY_TINT[card.priority]} className={PRIORITY_TEXT[card.priority]}>
          {priorityLabel(t, card.priority)}
        </Tag>
      </span>

      <span role="cell" className="hidden min-w-0 items-center gap-1.5 lg:flex">
        {hero ? (
          <>
            <Avatar className="h-6 w-6">
              {hero.user.avatar_url ? (
                <AvatarImage src={hero.user.avatar_url} alt={hero.user.name} />
              ) : null}
              <AvatarFallback className="text-[0.6rem]">
                {hero.user.name
                  .split(" ")
                  .map((part) => part[0])
                  .join("")
                  .toUpperCase()
                  .slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <span className="truncate text-xs text-muted-foreground">
              {hero.user.name || hero.user.email}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("kanban.table.unassigned")}
          </span>
        )}
      </span>

      <span
        role="cell"
        className={cn(
          "hidden text-xs text-muted-foreground lg:block",
          isOverdue && "text-destructive",
        )}
      >
        {card.due_date ? formatDate(card.due_date) : "—"}
      </span>

      <span role="cell" className="justify-self-end">
        <DependencyCell card={card} />
      </span>

      <span role="cell" className="justify-self-end">
        <RowActions card={card} slug={slug} boardId={boardId} />
      </span>
    </div>
  );
}

function RowActions({
  card,
  slug,
  boardId,
}: {
  card: Card;
  slug: string;
  boardId: string;
}) {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deleteCard = useDeleteCard(slug, boardId);
  const bulkSetDeps = useBulkSetDependencies(slug, boardId);
  const hasDeps = (card.depends_on_count ?? 0) > 0;

  // Row click opens the sheet; the menu trigger, items, and confirm dialog all
  // sit inside the row, so every interactive handler stops propagation to keep
  // the sheet from opening behind the menu.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div onClick={stop} onKeyDown={stop}>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("kanban.table.actions")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <MoreVertical className="h-4 w-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            aria-disabled={!hasDeps}
            className={cn(!hasDeps && "pointer-events-none opacity-50")}
            onClick={() => {
              if (hasDeps) {
                bulkSetDeps.mutate({ cardId: card.id, dependsOnCardIds: [] });
              }
            }}
          >
            <Unlink className="h-4 w-4" aria-hidden />
            {t("kanban.table.removeDependencies")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("kanban.table.deleteCard")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteCardConfirm
        open={confirmOpen}
        title={card.title}
        pending={deleteCard.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          deleteCard.mutate(card.id);
          setConfirmOpen(false);
        }}
      />
    </div>
  );
}

function DeleteCardConfirm({
  open,
  title,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("kanban.table.confirmDeleteTitle")}</DialogTitle>
          <DialogDescription>
            {t("kanban.table.confirmDeleteBody", { title: title ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? t("common.saving") : t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Tag({
  tint,
  className,
  children,
}: {
  tint: string;
  className: string;
  children: React.ReactNode;
}) {
  // The pill lives in a fixed-width grid track; `max-w-full min-w-0` lets it
  // shrink to the cell and the inner `truncate` clips a too-long label (ES
  // "Funcionalidad"/"Incidencia", or any term widened by the letter-tracking)
  // with an ellipsis instead of bleeding into the neighbouring column. `title`
  // keeps the full value reachable on hover.
  const label = typeof children === "string" ? children : undefined;
  return (
    <span
      title={label}
      className={cn(
        "inline-flex max-w-full min-w-0 select-none items-center rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em]",
        className,
      )}
      style={{
        background: `color-mix(in oklab, ${tint} 16%, transparent)`,
      }}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

function DependencyCell({ card }: { card: Card }) {
  const { t } = useTranslation();
  const status = card.dependency_status ?? "ready";
  if (status === "ready") return <span className="text-muted-foreground">—</span>;

  const depsCount = card.depends_on_count ?? 0;
  const blocksCount = card.blocks_count ?? 0;
  const parts: string[] = [];
  if (depsCount > 0) parts.push(`↓${depsCount}`);
  if (blocksCount > 0) parts.push(`↑${blocksCount}`);

  const isBlocked = status === "blocked";
  const tooltipKey = isBlocked
    ? "kanban.dependencies.stateBlocked"
    : "kanban.dependencies.stateUnblocked";
  const ariaKey = isBlocked
    ? "kanban.dependencies.chipAriaBlocked"
    : "kanban.dependencies.chipAriaUnblocked";

  return (
    <RichTooltip i18nKey={tooltipKey} side="top">
      <span
        role="status"
        aria-label={t(ariaKey, { count: depsCount })}
        className={cn(
          "inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[0.65rem] font-medium",
          isBlocked
            ? "border border-[color:var(--color-warning)]/30 bg-warning/15 text-[color:var(--color-warning-foreground)]"
            : "bg-success/10 text-[color:var(--color-success)]",
        )}
      >
        {isBlocked ? (
          <Lock className="h-3 w-3" aria-hidden />
        ) : (
          <Link2 className="h-3 w-3" aria-hidden />
        )}
        <span>{parts.join(" / ")}</span>
      </span>
    </RichTooltip>
  );
}
