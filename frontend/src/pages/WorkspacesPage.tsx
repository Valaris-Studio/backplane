// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Building2,
  Plus,
  Search,
  X,
} from "lucide-react";
import { CreateWorkspaceDialog } from "@/features/workspaces/components/CreateWorkspaceDialog";
import { WorkspaceCard } from "@/features/workspaces/components/WorkspaceCard";
import { WorkspaceSortDropdown } from "@/features/workspaces/components/WorkspaceSortDropdown";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import {
  sortWorkspaces,
  useWorkspaceSort,
} from "@/features/workspaces/hooks/use-workspace-sort";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { AccountMenu } from "@/components/layout/AccountMenu";
import { EmptyState } from "@/components/layout/EmptyState";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { fadeInUp, scaleIn, staggerChildren } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { BrandLogo } from "@/components/brand/BrandLogo";

export function WorkspacesPage() {
  const { data: workspaces, isLoading } = useWorkspaces();
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode, sortDirection, toggleSortDirection] =
    useWorkspaceSort();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const heroRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!workspaces) return [];
    const q = query.trim().toLowerCase();
    const matched = q
      ? workspaces.filter(
          (w) =>
            w.name.toLowerCase().includes(q) ||
            w.slug.toLowerCase().includes(q),
        )
      : workspaces;
    return sortWorkspaces(matched, sortMode, sortDirection);
  }, [workspaces, query, sortMode, sortDirection]);

  // Stagger runs ONCE per load (gated on isLoading), not per keystroke — the
  // filter recomputes a separate `filtered` list without re-animating the grid.
  useEffect(() => {
    if (isLoading || reducedMotion) return;
    const heroTween = fadeInUp(heroRef.current, { duration: 0.22, offset: 10 });
    const gridTween = staggerChildren(
      gridRef.current,
      "[data-workspace-card]",
      scaleIn,
      { stagger: 0.04, duration: 0.2, maxStaggered: 12 },
    );
    // progress(1) BEFORE kill: the entrances start from autoAlpha 0, so a bare
    // mid-flight kill strands elements invisible.
    return () => {
      heroTween?.progress(1).kill();
      gridTween?.progress(1).kill();
    };
  }, [isLoading, reducedMotion]);

  const hasWorkspaces = Boolean(workspaces && workspaces.length > 0);
  const count = workspaces?.length ?? 0;

  return (
    <div className="relative min-h-screen px-4 py-6 md:px-6 lg:px-10">
      {/* Branded top warmth — a tall, soft fade so it blends into the body
          background instead of cutting off as a hard band when content is short.
          fixed so it always covers the viewport regardless of grid height. */}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[28rem] bg-[radial-gradient(120%_100%_at_top_left,color-mix(in_oklab,var(--color-brand-200)_55%,transparent),transparent_60%)] dark:bg-[radial-gradient(120%_100%_at_top_left,color-mix(in_oklab,var(--color-brand-700)_45%,transparent),transparent_60%)]" />

      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] max-w-6xl flex-col gap-6 pt-2">
        <div className="flex flex-wrap justify-end gap-2">
          <ThemeSwitcher />
          <LanguageSwitcher />
          <Link
            to="/documentation"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "shrink-0 gap-2",
            )}
          >
            <BookOpen className="h-4 w-4 shrink-0" />
            {t("nav.docs")}
          </Link>
          <AccountMenu />
        </div>

        {isLoading ? (
          <div className="w-full space-y-6">
            <Skeleton className="h-20 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="h-[6.5rem] rounded-[var(--radius-lg)]" />
              ))}
            </div>
          </div>
        ) : (
          <>
            <div
              ref={heroRef}
              className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-center gap-3">
                <BrandLogo className="h-8 w-auto" />
                <span className="text-xl font-bold tracking-tight text-foreground">
                  Backplane
                </span>
                <span
                  aria-hidden
                  className="h-8 w-px bg-border/70"
                />
                <div className="leading-tight">
                  <p className="text-sm font-medium text-foreground">
                    {t("workspaces.heroTagline")}
                  </p>
                  {hasWorkspaces && (
                    <p className="text-xs text-muted-foreground">
                      {t("workspaces.count", { count })}
                    </p>
                  )}
                </div>
              </div>

              <Button onClick={() => setCreateOpen(true)} className="self-start sm:self-auto">
                <Plus className="h-4 w-4" />
                {t("workspaces.newWorkspace")}
              </Button>
            </div>

            {hasWorkspaces && (
              <div className="flex w-full items-center gap-2">
                <div className="relative w-full max-w-sm">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setQuery("");
                    }}
                    placeholder={t("workspaces.searchPlaceholder")}
                    className="w-full pl-9 pr-9"
                    aria-label={t("workspaces.searchPlaceholder")}
                  />
                  {query && (
                    <button
                      type="button"
                      aria-label={t("workspaces.clearSearch")}
                      onClick={() => setQuery("")}
                      className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <WorkspaceSortDropdown value={sortMode} onChange={setSortMode} />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={toggleSortDirection}
                  aria-label={t(
                    sortDirection === "asc"
                      ? "workspaces.sort.directionAsc"
                      : "workspaces.sort.directionDesc",
                  )}
                  title={t(
                    sortDirection === "asc"
                      ? "workspaces.sort.directionAsc"
                      : "workspaces.sort.directionDesc",
                  )}
                  className="shrink-0 text-muted-foreground"
                >
                  {sortDirection === "asc" ? (
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  ) : (
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              </div>
            )}

            {!hasWorkspaces ? (
              <EmptyState
                icon={Building2}
                title={t("workspaces.emptyTitle")}
                description={t("workspaces.emptyDescription")}
                action={
                  <Button size="lg" onClick={() => setCreateOpen(true)}>
                    <Plus className="h-4 w-4" />
                    {t("workspaces.createWorkspace")}
                  </Button>
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Search}
                title={t("workspaces.noMatchTitle", { query })}
                description={t("workspaces.noMatchDescription")}
                action={
                  <Button variant="outline" onClick={() => setQuery("")}>
                    {t("workspaces.clearSearch")}
                  </Button>
                }
              />
            ) : (
              <div
                ref={gridRef}
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
              >
                {filtered.map((workspace) => (
                  <WorkspaceCard
                    key={workspace.id}
                    workspace={workspace}
                    onOpen={(slug) => navigate(`/${slug}`)}
                    sortMode={sortMode}
                  />
                ))}
              </div>
            )}
          </>
        )}

        <CreateWorkspaceDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(slug) => navigate(`/${slug}`)}
        />
      </div>
    </div>
  );
}
