// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ExternalLink,
  GitBranch,
  KeyRound,
  Plus,
  Rocket,
  SquarePen,
} from "lucide-react";
import { CreateGitRepoDialog } from "./CreateGitRepoDialog";
import { GitRepoEditor } from "./GitRepoEditor";
import { RunnerConfigDialog } from "./RunnerConfigDialog";
import { useGitRepos } from "../api/use-git-repos";
import { useGitConnections } from "@/features/integrations/api/use-git-connections";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { FrozenActionTooltip } from "@/features/kanban/components/FrozenActionTooltip";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { scaleIn, staggerChildren } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { GitProvider, GitRepo } from "@/types/git";

const providerStyles: Record<GitProvider, string> = {
  github: "bg-muted text-foreground",
  gitlab: "bg-[color:color-mix(in_oklab,var(--color-data-4)_20%,transparent)] text-[color:var(--color-data-4)]",
  gitea: "bg-success/16 text-[color:var(--color-success-foreground)]",
  bitbucket: "bg-info/16 text-[color:var(--color-info-foreground)]",
  other: "bg-secondary text-secondary-foreground",
};

interface GitRepoListProps {
  slug: string;
  boardId: string;
  isFrozen?: boolean;
}

export function GitRepoList({ slug, boardId, isFrozen = false }: GitRepoListProps) {
  const { t } = useTranslation();
  const { data: repos, isLoading } = useGitRepos(slug, boardId);
  const { isAdmin } = useWorkspaceAdmin(slug);
  const connectionsQuery = useGitConnections(slug);
  const [selectedRepo, setSelectedRepo] = useState<GitRepo | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [runnerConfigOpen, setRunnerConfigOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const gridRef = useRef<HTMLDivElement>(null);

  // Names the bound credential on the card. Returns null while connections are
  // still loading or when the id points at a connection this member cannot see,
  // so a half-loaded page never renders a misleading badge.
  function resolveConnectionLogin(connectionId: string | null): string | null {
    if (!connectionId) return null;
    return (
      connectionsQuery.data?.find((c) => c.id === connectionId)
        ?.account_login ?? null
    );
  }

  useEffect(() => {
    if (isLoading || reducedMotion) return;
    const tween = staggerChildren(
      gridRef.current,
      "[data-stagger-item]",
      scaleIn,
      { stagger: 0.05, duration: 0.2, maxStaggered: 12 },
    );
    // progress(1) BEFORE kill: the entrance starts cards at autoAlpha 0, so a
    // bare mid-flight kill strands them invisible.
    return () => { tween?.progress(1).kill(); };
  }, [isLoading, reducedMotion, repos?.length]);

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton
              key={index}
              className="h-56 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        slim
        title={t("gitRepos.title")}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setRunnerConfigOpen(true)}>
              <Rocket className="h-4 w-4" />
              {t("runnerConfig.action")}
            </Button>
            <FrozenActionTooltip frozen={isFrozen}>
              <Button onClick={() => setCreateOpen(true)} disabled={isFrozen}>
                <Plus className="h-4 w-4" />
                {t("gitRepos.addRepo")}
              </Button>
            </FrozenActionTooltip>
          </div>
        }
      />

      {!repos?.length ? (
        <EmptyState
          icon={GitBranch}
          title={t("gitRepos.title")}
          description={t("gitRepos.empty")}
          action={
            <FrozenActionTooltip frozen={isFrozen}>
              <Button
                size="lg"
                onClick={() => setCreateOpen(true)}
                disabled={isFrozen}
              >
                <Plus className="h-4 w-4" />
                {t("gitRepos.addRepo")}
              </Button>
            </FrozenActionTooltip>
          }
        />
      ) : (
        <div
          ref={gridRef}
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {repos.map((repo) => (
            <button
              key={repo.id}
              type="button"
              data-stagger-item
              onClick={() => {
                setSelectedRepo(repo);
                setEditorOpen(true);
              }}
              className="text-left"
            >
              <Card className="group h-full border-border/75 hover:-translate-y-1 hover:border-primary/20 hover:shadow-panel">
                <CardHeader className="gap-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary shadow-soft">
                      <GitBranch className="h-5 w-5" />
                    </div>
                    <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-card/70 text-muted-foreground opacity-0 transition-all duration-200 group-hover:opacity-100">
                      <SquarePen className="h-4 w-4" />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <CardTitle className="line-clamp-2 text-lg">
                        {repo.name}
                      </CardTitle>
                      <Pill className={providerStyles[repo.provider]}>
                        {t(`gitRepos.providers.${repo.provider}`)}
                      </Pill>
                    </div>

                    <a
                      href={repo.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {repo.url}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>

                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        <GitBranch className="h-3 w-3" />
                        {repo.default_branch}
                      </Badge>
                      {/* Only shown when bound — an unbound repo falls back to
                          the platform token, which is the silent default and
                          needs no badge of its own. */}
                      {resolveConnectionLogin(repo.connection_id) ? (
                        <Badge variant="outline">
                          <KeyRound className="h-3 w-3" />
                          {t("gitRepos.connectionBadge", {
                            login: resolveConnectionLogin(repo.connection_id),
                          })}
                        </Badge>
                      ) : null}
                    </div>

                    {repo.description ? (
                      <CardDescription className="line-clamp-2">
                        {repo.description}
                      </CardDescription>
                    ) : null}
                  </div>
                </CardHeader>
              </Card>
            </button>
          ))}
        </div>
      )}

      <CreateGitRepoDialog
        slug={slug}
        boardId={boardId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <RunnerConfigDialog
        slug={slug}
        boardId={boardId}
        open={runnerConfigOpen}
        onOpenChange={setRunnerConfigOpen}
      />

      {selectedRepo ? (
        <GitRepoEditor
          repo={selectedRepo}
          slug={slug}
          boardId={boardId}
          open={editorOpen}
          onOpenChange={setEditorOpen}
          isAdmin={isAdmin}
        />
      ) : null}
    </div>
  );
}
