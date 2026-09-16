// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from "react";
import { isApiError } from "@/lib/api-error";
import {
  useWorkspaceConfig,
  useUpdateWorkspaceConfig,
} from "./useWorkspaceConfig";
import { usePromptConfigs } from "./usePromptConfigs";
import type {
  ContextSourceEntry,
  PipelineConfig,
  PipelineValidationError,
  StageConfig,
} from "../api/pipelineConfig";
import {
  buildEmptyStageLegacyBlocks,
  buildLifecycleFromTemplate,
  type LifecycleTemplateKey,
} from "../utils/lifecycleTemplates";
import {
  declaredAliasesForStage,
  lintContextSourceWiring,
} from "../utils/contextSourceWiring";
import {
  type DraftStage,
  type DraftStep,
  newDndId,
} from "../components/pipeline-builder/lifecycleDraft";

// ── Pure draft <-> wire transforms ──────────────────────────────────────────
// Extracted from LifecyclePipelineBuilderPage so the graph canvas and the
// Advanced form editor share ONE draft model and ONE save path. Both mount
// this hook (lifted to RunnerPipelineTab), so switching Graph<->Advanced never
// loses edits.

export function cloneToDraft(c: PipelineConfig | null): DraftStage[] {
  if (!c) return [];
  return c.stages.map((stage) => {
    // Deep-clone via JSON to detach from the server cache. structuredClone is
    // skipped for jsdom parity in tests.
    const cloned = JSON.parse(JSON.stringify(stage)) as StageConfig;
    const lifecycle = (cloned.lifecycle ?? []).map((s) => ({
      ...s,
      _dndId: newDndId("lcstep"),
    }));
    return {
      ...cloned,
      lifecycle,
      _dndId: newDndId("lcrole"),
    };
  });
}

export function serializePipeline(
  draft: DraftStage[],
  remote: PipelineConfig | null,
): PipelineConfig {
  const stages: StageConfig[] = draft.map((d) => {
    const { _dndId: _unused, lifecycle, ...rest } = d;
    void _unused;
    // Clone + delete pattern: destructuring a discriminated union collapses the
    // discriminant; this preserves the runtime shape (cast at the boundary).
    const cleanLifecycle = lifecycle.map((step) => {
      const wide = { ...step } as Record<string, unknown>;
      delete wide._dndId;
      if (
        wide.branches &&
        typeof wide.branches === "object" &&
        Object.keys(wide.branches as Record<string, unknown>).length === 0
      ) {
        delete wide.branches;
      }
      return wide as unknown as import("../api/pipelineConfig").LifecycleStep;
    });
    return { ...rest, lifecycle: cleanLifecycle };
  });
  return {
    version: remote?.version ?? 1,
    stages,
    scheduling: remote?.scheduling ?? { priority_order: [], mode: "priority" },
  };
}

export function validateLocal(draft: DraftStage[]): PipelineValidationError[] {
  const errors: PipelineValidationError[] = [];
  draft.forEach((stage, stageIdx) => {
    const names = new Set<string>();
    const dups = new Set<string>();
    for (const step of stage.lifecycle) {
      if (names.has(step.name)) dups.add(step.name);
      names.add(step.name);
    }
    stage.lifecycle.forEach((step, stepIdx) => {
      const path = `stages[${stageIdx}].lifecycle[${stepIdx}]`;
      if (dups.has(step.name)) {
        errors.push({
          code: "duplicate_step_name",
          field: `${path}.name`,
          message: `Step name '${step.name}' is not unique within role '${stage.role}'.`,
          params: { step: step.name, role: stage.role },
        });
      }
      if (step.next && step.branches && Object.keys(step.branches).length > 0) {
        errors.push({
          code: "next_and_branches",
          field: `${path}`,
          message: `Step '${step.name}' has both 'next' and 'branches' set — pick one.`,
          params: { step: step.name },
        });
      }
      if (step.next && !names.has(step.next)) {
        errors.push({
          code: "dangling_next",
          field: `${path}.next`,
          message: `Step '${step.name}' references unknown step '${step.next}'.`,
          params: { step: step.name, target: step.next },
        });
      }
      if (step.branches) {
        for (const [k, target] of Object.entries(step.branches)) {
          if (target && !names.has(target)) {
            errors.push({
              code: "dangling_branch",
              field: `${path}.branches.${k}`,
              message: `Step '${step.name}' branch '${k}' references unknown step '${target}'.`,
              params: { step: step.name, branch: k, target },
            });
          }
        }
      }
    });
  });
  return errors;
}

// ── Conflict (409 stale_version) ────────────────────────────────────────────
export interface DraftConflict {
  currentVersion: number | null;
  expectedVersion: number | null;
}

function parseConflictContext(context: unknown): DraftConflict {
  if (context && typeof context === "object") {
    const c = context as Record<string, unknown>;
    return {
      currentVersion:
        typeof c.current_version === "number" ? c.current_version : null,
      expectedVersion:
        typeof c.expected_version === "number" ? c.expected_version : null,
    };
  }
  return { currentVersion: null, expectedVersion: null };
}

// ── The hook ────────────────────────────────────────────────────────────────

export interface UseLifecycleDraft {
  draft: DraftStage[] | null;
  loading: boolean;
  version: number | null;
  dirty: boolean;
  saving: boolean;
  clientErrors: PipelineValidationError[];
  serverErrors: PipelineValidationError[];
  wiringWarnings: PipelineValidationError[];
  /** serverErrors when present, else clientErrors — the blocking set. */
  errors: PipelineValidationError[];
  /** errors ∪ wiringWarnings — the summary roll-up feed. */
  summaryFindings: PipelineValidationError[];
  conflict: DraftConflict | null;
  setStageSteps: (idx: number, steps: DraftStep[]) => void;
  setStageContextSources: (idx: number, sources: ContextSourceEntry[]) => void;
  setStageToolDeny: (idx: number, deny: string[]) => void;
  reorderRoles: (fromDndId: string, toDndId: string) => void;
  addRole: (name: string, template: LifecycleTemplateKey) => void;
  deleteRole: (idx: number) => void;
  reset: () => void;
  save: (opts?: { onSuccess?: () => void }) => void;
  /** Discard the conflict banner and re-PATCH with a fresh expected_version. */
  overwriteConflict: () => void;
  clearConflict: () => void;
}

export function useLifecycleDraft(slug: string): UseLifecycleDraft {
  const { data: remote, isLoading: remoteLoading, refetch } =
    useWorkspaceConfig(slug);
  const { data: promptConfigs } = usePromptConfigs(slug);
  const updateConfig = useUpdateWorkspaceConfig(slug);

  const [draft, setDraft] = useState<DraftStage[] | null>(null);
  const [serverErrors, setServerErrors] = useState<PipelineValidationError[]>(
    [],
  );
  const [conflict, setConflict] = useState<DraftConflict | null>(null);

  useEffect(() => {
    if (remote && draft === null) {
      setDraft(cloneToDraft(remote.pipeline_config));
    }
  }, [remote, draft]);

  const clientErrors = useMemo(
    () => (draft ? validateLocal(draft) : []),
    [draft],
  );

  // Context-source ↔ prompt wiring warnings across every stage. Advisory —
  // they surface in the summary but never block save.
  const wiringWarnings = useMemo(() => {
    if (!draft || !remote) return [];
    const serialized = serializePipeline(draft, remote.pipeline_config);
    const contentByKey = new Map<string, string>();
    for (const p of promptConfigs ?? []) {
      if (p.team_role && p.stage) {
        contentByKey.set(`${p.team_role}::${p.stage}`, p.content);
      }
    }
    const findings: PipelineValidationError[] = [];
    for (const stage of serialized.stages ?? []) {
      const stageName = stage.llm?.stage;
      if (!stage.role || !stageName) continue;
      const content = contentByKey.get(`${stage.role}::${stageName}`);
      if (content === undefined) continue;
      const declared = declaredAliasesForStage(serialized, stage.role, stageName);
      for (const w of lintContextSourceWiring(declared, content)) {
        findings.push({ ...w, field: `${stage.role}.${stageName}: ${w.field}` });
      }
    }
    return findings;
  }, [draft, remote, promptConfigs]);

  const errors = serverErrors.length > 0 ? serverErrors : clientErrors;
  const summaryFindings = useMemo(
    () => [...errors, ...wiringWarnings],
    [errors, wiringWarnings],
  );

  const dirty = useMemo(() => {
    if (!remote) return draft !== null;
    if (!draft) return false;
    return (
      JSON.stringify(remote.pipeline_config) !==
      JSON.stringify(serializePipeline(draft, remote.pipeline_config))
    );
  }, [draft, remote]);

  // ── Reducers (mutate the draft; clear stale serverErrors) ──
  const mutate = useCallback(
    (fn: (prev: DraftStage[]) => DraftStage[]) => {
      setDraft((prev) => (prev ? fn(prev) : prev));
      setServerErrors([]);
    },
    [],
  );

  const setStageSteps = useCallback(
    (idx: number, steps: DraftStep[]) =>
      mutate((prev) => {
        const next = [...prev];
        const existing = next[idx];
        if (!existing) return prev;
        next[idx] = { ...existing, lifecycle: steps };
        return next;
      }),
    [mutate],
  );

  const setStageContextSources = useCallback(
    (idx: number, sources: ContextSourceEntry[]) =>
      mutate((prev) => {
        const next = [...prev];
        const existing = next[idx];
        if (!existing) return prev;
        next[idx] = {
          ...existing,
          llm: { ...existing.llm, context_sources: sources },
        };
        return next;
      }),
    [mutate],
  );

  const setStageToolDeny = useCallback(
    (idx: number, deny: string[]) =>
      mutate((prev) => {
        const next = [...prev];
        const existing = next[idx];
        if (!existing) return prev;
        next[idx] = {
          ...existing,
          llm: {
            ...existing.llm,
            tool_policy: { ...existing.llm.tool_policy, deny },
          },
        };
        return next;
      }),
    [mutate],
  );

  const reorderRoles = useCallback(
    (fromDndId: string, toDndId: string) =>
      mutate((prev) => {
        const oldIdx = prev.findIndex((s) => s._dndId === fromDndId);
        const newIdx = prev.findIndex((s) => s._dndId === toDndId);
        if (oldIdx < 0 || newIdx < 0) return prev;
        const next = [...prev];
        const [moved] = next.splice(oldIdx, 1);
        next.splice(newIdx, 0, moved!);
        return next;
      }),
    [mutate],
  );

  const addRole = useCallback(
    (name: string, template: LifecycleTemplateKey) => {
      setDraft((prev) => {
        const base = prev ?? [];
        const lifecycle = buildLifecycleFromTemplate(template).map((s) => ({
          ...s,
          _dndId: newDndId("lcstep"),
        }));
        const newRole: DraftStage = {
          role: name,
          ...buildEmptyStageLegacyBlocks(),
          lifecycle,
          _dndId: newDndId("lcrole"),
        };
        return [...base, newRole];
      });
      setServerErrors([]);
    },
    [],
  );

  const deleteRole = useCallback(
    (idx: number) => mutate((prev) => prev.filter((_, i) => i !== idx)),
    [mutate],
  );

  const reset = useCallback(() => {
    if (!remote) return;
    setDraft(cloneToDraft(remote.pipeline_config));
    setServerErrors([]);
    setConflict(null);
  }, [remote]);

  const runSave = useCallback(
    (expectedVersion: number, onSuccess?: () => void) => {
      if (!draft || !remote) return;
      updateConfig.mutate(
        {
          pipeline_config: serializePipeline(draft, remote.pipeline_config),
          expected_version: expectedVersion,
        },
        {
          onSuccess: (fresh) => {
            setDraft(cloneToDraft(fresh.pipeline_config));
            setServerErrors([]);
            setConflict(null);
            onSuccess?.();
          },
          onError: (err: unknown) => {
            if (isApiError(err) && err.isConflict()) {
              // Preserve the user's draft; surface a conflict banner instead.
              setConflict(parseConflictContext(err.context));
              setServerErrors([]);
              return;
            }
            // 422 (or a message-encoded validation array) → field errors.
            const detail = isApiError(err) ? err.detail : undefined;
            const parsed =
              Array.isArray(detail) ? detail : tryParseArray(err);
            if (parsed) setServerErrors(parsed as PipelineValidationError[]);
          },
        },
      );
    },
    [draft, remote, updateConfig],
  );

  const save = useCallback(
    (opts?: { onSuccess?: () => void }) => {
      if (!remote) return;
      runSave(remote.version, opts?.onSuccess);
    },
    [remote, runSave],
  );

  // Refetch to learn the server's current version, then re-PATCH the user's
  // draft against it — "keep mine, overwrite theirs."
  const overwriteConflict = useCallback(() => {
    refetch().then((res) => {
      const fresh = res.data;
      if (fresh) runSave(fresh.version);
    });
  }, [refetch, runSave]);

  const clearConflict = useCallback(() => setConflict(null), []);

  return {
    draft,
    loading: remoteLoading,
    version: remote?.version ?? null,
    dirty,
    saving: updateConfig.isPending,
    clientErrors,
    serverErrors,
    wiringWarnings,
    errors,
    summaryFindings,
    conflict,
    setStageSteps,
    setStageContextSources,
    setStageToolDeny,
    reorderRoles,
    addRole,
    deleteRole,
    reset,
    save,
    overwriteConflict,
    clearConflict,
  };
}

// Legacy fallback: some error paths still arrive as a bare Error whose message
// is a JSON-encoded validation array (pre-ApiError callers / re-thrown).
function tryParseArray(err: unknown): unknown[] | null {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(msg);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
