// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Kanban,
  Plus,
  Search,
  Snowflake,
  X,
} from "lucide-react";
import { BoardCard } from "./BoardCard";
import { BoardSortDropdown } from "./BoardSortDropdown";
import { CreateBoardDialog } from "./CreateBoardDialog";
import { useBoards } from "../api/use-boards";
import { sortBoards, useBoardSort } from "../hooks/use-board-sort";
import { useShowFrozenBoards } from "../hooks/use-frozen-filter";
import { FROZEN_ACCENT_CLASS } from "../lib/frozen-theme";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { scaleIn, staggerChildren } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

export function BoardList() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  const { data: boards, isLoading } = useBoards(slug);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode, sortDirection, toggleSortDirection] =
    useBoardSort();
  const [showFrozen, toggleShowFrozen] = useShowFrozenBoards();
  const reducedMotion = useReducedMotion();
  const gridRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!boards) return [];
    const q = query.trim().toLowerCase();
    const searched = q
      ? boards.filter(
          (b) =>
            b.name.toLowerCase().includes(q) ||
            b.description.toLowerCase().includes(q) ||
            (b.slug ?? "").toLowerCase().includes(q) ||
            b.tags.some((tag) => tag.toLowerCase().includes(q)),
        )
      : boards;
    // is_frozen is optional on Board (single-board responses omit it) — absent
    // means not frozen, so only an explicit true is filtered out.
    const matched = showFrozen
      ? searched
      : searched.filter((b) => b.is_frozen !== true);
    return sortBoards(matched, sortMode, sortDirection);
  }, [boards, query, showFrozen, sortMode, sortDirection]);

  // Distinguishes "your search matched nothing" from "everything left is
  // frozen and you asked to hide frozen boards" — different dead ends, and the
  // second one is only escapable via the toggle, not by clearing the search.
  const hiddenOnlyByFrozenFilter =
    !showFrozen && !query.trim() && filtered.length === 0;

  // Stagger runs ONCE per load (gated on isLoading), not per keystroke — the
  // filter recomputes a separate `filtered` list without re-animating the grid.
  useEffect(() => {
    if (isLoading || reducedMotion) return;
    const tween = staggerChildren(
      gridRef.current,
      "[data-board-card]",
      scaleIn,
      { stagger: 0.04, duration: 0.2, maxStaggered: 12 },
    );
    // progress(1) BEFORE kill: the entrance starts cards at autoAlpha 0, so a
    // bare mid-flight kill strands them invisible.
    return () => { tween?.progress(1).kill(); };
  }, [isLoading, reducedMotion]);

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-20 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.4rem))]" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-[7.25rem] rounded-[var(--radius-lg)]" />
          ))}
        </div>
      </div>
    );
  }

  const hasBoards = Boolean(boards && boards.length > 0);

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title={t("boards.title")}
        description={t("boards.subtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("boards.createBoard")}
          </Button>
        }
      />

      {hasBoards && (
        <div className="flex w-full items-center gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder={t("boards.searchPlaceholder")}
              className="w-full pl-9 pr-9"
              aria-label={t("boards.searchPlaceholder")}
            />
            {query && (
              <button
                type="button"
                aria-label={t("boards.clearSearch")}
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <BoardSortDropdown value={sortMode} onChange={setSortMode} />
          <Button
            variant="outline"
            size="icon"
            onClick={toggleSortDirection}
            aria-label={t(
              sortDirection === "asc"
                ? "boards.sort.directionAsc"
                : "boards.sort.directionDesc",
            )}
            title={t(
              sortDirection === "asc"
                ? "boards.sort.directionAsc"
                : "boards.sort.directionDesc",
            )}
            className="shrink-0 text-muted-foreground"
          >
            {sortDirection === "asc" ? (
              <ArrowUp className="h-4 w-4" aria-hidden />
            ) : (
              <ArrowDown className="h-4 w-4" aria-hidden />
            )}
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={toggleShowFrozen}
            aria-pressed={!showFrozen}
            aria-label={t(
              showFrozen ? "boards.frozenFilter.hide" : "boards.frozenFilter.show",
            )}
            title={t(
              showFrozen ? "boards.frozenFilter.hide" : "boards.frozenFilter.show",
            )}
            // Ice blue from the shared constant marks the filter ENGAGED,
            // tying the control to the frozen surfaces it is acting on; neutral
            // marks it resting, matching the sibling filter controls. Hue, not
            // alpha, carries on/off — the accent must stay the shared constant
            // so the control and the state it filters cannot drift apart.
            className={cn(
              "shrink-0 transition-colors",
              showFrozen ? "text-muted-foreground" : FROZEN_ACCENT_CLASS,
            )}
          >
            <Snowflake className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )}

      {!hasBoards ? (
        <EmptyState
          icon={Kanban}
          title={t("boards.title")}
          description={t("dashboard.emptyDescription")}
          action={
            <Button size="lg" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("boards.createBoard")}
            </Button>
          }
        />
      ) : hiddenOnlyByFrozenFilter ? (
        <EmptyState
          icon={Snowflake}
          title={t("boards.frozenFilter.emptyTitle")}
          description={t("boards.frozenFilter.emptyDescription")}
          action={
            <Button variant="outline" onClick={toggleShowFrozen}>
              {t("boards.frozenFilter.show")}
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("boards.noMatchTitle", { query })}
          description={t("boards.noMatchDescription")}
          action={
            <Button variant="outline" onClick={() => setQuery("")}>
              {t("boards.clearSearch")}
            </Button>
          }
        />
      ) : (
        <div
          ref={gridRef}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
        >
          {filtered.map((board) => (
            <BoardCard
              key={board.id}
              board={board}
              workspaceSlug={slug}
              sortMode={sortMode}
            />
          ))}
        </div>
      )}

      <CreateBoardDialog
        slug={slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}
