// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Lock, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { useConnectionRepositories } from "../api/use-git-connections";
import type { GitConnectionRepository } from "@/types/git";

interface RepositoryPickerDialogProps {
  slug: string;
  connectionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (repo: GitConnectionRepository) => void;
}

function formatUpdatedAt(iso: string): string {
  return formatDate(iso);
}

export function RepositoryPickerDialog({
  slug,
  connectionId,
  open,
  onOpenChange,
  onSelect,
}: RepositoryPickerDialogProps) {
  const { t } = useTranslation();
  const reposQuery = useConnectionRepositories(slug, connectionId);
  const [filter, setFilter] = useState("");

  const loadedRepos = reposQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const hasMore = reposQuery.hasNextPage;

  // Filtering is local to the pages already fetched — no query key change, so a
  // keystroke never triggers a request.
  const needle = filter.trim().toLowerCase();
  const repos = needle
    ? loadedRepos.filter((repo) =>
        repo.full_name.toLowerCase().includes(needle),
      )
    : loadedRepos;

  const filteredEverythingOut = needle.length > 0 && repos.length === 0;

  function handleSelect(repo: GitConnectionRepository) {
    onSelect(repo);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("integrations.pickRepository")}</DialogTitle>
          <DialogDescription>
            {t("integrations.pickRepositorySubtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="repo-picker-filter"
            className="pl-9"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("integrations.filterRepositoriesPlaceholder")}
            aria-label={t("integrations.filterRepositoriesPlaceholder")}
          />
        </div>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {reposQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-[var(--radius-md)]" />
              ))}
            </div>
          ) : reposQuery.isError ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("common.loadError")}
            </p>
          ) : filteredEverythingOut ? (
            <p
              data-testid={
                hasMore
                  ? "repo-picker-no-matches-more"
                  : "repo-picker-no-matches"
              }
              className="px-2 py-6 text-center text-sm text-muted-foreground"
            >
              {hasMore
                ? t("integrations.noMatchesLoadMore")
                : t("integrations.noMatches")}
            </p>
          ) : repos.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("integrations.repositoriesEmpty")}
            </p>
          ) : (
            repos.map((repo) => (
              <button
                key={`${repo.provider}:${repo.id}`}
                data-testid="repo-picker-item"
                type="button"
                onClick={() => handleSelect(repo)}
                className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-md)] border border-border/60 bg-[color:var(--color-surface-1)] px-3 py-2 text-left transition-colors hover:border-primary/30 hover:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {repo.full_name}
                    </span>
                    {repo.private ? (
                      <Badge variant="outline">
                        <Lock className="h-3 w-3" />
                        {t("integrations.private")}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <GitBranch className="h-3 w-3" />
                      {repo.default_branch}
                    </span>
                    <span>{formatUpdatedAt(repo.updated_at)}</span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {hasMore ? (
          <div className="flex justify-center border-t border-border/70 pt-4">
            <Button
              variant="outline"
              onClick={() => reposQuery.fetchNextPage()}
              disabled={reposQuery.isFetchingNextPage}
            >
              {reposQuery.isFetchingNextPage
                ? t("common.loading")
                : t("integrations.loadMore")}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
