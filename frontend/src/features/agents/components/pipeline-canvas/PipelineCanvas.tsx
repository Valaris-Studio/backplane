// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AnimatePresence } from "motion/react";
import { useTheme } from "@/hooks/use-theme";
import { useTeams } from "../../hooks/useTeams";
import { useAgentMetrics } from "../../hooks/useAgentMetrics";
import { useLifecycleKinds } from "../../api/lifecycleKinds";
import { usePromptConfigs, usePromptDefaults } from "../../hooks/usePromptConfigs";
import type { LifecycleKindName } from "../../api/pipelineConfig";
import type { ResolvedLifecycleStepPrompt } from "../pipeline-builder/LifecycleLLMStepPrompt";
import type { UseLifecycleDraft } from "../../hooks/useLifecycleDraft";
import { serializePipeline } from "../../hooks/useLifecycleDraft";
import { summarizePipelineHealth } from "../../utils/lifecycle-graph";
import { PipelineHealthBanner } from "../pipeline-graph/PipelineHealthBanner";
import { canvasNodeTypes } from "./nodes/nodeTypes";
import { CanvasActionsProvider, type CanvasActions } from "./CanvasActionsContext";
import { buildRunnerBindings } from "./runnerBindings";
import { buildCanvasModel, layoutCanvas } from "./canvasLayout";
import { mapErrorsToNodes } from "./validationTargets";
import { useCanvasNodeState } from "./useCanvasNodeState";
import { CanvasInspector } from "./CanvasInspector";
import { CanvasSaveBar } from "./CanvasSaveBar";
import { ConflictBanner } from "./ConflictBanner";
import { BindRoleDialog } from "./BindRoleDialog";
import { FALLBACK_KINDS } from "../pipeline-builder/LifecyclePipelineBuilderPage";

interface PipelineCanvasProps {
  slug: string;
  /** The shared draft engine, lifted to RunnerPipelineTab and shared with the
   *  Advanced form so a switch between views keeps edits. */
  draft: UseLifecycleDraft;
  onLaunchRunner?: (agentId: string | null) => void;
}

function InnerCanvas({ slug, draft, onLaunchRunner }: PipelineCanvasProps) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { data: teams } = useTeams(slug);
  const { data: metrics } = useAgentMetrics(slug);
  const { data: kindsData } = useLifecycleKinds();
  const { data: promptConfigs } = usePromptConfigs(slug);
  const { data: promptDefaults } = usePromptDefaults(slug);

  const nav = useCanvasNodeState();
  const { fitBounds, getInternalNode } = useReactFlow();
  // The unbound role the operator is binding a runner to (gap-lane action).
  const [bindRole, setBindRole] = useState<string | null>(null);

  // Focus crosshair → zoom the viewport to that role. focusRole also expands the
  // role, so its node dimensions only settle AFTER React Flow re-lays-out; defer
  // one frame so we read the settled box. clearFocus lets a repeat click on the
  // same role re-fire (the effect keys on the value changing). Role nodes are
  // CHILDREN of a lane (parentId + extent:'parent'), so their `position` is
  // parent-RELATIVE — fitView on the id lands off-content. Resolve the ABSOLUTE
  // rect and fitBounds so the camera actually frames the role.
  const { focusedRole, clearFocus } = nav;
  useEffect(() => {
    if (!focusedRole) return;
    const raf = requestAnimationFrame(() => {
      const node = getInternalNode(focusedRole);
      if (node) {
        const { x, y } = node.internals.positionAbsolute;
        const width = node.measured?.width ?? node.width ?? 0;
        const height = node.measured?.height ?? node.height ?? 0;
        if (width > 0 && height > 0) {
          fitBounds({ x, y, width, height }, { padding: 0.3, duration: 400 });
        }
      }
      clearFocus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusedRole, fitBounds, getInternalNode, clearFocus]);

  const knownKinds = useMemo<LifecycleKindName[]>(() => {
    if (!kindsData) return [...FALLBACK_KINDS];
    return Object.keys(kindsData.kinds) as LifecycleKindName[];
  }, [kindsData]);

  const resolvedPromptsByKey = useMemo(() => {
    const map = new Map<string, ResolvedLifecycleStepPrompt>();
    for (const d of promptDefaults ?? []) {
      map.set(`${d.role}::${d.stage}`, {
        stepName: "", stageToken: d.stage, role: d.role, slug: d.slug,
        contentPreview: d.default_content, workspaceSlug: slug,
        isCustom: false, isMissing: false,
      });
    }
    for (const c of promptConfigs ?? []) {
      if (!c.team_role || !c.stage) continue;
      map.set(`${c.team_role}::${c.stage}`, {
        stepName: "", stageToken: c.stage, role: c.team_role, slug: c.slug,
        contentPreview: c.content, workspaceSlug: slug,
        isCustom: true, isMissing: false,
      });
    }
    return map;
  }, [promptConfigs, promptDefaults, slug]);

  // Bindings ← teams × metrics; the canvas config = the live DRAFT (edits render
  // immediately on nodes). serialize so analysis sees the wire shape.
  const bindings = useMemo(
    () => buildRunnerBindings(teams ?? [], metrics ?? []),
    [teams, metrics],
  );

  const config = useMemo(
    () => (draft.draft ? serializePipeline(draft.draft, null) : null),
    [draft.draft],
  );

  const model = useMemo(() => buildCanvasModel(config, bindings), [config, bindings]);

  const errorCountByNodeId = useMemo(() => {
    const errMap = mapErrorsToNodes(draft.errors, model);
    const counts = new Map<string, number>();
    for (const [nodeId, errs] of errMap) counts.set(nodeId, errs.length);
    return counts;
  }, [draft.errors, model]);

  const workingRoleIds = useMemo(() => {
    // A working runner pulses the role(s) it's configured to run. We don't know
    // the exact live step, so pulse at role granularity for every role in a
    // working lane (honest — no fabricated per-step liveness).
    const ids = new Set<string>();
    for (const lane of model.lanes) {
      if (lane.working) for (const r of lane.roles) ids.add(r.nodeId);
    }
    return ids;
  }, [model]);

  const { nodes, edges } = useMemo(
    () =>
      layoutCanvas(model, {
        expandedRoles: nav.expandedRoles,
        workingRoleIds,
        errorCountByNodeId,
      }),
    [model, nav.expandedRoles, workingRoleIds, errorCountByNodeId],
  );

  const health = useMemo(
    () => (config ? summarizePipelineHealth(config) : null),
    [config],
  );

  // Resolve the current selection → draft stage + index for the inspector.
  // PipelineCanvas owns nodeId parsing (the layout id scheme lives here); the
  // inspector receives already-resolved indices, never raw node ids.
  const selectedRole =
    nav.selection?.kind === "role"
      ? nav.selection.nodeId
      : nav.selection?.kind === "step"
        ? nav.selection.roleNodeId
        : null;
  const roleName = selectedRole?.split("::").pop() ?? null;
  const stageIndex = roleName
    ? (draft.draft?.findIndex((s) => s.role === roleName) ?? -1)
    : -1;
  const selectedStage = stageIndex >= 0 ? (draft.draft?.[stageIndex] ?? null) : null;

  // A step node id is `${roleNodeId}//${step.name}`; map the trailing name to
  // its index in the resolved stage's lifecycle (the analysis node id === name).
  const stepIndex =
    nav.selection?.kind === "step" && selectedStage
      ? (() => {
          const stepName = nav.selection.nodeId.split("//").pop() ?? null;
          const idx =
            stepName != null
              ? selectedStage.lifecycle.findIndex((s) => s.name === stepName)
              : -1;
          return idx >= 0 ? idx : null;
        })()
      : null;

  const laneAgentId =
    nav.selection?.kind === "lane"
      ? (model.lanes.find((l) => l.laneId === nav.selection!.nodeId)?.agentId ?? null)
      : null;

  const configuredRoles = useMemo(
    () => draft.draft?.map((s) => s.role) ?? [],
    [draft.draft],
  );

  const actions: CanvasActions = useMemo(
    () => ({
      onToggleRole: nav.toggleRole,
      onFocusRole: nav.focusRole,
      onSelectRole: (nodeId) => nav.select({ kind: "role", nodeId }),
      onSelectStep: (nodeId, roleNodeId) =>
        nav.select({ kind: "step", nodeId, roleNodeId }),
      onLaunchRunner: (agentId) => onLaunchRunner?.(agentId),
      onEditRoles: (agentId) =>
        nav.select({ kind: "lane", nodeId: `lane-${agentId}` }),
      onBindRole: (role) => setBindRole(role),
    }),
    [nav, onLaunchRunner],
  );

  if (!draft.draft || draft.draft.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
        {t("pipelineGraph.empty")}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      {health ? <PipelineHealthBanner health={health} /> : null}
      <ConflictBanner
        conflict={draft.conflict}
        onReload={draft.reset}
        onOverwrite={draft.overwriteConflict}
        onDismiss={draft.clearConflict}
      />
      <div className="flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row">
        <div className="relative flex flex-1 overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-border/70 bg-card/30">
          <CanvasActionsProvider actions={actions}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={canvasNodeTypes}
              colorMode={resolvedTheme}
              fitView
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              minZoom={0.2}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="var(--color-border)"
              />
              {/* No MiniMap: at the canvas's typical lane count it covered
                  more content than it helped navigate. */}
              <Controls showInteractive={false} />
            </ReactFlow>
          </CanvasActionsProvider>
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
            <AnimatePresence>
              <CanvasSaveBar
                dirty={draft.dirty}
                saving={draft.saving}
                errorCount={draft.errors.length}
                onSave={() => draft.save()}
                onDiscard={draft.reset}
              />
            </AnimatePresence>
          </div>
        </div>
        {nav.selection ? (
          <div className="flex w-full shrink-0 flex-col lg:w-auto">
            <CanvasInspector
              slug={slug}
              selection={nav.selection}
              stage={selectedStage}
              stageIndex={stageIndex >= 0 ? stageIndex : null}
              stepIndex={stepIndex}
              roleNodeId={selectedRole}
              knownKinds={knownKinds}
              resolvedPromptsByKey={resolvedPromptsByKey}
              laneAgentId={laneAgentId}
              configuredRoles={configuredRoles}
              onClose={() => nav.select(null)}
              onSelect={nav.select}
              onStepsChange={(steps) =>
                stageIndex >= 0 && draft.setStageSteps(stageIndex, steps)
              }
              onContextSourcesChange={(s) =>
                stageIndex >= 0 && draft.setStageContextSources(stageIndex, s)
              }
              onToolDenyChange={(d) =>
                stageIndex >= 0 && draft.setStageToolDeny(stageIndex, d)
              }
              onDeleteRole={() => {
                if (stageIndex >= 0) draft.deleteRole(stageIndex);
                nav.select(null);
              }}
            />
          </div>
        ) : null}
      </div>

      {bindRole ? (
        <BindRoleDialog
          slug={slug}
          role={bindRole}
          open
          onOpenChange={(o) => (o ? undefined : setBindRole(null))}
          onCreateRunner={() => onLaunchRunner?.(null)}
        />
      ) : null}
    </div>
  );
}

export function PipelineCanvas(props: PipelineCanvasProps) {
  return (
    <ReactFlowProvider>
      <InnerCanvas {...props} />
    </ReactFlowProvider>
  );
}
