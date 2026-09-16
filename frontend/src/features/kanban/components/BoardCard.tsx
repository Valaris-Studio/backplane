// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  CalendarPlus,
  Clock,
  Columns3,
  Snowflake,
  SquareStack,
} from "lucide-react";
import { MetaChip } from "@/components/shared/MetaChip";
import { WaveCard } from "@/features/visuals/components/WaveCard";
import { cn } from "@/lib/utils";
import { formatAbsolute, formatRelativeShort } from "@/lib/date-format";
import type { Board } from "@/types/kanban";
import type { BoardSortMode } from "../hooks/use-board-sort";
import {
  FROZEN_ACCENT_CLASS,
  FROZEN_BORDER_CLASS,
  FROZEN_HUE,
} from "../lib/frozen-theme";

const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// First two alphanumeric chars of the name, uppercased — same identity system
// as the workspace landing cards, so both grids read as one design.
function monogram(name: string): string {
  const cleaned = name.replace(/[^a-z0-9]/gi, "");
  return (cleaned.slice(0, 2) || "?").toUpperCase();
}

interface BoardCardProps {
  board: Board;
  workspaceSlug: string;
  /**
   * The grid's current sort mode. When it matches a field this card shows, that
   * field is highlighted so you can see *why* the grid is in its current order.
   */
  sortMode?: BoardSortMode;
}

export function BoardCard({ board, workspaceSlug, sortMode }: BoardCardProps) {
  const { t } = useTranslation();

  // Freshness reads last_activity_at (newest card/column edit) and falls back
  // to updated_at — the SAME key the grid sorts on, so the dot explains the
  // order instead of contradicting it.
  const activityStr = board.last_activity_at ?? board.updated_at;
  const activityTs = new Date(activityStr).getTime();
  const isActive =
    !Number.isNaN(activityTs) && Date.now() - activityTs <= ACTIVE_WINDOW_MS;
  const hasCardCount = board.card_count !== null && board.card_count !== undefined;
  const hasColumnCount =
    board.column_count !== null && board.column_count !== undefined;

  return (
    <Link
      to={`/${workspaceSlug}/boards/${board.slug ?? board.id}`}
      data-board-card
      className="block"
    >
      <WaveCard
        className={cn(
          "h-[7.25rem] w-full border-border/75 p-4 transition-all duration-200 hover:-translate-y-1 hover:border-primary/30 hover:shadow-panel focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
          board.is_frozen && FROZEN_BORDER_CLASS,
        )}
        contentClassName="justify-between"
        hue={board.is_frozen ? FROZEN_HUE : undefined}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-brand-200)_65%,transparent),color-mix(in_oklab,var(--color-brand-500)_26%,transparent))] text-xs font-semibold uppercase tracking-wide text-primary shadow-soft transition-shadow group-hover:shadow-glow">
            {monogram(board.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {board.name}
            </div>
            <div className="truncate text-xs text-muted-foreground/80">
              {board.description || `/${board.slug ?? board.id}`}
            </div>
          </div>
          {/* Frozen boards swap the freshness dot for the snow icon — the
              board's activity is moot while every mutation is blocked. The
              freshness dot is decorative (the activity chip carries the same
              signal as text) but labeled for SR users; both share the
              top-right slot with the hover arrow, fading as it fades in. */}
          {board.is_frozen ? (
            <Snowflake
              aria-label={t("kanban.frozen.badge")}
              className={cn(
                "mt-0.5 h-3.5 w-3.5 shrink-0 transition-opacity duration-200 group-hover:opacity-0",
                FROZEN_ACCENT_CLASS,
              )}
            />
          ) : (
            <span
              aria-label={isActive ? t("boards.statusActive") : t("boards.statusDormant")}
              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full transition-opacity duration-200 group-hover:opacity-0 ${
                isActive ? "bg-[color:var(--color-data-2)]" : "bg-muted-foreground/40"
              }`}
            />
          )}
        </div>

        {/* Counts (cards/columns) on the first row, timestamps on the second —
            each its own highlightable chip, mirroring WorkspaceCard. */}
        <div className="space-y-1 text-[0.7rem] tabular-nums">
          <div className="flex items-center gap-3">
            {hasCardCount && (
              <MetaChip
                field="cards"
                active={sortMode === "cards"}
                icon={SquareStack}
                testId="board-card-count"
              >
                {t("boards.cardCount", { count: board.card_count ?? 0 })}
              </MetaChip>
            )}
            {hasColumnCount && (
              <MetaChip
                field="columns"
                active={false}
                icon={Columns3}
                testId="board-column-count"
              >
                {t("boards.columnCount", { count: board.column_count ?? 0 })}
              </MetaChip>
            )}
          </div>
          <div className="flex items-center gap-3">
            <MetaChip
              field="activity"
              active={sortMode === "activity"}
              icon={Clock}
              testId="board-activity"
              ariaLabel={t("boards.activeAria", {
                date: formatAbsolute(activityStr),
              })}
            >
              {formatRelativeShort(activityStr)}
            </MetaChip>
            <MetaChip
              field="created"
              active={sortMode === "created"}
              icon={CalendarPlus}
              testId="board-created"
              ariaLabel={t("boards.createdAria", {
                date: formatAbsolute(board.created_at),
              })}
            >
              <span className="text-muted-foreground/50">
                {t("boards.createdLabel")}
              </span>
              <span className={cn(sortMode !== "created" && "text-muted-foreground/80")}>
                {formatRelativeShort(board.created_at)}
              </span>
            </MetaChip>
          </div>
        </div>

        {/* Pinned to the card corner, same as WorkspaceCard. */}
        <ArrowRight
          aria-hidden
          className="absolute -right-1 -top-1 h-4 w-4 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:transition-none"
        />
      </WaveCard>
    </Link>
  );
}
