// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type {
  ContextSourceEntry,
  LifecycleKindName,
  LifecycleStep,
} from "../../api/pipelineConfig";
import type { DraftStage, DraftStep } from "../pipeline-builder/lifecycleDraft";
import type { ResolvedLifecycleStepPrompt } from "../pipeline-builder/LifecycleLLMStepPrompt";
import { LifecycleRoleCard } from "../pipeline-builder/LifecycleRoleCard";
import { LifecycleStepEditor } from "../pipeline-builder/LifecycleStepEditor";
import { RolePanel } from "../pipeline-graph/RolePanel";
import { RunnerBindingEditor } from "./RunnerBindingEditor";
import type { CanvasSelection } from "./useCanvasNodeState";

interface CanvasInspectorProps {
  slug: string;
  selection: CanvasSelection;
  /** The draft stage the selection resolves to (role/step selections). */
  stage: DraftStage | null;
  stageIndex: number | null;
  /** Index of the selected step in `stage.lifecycle` (step selections). */
  stepIndex: number | null;
  /** The role node id the selection belongs to — used to build step-row ids. */
  roleNodeId: string | null;
  knownKinds: LifecycleKindName[];
  resolvedPromptsByKey?: Map<string, ResolvedLifecycleStepPrompt>;
  /** Lane selection → the bound runner's agent id + configured role list. */
  laneAgentId: string | null;
  configuredRoles: string[];
  onClose: () => void;
  onStepsChange: (steps: DraftStep[]) => void;
  onContextSourcesChange: (sources: ContextSourceEntry[]) => void;
  onToolDenyChange: (deny: string[]) => void;
  /** Switch the canvas selection (breadcrumb + step-row navigation). */
  onSelect: (selection: CanvasSelection) => void;
  onDeleteRole: () => void;
}

// The context-sensitive right rail, three densities (progressive disclosure):
//  - STEP selection  → a focused single-step editor + a breadcrumb up to the role.
//  - ROLE selection  → a compact summary (clickable step rows) that drills into
//                      the full lifecycle editor (LifecycleRoleCard + RolePanel).
//  - LANE selection  → the runner-role binding editor.
// The step editor is the SAME component the sortable list uses, so edits are
// identical wherever they happen — all writing through onStepsChange.
export function CanvasInspector({
  slug,
  selection,
  stage,
  stageIndex,
  stepIndex,
  roleNodeId,
  knownKinds,
  resolvedPromptsByKey,
  laneAgentId,
  configuredRoles,
  onClose,
  onStepsChange,
  onContextSourcesChange,
  onToolDenyChange,
  onSelect,
  onDeleteRole,
}: CanvasInspectorProps) {
  const { t } = useTranslation();
  // Whether a role selection has been drilled into its full editor. Local view
  // state — RESET on every selection change so a fresh click starts compact.
  const [drilledIn, setDrilledIn] = useState(false);
  const selectionKey =
    selection?.kind === "lane"
      ? `lane:${selection.nodeId}`
      : selection?.kind === "role"
        ? `role:${selection.nodeId}`
        : selection?.kind === "step"
          ? `step:${selection.nodeId}`
          : "none";
  useEffect(() => {
    setDrilledIn(false);
  }, [selectionKey]);

  if (!selection) return null;

  const headerLabel =
    selection.kind === "lane"
      ? t("pipelineGraph.canvas.inspectorRunner")
      : selection.kind === "step"
        ? t("pipelineGraph.canvas.inspectorStep")
        : t("pipelineGraph.canvas.inspectorRole");

  return (
    <aside
      className="flex h-full w-full flex-col gap-3 overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-border/70 bg-card/40 p-3 lg:w-[26rem]"
      aria-label={t("pipelineGraph.canvas.inspector")}
      data-testid="canvas-inspector"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {headerLabel}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("pipelineGraph.canvas.closeInspector")}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pr-1">
        {selection.kind === "lane" ? (
          <RunnerBindingEditor
            slug={slug}
            agentId={laneAgentId}
            configuredRoles={configuredRoles}
          />
        ) : selection.kind === "step" &&
          stage &&
          stageIndex != null &&
          stepIndex != null &&
          stage.lifecycle[stepIndex] ? (
          <FocusedStepView
            slug={slug}
            stage={stage}
            step={stage.lifecycle[stepIndex]!}
            stepIndex={stepIndex}
            roleNodeId={selection.roleNodeId}
            knownKinds={knownKinds}
            resolvedPromptsByKey={resolvedPromptsByKey}
            onStepsChange={onStepsChange}
            onSelect={onSelect}
            onSelectRole={() =>
              onSelect({ kind: "role", nodeId: selection.roleNodeId })
            }
          />
        ) : stage && stageIndex != null && roleNodeId ? (
          drilledIn ? (
            <div className="flex flex-col gap-4">
              <LifecycleRoleCard
                stage={stage}
                steps={stage.lifecycle}
                dndId={stage._dndId}
                knownKinds={knownKinds}
                workspaceSlug={slug}
                resolvedPromptsByKey={resolvedPromptsByKey}
                onStepsChange={onStepsChange}
                onContextSourcesChange={onContextSourcesChange}
                onToolDenyChange={onToolDenyChange}
                onDelete={onDeleteRole}
              />
              <div className="min-h-[18rem]">
                <RolePanel slug={slug} stage={stage} />
              </div>
            </div>
          ) : (
            <RoleSummaryView
              stage={stage}
              roleNodeId={roleNodeId}
              onSelectStep={(stepNodeId) =>
                onSelect({ kind: "step", nodeId: stepNodeId, roleNodeId })
              }
              onEditFull={() => setDrilledIn(true)}
            />
          )
        ) : null}
      </div>
    </aside>
  );
}

// Compact role summary: name + step count + one clickable row per lifecycle
// step, plus a drill-in into the full editor. Delete-role lives ONLY inside the
// full editor (safe: no destructive affordance in the glance-level view).
function RoleSummaryView({
  stage,
  roleNodeId,
  onSelectStep,
  onEditFull,
}: {
  stage: DraftStage;
  roleNodeId: string;
  onSelectStep: (stepNodeId: string) => void;
  onEditFull: () => void;
}) {
  const { t } = useTranslation();
  // Annotated as DraftStep[] so `_dndId` survives the DraftStage intersection
  // (StageConfig.lifecycle is the wider optional LifecycleStep[]).
  const steps: DraftStep[] = stage.lifecycle;
  return (
    <div className="flex flex-col gap-3" data-testid="inspector-role-summary">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-foreground">
          {stage.role}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("pipeline.lifecycle.role.stepsCount", { count: steps.length })}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("pipelineGraph.canvas.inspectorRoleSteps")}
        </span>
        {steps.map((step) => (
          <button
            key={step._dndId}
            type="button"
            data-testid={`inspector-step-row-${step.name}`}
            onClick={() => onSelectStep(`${roleNodeId}//${step.name}`)}
            className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-card/60 px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-card"
          >
            <span className="truncate text-sm text-foreground">{step.name}</span>
            <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
              {step.kind}
            </code>
          </button>
        ))}
      </div>

      <button
        type="button"
        data-testid="inspector-edit-full-role"
        onClick={onEditFull}
        className="mt-1 rounded-md border border-border/70 bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        {t("pipelineGraph.canvas.inspectorEditFullRole")}
      </button>
    </div>
  );
}

// Focused single-step view: breadcrumb back to the role + only this step's
// editor (same component the sortable list uses). Edits replace the step at its
// index and pass the full array back through onStepsChange.
function FocusedStepView({
  slug,
  stage,
  step,
  stepIndex,
  roleNodeId,
  knownKinds,
  resolvedPromptsByKey,
  onStepsChange,
  onSelect,
  onSelectRole,
}: {
  slug: string;
  stage: DraftStage;
  step: DraftStep;
  stepIndex: number;
  roleNodeId: string;
  knownKinds: LifecycleKindName[];
  resolvedPromptsByKey?: Map<string, ResolvedLifecycleStepPrompt>;
  onStepsChange: (steps: DraftStep[]) => void;
  onSelect: (selection: CanvasSelection) => void;
  onSelectRole: () => void;
}) {
  const { t } = useTranslation();
  const steps: DraftStep[] = stage.lifecycle;
  const peerStepNames = steps.map((s) => s.name);
  const stageToken = step.kind === "llm" ? step.params?.stage : undefined;
  const resolvedPrompt =
    stageToken && resolvedPromptsByKey
      ? resolvedPromptsByKey.get(`${stage.role}::${stageToken}`)
      : undefined;

  function replaceStep(next: LifecycleStep) {
    const updated = [...steps];
    const existing = updated[stepIndex];
    if (!existing) return;
    // The editor emits a plain LifecycleStep; re-attach the stable dnd id so
    // the step keeps its identity across the sortable list.
    updated[stepIndex] = { ...next, _dndId: existing._dndId };
    onStepsChange(updated);
    // A step's nodeId is `${roleNodeId}//${name}`, so a rename orphans the
    // current selection (its old name no longer resolves) and the focused view
    // would collapse. Re-point the selection to the renamed step's nodeId.
    if (next.name !== step.name) {
      onSelect({
        kind: "step",
        nodeId: `${roleNodeId}//${next.name}`,
        roleNodeId,
      });
    }
  }

  function deleteStep() {
    onStepsChange(steps.filter((_, i) => i !== stepIndex));
  }

  return (
    <div className="flex flex-col gap-3" data-testid="inspector-step-focus">
      <button
        type="button"
        data-testid="inspector-breadcrumb-role"
        onClick={onSelectRole}
        className="flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {t("pipelineGraph.canvas.inspectorBackToRole", { role: stage.role })}
      </button>

      <LifecycleStepEditor
        step={step}
        peerStepNames={peerStepNames}
        knownKinds={knownKinds}
        role={stage.role}
        workspaceSlug={slug}
        resolvedPrompt={resolvedPrompt}
        onChange={(next) => replaceStep(next)}
        onDelete={deleteStep}
      />
    </div>
  );
}
