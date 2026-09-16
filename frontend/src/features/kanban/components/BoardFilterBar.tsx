// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Rows4,
  Search,
  SlidersHorizontal,
  Table2,
  X,
} from "lucide-react";
import {
  FilterMultiSelect,
  FilterToggle,
  type CollectionViewControls,
  type ViewMode,
} from "@/components/collection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { BOARD_SORT_IDS, type BoardSortId } from "../hooks/use-board-filters";
import type { Card, CardType, Priority } from "@/types/kanban";

interface BoardFilterBarProps {
  controls: CollectionViewControls<Card>;
  visibleCount: number;
  totalCount: number;
  labelOptions: string[];
  assigneeOptions: { value: string; label: string }[];
  // 'grid' = board (columns) view, 'compact' = the same columns with one-line
  // cards, 'list' = table view. Reuses the persisted collection view-mode from
  // useCollectionView.
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

// Density runs left → right: full cards, one-line cards, table rows.
const VIEW_MODE_SEGMENTS: {
  mode: ViewMode;
  Icon: typeof LayoutGrid;
  labelKey: string;
}[] = [
  { mode: "grid", Icon: LayoutGrid, labelKey: "kanban.viewMode.board" },
  { mode: "compact", Icon: Rows4, labelKey: "kanban.viewMode.compact" },
  { mode: "list", Icon: Table2, labelKey: "kanban.viewMode.table" },
];

const CARD_TYPES: CardType[] = ["task", "bug", "feature", "issue"];
const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
const AGENT_PRESENCES = ["none", "eligible", "touched", "active"] as const;

// User-level preference (not per-board): whether the filter/sort panel is
// expanded. Collapsed is the default — the panel is tall and the board is
// viewport-bound, so every collapsed pixel is card space.
const FILTER_BAR_EXPANDED_KEY = "kanban:filter-bar-expanded";
const FILTER_PANEL_ID = "board-filter-panel";

export function BoardFilterBar({
  controls,
  visibleCount,
  totalCount,
  labelOptions,
  assigneeOptions,
  viewMode,
  onViewModeChange,
}: BoardFilterBarProps) {
  const { t } = useTranslation();
  const sortId = controls.sortId as BoardSortId;
  const sortDirectionDisabled = sortId === "manual";

  const types = (controls.filterValues.types as CardType[] | undefined) ?? [];
  const priorities = (controls.filterValues.priorities as Priority[] | undefined) ?? [];
  const labels = (controls.filterValues.labels as string[] | undefined) ?? [];
  const assignees = (controls.filterValues.assignees as string[] | undefined) ?? [];
  const presence = (controls.filterValues.agentPresence as string[] | undefined) ?? [];
  const pendingApproval = controls.filterValues.pendingApproval === true;

  const hasActiveControls = controls.activeFilterCount > 0 || controls.search.length > 0;
  // Everything narrowing the board, search included — surfaced on the
  // collapsed toggle so hidden filters can't silently eat cards.
  const activeControlCount =
    controls.activeFilterCount + (controls.search.length > 0 ? 1 : 0);

  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(FILTER_BAR_EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggleExpanded() {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(FILTER_BAR_EXPANDED_KEY, next ? "1" : "0");
      } catch {
        /* storage disabled — session-only preference */
      }
      return next;
    });
  }

  return (
    <div className="space-y-2">
      {/* The always-visible slim row: expand toggle + result count + view
          switcher. Search/sort/filter chips live in the panel below it. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          aria-controls={FILTER_PANEL_ID}
          className="inline-flex h-8 items-center gap-1.5 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-border/70 bg-card/50 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t("kanban.filterBar.toggle")}
          {activeControlCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.6rem] font-semibold text-primary-foreground">
              {activeControlCount}
            </span>
          ) : null}
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        <span className="text-xs text-muted-foreground">
          {t("collection.resultCount", { count: visibleCount, total: totalCount })}
        </span>
        <div
          className="ml-auto inline-flex h-8 items-center rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-border/80 bg-card p-0.5"
          role="group"
          aria-label={t("collection.viewMode")}
        >
          {VIEW_MODE_SEGMENTS.map(({ mode, Icon, labelKey }) => (
            <button
              key={mode}
              type="button"
              onClick={() => onViewModeChange(mode)}
              aria-pressed={viewMode === mode}
              aria-label={t(labelKey)}
              className={cn(
                "inline-flex h-7 items-center justify-center rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.15rem))] px-2 text-muted-foreground transition-colors",
                viewMode === mode && "bg-accent text-foreground shadow-soft",
              )}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      {expanded ? (
        <div
          id={FILTER_PANEL_ID}
          className="space-y-2 rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-border/70 bg-card/50 px-3 py-2.5 shadow-soft"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={controls.search}
            onChange={(e) => controls.setSearch(e.target.value)}
            placeholder={t("kanban.filterBar.searchPlaceholder")}
            className="h-9 pl-9"
            aria-label={t("kanban.filterBar.searchPlaceholder")}
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-border/80 bg-card px-3 text-sm font-medium text-foreground hover:bg-accent",
            )}
          >
            <span className="text-muted-foreground">{t("collection.sortBy")}:</span>
            <span>{t(`kanban.filterBar.sort.${sortId}`)}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{t("collection.sortBy")}</DropdownMenuLabel>
            {BOARD_SORT_IDS.map((id) => (
              <DropdownMenuItem
                key={id}
                onClick={() => controls.setSortId(id)}
                className={cn(id === sortId && "bg-accent/60")}
              >
                {t(`kanban.filterBar.sort.${id}`)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                if (sortDirectionDisabled) return;
                controls.toggleSortDirection();
              }}
              className={cn(sortDirectionDisabled && "opacity-50 pointer-events-none")}
            >
              {controls.sortDirection === "asc" ? (
                <ArrowUp className="h-4 w-4" />
              ) : (
                <ArrowDown className="h-4 w-4" />
              )}
              {controls.sortDirection === "asc"
                ? t("collection.ascending")
                : t("collection.descending")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={controls.toggleSortDirection}
          disabled={sortDirectionDisabled}
          aria-label={
            controls.sortDirection === "asc"
              ? t("collection.ascending")
              : t("collection.descending")
          }
        >
          {controls.sortDirection === "asc" ? (
            <ArrowUp className="h-4 w-4" />
          ) : (
            <ArrowDown className="h-4 w-4" />
          )}
        </Button>

          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FilterMultiSelect
          label={t("kanban.filterBar.filter.types")}
          options={CARD_TYPES.map((v) => ({ value: v, label: t(`cards.types.${v}`) }))}
          value={types}
          onChange={(next) => controls.setFilterValue("types", next)}
        />
        <FilterMultiSelect
          label={t("kanban.filterBar.filter.priorities")}
          options={PRIORITIES.map((v) => ({ value: v, label: t(`cards.priorities.${v}`) }))}
          value={priorities}
          onChange={(next) => controls.setFilterValue("priorities", next)}
        />
        <FilterMultiSelect
          label={t("kanban.filterBar.filter.labels")}
          options={labelOptions.map((v) => ({ value: v, label: v }))}
          value={labels}
          onChange={(next) => controls.setFilterValue("labels", next)}
        />
        <FilterMultiSelect
          label={t("kanban.filterBar.filter.assignees")}
          options={assigneeOptions}
          value={assignees}
          onChange={(next) => controls.setFilterValue("assignees", next)}
        />
        <FilterMultiSelect
          label={t("kanban.filterBar.filter.agentPresence")}
          options={AGENT_PRESENCES.map((v) => ({
            value: v,
            label: t(`kanban.filterBar.presence.${v}`),
          }))}
          value={presence}
          onChange={(next) => controls.setFilterValue("agentPresence", next)}
        />
        <FilterToggle
          label={t("kanban.filterBar.filter.pendingApproval")}
          active={pendingApproval}
          onChange={(next) => controls.setFilterValue("pendingApproval", next)}
          icon={<AlertCircle className="h-3.5 w-3.5" />}
        />

        {hasActiveControls ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={controls.resetFilters}
            className="text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
            {t("collection.clear")}
          </Button>
        ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
