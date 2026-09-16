// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { gsap } from "gsap";
import { AlertTriangle, Bot, Calendar, Check, Flag, Hash, Link2, Lock, MoreVertical, PauseCircle, Trash2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Marquee } from "@/components/ui/marquee";
import { useDeleteCard, useUpdateCard } from "../api/use-cards";
import { useDependencyHighlight } from "../hooks/use-dependency-highlight";
import {
  CARD_TYPE_TEXT,
  CARD_TYPE_TINT,
  PRIORITY_TEXT,
  PRIORITY_TINT,
} from "../utils/card-visuals";
import { priorityLabel } from "../utils/priority-label";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useCardHasSkippedExecution } from "@/features/agents/hooks/useAgentMetrics";
import { buildCardLink } from "../utils/card-link";
import { extractPlainText } from "@/lib/text-utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Card as CardType, Priority } from "@/types/kanban";

const PRIORITY_OPTIONS: Priority[] = ["urgent", "high", "medium", "low"];

// Priorities quiet enough to say nothing: on a dense board a dot per card is
// noise, so only medium and above earn one. Silence is information — a calm
// board should look calm.
const SILENT_PRIORITIES: Priority[] = ["none", "low"];

// Compact rows carry the same signals as the full card, but each glyph costs
// vertical space it doesn't have — so nothing renders unless it's active.
export type CardDensity = "comfortable" | "compact";

interface Props {
  card: CardType;
  boardId: string;
  onClick: () => void;
  // Frozen board: the card's drag is disabled at the draggable. The sensor
  // list stays constant (see use-kanban-dnd), so this is what actually stops
  // a drag from activating.
  isFrozen?: boolean;
  // A rendering variant, NOT a separate component: keeping it inside the card
  // means `useSortable`, the memo boundary and the stagger contract are shared
  // by both densities. A string literal keeps the prop memo-stable.
  density?: CardDensity;
}

function isOverdue(dueDate: string | null | undefined): boolean {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date(new Date().toDateString());
}

function KanbanCardImpl({
  card,
  boardId,
  onClick,
  isFrozen = false,
  density = "comfortable",
}: Props) {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  const hasSkipped = useCardHasSkippedExecution(slug, card.id);
  const deleteCard = useDeleteCard(slug, boardId);
  const updateCard = useUpdateCard(slug, boardId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const reducedMotion = useReducedMotion();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const wasDragging = useRef(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isSorting,
  } = useSortable({
    id: card.id,
    data: { type: "card", ...card },
    disabled: isFrozen,
  });

  useEffect(() => {
    const element = cardRef.current;
    if (!element || reducedMotion) return;

    if (isDragging) {
      wasDragging.current = true;
      return;
    }

    if (wasDragging.current) {
      wasDragging.current = false;
      const tween = gsap.fromTo(
        element,
        { boxShadow: "0 24px 40px -28px color-mix(in oklab, var(--color-brand-900) 48%, transparent)" },
        {
          boxShadow: "var(--shadow-soft)",
          duration: 0.26,
          ease: "back.out(1.4)",
        },
      );
      return () => { tween.kill(); };
    }
  }, [isDragging, reducedMotion]);

  const style = {
    transform: CSS.Translate.toString(transform) ?? undefined,
    transition: isDragging ? "none" : transition,
  };

  function setRefs(node: HTMLDivElement | null) {
    cardRef.current = node;
    setNodeRef(node);
  }

  function stopDragHandlers(e: React.PointerEvent | React.MouseEvent) {
    e.stopPropagation();
  }

  function copyCardLink() {
    const url = `${window.location.origin}${buildCardLink({ slug, boardId, cardId: card.id })}`;
    void copyTextToClipboard(url).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    });
  }

  function copyCardId() {
    void copyTextToClipboard(card.id).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setIdCopied(true);
      window.setTimeout(() => setIdCopied(false), 1500);
    });
  }

  // A runner is executing a pipeline stage against this card RIGHT NOW
  // (agent_presence='active', backed by an in-flight execution bound to the
  // card). Surfaced on the card body — not just the robot icon — so the card
  // being worked stands out in a dense column.
  const isAgentActive = (card.agent_presence ?? "none") === "active";

  const dependencyStatus = card.dependency_status ?? "ready";
  const hasDependencies =
    (card.depends_on_count ?? 0) > 0 || (card.blocks_count ?? 0) > 0;

  const { highlightedIds, setHoveredCard } = useDependencyHighlight();
  const isLinkHighlighted = highlightedIds.has(card.id);

  const descriptionText =
    density === "compact" || !card.description
      ? ""
      : extractPlainText(card.description);

  if (density === "compact") {
    return (
      <div
        ref={setRefs}
        style={style}
        data-card-root
        data-density="compact"
        data-agent-active={isAgentActive ? "true" : undefined}
        data-overdue={isOverdue(card.due_date) ? "true" : undefined}
        {...attributes}
        {...listeners}
        title={card.title}
        className={cn(
          "group relative flex h-8 cursor-grab items-center gap-2 overflow-hidden rounded-[min(var(--radius-cap),var(--radius-md))] border border-border/75 bg-card/92 pr-2 shadow-soft hover:border-primary/25 active:cursor-grabbing",
          isSorting
            ? "transition-none"
            : "transition-[box-shadow,border-color,background-color,opacity] duration-200",
          isDragging && "z-50 opacity-0",
          isAgentActive && "border-primary/60 shadow-[0_0_0_1px_var(--color-primary)]",
          // Urgency is the only whole-row tint, so it stays the loudest signal
          // on a dense board.
          isOverdue(card.due_date) &&
            "bg-[color:color-mix(in_oklab,var(--color-destructive)_8%,var(--color-card))]",
          isLinkHighlighted && "border-primary/70",
        )}
        onClick={onClick}
        onMouseEnter={() => setHoveredCard(card.id, hasDependencies)}
        onMouseLeave={() => setHoveredCard(null, false)}
      >
        <span
          aria-hidden
          data-compact-type-bar
          className="h-full w-[3px] shrink-0"
          style={{
            background: `color-mix(in oklab, ${CARD_TYPE_TINT[card.card_type]} 80%, transparent)`,
          }}
        />

        {SILENT_PRIORITIES.includes(card.priority) ? null : (
          <span
            aria-hidden
            data-compact-priority-dot
            title={priorityLabel(t, card.priority)}
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: PRIORITY_TINT[card.priority] }}
          />
        )}

        <span className="min-w-0 flex-1 truncate text-xs font-medium leading-none text-foreground">
          {card.title}
        </span>

        <span className="flex shrink-0 items-center gap-1.5">
          {isAgentActive ? (
            <Link
              to={
                card.active_execution_id
                  ? `/${slug}/runner/executions/${card.active_execution_id}`
                  : `/${slug}/runner/overview`
              }
              aria-label={t("cards.agentPresence.activeAria")}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center"
            >
              <Bot className="h-3 w-3 animate-pulse text-primary" />
            </Link>
          ) : null}
          {card.has_pending_approval ? (
            <AlertTriangle
              data-compact-approval
              aria-label={t("cards.awaitingApproval")}
              className="h-3 w-3 text-[color:var(--color-warning)]"
            />
          ) : null}
          {dependencyStatus === "blocked" ? (
            <Lock
              data-compact-dependency
              aria-label={t("kanban.dependencies.chipAriaBlocked", {
                count: card.depends_on_count ?? 0,
              })}
              className="h-3 w-3 text-[color:var(--color-warning)]"
            />
          ) : null}
          {card.due_date ? (
            <span
              data-compact-due
              className={cn(
                "text-[0.65rem] tabular-nums text-muted-foreground",
                isOverdue(card.due_date) && "text-destructive",
              )}
            >
              {formatDate(card.due_date, { month: "short", day: "numeric" })}
            </span>
          ) : null}
          <CompactParticipants card={card} />
        </span>
      </div>
    );
  }

  return (
    <>
    <div
      ref={setRefs}
      style={style}
      data-card-root
      data-agent-active={isAgentActive ? "true" : undefined}
      {...attributes}
      {...listeners}
      className={cn(
        "group relative cursor-grab overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-lg)+0.05rem))] border border-border/75 bg-card/92 pt-7 pb-4 px-4 shadow-soft hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-panel active:cursor-grabbing",
        // Paint-heavy properties (box-shadow, border-color, background-color)
        // transition at rest and on hover, but a board-wide drag displaces
        // every sibling card every frame — transitioning them then costs a
        // full repaint per card per frame. `isSorting` is the board-wide drag
        // signal (not just this card's), so the whole column drops to
        // untransitioned transforms for the duration and snaps back after.
        isSorting
          ? "transition-none"
          : "transition-[transform,box-shadow,border-color,background-color,opacity] duration-200",
        isDragging && "z-50 opacity-0",
        // Actively-worked: a primary ring + soft glow so the card a runner is
        // executing against reads at a glance. Ring (not border-width) keeps the
        // box size stable; the tint is subtle so it doesn't fight card content.
        isAgentActive &&
          "border-primary/60 shadow-[0_0_0_1px_var(--color-primary),0_8px_24px_-12px_color-mix(in_oklab,var(--color-primary)_55%,transparent)] bg-[color:color-mix(in_oklab,var(--color-primary)_5%,var(--color-card))]",
        // Subtle left-edge accent when this card is waiting on others.
        // Spec: "blocked" only — unblocked cards do NOT get the accent.
        dependencyStatus === "blocked" && "border-l-2 border-l-[color:var(--color-warning)]",
        // Highlight every card linked to the one currently hovered (the hover
        // source resolves the link set; see use-dependency-highlight). Border
        // COLOR only — no ring/offset: a ring paints an outset outline that
        // reads as the card growing/shifting. Border width stays 1px so the box
        // never changes size.
        isLinkHighlighted && "border-primary/70",
      )}
      onClick={onClick}
      onMouseEnter={() => setHoveredCard(card.id, hasDependencies)}
      onMouseLeave={() => setHoveredCard(null, false)}
    >
      {/* Top-left: card type tag. Direct child of the card so `absolute`
          anchors to the card's `relative` box. (Wrapping in RichTooltip
          breaks this — RichTooltip's own `relative inline-flex` wrapper
          becomes the offset parent and the corner falls into the layout
          flow, pushing the title aside.) Color + uppercase text are
          self-evident; tooltip omitted by design. */}
      <span
        aria-label={t(`cards.types.${card.card_type}`)}
        title={t(`cards.types.${card.card_type}`)}
        className={cn(
          "pointer-events-none absolute left-0 top-0 z-[1] select-none rounded-tl-[min(var(--radius-cap),calc(var(--radius-lg)+0.05rem))] px-2.5 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.16em]",
          CARD_TYPE_TEXT[card.card_type],
        )}
        style={{
          background: `linear-gradient(135deg, color-mix(in oklab, ${CARD_TYPE_TINT[card.card_type]} 22%, transparent) 0%, color-mix(in oklab, ${CARD_TYPE_TINT[card.card_type]} 14%, transparent) 55%, transparent 100%)`,
        }}
      >
        {t(`cards.types.${card.card_type}`)}
      </span>

      {/* Top-right: priority tag, mirror of the type corner. */}
      <span
        aria-label={priorityLabel(t, card.priority)}
        title={priorityLabel(t, card.priority)}
        className={cn(
          "pointer-events-none absolute right-0 top-0 z-[1] select-none rounded-tr-[min(var(--radius-cap),calc(var(--radius-lg)+0.05rem))] px-2.5 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.16em]",
          PRIORITY_TEXT[card.priority],
        )}
        style={{
          background: `linear-gradient(225deg, color-mix(in oklab, ${PRIORITY_TINT[card.priority]} 22%, transparent) 0%, color-mix(in oklab, ${PRIORITY_TINT[card.priority]} 14%, transparent) 55%, transparent 100%)`,
        }}
      >
        {priorityLabel(t, card.priority)}
      </span>

      {/* Kebab menu — absolute so it doesn't disturb the existing flex layout.
          Offset below the priority corner tag (top-0, ~1.75rem tall) so the two
          never overlap when the menu fades in on hover. Stops drag/click
          propagation so the card neither drags nor opens the detail sheet when
          the menu is interacted with. */}
      <div
        className="absolute right-2 top-9 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        onPointerDown={stopDragHandlers}
        onMouseDown={stopDragHandlers}
        onClick={stopDragHandlers}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("cards.actions.more")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Body lives in its own component so its ~10 t()/priorityLabel
                calls and the PRIORITY_OPTIONS map run only when the menu is
                actually open — DropdownMenuContent returns null when closed,
                but inline JSX would still be built on every card render. */}
            <CardMenuBody
              card={card}
              linkCopied={linkCopied}
              idCopied={idCopied}
              onCopyLink={copyCardLink}
              onCopyId={copyCardId}
              onChangePriority={(priority) =>
                updateCard.mutate({ cardId: card.id, priority })
              }
              onRequestDelete={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            {card.has_pending_approval ? (
              <Badge variant="warning" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                {t("cards.awaitingApproval")}
              </Badge>
            ) : null}

            <p className="text-sm font-semibold leading-6 text-foreground [overflow-wrap:anywhere]">
              {card.title}
            </p>

            {descriptionText ? (
              <Marquee
                text={descriptionText}
                revealOnHover
                fadeFrom="from-card/92"
              />
            ) : null}

            {(card.due_date || dependencyStatus !== "ready" || (card.labels && card.labels.length > 0)) ? (
              <div className="space-y-2">
                {(card.due_date || dependencyStatus !== "ready") ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {card.due_date ? (
                      <RichTooltip i18nKey="kanban.dueDate" side="top">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 text-xs text-muted-foreground",
                            new Date(card.due_date) < new Date(new Date().toDateString()) && "text-destructive",
                          )}
                        >
                          <Calendar className="h-3 w-3" />
                          {formatDate(card.due_date)}
                        </span>
                      </RichTooltip>
                    ) : null}
                    {dependencyStatus !== "ready" ? (
                      <DependencyChip card={card} />
                    ) : null}
                  </div>
                ) : null}
                {card.labels && card.labels.length > 0 ? (
                  // RichTooltip's `inline-flex` wrapper breaks `flex-wrap` here
                  // (children can't wrap because the wrapper shrinks to the
                  // unwrapped width). Each label has its own text already; the
                  // generic "what are labels" tooltip wasn't carrying its weight.
                  <div className="flex flex-wrap gap-1">
                    {card.labels.map((label) =>
                      // Stuck-loop park label — warning treatment so it never
                      // blends in with ordinary muted pills.
                      label === "needs-advisor" ? (
                        <span
                          key={label}
                          data-testid="needs-advisor-pill"
                          className="rounded-full border border-warning/30 bg-warning/5 px-2 py-0.5 text-[0.65rem] text-warning"
                        >
                          {label}
                        </span>
                      ) : (
                        <span
                          key={label}
                          className="rounded-full bg-muted px-2 py-0.5 text-[0.65rem] text-muted-foreground"
                        >
                          {label}
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {(() => {
            const hero = card.participants?.find((p) => p.role === "hero");
            const otherCount = (card.participants?.length ?? 0) - (hero ? 1 : 0);
            const presence = card.agent_presence ?? "none";
            const presenceVisible = presence !== "none";
            if (!hero && !presenceVisible && !hasSkipped) return null;
            return (
              // Reserve the kebab's slot permanently (mr-7) so the cluster
              // never shifts when the kebab fades in on hover. Animating the
              // margin on hover moved the avatars and made the card feel like it
              // resized; a constant gap keeps the layout perfectly stable.
              <div className="flex items-center gap-1.5 mr-7">
                {hasSkipped && (
                  <RichTooltip i18nKey="kanban.skippedExecution" side="top">
                    <PauseCircle className="h-3.5 w-3.5 text-[color:var(--color-warning)]" />
                  </RichTooltip>
                )}
                {presenceVisible && (
                  <AgentPresenceIndicator card={card} slug={slug} />
                )}
                {hero ? (
                  <>
                    <Avatar className="h-8 w-8">
                      {hero.user.avatar_url ? (
                        <AvatarImage src={hero.user.avatar_url} alt={hero.user.name} />
                      ) : null}
                      <AvatarFallback>
                        {hero.user.name
                          .split(" ")
                          .map((part) => part[0])
                          .join("")
                          .toUpperCase()
                          .slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                    {otherCount > 0 ? (
                      <span className="text-xs text-muted-foreground">+{otherCount}</span>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })()}
        </div>
      </div>
    </div>

    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("cards.delete.confirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("cards.delete.confirmBody", { title: card.title })}
          </DialogDescription>
        </DialogHeader>
        {deleteError ? (
          <p role="alert" className="text-sm text-destructive">{deleteError}</p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setConfirmDelete(false)}
            disabled={deleteCard.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setDeleteError(null);
              deleteCard.mutate(card.id, {
                onSuccess: () => setConfirmDelete(false),
                onError: () => setDeleteError(t("cards.delete.error")),
              });
            }}
            disabled={deleteCard.isPending}
          >
            {deleteCard.isPending ? t("common.saving") : t("cards.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

// One avatar carries "who holds this"; everyone else collapses into +N. The
// hero comes first when there is one, matching the comfortable card's cluster.
function CompactParticipants({ card }: { card: CardType }) {
  const participants = card.participants ?? [];
  const holder = participants.find((p) => p.role === "hero") ?? participants[0];
  if (!holder) return null;
  const overflow = participants.length - 1;

  return (
    <span className="flex shrink-0 items-center gap-1">
      <Avatar data-compact-avatar className="h-4 w-4" title={holder.user.name}>
        {holder.user.avatar_url ? (
          <AvatarImage src={holder.user.avatar_url} alt={holder.user.name} />
        ) : null}
        <AvatarFallback className="text-[0.5rem]">
          {holder.user.name
            .split(" ")
            .map((part) => part[0])
            .join("")
            .toUpperCase()
            .slice(0, 2)}
        </AvatarFallback>
      </Avatar>
      {overflow > 0 ? (
        <span className="text-[0.6rem] tabular-nums text-muted-foreground">
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

function CardMenuBody({
  card,
  linkCopied,
  idCopied,
  onCopyLink,
  onCopyId,
  onChangePriority,
  onRequestDelete,
}: {
  card: CardType;
  linkCopied: boolean;
  idCopied: boolean;
  onCopyLink: () => void;
  onCopyId: () => void;
  onChangePriority: (priority: Priority) => void;
  onRequestDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem onClick={onCopyLink} closeOnClick={false}>
        {linkCopied ? (
          <Check className="mr-2 h-4 w-4 text-[color:var(--color-success)]" />
        ) : (
          <Link2 className="mr-2 h-4 w-4" />
        )}
        {linkCopied ? t("cards.actions.linkCopied") : t("cards.actions.copyLink")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onCopyId} closeOnClick={false}>
        {idCopied ? (
          <Check className="mr-2 h-4 w-4 text-[color:var(--color-success)]" />
        ) : (
          <Hash className="mr-2 h-4 w-4" />
        )}
        {idCopied ? t("cards.actions.idCopied") : t("cards.actions.copyId")}
      </DropdownMenuItem>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>
        <span className="inline-flex items-center gap-1.5">
          <Flag className="h-3 w-3" />
          {t("cards.actions.changePriority")}
        </span>
      </DropdownMenuLabel>
      {PRIORITY_OPTIONS.map((priority) => (
        <DropdownMenuItem
          key={priority}
          onClick={() => {
            if (priority !== card.priority) onChangePriority(priority);
          }}
          className={cn(priority === card.priority && "bg-accent/60")}
        >
          <span
            aria-hidden
            className="mr-2 h-2.5 w-2.5 rounded-full"
            style={{ background: PRIORITY_TINT[priority] }}
          />
          {priorityLabel(t, priority)}
          {priority === card.priority ? (
            <Check className="ml-auto h-4 w-4 text-muted-foreground" />
          ) : null}
        </DropdownMenuItem>
      ))}

      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={onRequestDelete}
        className="text-destructive focus:text-destructive"
      >
        <Trash2 className="mr-2 h-4 w-4" />
        {t("cards.actions.delete")}
      </DropdownMenuItem>
    </>
  );
}

// The memoization boundary that keeps a drag cheap: dnd-kit's DndContext and
// SortableContext values change on EVERY pointer move, so without this every
// mounted card re-renders per frame and the cost scales with board size. Its
// correctness rests entirely on prop identity — `card` comes straight from the
// query cache (new object only when the card actually changed) and `onClick`
// must be a stable per-card callback (see KanbanColumn's handler map). An
// inline arrow at any callsite silently disables it.
// `useSortable` lives INSIDE the card, so cards whose own sortable state
// changes still re-render and displacement animation is unaffected.
export const KanbanCard = memo(KanbanCardImpl);

// Board-view dependency chip. Counts + status come inline on CardRead
// (see backend `attach_dependency_counts`) so this renders without any
// per-card fetch. Hidden when `dependency_status === "ready"`. The full
// bidirectional list (titles, links, removal) lives in CardDetailSheet.
function DependencyChip({ card }: { card: CardType }) {
  const { t } = useTranslation();
  const status = card.dependency_status ?? "ready";
  if (status === "ready") return null;

  const depsCount = card.depends_on_count ?? 0;
  const blocksCount = card.blocks_count ?? 0;

  const counterParts: string[] = [];
  if (depsCount > 0) counterParts.push(`↓${depsCount}`);
  if (blocksCount > 0) counterParts.push(`↑${blocksCount}`);
  const counter = counterParts.join(" / ");

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
        <span>{counter}</span>
      </span>
    </RichTooltip>
  );
}

// Presence-aware robot indicator. State is derived server-side (see backend
// `attach_agent_presence`) so the frontend only chooses the visual treatment.
// - eligible: muted robot, "A runner can work this card" tooltip.
// - touched: muted robot with a small dot overlay + relative timestamp.
// - active:  pulsing primary-tinted robot, links to execution detail.
function AgentPresenceIndicator({
  card,
  slug,
}: {
  card: CardType;
  slug: string;
}) {
  const { t } = useTranslation();
  const presence = card.agent_presence ?? "none";
  if (presence === "none") return null;

  if (presence === "active") {
    const href = card.active_execution_id
      ? `/${slug}/runner/executions/${card.active_execution_id}`
      : `/${slug}/runner/overview`;
    return (
      <RichTooltip i18nKey="kanban.runnerBadge.active" side="top">
        <Link
          to={href}
          aria-label={t("cards.agentPresence.activeAria")}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center"
        >
          <Bot className="h-3.5 w-3.5 animate-pulse text-primary" />
          <span className="sr-only">{t("cards.agentPresence.active")}</span>
        </Link>
      </RichTooltip>
    );
  }

  if (presence === "touched") {
    const when = card.last_agent_activity_at
      ? formatDateTime(card.last_agent_activity_at)
      : "";
    return (
      <RichTooltip
        i18nKey="kanban.runnerBadge.touched"
        summary={t("ui.tooltips.kanban.runnerBadge.touched.summary", { when })}
        side="top"
      >
        <span className="relative inline-flex">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/70 ring-1 ring-background"
          />
        </span>
      </RichTooltip>
    );
  }

  if (presence === "suspended") {
    // Parked mid-implementation (budget ceiling). Amber-tinted robot with a
    // pause overlay — distinct from the grey `touched` dot and the pulsing
    // primary `active`. Reads as "paused, not working" at a glance.
    return (
      <RichTooltip i18nKey="kanban.runnerBadge.suspended" side="top">
        <span className="relative inline-flex">
          <Bot className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" />
          <PauseCircle
            aria-hidden
            className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-background text-amber-600 dark:text-amber-500"
          />
          <span className="sr-only">{t("cards.agentPresence.suspended")}</span>
        </span>
      </RichTooltip>
    );
  }

  // eligible
  return (
    <RichTooltip i18nKey="kanban.runnerBadge.eligible" side="top">
      <Bot className="h-3.5 w-3.5 text-muted-foreground/70" />
    </RichTooltip>
  );
}
