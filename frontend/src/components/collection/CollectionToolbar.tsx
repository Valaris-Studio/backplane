// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, LayoutGrid, List, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import type { CollectionViewControls, ViewMode } from "./use-collection-view";
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

interface CollectionToolbarProps<T> {
  controls: CollectionViewControls<T>;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  searchPlaceholder?: string;
  /**
   * Optional feature-owned filter widgets. The toolbar renders the slot in a
   * row beneath the primary controls. Pass `null` if no filters are needed.
   */
  filterSlot?: ReactNode;
  resultLabel?: string;
}

export function CollectionToolbar<T>({
  controls,
  viewMode,
  onViewModeChange,
  searchPlaceholder,
  filterSlot,
  resultLabel,
}: CollectionToolbarProps<T>) {
  const { t } = useTranslation();
  const {
    search,
    setSearch,
    sortId,
    setSortId,
    sortDirection,
    toggleSortDirection,
    sorters,
    activeFilterCount,
    resetFilters,
  } = controls;

  const activeSorter = sorters.find((s) => s.id === sortId) ?? sorters[0];
  const hasActiveControls = activeFilterCount > 0 || search.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder ?? t("collection.searchPlaceholder")}
            className="pl-9"
            aria-label={searchPlaceholder ?? t("collection.searchPlaceholder")}
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-border/80 bg-card px-3 text-sm font-medium text-foreground hover:bg-accent",
            )}
          >
            <span className="text-muted-foreground">{t("collection.sortBy")}:</span>
            <span>{activeSorter?.label}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{t("collection.sortBy")}</DropdownMenuLabel>
            {sorters.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onClick={() => setSortId(s.id)}
                className={cn(s.id === sortId && "bg-accent/60")}
              >
                {s.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={toggleSortDirection}>
              {sortDirection === "asc" ? (
                <ArrowUp className="h-4 w-4" />
              ) : (
                <ArrowDown className="h-4 w-4" />
              )}
              {sortDirection === "asc"
                ? t("collection.ascending")
                : t("collection.descending")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={toggleSortDirection}
          aria-label={
            sortDirection === "asc"
              ? t("collection.ascending")
              : t("collection.descending")
          }
        >
          {sortDirection === "asc" ? (
            <ArrowUp className="h-4 w-4" />
          ) : (
            <ArrowDown className="h-4 w-4" />
          )}
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {resultLabel ? (
            <span className="text-xs text-muted-foreground">{resultLabel}</span>
          ) : null}
          <div
            className="inline-flex h-9 items-center rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-border/80 bg-card p-0.5"
            role="group"
            aria-label={t("collection.viewMode")}
          >
            <button
              type="button"
              onClick={() => onViewModeChange("grid")}
              aria-pressed={viewMode === "grid"}
              aria-label={t("collection.grid")}
              className={cn(
                "inline-flex h-8 items-center justify-center rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.15rem))] px-2 text-muted-foreground transition-colors",
                viewMode === "grid" && "bg-accent text-foreground shadow-soft",
              )}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange("list")}
              aria-pressed={viewMode === "list"}
              aria-label={t("collection.list")}
              className={cn(
                "inline-flex h-8 items-center justify-center rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.15rem))] px-2 text-muted-foreground transition-colors",
                viewMode === "list" && "bg-accent text-foreground shadow-soft",
              )}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {filterSlot || hasActiveControls ? (
        <div className="flex flex-wrap items-center gap-2">
          {filterSlot}
          {hasActiveControls ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="text-muted-foreground"
            >
              <X className="h-3.5 w-3.5" />
              {t("collection.clear")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
