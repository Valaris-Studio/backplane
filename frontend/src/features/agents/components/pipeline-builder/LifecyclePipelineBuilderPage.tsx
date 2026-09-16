// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CompletionContextWarning } from "@/features/kanban/components/CompletionContextWarning";

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ArrowLeft, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { usePromptConfigs, usePromptDefaults } from "../../hooks/usePromptConfigs";
import { useLifecycleKinds } from "../../api/lifecycleKinds";
import { useRunnerBasePath } from "../../hooks/useRunnerBasePath";
import {
  useLifecycleDraft,
  type UseLifecycleDraft,
} from "../../hooks/useLifecycleDraft";
import type { ResolvedLifecycleStepPrompt } from "./LifecycleLLMStepPrompt";
import type { LifecycleKindName } from "../../api/pipelineConfig";
import type { LifecycleTemplateKey } from "../../utils/lifecycleTemplates";
import { LifecycleRoleCard } from "./LifecycleRoleCard";
import { AddRoleDialog } from "./AddRoleDialog";
import { ValidationSummary } from "./ValidationSummary";

// Fallback Select options for the brief window between `remoteLoading`
// resolving and GET /api/config/lifecycle-kinds returning. Authoritative
// source is the live endpoint; this list exists to avoid an empty add-step
// dropdown during the race window.
//
// `satisfies readonly LifecycleKindName[]` makes TypeScript flag drift: if
// `LifecycleKindName` gains a new member and we forget to add it here, the
// `satisfies` check still passes (subset is fine), but if we add a typo or
// a value not in the union, tsc errors. The drift-test in
// LifecycleBuilder.test.tsx is the second guardrail — it asserts this list
// matches the union exactly.
export const FALLBACK_KINDS = [
  "discover",
  "claim",
  "git_setup",
  "skills_setup",
  "llm",
  "sensor",
  "move_card",
  "apply_label",
  "remove_label",
  "create_note",
  "enqueue_for_merge",
  "mcp_call",
  "create_fix_cards",
  "branch",
  "wake_role",
  "create_pr",
  "enable_auto_merge",
  "merge_pr",
  "post_pr_review",
  "ship",
  "end",
] as const satisfies readonly LifecycleKindName[];

// The lifecycle DSL form editor — the "Advanced" escape hatch behind the
// pipeline graph. All draft state, validation, and the save path live in the
// shared `useLifecycleDraft` hook so this form and the graph canvas edit ONE
// draft and share ONE save path. When rendered inside the Runner Console the
// caller injects that shared instance via `draft`; standalone (own route /
// tests) it mounts its own.
export function LifecyclePipelineBuilderPage({
  draft: injectedDraft,
}: {
  draft?: UseLifecycleDraft;
} = {}) {
  const { slug = "" } = useParams<{ slug: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { overview: agentsHome } = useRunnerBasePath();

  const { isAdmin, isLoading: adminLoading } = useWorkspaceAdmin(slug);
  const { data: kindsData } = useLifecycleKinds();
  const { data: promptConfigs } = usePromptConfigs(slug);
  const { data: promptDefaults } = usePromptDefaults(slug);

  const ownDraft = useLifecycleDraft(slug);
  const {
    draft,
    loading: remoteLoading,
    dirty,
    saving,
    errors,
    summaryFindings,
    setStageSteps,
    setStageContextSources,
    setStageToolDeny,
    reorderRoles,
    addRole,
    deleteRole,
    reset,
    save,
  } = injectedDraft ?? ownDraft;

  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [pendingRoleDelete, setPendingRoleDelete] = useState<number | null>(null);

  // Page-level resolver: keyed on `${role}::${stage}`. Defaults seed first;
  // workspace overrides overwrite — so `isCustom` is purely "which query
  // produced this entry last". Threaded down to each LifecycleRoleCard
  // pre-filtered to that role's entries; per-step lookup happens inside
  // SortableLifecycleStep.
  const resolvedPromptsByKey = useMemo(() => {
    const map = new Map<string, ResolvedLifecycleStepPrompt>();
    for (const d of promptDefaults ?? []) {
      map.set(`${d.role}::${d.stage}`, {
        stepName: "",
        stageToken: d.stage,
        role: d.role,
        slug: d.slug,
        contentPreview: d.default_content,
        workspaceSlug: slug,
        isCustom: false,
        isMissing: false,
      });
    }
    for (const c of promptConfigs ?? []) {
      if (!c.team_role || !c.stage) continue;
      map.set(`${c.team_role}::${c.stage}`, {
        stepName: "",
        stageToken: c.stage,
        role: c.team_role,
        slug: c.slug,
        contentPreview: c.content,
        workspaceSlug: slug,
        isCustom: true,
        isMissing: false,
      });
    }
    return map;
  }, [promptConfigs, promptDefaults, slug]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const knownKinds = useMemo<LifecycleKindName[]>(() => {
    if (!kindsData) return [...FALLBACK_KINDS];
    return Object.keys(kindsData.kinds) as LifecycleKindName[];
  }, [kindsData]);

  const handleRoleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      reorderRoles(String(active.id), String(over.id));
    },
    [reorderRoles],
  );

  const handleAddRole = useCallback(
    (name: string, template: LifecycleTemplateKey) => addRole(name, template),
    [addRole],
  );

  const handleDeleteRole = useCallback(() => {
    if (pendingRoleDelete == null) return;
    deleteRole(pendingRoleDelete);
    setPendingRoleDelete(null);
  }, [pendingRoleDelete, deleteRole]);

  const handleSave = useCallback(() => {
    save({
      onSuccess: () => toast.success(t("pipeline.lifecycle.savedToast")),
    });
  }, [save, t]);

  if (adminLoading || remoteLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate(agentsHome)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("agents.title")}
        </Button>
        <p className="text-sm text-destructive">
          {t("pipelineBuilder.adminRequired")}
        </p>
      </div>
    );
  }

  if (!draft) return null;

  const existingRoles = draft.map((s) => s.role);
  const hasErrors = errors.length > 0;

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <CompletionContextWarning slug={slug} sourceKind="configuration" />
      <PageHeader
        title={t("pipeline.lifecycle.builder.title")}
        description={t("pipeline.lifecycle.builder.subtitle")}
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate(agentsHome)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("agents.title")}
            </Button>
            <Button
              variant="outline"
              onClick={reset}
              disabled={!dirty || saving}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              {t("pipelineBuilder.reset")}
            </Button>
            <Button
              onClick={handleSave}
              disabled={hasErrors || !dirty || saving}
              data-testid="lifecycle-save"
            >
              {saving ? t("common.saving") : t("pipeline.lifecycle.save")}
            </Button>
          </>
        }
      />

      <ValidationSummary errors={summaryFindings} />

      {/* Roles are rendered as a flat vertical stack — NOT inside an outer
        Card. Each LifecycleRoleCard is itself a Card with its own border;
        wrapping them all in one container fused the boundaries visually
        (the original phase-8 complaint). The "Add role" button sits at the
        section head so the affordance stays obvious. */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {t("pipeline.lifecycle.builder.title")}
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddRoleOpen(true)}
            data-testid="lifecycle-add-role"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("pipeline.lifecycle.role.add")}
          </Button>
        </div>
        {draft.length === 0 ? (
          <p
            data-testid="lifecycle-builder-empty"
            className="py-8 text-center text-sm text-muted-foreground"
          >
            {t("pipeline.lifecycle.builder.empty")}
          </p>
        ) : (
          <DndContext sensors={sensors} onDragEnd={handleRoleDragEnd}>
            <SortableContext
              items={draft.map((s) => s._dndId)}
              strategy={verticalListSortingStrategy}
            >
              <div
                data-testid="lifecycle-roles-list"
                data-dnd-ids={draft.map((s) => s._dndId).join(",")}
                className="space-y-5"
              >
                {draft.map((stage, idx) => (
                  <LifecycleRoleCard
                    key={stage._dndId}
                    stage={stage}
                    steps={stage.lifecycle}
                    dndId={stage._dndId}
                    knownKinds={knownKinds}
                    workspaceSlug={slug}
                    resolvedPromptsByKey={resolvedPromptsByKey}
                    onStepsChange={(next) => setStageSteps(idx, next)}
                    onContextSourcesChange={(next) =>
                      setStageContextSources(idx, next)
                    }
                    onToolDenyChange={(next) => setStageToolDeny(idx, next)}
                    onDelete={() => setPendingRoleDelete(idx)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </section>

      <AddRoleDialog
        open={addRoleOpen}
        existingRoles={existingRoles}
        onOpenChange={setAddRoleOpen}
        onSubmit={handleAddRole}
      />

      <DeleteRoleDialog
        role={
          pendingRoleDelete != null
            ? (draft[pendingRoleDelete]?.role ?? null)
            : null
        }
        onCancel={() => setPendingRoleDelete(null)}
        onConfirm={handleDeleteRole}
      />
    </div>
  );
}

function DeleteRoleDialog({
  role,
  onCancel,
  onConfirm,
}: {
  role: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!role) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pipeline.lifecycle.role.delete")}</DialogTitle>
          <DialogDescription>
            {t("pipeline.lifecycle.role.deleteConfirm", { role })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            data-testid="lifecycle-role-delete-confirm"
          >
            {t("pipeline.lifecycle.role.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
