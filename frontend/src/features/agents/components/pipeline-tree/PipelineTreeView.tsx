// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { TreePill } from "./TreePill";
import { TreeDisclosure } from "./TreeDisclosure";
import { CanvasSaveBar } from "../pipeline-canvas/CanvasSaveBar";
import { LifecycleStepEditor } from "../pipeline-builder/LifecycleStepEditor";
import { ContextSourcePicker } from "../pipeline-builder/ContextSourcePicker";
import { ToolDenyEditor } from "../pipeline-builder/ToolDenyEditor";
import { AddRoleDialog } from "../pipeline-builder/AddRoleDialog";
import type { LifecycleTemplateKey } from "../../utils/lifecycleTemplates";
import {
  configNodeId,
  propertyGroupNodeId,
  pruneNodeIds,
  schedulingNodeId,
  usePipelineTreeState,
} from "./usePipelineTreeState";
import { useTreeNavigation, type TreeNavigation } from "./useTreeNavigation";
import { buildTreeErrorIndex } from "./treeErrorIndex";
import {
  rolePropertyGroups,
  stepPropertyGroups,
  type TreePropertyGroup,
} from "./treeProperties";
import type { DraftStage, DraftStep } from "../pipeline-builder/lifecycleDraft";
import type { UseLifecycleDraft } from "../../hooks/useLifecycleDraft";
import type {
  ContextSourceEntry,
  LifecycleKindName,
  LifecycleStep,
  SchedulingDef,
} from "../../api/pipelineConfig";
import { useLifecycleKinds } from "../../api/lifecycleKinds";
import { FALLBACK_KINDS } from "../pipeline-builder/LifecyclePipelineBuilderPage";

// Tree over the SHARED lifecycle draft — cards 2-3 of the Advanced-page revamp.
// It renders config → roles → steps → properties as collapsible pills, and a
// property group can reveal the SAME editor the Advanced form mounts, bound to
// the same draft setters. The tree owns no editing logic of its own: that is
// what keeps "edit here" and "edit in the form" the same operation rather than
// two implementations that drift.

export interface PipelineTreeViewProps {
  /** The instance lifted in RunnerPipelineTab — never mount a second one. */
  draft: UseLifecycleDraft;
  scheduling: SchedulingDef;
  /** Needed by the LLM step editor's prompt deep-links; absent in isolated tests. */
  workspaceSlug?: string;
}

export function PipelineTreeView({
  draft,
  scheduling,
  workspaceSlug = "",
}: PipelineTreeViewProps) {
  const { t } = useTranslation();
  const stages = useMemo(() => draft.draft ?? [], [draft.draft]);
  const { data: kindsData } = useLifecycleKinds();

  // Config + every role open, steps closed: enough shape to orient, few enough
  // pills to scan. Collapse-all returns HERE rather than to an empty map, which
  // would leave the operator staring at a single pill.
  const defaultExpanded = useMemo(
    () => [configNodeId(), ...stages.map((s) => s._dndId)],
    [stages],
  );

  const tree = usePipelineTreeState({ defaultExpanded });

  // Which property groups have their editor revealed. Kept as a plain node-id
  // set for the same reason expansion is: the north-star diagram needs this
  // state serializable, not scattered across component-local booleans.
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
  const toggleEditing = useCallback((nodeId: string) => {
    setEditing((prev) => {
      const next = new Set(prev);
      if (!next.delete(nodeId)) next.add(nodeId);
      return next;
    });
  }, []);

  const knownKinds = useMemo<LifecycleKindName[]>(() => {
    if (!kindsData) return [...FALLBACK_KINDS];
    return Object.keys(kindsData.kinds) as LifecycleKindName[];
  }, [kindsData]);

  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const [addingRole, setAddingRole] = useState(false);

  // Every id the draft can still justify. A removed role or step must not leave
  // expansion or editing entries behind: a later node that reuses the id (both
  // are name-derived) would silently inherit the dead node's open state.
  const liveNodeIds = useMemo(
    () => [
      configNodeId(),
      schedulingNodeId(),
      ...stages.flatMap((stage) => [
        stage._dndId,
        ...(stage.lifecycle ?? []).map((step: DraftStep) => step._dndId),
      ]),
    ],
    [stages],
  );

  const { prune } = tree;
  useEffect(() => {
    prune(liveNodeIds);
    setEditing((prev) => {
      const next = pruneNodeIds(prev, liveNodeIds);
      return next.size === prev.size ? prev : next;
    });
  }, [liveNodeIds, prune]);

  const treeRef = useRef<HTMLDivElement | null>(null);
  const { setExpanded, expandAll } = tree;
  const nav = useTreeNavigation({
    containerRef: treeRef,
    expand: useCallback(
      (nodeId: string) => setExpanded({ ...tree.expanded, [nodeId]: true }),
      [setExpanded, tree.expanded],
    ),
    collapse: useCallback(
      (nodeId: string) => {
        const next = { ...tree.expanded };
        // eslint's varsIgnorePattern is off, so destructure-and-drop errors —
        // and the hook's own contract is "collapsed keys are absent", not false.
        delete next[nodeId];
        setExpanded(next);
      },
      [setExpanded, tree.expanded],
    ),
    liveNodeIds,
  });

  // Every id in the tree, including the property groups that only exist while
  // their owner is open — expand-all has to reach those too or "all" is a lie.
  const allNodeIds = useMemo(
    () => [
      configNodeId(),
      schedulingNodeId(),
      ...stages.flatMap((stage) => [
        stage._dndId,
        ...rolePropertyGroups(stage).map((g) => propertyGroupNodeId(stage._dndId, g.group)),
        ...(stage.lifecycle ?? []).flatMap((step: DraftStep) => [
          step._dndId,
          ...stepPropertyGroups(step).map((g) => propertyGroupNodeId(step._dndId, g.group)),
        ]),
      ]),
    ],
    [stages],
  );

  const { focusNodeSoon } = nav;
  // Deep link: ?role=<role name>[&step=<step name>] opens the path to that node
  // and focuses it. Params are NAMES, not _dndIds — a _dndId is a render-time
  // identity nobody can type or bookmark. Applied once per param change; an
  // unknown name is ignored rather than throwing, because a pipeline can be
  // renamed after a link is shared.
  const [searchParams] = useSearchParams();
  const roleParam = searchParams.get("role");
  const stepParam = searchParams.get("step");
  useEffect(() => {
    if (!roleParam) return;
    const stage = stages.find((s) => s.role === roleParam);
    if (!stage) return;
    const step = stepParam
      ? (stage.lifecycle ?? []).find((s: DraftStep) => s.name === stepParam)
      : undefined;
    // Open every ancestor on the path, or the target is still unmounted when
    // focus reaches for it. The deepest resolved node is what gets focused.
    const target = step?._dndId ?? stage._dndId;
    expandAll([configNodeId(), stage._dndId, target]);
    focusNodeSoon(target);
  }, [roleParam, stepParam, stages, expandAll, focusNodeSoon]);

  const errorIndex = useMemo(
    () => buildTreeErrorIndex(stages, draft.summaryFindings ?? []),
    [stages, draft.summaryFindings],
  );

  // The tree edits through the SAME setters the form uses. Binding by stage
  // INDEX (not _dndId) matches setStageSteps' contract; _dndId is preserved on
  // the rewritten step so tree identity survives the edit.
  const editContext = useMemo<TreeEditContext>(
    () => ({
      knownKinds,
      workspaceSlug,
      isEditing: (nodeId: string) => editing.has(nodeId),
      toggleEditing,
      onStepChange: (stageIdx: number, step: DraftStep, next: LifecycleStep) => {
        // StageConfig declares `lifecycle` optional while DraftStage narrows it
        // to DraftStep[]; the annotation keeps the _dndId identity visible.
        const steps: DraftStep[] = stages[stageIdx]?.lifecycle ?? [];
        draft.setStageSteps(
          stageIdx,
          steps.map((s) =>
            s._dndId === step._dndId
              ? ({ ...next, _dndId: step._dndId } as DraftStep)
              : s,
          ),
        );
      },
      onContextSourcesChange: (stageIdx: number, sources: ContextSourceEntry[]) =>
        draft.setStageContextSources(stageIdx, sources),
      onToolDenyChange: (stageIdx: number, deny: string[]) =>
        draft.setStageToolDeny(stageIdx, deny),
      onAddStep: (stageIdx: number, kind: LifecycleKindName) => {
        const steps: DraftStep[] = stages[stageIdx]?.lifecycle ?? [];
        draft.setStageSteps(stageIdx, [...steps, blankStep(steps, kind)]);
      },
      onMoveStep: (stageIdx: number, stepDndId: string, delta: 1 | -1) => {
        const steps: DraftStep[] = stages[stageIdx]?.lifecycle ?? [];
        const moved = moveByDndId(steps, stepDndId, delta);
        if (moved) draft.setStageSteps(stageIdx, moved);
      },
      // Roles reorder through reorderRoles, which is keyed by _dndId while the
      // stage setters are keyed by index — the one asymmetry in the draft API.
      onMoveRole: (stageIdx: number, delta: 1 | -1) => {
        const from = stages[stageIdx];
        const to = stages[stageIdx + delta];
        if (from && to) draft.reorderRoles(from._dndId, to._dndId);
      },
      requestRemove: setPendingRemoval,
      nav,
    }),
    [knownKinds, workspaceSlug, editing, toggleEditing, stages, draft, nav],
  );

  const confirmRemoval = useCallback(() => {
    if (!pendingRemoval) return;
    if (pendingRemoval.scope === "role") {
      draft.deleteRole(pendingRemoval.stageIdx);
    } else {
      const steps: DraftStep[] = stages[pendingRemoval.stageIdx]?.lifecycle ?? [];
      draft.setStageSteps(
        pendingRemoval.stageIdx,
        removeStep(steps, pendingRemoval.stepDndId),
      );
    }
    setPendingRemoval(null);
  }, [pendingRemoval, stages, draft]);

  const addRole = useCallback(
    (name: string, template: LifecycleTemplateKey) => draft.addRole(name, template),
    [draft],
  );

  // Both the populated tree and the empty state need the add-role affordance
  // and the dialogs — an empty pipeline is exactly when adding a role matters.
  const dialogs = (
    <>
      <AddRoleDialog
        open={addingRole}
        existingRoles={stages.map((s) => s.role)}
        onOpenChange={setAddingRole}
        onSubmit={addRole}
      />
      <RemoveConfirmDialog
        pending={pendingRemoval}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={confirmRemoval}
      />
    </>
  );

  const addRoleButton = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="tree-add-role"
      onClick={() => setAddingRole(true)}
    >
      <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
      {t("pipelineTree.addRole")}
    </Button>
  );

  if (stages.length === 0) {
    return (
      <div className="flex min-h-[12rem] flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-border/70 p-8 text-center">
        <p className="text-sm font-medium">{t("pipelineTree.emptyTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("pipelineTree.emptyHint")}</p>
        {addRoleButton}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 overflow-auto p-1">
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="tree-expand-all"
          onClick={() => expandAll(allNodeIds)}
        >
          <ChevronsUpDown className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t("pipelineTree.expandAll")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="tree-collapse-all"
          onClick={() => setExpanded(Object.fromEntries(defaultExpanded.map((id) => [id, true])))}
        >
          <ChevronsDownUp className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t("pipelineTree.collapseAll")}
        </Button>
        {addRoleButton}
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label={t("pipelineTree.treeLabel")}
        className="flex flex-col gap-2"
      >
      <div data-tree-node>
      <TreePill
        nodeKind="config"
        nodeId={configNodeId()}
        label={t("pipelineTree.nodeKind.config")}
        summary={t("pipelineTree.configSummary", {
          version: draft.version ?? "—",
          count: stages.length,
        })}
        expanded={tree.isExpanded(configNodeId())}
        onToggle={() => tree.toggle(configNodeId())}
        errorCount={errorIndex.total}
        badge={<ErrorBadge count={errorIndex.total} />}
        {...navProps(editContext, configNodeId(), tree.isExpanded(configNodeId()), true, true)}
      />

      <TreeDisclosure nodeId={configNodeId()} open={tree.isExpanded(configNodeId())}>
        <div className="flex flex-col gap-2 border-l border-border/60 pl-4 pt-2">
          <div data-tree-node>
          <TreePill
            nodeKind="scheduling"
            nodeId={schedulingNodeId()}
            label={t("pipelineTree.nodeKind.scheduling")}
            summary={t("pipelineTree.schedulingSummary", {
              mode: scheduling.mode,
              order: scheduling.priority_order.join(" → ") || "—",
            })}
            {...navProps(editContext, schedulingNodeId(), false, false)}
          />
          </div>
          {stages.map((stage, stageIdx) => (
            <RoleNode
              key={stage._dndId}
              stage={stage}
              stageIdx={stageIdx}
              isFirst={stageIdx === 0}
              isLast={stageIdx === stages.length - 1}
              tree={tree}
              errorCountFor={errorIndex.countFor}
              edit={editContext}
            />
          ))}
        </div>
      </TreeDisclosure>
      </div>
      </div>

      {/* The canvas's save bar, not a second one: same draft, same dirty/error
          gating, so all three views agree on when a save is allowed. */}
      <div className="pointer-events-none sticky bottom-2 flex justify-end pt-2">
        <CanvasSaveBar
          dirty={draft.dirty}
          saving={draft.saving}
          errorCount={draft.errors?.length ?? 0}
          onSave={() => draft.save()}
          onDiscard={draft.reset}
        />
      </div>
      {dialogs}
    </div>
  );
}

// Step defaults match LifecycleRoleCard.addStep exactly — same unique `step_N`
// naming and the same empty params (the form clears params on kind change), so
// a step added here is byte-identical to one added in the form.
function blankStep(steps: readonly DraftStep[], kind: LifecycleKindName): DraftStep {
  let suffix = steps.length + 1;
  let name = `step_${suffix}`;
  while (steps.some((s) => s.name === name)) {
    suffix += 1;
    name = `step_${suffix}`;
  }
  return {
    name,
    kind,
    params: {},
    _dndId: `lcstep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  } as DraftStep;
}

function moveByDndId(
  steps: readonly DraftStep[],
  dndId: string,
  delta: 1 | -1,
): DraftStep[] | null {
  const from = steps.findIndex((s) => s._dndId === dndId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= steps.length) return null;
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

// Mirrors the form's confirmDelete: dropping a step also clears `next` and
// `branches` targets that pointed at it, so both removal paths leave the same
// consistent structure instead of one of them stranding a validation error.
function removeStep(steps: readonly DraftStep[], dndId: string): DraftStep[] {
  const removedName = steps.find((s) => s._dndId === dndId)?.name;
  const remaining = steps.filter((s) => s._dndId !== dndId);
  if (!removedName) return remaining;
  return remaining.map((step) => {
    const out: DraftStep = { ...step };
    if (out.next === removedName) out.next = undefined;
    if (out.branches) {
      const branches = Object.fromEntries(
        Object.entries(out.branches).filter(([, target]) => target !== removedName),
      );
      out.branches = Object.keys(branches).length > 0 ? branches : undefined;
    }
    return out;
  });
}

// The editing seam. Passing ONE object keeps the node components' signatures
// stable as card 4 adds structure operations.
interface TreeEditContext {
  knownKinds: LifecycleKindName[];
  workspaceSlug: string;
  isEditing: (nodeId: string) => boolean;
  toggleEditing: (nodeId: string) => void;
  onStepChange: (stageIdx: number, step: DraftStep, next: LifecycleStep) => void;
  onContextSourcesChange: (stageIdx: number, sources: ContextSourceEntry[]) => void;
  onToolDenyChange: (stageIdx: number, deny: string[]) => void;
  // Structure operations (card 4). They live here rather than as new props on
  // every node component, which is what keeps RoleNode/StepNode signatures
  // stable as the tree grows toward the north-star diagram.
  onAddStep: (stageIdx: number, kind: LifecycleKindName) => void;
  onMoveStep: (stageIdx: number, stepDndId: string, delta: 1 | -1) => void;
  onMoveRole: (stageIdx: number, delta: 1 | -1) => void;
  requestRemove: (target: PendingRemoval) => void;
  /** Roving tabindex + arrow traversal (card 5). */
  nav: TreeNavigation;
}

/** What a confirm dialog is currently asking about; null ⇒ nothing pending. */
type PendingRemoval =
  | { scope: "role"; stageIdx: number; label: string }
  | { scope: "step"; stageIdx: number; stepDndId: string; label: string };

type TreeState = ReturnType<typeof usePipelineTreeState>;

// The roving-tabindex wiring every pill needs, in one place so a new node kind
// cannot join the tree with half of it. `isFirstNode` marks the pill that holds
// the tab stop before anything has been focused.
function navProps(
  edit: TreeEditContext,
  nodeId: string,
  expanded: boolean,
  toggleable: boolean,
  isFirstNode = false,
) {
  return {
    tabbable: edit.nav.isTabbable(nodeId, isFirstNode),
    onFocus: () => edit.nav.onNodeFocus(nodeId),
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
      edit.nav.handleKeyDown(event, { nodeId, expanded, toggleable }),
  };
}

function RoleNode({
  stage,
  stageIdx,
  isFirst,
  isLast,
  tree,
  errorCountFor,
  edit,
}: {
  stage: DraftStage;
  stageIdx: number;
  isFirst: boolean;
  isLast: boolean;
  tree: TreeState;
  errorCountFor: (nodeId: string) => number;
  edit: TreeEditContext;
}) {
  const { t } = useTranslation();
  const open = tree.isExpanded(stage._dndId);
  // DraftStage narrows lifecycle to DraftStep[]; the `??` guards the legacy
  // configs where StageConfig still declares it optional.
  const steps: DraftStep[] = stage.lifecycle ?? [];
  const groups = rolePropertyGroups(stage);

  return (
    <div className="flex flex-col gap-2" data-tree-node>
      <div className="flex items-center gap-1">
        <TreePill
          nodeKind="role"
          nodeId={stage._dndId}
          label={stage.role}
          summary={t("pipelineTree.roleSummary", { count: steps.length })}
          expanded={open}
          onToggle={() => tree.toggle(stage._dndId)}
          errorCount={errorCountFor(stage._dndId)}
          badge={<ErrorBadge count={errorCountFor(stage._dndId)} />}
          className="flex-1"
          {...navProps(edit, stage._dndId, open, true)}
        />
        <StructureControls
          nodeId={stage._dndId}
          label={stage.role}
          canMoveUp={!isFirst}
          canMoveDown={!isLast}
          onMoveUp={() => edit.onMoveRole(stageIdx, -1)}
          onMoveDown={() => edit.onMoveRole(stageIdx, 1)}
          onRemove={() =>
            edit.requestRemove({ scope: "role", stageIdx, label: stage.role })
          }
        />
      </div>
      <TreeDisclosure nodeId={stage._dndId} open={open}>
        <div className="flex flex-col gap-2 border-l border-border/60 pl-4">
          {steps.map((step, stepIdx) => (
            <StepNode
              key={step._dndId}
              step={step}
              stageIdx={stageIdx}
              isFirst={stepIdx === 0}
              isLast={stepIdx === steps.length - 1}
              tree={tree}
              errorCountFor={errorCountFor}
              edit={edit}
            />
          ))}
          <AddStepControl stageIdx={stageIdx} roleNodeId={stage._dndId} edit={edit} />
          {groups.map((group) => (
            <PropertyGroupNode
              key={group.group}
              ownerNodeId={stage._dndId}
              group={group}
              tree={tree}
              edit={edit}
              editor={roleGroupEditor(group.group, stage, stageIdx, edit)}
            />
          ))}
        </div>
      </TreeDisclosure>
    </div>
  );
}

function StepNode({
  step,
  stageIdx,
  isFirst,
  isLast,
  tree,
  errorCountFor,
  edit,
}: {
  step: DraftStep;
  stageIdx: number;
  isFirst: boolean;
  isLast: boolean;
  tree: TreeState;
  errorCountFor: (nodeId: string) => number;
  edit: TreeEditContext;
}) {
  const { t } = useTranslation();
  const open = tree.isExpanded(step._dndId);
  const groups = stepPropertyGroups(step);

  return (
    <div className="flex flex-col gap-2" data-tree-node>
      <div className="flex items-center gap-1">
        <TreePill
          nodeKind="step"
          nodeId={step._dndId}
          stepKind={step.kind}
          label={step.name}
          summary={t("pipelineTree.stepSummary", { kind: step.kind })}
          expanded={open}
          onToggle={groups.length > 0 ? () => tree.toggle(step._dndId) : undefined}
          errorCount={errorCountFor(step._dndId)}
          badge={<ErrorBadge count={errorCountFor(step._dndId)} />}
          className="flex-1"
          {...navProps(edit, step._dndId, open, groups.length > 0)}
        />
        <StructureControls
          nodeId={step._dndId}
          label={step.name}
          canMoveUp={!isFirst}
          canMoveDown={!isLast}
          onMoveUp={() => edit.onMoveStep(stageIdx, step._dndId, -1)}
          onMoveDown={() => edit.onMoveStep(stageIdx, step._dndId, 1)}
          onRemove={() =>
            edit.requestRemove({
              scope: "step",
              stageIdx,
              stepDndId: step._dndId,
              label: step.name,
            })
          }
        />
      </div>
      {groups.length > 0 ? (
        <TreeDisclosure nodeId={step._dndId} open={open}>
          <div className="flex flex-col gap-2 border-l border-border/60 pl-4">
            {groups.map((group) => (
              <PropertyGroupNode
                key={group.group}
                ownerNodeId={step._dndId}
                group={group}
                tree={tree}
                edit={edit}
                // LifecycleStepEditor edits the WHOLE step (name, kind, params,
                // routing), so it hangs off `params` — the canonical group —
                // rather than being duplicated under `routing` as a second
                // instance competing for the same state.
                editor={
                  group.group === "params" ? (
                    <LifecycleStepEditor
                      step={step}
                      peerStepNames={[]}
                      knownKinds={edit.knownKinds}
                      role=""
                      workspaceSlug={edit.workspaceSlug}
                      onChange={(next) => edit.onStepChange(stageIdx, step, next)}
                      onDelete={() => {}}
                    />
                  ) : null
                }
              />
            ))}
          </div>
        </TreeDisclosure>
      ) : null}
    </div>
  );
}

function PropertyGroupNode({
  ownerNodeId,
  group,
  tree,
  edit,
  editor,
}: {
  ownerNodeId: string;
  group: TreePropertyGroup;
  tree: TreeState;
  edit: TreeEditContext;
  /** Absent ⇒ this group has no editor yet and stays read-only. */
  editor?: ReactNode;
}) {
  const { t } = useTranslation();
  const nodeId = propertyGroupNodeId(ownerNodeId, group.group);
  const open = tree.isExpanded(nodeId);
  const editable = Boolean(editor);
  const isEditing = editable && edit.isEditing(nodeId);

  return (
    <div className="flex flex-col gap-1" data-tree-node>
      <div className="flex items-center gap-1">
        <TreePill
          nodeKind="propertyGroup"
          nodeId={nodeId}
          label={t(group.labelKey, { defaultValue: group.group })}
          summary={t("pipelineTree.groupSummary", { count: group.rows.length })}
          expanded={open}
          onToggle={() => tree.toggle(nodeId)}
          className="flex-1"
          {...navProps(edit, nodeId, open, true)}
        />
        {editable && open ? (
          <button
            type="button"
            data-edit-for={nodeId}
        tabIndex={-1}
            aria-pressed={isEditing}
            onClick={() => edit.toggleEditing(nodeId)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-border/70",
              "px-2 py-1 text-xs font-medium hover:bg-muted/40",
              isEditing && "bg-accent text-foreground",
            )}
          >
            <Pencil className="h-3 w-3" aria-hidden />
            {isEditing ? t("pipelineTree.doneEditing") : t("pipelineTree.edit")}
          </button>
        ) : null}
      </div>
      <TreeDisclosure nodeId={nodeId} open={open}>
        {isEditing ? (
          <div
            data-editor-for={nodeId}
            className="border-l border-border/60 py-1 pl-4"
          >
            {editor}
          </div>
        ) : (
          <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 border-l border-border/60 py-1 pl-4 text-xs">
            {group.rows.map((row) => (
              <div key={row.key} className="contents">
                <dt className="truncate font-medium text-muted-foreground">{row.key}</dt>
                <dd className="truncate">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </TreeDisclosure>
    </div>
  );
}

// Role-level groups map to the stage-scoped editors the form mounts today.
// `discover`/`claim`/`git` have no standalone editor component (the form edits
// them through step kinds), so they stay read-only here — returning null is the
// honest answer rather than inventing a new editor this card explicitly excludes.
function roleGroupEditor(
  group: string,
  stage: DraftStage,
  stageIdx: number,
  edit: TreeEditContext,
): ReactNode {
  if (group === "llm") {
    return (
      <div className="space-y-3">
        <ContextSourcePicker
          value={stage.llm?.context_sources ?? []}
          onChange={(next) => edit.onContextSourcesChange(stageIdx, next)}
        />
        <ToolDenyEditor
          value={stage.llm?.tool_policy?.deny ?? []}
          onChange={(next) => edit.onToolDenyChange(stageIdx, next)}
        />
      </div>
    );
  }
  return null;
}

// Move-up/move-down buttons rather than drag-and-drop: dnd is a pointer-only
// affordance, and WCAG 2.1.1 makes keyboard operability the floor, not an
// enhancement. Same control set for roles and steps so the two levels behave
// identically — only the callbacks differ.
function StructureControls({
  nodeId,
  label,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  nodeId: string;
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const cls =
    "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] " +
    "border border-border/70 text-muted-foreground hover:bg-muted/40 " +
    "disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        data-move-up-for={nodeId}
        tabIndex={-1}
        disabled={!canMoveUp}
        onClick={onMoveUp}
        aria-label={t("pipelineTree.moveUp", { label })}
        className={cls}
      >
        <ChevronUp className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        data-move-down-for={nodeId}
        tabIndex={-1}
        disabled={!canMoveDown}
        onClick={onMoveDown}
        aria-label={t("pipelineTree.moveDown", { label })}
        className={cls}
      >
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        data-remove-for={nodeId}
        tabIndex={-1}
        onClick={onRemove}
        aria-label={t("pipelineTree.remove", { label })}
        className={cn(cls, "hover:text-destructive")}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

// The kind list comes from edit.knownKinds — the same source card 3 wired for
// the step editor — so the tree never carries a third copy of the kind list.
function AddStepControl({
  stageIdx,
  roleNodeId,
  edit,
}: {
  stageIdx: number;
  roleNodeId: string;
  edit: TreeEditContext;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-add-step-for={roleNodeId}
        aria-expanded={picking}
        onClick={() => setPicking((prev) => !prev)}
        className={cn(
          "inline-flex w-fit items-center gap-1 rounded-[var(--radius-sm)] border border-dashed",
          "border-border/70 px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/40",
        )}
      >
        <Plus className="h-3 w-3" aria-hidden />
        {t("pipelineTree.addStep")}
      </button>
      {picking ? (
        <div
          role="group"
          aria-label={t("pipelineTree.addStepKindLabel")}
          className="flex flex-wrap gap-1 rounded-[var(--radius-sm)] border border-border/60 p-2"
        >
          {edit.knownKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              data-testid={`tree-add-step-kind-${kind}`}
              onClick={() => {
                edit.onAddStep(stageIdx, kind);
                setPicking(false);
              }}
              className="rounded-[var(--radius-sm)] border border-border/70 px-2 py-0.5 text-xs hover:bg-muted/40"
            >
              {kind}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// One dialog for both scopes: removing a role and removing a step are the same
// question, and a single instance keeps "confirm before destroying draft
// structure" from drifting between the two levels.
function RemoveConfirmDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingRemoval | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!pending) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="tree-remove-dialog">
        <DialogHeader>
          <DialogTitle>
            {pending.scope === "role"
              ? t("pipelineTree.removeRoleTitle")
              : t("pipelineTree.removeStepTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("pipelineTree.removeConfirm", { label: pending.label })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            data-testid="tree-remove-confirm"
            onClick={onConfirm}
          >
            {t("pipelineTree.removeAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ErrorBadge({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <Badge variant="destructive" aria-label={t("pipelineTree.errorCount", { count })}>
      {count}
    </Badge>
  );
}
