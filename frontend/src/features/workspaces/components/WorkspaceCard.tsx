// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  CalendarPlus,
  Clock,
  LayoutGrid,
  SquareStack,
} from "lucide-react";
import { MetaChip } from "@/components/shared/MetaChip";
import { WaveCard } from "@/features/visuals/components/WaveCard";
import { cn } from "@/lib/utils";
import { formatAbsolute, formatRelativeShort } from "@/lib/date-format";
import type { Workspace } from "@/types/workspace";
import type { WorkspaceSortMode } from "../hooks/use-workspace-sort";

const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// First two alphanumeric chars of the name, uppercased — a warmer identity than
// a generic building icon, and enough to tell workspaces apart at a glance.
function monogram(name: string): string {
  const cleaned = name.replace(/[^a-z0-9]/gi, "");
  return (cleaned.slice(0, 2) || "?").toUpperCase();
}

interface WorkspaceCardProps {
  workspace: Workspace;
  onOpen: (slug: string) => void;
  /**
   * The grid's current sort mode. When it matches a field this card shows, that
   * field is highlighted (brighter + bold) so you can see *why* the grid is in
   * its current order. `name` has no footer chip, so nothing lights up for it.
   */
  sortMode?: WorkspaceSortMode;
}

export function WorkspaceCard({ workspace, onOpen, sortMode }: WorkspaceCardProps) {
  const { t } = useTranslation();

  // The "activity" signal — both the freshness dot and the chip — reads
  // last_activity_at (newest board/card edit) and falls back to updated_at when
  // the workspace has no activity yet. This is the SAME key the grid sorts on,
  // so the dot/chip explain the order instead of contradicting it.
  const activityStr = workspace.last_activity_at ?? workspace.updated_at;
  const activityTs = new Date(activityStr).getTime();
  const isActive =
    !Number.isNaN(activityTs) && Date.now() - activityTs <= ACTIVE_WINDOW_MS;
  const hasBoardCount =
    workspace.board_count !== null && workspace.board_count !== undefined;
  const hasCardCount =
    workspace.card_count !== null && workspace.card_count !== undefined;

  return (
    <button
      type="button"
      data-workspace-card
      onClick={() => onOpen(workspace.slug)}
      className="w-full text-left"
    >
      {/* WaveCard owns the hover/focus → waves wiring, the relative+overflow clip,
          and the z-10 content slot. justify-between pins the identity row to the
          top and the metadata row to the bottom of the fixed-height tile. */}
      <WaveCard
        className="h-[7.25rem] w-full border-border/75 p-4 transition-all duration-200 hover:-translate-y-1 hover:border-primary/30 hover:shadow-panel focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        contentClassName="justify-between"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-brand-200)_65%,transparent),color-mix(in_oklab,var(--color-brand-500)_26%,transparent))] text-xs font-semibold uppercase tracking-wide text-primary shadow-soft transition-shadow group-hover:shadow-glow">
            {monogram(workspace.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {workspace.name}
            </div>
            <div className="truncate text-xs text-muted-foreground/80">
              /{workspace.slug}
            </div>
          </div>
          {/* Freshness dot. The activity chip below carries the same signal as
              text, so the dot is decorative but still gets an aria-label for SR
              users. It shares the top-right slot with the hover arrow: the dot
              fades out as the arrow fades in, so there's no overlap or shift. */}
          <span
            aria-label={isActive ? t("workspaces.statusActive") : t("workspaces.statusDormant")}
            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full transition-opacity duration-200 group-hover:opacity-0 ${
              isActive ? "bg-[color:var(--color-data-2)]" : "bg-muted-foreground/40"
            }`}
          />
        </div>

        {/* Counts (boards/cards) on the first row, timestamps (activity/created)
            on the second — each its own highlightable chip so the active sort
            field stands out and the rest recede. */}
        <div className="space-y-1 text-[0.7rem] tabular-nums">
          <div className="flex items-center gap-3">
            {hasBoardCount && (
              <MetaChip
                field="boards"
                active={sortMode === "boards"}
                icon={LayoutGrid}
                testId="workspace-board-count"
              >
                {t("workspaces.boardCount", { count: workspace.board_count ?? 0 })}
              </MetaChip>
            )}
            {hasCardCount && (
              <MetaChip
                field="cards"
                active={sortMode === "cards"}
                icon={SquareStack}
                testId="workspace-card-count"
              >
                {t("workspaces.cardCount", { count: workspace.card_count ?? 0 })}
              </MetaChip>
            )}
          </div>
          <div className="flex items-center gap-3">
            <MetaChip
              field="activity"
              active={sortMode === "activity"}
              icon={Clock}
              testId="workspace-activity"
              ariaLabel={t("workspaces.activeAria", {
                date: formatAbsolute(activityStr),
              })}
            >
              {formatRelativeShort(activityStr)}
            </MetaChip>
            <MetaChip
              field="created"
              active={sortMode === "created"}
              icon={CalendarPlus}
              testId="workspace-created"
              ariaLabel={t("workspaces.createdAria", {
                date: formatAbsolute(workspace.created_at),
              })}
            >
              <span className="text-muted-foreground/50">
                {t("workspaces.createdLabel")}
              </span>
              <span className={cn(sortMode !== "created" && "text-muted-foreground/80")}>
                {formatRelativeShort(workspace.created_at)}
              </span>
            </MetaChip>
          </div>
        </div>

        {/* Pinned to the card corner. The content slot is inset by the card's
            p-4, so a slightly negative offset lands the arrow where it sat when
            anchored to the card itself. */}
        <ArrowRight
          aria-hidden
          className="absolute -right-1 -top-1 h-4 w-4 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:transition-none"
        />
      </WaveCard>
    </button>
  );
}
