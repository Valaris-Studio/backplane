// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Info, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  ContextSourceEntry,
  LifecycleKindName,
  LifecycleStep,
  StageConfig,
} from "../../api/pipelineConfig";
import { SortableLifecycleStep } from "./SortableLifecycleStep";
import { ContextSourcePicker } from "./ContextSourcePicker";
import { ToolDenyEditor } from "./ToolDenyEditor";
import type { DraftStep } from "./lifecycleDraft";
import type { ResolvedLifecycleStepPrompt } from "./LifecycleLLMStepPrompt";

// Map known DEFAULT_PIPELINE_CONFIG roles to their `ui.tooltips.<key>` entry.
// Custom user-authored roles render without a tooltip — graceful fallback.
// Backend's DEFAULT_PIPELINE_CONFIG (workspace_config.py) ships these 5
// roles today: planner, implementer, reviewer, rework_mediator, documentator.
const ROLE_TOOLTIP_KEYS: Record<string, string> = {
  implementer: "roleImplementer",
  reviewer: "roleReviewer",
  documentator: "roleDocumentator",
  planner: "rolePlanner",
  rework_mediator: "roleReworkMediator",
};

interface LifecycleRoleCardProps {
  stage: StageConfig;
  steps: DraftStep[];
  dndId: string;
  knownKinds: LifecycleKindName[];
  workspaceSlug: string;
  // Page-level resolver keyed on `${role}::${stage}`. Optional so isolated
  // tests of the card don't need to mock prompt data.
  resolvedPromptsByKey?: Map<string, ResolvedLifecycleStepPrompt>;
  onStepsChange: (next: DraftStep[]) => void;
  // Edits the stage-level llm.context_sources block — the location the backend
  // assembler reads (assignments.py reads stage.llm.context_sources, NOT step
  // params). Scoped per role/stage, not per LLM step.
  onContextSourcesChange: (next: ContextSourceEntry[]) => void;
  // Edits the stage-level llm.tool_policy.deny block — the deny-list the runner
  // enforces on the coding agent (Claude Code --disallowedTools, Codex execpolicy
  // rules). Same flat-stage location the backend reads.
  onToolDenyChange: (next: string[]) => void;
  onDelete: () => void;
}

export function LifecycleRoleCard({
  stage,
  steps,
  dndId,
  knownKinds,
  workspaceSlug,
  resolvedPromptsByKey,
  onStepsChange,
  onContextSourcesChange,
  onToolDenyChange,
  onDelete,
}: LifecycleRoleCardProps) {
  const { t } = useTranslation();
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: dndId });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const style = { transform: CSS.Transform.toString(transform), transition };

  const peerStepNames = steps.map((s) => s.name);

  const handleStepChange = useCallback(
    (idx: number, next: LifecycleStep) => {
      const updated = [...steps];
      const existing = updated[idx];
      if (!existing) return;
      updated[idx] = { ...next, _dndId: existing._dndId };
      onStepsChange(updated);
    },
    [steps, onStepsChange],
  );

  const handleStepDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIdx = steps.findIndex((s) => s._dndId === active.id);
      const newIdx = steps.findIndex((s) => s._dndId === over.id);
      if (oldIdx < 0 || newIdx < 0) return;
      const next = [...steps];
      const [moved] = next.splice(oldIdx, 1);
      next.splice(newIdx, 0, moved!);
      onStepsChange(next);
    },
    [steps, onStepsChange],
  );

  const addStep = useCallback(() => {
    // Generate a unique step name within this role's lifecycle.
    const base = "step";
    let suffix = steps.length + 1;
    let name = `${base}_${suffix}`;
    while (steps.some((s) => s.name === name)) {
      suffix += 1;
      name = `${base}_${suffix}`;
    }
    const blank: DraftStep = {
      name,
      kind: "discover",
      params: {},
      _dndId: `lcstep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    onStepsChange([...steps, blank]);
  }, [steps, onStepsChange]);

  const requestDelete = useCallback((idx: number) => {
    setPendingDelete(idx);
  }, []);

  const confirmDelete = useCallback(() => {
    if (pendingDelete == null) return;
    const idx = pendingDelete;
    const removedName = steps[idx]?.name;
    let next = steps.filter((_, i) => i !== idx);
    // Clear dangling `next` and `branches` targets that point at the
    // removed step name. Leaves the structure consistent — the user can
    // re-target without seeing a validation error first.
    if (removedName) {
      next = next.map((s) => {
        const out: LifecycleStep & { _dndId: string } = { ...s };
        if (out.next === removedName) out.next = undefined;
        if (out.branches) {
          const branches: Record<string, string> = {};
          for (const [k, v] of Object.entries(out.branches)) {
            if (v !== removedName) branches[k] = v;
          }
          out.branches = Object.keys(branches).length ? branches : undefined;
        }
        return out;
      });
    }
    onStepsChange(next);
    setPendingDelete(null);
  }, [pendingDelete, steps, onStepsChange]);

  const stepCount = steps.length;
  const llmPromptSlugs = collectLLMPromptSlugs(
    steps,
    stage.role,
    resolvedPromptsByKey,
    t("pipeline.lifecycle.role.promptMissingPlaceholder"),
  );
  const llmStepCount = llmPromptSlugs.length;

  // Context sources are assembled for the stage's LLM call, so the picker only
  // makes sense when this role actually runs an LLM step with a stage token.
  const hasLLMStage = steps.some(
    (s) => s.kind === "llm" && Boolean(s.params?.stage),
  );

  const tooltipKey = ROLE_TOOLTIP_KEYS[stage.role];

  return (
    <Card
      ref={setNodeRef}
      style={style}
      data-testid={`lifecycle-role-${stage.role}`}
      // Each role gets its own thicker border + header band so the boundary
      // between roles is unmistakable. The role cards fill the whole pipeline
      // view, so an opaque `bg-card` body reads as a lighter "background" than
      // the rest of the console (overview/graph sit on `--color-background`).
      // Override the Card gradient with a background-toned surface so the form
      // consolidates to the same dark base. `bg-muted/30` tints the header strip
      // against it — re-uses existing tokens, no new design tokens introduced.
      className={cn(
        "border-2 border-border/80 bg-background [background-image:none] shadow-sm",
        isDragging && "opacity-60",
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between rounded-t-[min(var(--radius-cap),calc(var(--radius-xl)-2px))] border-b border-border/60 bg-muted/30 pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="cursor-grab rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
            aria-label={t("pipeline.lifecycle.role.dragHandle")}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <h3 className="text-sm font-semibold">{stage.role}</h3>
          {tooltipKey && (
            <RichTooltip i18nKey={tooltipKey} side="bottom">
              <Info
                data-testid={`lifecycle-role-tooltip-${stage.role}`}
                className="h-3.5 w-3.5 text-muted-foreground/70"
                aria-hidden
              />
            </RichTooltip>
          )}
          <span className="text-xs text-muted-foreground">
            {t("pipeline.lifecycle.role.stepsCount", { count: stepCount })}
          </span>
          <LLMStepSummary count={llmStepCount} slugs={llmPromptSlugs} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addStep}
            data-testid={`lifecycle-add-step-${stage.role}`}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("pipeline.lifecycle.step.add")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
            aria-label={t("pipeline.lifecycle.role.delete")}
            data-testid={`lifecycle-role-delete-${stage.role}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <DndContext sensors={sensors} onDragEnd={handleStepDragEnd}>
          <SortableContext
            items={steps.map((s) => s._dndId)}
            strategy={verticalListSortingStrategy}
          >
            {steps.map((step, idx) => {
              // LLM step's prompt key is `${role}::${params.stage}`. Non-LLM
              // kinds short-circuit the lookup to undefined.
              const stageToken =
                step.kind === "llm" ? step.params?.stage : undefined;
              const resolvedPrompt =
                stageToken && resolvedPromptsByKey
                  ? resolvedPromptsByKey.get(`${stage.role}::${stageToken}`)
                  : undefined;
              return (
                <SortableLifecycleStep
                  key={step._dndId}
                  step={step}
                  dndId={step._dndId}
                  peerStepNames={peerStepNames}
                  knownKinds={knownKinds}
                  role={stage.role}
                  workspaceSlug={workspaceSlug}
                  resolvedPrompt={resolvedPrompt}
                  onChange={(next) => handleStepChange(idx, next)}
                  onDelete={() => requestDelete(idx)}
                />
              );
            })}
          </SortableContext>
        </DndContext>
        {stepCount === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t("pipeline.lifecycle.builder.empty")}
          </p>
        )}

        {hasLLMStage && (
          <div
            data-testid="role-context-sources"
            className="rounded-md border border-border/60 bg-muted/20 p-3"
          >
            <div className="mb-2 flex items-center gap-1">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("pipelineBuilder.llm.contextSources.sectionLabel")}
              </span>
              <RichTooltip i18nKey="pipelineContextSources" side="top">
                <Info
                  className="h-3 w-3 text-muted-foreground/70"
                  aria-hidden
                />
              </RichTooltip>
            </div>
            <ContextSourcePicker
              value={stage.llm?.context_sources ?? []}
              onChange={onContextSourcesChange}
            />
          </div>
        )}

        {hasLLMStage && (
          <div
            data-testid="role-tool-deny"
            className="rounded-md border border-border/60 bg-muted/20 p-3"
          >
            <div className="mb-2 flex items-center gap-1">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("pipelineBuilder.llm.toolPolicy.sectionLabel")}
              </span>
              <RichTooltip i18nKey="pipelineToolPolicy" side="top">
                <Info
                  className="h-3 w-3 text-muted-foreground/70"
                  aria-hidden
                />
              </RichTooltip>
            </div>
            <ToolDenyEditor
              value={stage.llm?.tool_policy?.deny ?? []}
              onChange={onToolDenyChange}
            />
          </div>
        )}
      </CardContent>

      <DeleteStepDialog
        step={pendingDelete != null ? steps[pendingDelete] ?? null : null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </Card>
  );
}

// Walks the role's lifecycle, collects one slug per kind:llm step. An LLM
// step that has no params.stage, or whose stage doesn't resolve, surfaces the
// caller-supplied placeholder so the operator sees the count is honest
// (steps exist) but the prompt is incomplete.
function collectLLMPromptSlugs(
  steps: DraftStep[],
  role: string,
  resolvedPromptsByKey: Map<string, ResolvedLifecycleStepPrompt> | undefined,
  missingPlaceholder: string,
): string[] {
  const slugs: string[] = [];
  for (const step of steps) {
    if (step.kind !== "llm") continue;
    const stageToken = step.params?.stage;
    const resolved =
      stageToken && resolvedPromptsByKey
        ? resolvedPromptsByKey.get(`${role}::${stageToken}`)
        : undefined;
    slugs.push(resolved?.slug ?? missingPlaceholder);
  }
  return slugs;
}

function LLMStepSummary({ count, slugs }: { count: number; slugs: string[] }) {
  const { t } = useTranslation();
  const label = t("pipeline.lifecycle.role.llmStepCount", { count });

  let promptList = "";
  if (count === 1) {
    promptList = t("pipeline.lifecycle.role.promptListSingle", {
      slug: slugs[0],
    });
  } else if (count === 2) {
    promptList = t("pipeline.lifecycle.role.promptListMultiple", {
      slugs: slugs.join(", "),
    });
  } else if (count > 2) {
    promptList = t("pipeline.lifecycle.role.promptListTruncated", {
      visibleSlugs: slugs.slice(0, 2).join(", "),
      moreCount: count - 2,
    });
  }

  return (
    <span
      data-testid="lifecycle-role-llm-summary"
      className="text-xs text-muted-foreground"
    >
      {label}
      {promptList && <span className="ml-1">{`· ${promptList}`}</span>}
    </span>
  );
}

function DeleteStepDialog({
  step,
  onCancel,
  onConfirm,
}: {
  step: LifecycleStep | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!step) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pipeline.lifecycle.step.delete")}</DialogTitle>
          <DialogDescription>
            {t("pipeline.lifecycle.step.deleteConfirm", { name: step.name })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            data-testid="lifecycle-step-delete-confirm"
          >
            {t("pipeline.lifecycle.step.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
