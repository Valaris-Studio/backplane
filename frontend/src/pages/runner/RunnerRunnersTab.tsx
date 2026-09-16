// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, RotateCcw, Users } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/EmptyState";
import { AgentTable } from "@/features/agents/components/AgentTable";
import { LaunchRunnerWizard } from "@/features/agents/components/onboarding/LaunchRunnerWizard";
import { TeamPanel } from "@/features/agents/components/TeamPanel";
import { useAgentMetrics } from "@/features/agents/hooks/useAgentMetrics";
import { useTeams } from "@/features/agents/hooks/useTeams";

// Runner Console → Runners tab. The registered runner processes (credential +
// liveness + budget) AND their role bindings — the redesign folds the former
// "Teams" tab in here, because the thing operators actually want ("which roles
// can this runner take") is a property of the runner, surfaced inline on each
// row and editable on the runner detail. The full team objects (multi-board
// scoping, etc.) live in a demoted, collapsible "Teams" section below.
export function RunnerRunnersTab({ slug: slugProp }: { slug?: string } = {}) {
  const params = useParams();
  const slug = slugProp ?? params.slug ?? "";
  const { t } = useTranslation();
  const [showInactive, setShowInactive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const { data: agents, isLoading, isError, refetch } = useAgentMetrics(slug, showInactive);
  const { data: teams } = useTeams(slug);

  // Aggregate each runner's roles across its team memberships → the inline
  // "roles this runner may take" summary on the table.
  const rolesByAgent = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const team of teams ?? []) {
      for (const member of team.members) {
        const set = (map[member.agent_id] ??= new Set());
        for (const role of member.roles) set.add(role);
      }
    }
    return Object.fromEntries(
      Object.entries(map).map(([id, set]) => [id, [...set]]),
    );
  }, [teams]);

  if (isLoading) {
    return <Skeleton className="h-64 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />;
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <div className="flex items-center justify-between gap-3">
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          {t("runners.createRunner")}
        </Button>
        <Toggle
          pressed={showInactive}
          onPressedChange={setShowInactive}
          size="sm"
          aria-label={t("agents.showInactive")}
        >
          {t("agents.showInactive")}
        </Toggle>
      </div>
      {isError ? (
        // A fetch failure (e.g. the dev rate-limiter's 429) must NOT fall
        // through to AgentTable's empty state — that reads as an empty registry
        // and misleads a first-timer into re-creating runners. Distinct error +
        // retry instead; existing runners are untouched server-side.
        <EmptyState
          icon={AlertTriangle}
          title={t("runners.loadErrorTitle")}
          description={t("runners.loadErrorDescription")}
          action={
            <Button variant="outline" onClick={() => refetch()} className="gap-2">
              <RotateCcw className="h-4 w-4" />
              {t("runners.retry")}
            </Button>
          }
        />
      ) : (
        <>
          <AgentTable
            agents={agents ?? []}
            slug={slug}
            onCreate={() => setCreateOpen(true)}
            rolesByAgent={rolesByAgent}
          />

          {/* Demoted team management — the 20% case (multi-board team scoping,
              bulk role assignment). Per-runner role binding is the primary path
              (inline above + on runner detail). */}
          <section className="rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))] border border-border/70 bg-card/40">
            <button
              type="button"
              onClick={() => setTeamsOpen((o) => !o)}
              aria-expanded={teamsOpen}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted/30"
            >
              {teamsOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <Users className="h-4 w-4 text-muted-foreground" />
              {t("runners.teamsSection")}
              <span className="text-xs font-normal text-muted-foreground">
                {t("runners.teamsSectionHint")}
              </span>
            </button>
            {teamsOpen ? (
              <div className="border-t border-border/60 p-4">
                <TeamPanel slug={slug} />
              </div>
            ) : null}
          </section>
        </>
      )}

      <LaunchRunnerWizard open={createOpen} onOpenChange={setCreateOpen} slug={slug} />
    </div>
  );
}
