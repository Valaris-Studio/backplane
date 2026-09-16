// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { GitBranch, Diamond, Square, OctagonX, CircleDot, SlidersHorizontal, FileText, ListTree } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LifecyclePipelineBuilderPage } from "@/features/agents/components/pipeline-builder/LifecyclePipelineBuilderPage";
import { PipelineCanvas } from "@/features/agents/components/pipeline-canvas/PipelineCanvas";
import { PipelineTreeView } from "@/features/agents/components/pipeline-tree/PipelineTreeView";
import { useLifecycleDraft } from "@/features/agents/hooks/useLifecycleDraft";
import { useWorkspaceConfig } from "@/features/agents/hooks/useWorkspaceConfig";
import { LaunchRunnerWizard } from "@/features/agents/components/onboarding/LaunchRunnerWizard";
import { RunnerLaunchDialog } from "@/features/agents/components/onboarding/RunnerLaunchDialog";
import { useAgentMetrics } from "@/features/agents/hooks/useAgentMetrics";
import {
  type AdvancedView,
  readAdvancedView,
  writeAdvancedView,
} from "./pipelineViewPreference";

type View = "graph" | "advanced";

// Runner Console → Pipeline tab. The CANVAS is the primary surface: it shows
// every runner with its registered roles (roles never wired to each other — the
// runtime is signal-keyed), each role drilling into its own truthful lifecycle,
// and it is EDITABLE in place (add/remove roles, edit steps/prompts, rebind
// runners). The raw lifecycle DSL form is the "Advanced" escape hatch. Both
// views share ONE draft instance, so switching never loses edits.
export function RunnerPipelineTab({ slug: slugProp }: { slug?: string } = {}) {
  const params = useParams();
  const slug = slugProp ?? params.slug ?? "";
  const { t } = useTranslation();
  // A ?role= deep link names a TREE node, so it lands directly on the tree —
  // overriding both the graph landing view and a stored form preference for
  // that visit, without rewriting the preference the operator set deliberately.
  const [searchParams] = useSearchParams();
  const deepLinksToTree = searchParams.get("role") !== null;
  const [view, setView] = useState<View>(deepLinksToTree ? "advanced" : "graph");
  const [storedAdvancedView, setStoredAdvancedView] = useState<AdvancedView>(
    () => readAdvancedView(),
  );
  const advancedView: AdvancedView = deepLinksToTree ? "tree" : storedAdvancedView;

  const chooseAdvancedView = useCallback((next: AdvancedView) => {
    setStoredAdvancedView(next);
    writeAdvancedView(next);
  }, []);
  // Create-new-runner wizard: opened via a null agentId — from a runner lane's
  // rocket with no runner yet, or the BindRoleDialog's "Create runner" escape
  // when an unbound role has no active runner to bind.
  const [createOpen, setCreateOpen] = useState(false);
  // Launch-THIS-runner dialog: opened by a runner lane's rocket (real agentId).
  const [launchAgentId, setLaunchAgentId] = useState<string | null>(null);
  const draft = useLifecycleDraft(slug);
  const { data: agents } = useAgentMetrics(slug);
  // Scheduling is not part of the editable draft (only stages are), so the tree
  // reads it from the same cached config query useLifecycleDraft already holds
  // open — a cache hit, not a second fetch.
  const { data: workspaceConfig } = useWorkspaceConfig(slug);

  const launchAgent = agents?.find((a) => a.agent_id === launchAgentId);

  const handleLaunch = (agentId: string | null) => {
    if (agentId) setLaunchAgentId(agentId);
    else setCreateOpen(true);
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <SegmentedToggle view={view} onChange={setView} />
        <div className="flex items-center gap-3">
          {view === "graph" ? (
            <GraphLegend />
          ) : (
            <AdvancedViewFallback view={advancedView} onChange={chooseAdvancedView} />
          )}
          {/* The prompts page has no console tab of its own — this is the
              discoverable way in (LLM steps also deep-link per stage). */}
          <Link
            to={`/${slug}/runner/prompts`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          >
            <FileText className="h-3.5 w-3.5" />
            {t("pipelineGraph.managePrompts")}
          </Link>
        </div>
      </div>
      {view === "advanced" ? (
        advancedView === "form" ? (
          <LifecyclePipelineBuilderPage draft={draft} />
        ) : draft.loading ? (
          <Skeleton className="h-[28rem] flex-1 rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))]" />
        ) : (
          <PipelineTreeView
            draft={draft}
            workspaceSlug={slug}
            scheduling={
              workspaceConfig?.pipeline_config?.scheduling ?? {
                priority_order: [],
                mode: "priority",
              }
            }
          />
        )
      ) : draft.loading ? (
        <Skeleton className="h-[28rem] flex-1 rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))]" />
      ) : (
        <div className="flex min-h-[28rem] flex-1 flex-col">
          <PipelineCanvas slug={slug} draft={draft} onLaunchRunner={handleLaunch} />
        </div>
      )}
      <LaunchRunnerWizard slug={slug} open={createOpen} onOpenChange={setCreateOpen} />
      {launchAgent ? (
        <RunnerLaunchDialog
          slug={slug}
          agentId={launchAgent.agent_id}
          agentName={launchAgent.name}
          open
          onOpenChange={(o) => (o ? undefined : setLaunchAgentId(null))}
        />
      ) : null}
    </div>
  );
}

function SegmentedToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const { t } = useTranslation();
  const base =
    "flex items-center gap-1.5 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.1rem))] px-3 py-1.5 text-sm font-medium transition-colors";
  return (
    <div className="inline-flex rounded-[var(--radius-md)] border border-border/70 bg-card p-0.5">
      <button
        type="button"
        onClick={() => onChange("graph")}
        className={cn(base, view === "graph" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
        aria-pressed={view === "graph"}
      >
        <GitBranch className="h-3.5 w-3.5" />
        {t("pipelineGraph.viewGraph")}
      </button>
      <button
        type="button"
        onClick={() => onChange("advanced")}
        className={cn(base, view === "advanced" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
        aria-pressed={view === "advanced"}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {t("pipelineGraph.viewAdvanced")}
      </button>
    </div>
  );
}

// The tree IS the advanced editor now; the legacy nested form is a deliberately
// secondary escape hatch kept while the tree earns trust. Rendered as plain
// links rather than a second segmented control so it reads as an aside to the
// primary Graph/Advanced choice, not a peer of it.
function AdvancedViewFallback({
  view,
  onChange,
}: {
  view: AdvancedView;
  onChange: (v: AdvancedView) => void;
}) {
  const { t } = useTranslation();
  const base = "flex items-center gap-1 text-[0.7rem] transition-colors";
  return (
    <div className="flex items-center gap-3 text-muted-foreground">
      <button
        type="button"
        data-testid="advanced-view-tree"
        onClick={() => onChange("tree")}
        aria-pressed={view === "tree"}
        className={cn(base, view === "tree" ? "font-medium text-foreground" : "hover:text-foreground")}
      >
        <ListTree className="h-3 w-3" aria-hidden />
        {t("pipelineGraph.viewTree")}
      </button>
      <button
        type="button"
        data-testid="advanced-view-legacy-form"
        onClick={() => onChange("form")}
        aria-pressed={view === "form"}
        className={cn(base, view === "form" ? "font-medium text-foreground" : "hover:text-foreground")}
      >
        <SlidersHorizontal className="h-3 w-3" aria-hidden />
        {t("pipelineGraph.viewLegacyForm")}
      </button>
    </div>
  );
}

function GraphLegend() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.65rem] text-muted-foreground">
      <span className="flex items-center gap-1">
        <Diamond className="h-3 w-3 text-[color:var(--color-info)]" />
        {t("pipelineGraph.legendDecision")}
      </span>
      <span className="flex items-center gap-1">
        <Square className="h-3 w-3 fill-current" />
        {t("pipelineGraph.legendTerminal")}
      </span>
      <span className="flex items-center gap-1">
        <OctagonX className="h-3 w-3 text-destructive" />
        {t("pipelineGraph.legendStrand")}
      </span>
      <span className="flex items-center gap-1">
        <CircleDot className="h-3 w-3 text-[color:var(--color-warning)]" />
        {t("pipelineGraph.legendFailureGap")}
      </span>
    </div>
  );
}
