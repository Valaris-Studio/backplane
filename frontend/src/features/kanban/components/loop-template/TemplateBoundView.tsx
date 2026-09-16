// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LandingPolicyEditor } from "../LandingPolicyEditor";
import { useCompletionPolicyDraft, useCompletionPolicyPreview } from "../../api/use-completion";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError } from "@/components/ui/field-error";
import { NumberField } from "@/components/shared/NumberField";
import {
  useSaveBoardLoop,
  useSetBoardLoopState,
} from "@/features/kanban/api/use-board-loop";
import { useBoardLoopStatus } from "@/features/kanban/api/use-board-loop-status";
import {
  readUnfilledSlots,
  useBoardLoopBinding,
  useBoardLoopBindingDiff,
} from "@/features/kanban/api/use-board-loop-binding";
import type { DriftKind } from "@/features/kanban/api/use-board-loop-binding";
import { useLoopTemplateDetail } from "@/features/loop-templates/hooks/useLoopTemplateDetail";
import { LoopTemplateProfileSheet } from "@/features/loop-templates/components/LoopTemplateProfileSheet";
import {
  DECIMAL_RAILS,
  NUMERIC_RAILS,
  type NumericRail,
} from "@/features/loop-templates/lib/rails-catalog";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { isApiError } from "@/lib/api-error";
import {
  formatFinding,
  parseFindings,
  type ValidationFinding,
} from "@/features/kanban/utils/loop-findings";
import { BoundDiffPanel } from "./BoundDiffPanel";
import type {
  BoardLoopConfig,
  BoundLoopTemplate,
} from "@/features/kanban/api/use-board-loop";

interface Props {
  slug: string;
  boardUuid: string;
  template: BoundLoopTemplate;
  // The loop config the rails are edited against. Optional only so callers
  // that predate the guardrails section still type-check; without it the
  // section is withheld rather than rendered blank.
  config?: BoardLoopConfig;
  expectedVersion?: number;
  onDetached: () => void;
  onChangeTemplate: () => void;
  // Reports an unsaved guardrails draft so the panel's close guard can ask
  // before Escape discards it.
  onDirtyChange?: (dirty: boolean) => void;
}

const INPUT_CLASS =
  "border-input bg-background w-full rounded-md border px-2 py-1 text-sm";

/**
 * One banner line per drift kind.
 *
 * Typed as a total Record so a kind added to the backend contract fails the
 * BUILD rather than silently rendering the template_newer copy — which would
 * promise the operator a newer version that does not exist.
 */
const DRIFT_COPY_KEY: Record<DriftKind, string> = {
  none: "boardLoop.templates.bound.drift.templateNewer",
  template_newer: "boardLoop.templates.bound.drift.templateNewer",
  system_bumped: "boardLoop.templates.bound.drift.systemBumped",
  slots_changed: "boardLoop.templates.bound.drift.slotsChanged",
  raw_edited: "boardLoop.templates.bound.drift.rawEdited",
  binding_corrupt: "boardLoop.templates.bound.drift.bindingCorrupt",
};

/**
 * Label key and input floor per numeric rail — the same floors as
 * BoardLoopDialog's NumberFields, since both editors write the same columns.
 */
const RAIL_FIELDS: Record<
  NumericRail,
  { labelKey: string; min: number; step?: number }
> = {
  max_iterations: { labelKey: "boardLoop.maxIterationsLabel", min: 1 },
  iteration_delay_seconds: { labelKey: "boardLoop.delayLabel", min: 0 },
  iteration_timeout_seconds: { labelKey: "boardLoop.timeoutLabel", min: 1 },
  budget_usd: { labelKey: "boardLoop.budgetLabel", min: 0.01, step: 0.01 },
  max_consecutive_failures: { labelKey: "boardLoop.failuresLabel", min: 1 },
  max_blocked_on_human: { labelKey: "boardLoop.blockedOnHumanLabel", min: 0 },
};

type RailValues = Record<NumericRail, string>;

function railValuesFrom(config: BoardLoopConfig | undefined): RailValues {
  return Object.fromEntries(
    NUMERIC_RAILS.map((rail) => [rail, config ? String(config[rail]) : ""]),
  ) as RailValues;
}

/**
 * Strict parse for a rail typed here: `Number()` reads "1e3" as the thousand
 * it denotes (parseInt would cap the loop at ONE iteration), and a count or a
 * number of seconds must be whole. Only `budget_usd` takes decimals.
 * `undefined` = not a value the backend would accept.
 */
function parseRail(rail: NumericRail, raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  if (!DECIMAL_RAILS.has(rail) && !Number.isInteger(parsed)) return undefined;
  if (parsed < RAIL_FIELDS[rail].min) return undefined;
  return parsed;
}

/**
 * The bound state of a board's loop: what it runs, whether the template moved
 * underneath it, and the two ways off it.
 *
 * Updating is always an explicit, reviewed act (operator direction Q3/Q8): the
 * diff must be opened before Update appears, so a drifted board can never be
 * re-rendered by one stray click on a banner.
 */
export function TemplateBoundView({
  slug,
  boardUuid,
  template,
  config,
  expectedVersion,
  onDetached,
  onChangeTemplate,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation();
  const { isAdmin } = useWorkspaceAdmin(slug);
  const [confirmingDetach, setConfirmingDetach] = useState(false);
  const [confirmingChange, setConfirmingChange] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // Slot names the update still needs a value for, from the drift payload or
  // from the server's 422 — the two sources answer the same question and feed
  // one prompt.
  const [pendingSlots, setPendingSlots] = useState<string[] | null>(null);
  const [newSlotValues, setNewSlotValues] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  // The numeric guardrails stay the operator's while bound (the template owns
  // only prompts and tools), so they are edited here in place — never through
  // the detach lever. Same overlay shape as the slot `edits`: only what the
  // operator typed is held, over a baseline read from `config` each render,
  // so a WS refetch (new config identity) can never wipe half-typed values.
  const [railEdits, setRailEdits] = useState<Partial<RailValues>>({});
  const [sourceProviderEdit, setSourceProviderEdit] = useState<string>();
  const [sourceModelEdit, setSourceModelEdit] = useState<string>();
  const [policySaveError, setPolicySaveError] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [railFindings, setRailFindings] = useState<ValidationFinding[]>([]);
  const railFieldId = useId();
  const railBaseline = railValuesFrom(config);

  // Once the refetch after a save delivers the typed value as the baseline,
  // the edit has nothing left to say — drop it so the field follows the
  // server again (and a later teammate change is not shadowed by it).
  useEffect(() => {
    setSourceProviderEdit((previous) => previous === config?.provider ? undefined : previous);
    setSourceModelEdit((previous) => previous === config?.model ? undefined : previous);
    setRailEdits((prev) => {
      const settled = NUMERIC_RAILS.filter(
        (rail) => prev[rail] !== undefined && prev[rail] === railBaseline[rail],
      );
      if (settled.length === 0) return prev;
      const next = { ...prev };
      for (const rail of settled) delete next[rail];
      return next;
    });
    // railBaseline is derived from config alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const detailQuery = useLoopTemplateDetail(slug, template.ref);
  const bindingQuery = useBoardLoopBinding(slug, boardUuid);
  const statusQuery = useBoardLoopStatus(slug, boardUuid);
  const diffQuery = useBoardLoopBindingDiff(slug, boardUuid, reviewing);
  const saveLoop = useSaveBoardLoop(slug, boardUuid);
  const setLoopState = useSetBoardLoopState(slug, boardUuid);

  const binding = bindingQuery.data ?? null;
  const drift = binding?.drift;
  const hasDrift = !!drift && drift.kind !== "none";
  const slotValues = useMemo(
    () => binding?.slot_values ?? {},
    [binding?.slot_values],
  );

  const merged = { ...slotValues, ...edits };
  const dirty = Object.keys(edits).some((key) => edits[key] !== slotValues[key]);

  // Retire only edits confirmed by the binding read. A failed or delayed
  // refresh must not reveal an older slot value after a successful write.
  useEffect(() => {
    setEdits((previous) => {
      const remaining = Object.entries(previous).filter(([key, value]) => value !== slotValues[key]);
      return remaining.length === Object.keys(previous).length ? previous : Object.fromEntries(remaining);
    });
  }, [slotValues]);

  const name = detailQuery.data?.name ?? template.ref;
  const emoji = detailQuery.data?.profile?.emoji;
  const tagline = detailQuery.data?.profile?.tagline;

  const putLoop = (
    body: Record<string, unknown>,
    onSuccess?: () => void,
    onError?: (error: unknown) => void,
  ) => {
    setActionError(undefined);
    saveLoop.mutate(
      {
        ...body,
        ...(expectedVersion !== undefined
          ? { expected_version: expectedVersion }
          : {}),
      } as never,
      {
        onSuccess: () => {
          setPendingSlots(null);
          setNewSlotValues({});
          onSuccess?.();
        },
        onError: (error) => {
          // The backend knows about required slots the drift payload could not
          // enumerate (e.g. an optional→required promotion); surface the same
          // prompt rather than a dead-end toast.
          const unfilled = readUnfilledSlots(error);
          if (unfilled) setPendingSlots(unfilled);
          else if (onError) onError(error);
          else setActionError(error);
        },
      },
    );
  };

  const update = () => {
    if (!canUpdate || !isAdmin || saveLoop.isPending) return;
    putLoop({ template: updateTemplate });
  };

  const startUpdate = () => {
    const required = drift?.new_required_slots ?? [];
    const unfilled = required.filter((slot) => !merged[slot]);
    if (unfilled.length > 0) {
      setPendingSlots(unfilled);
      return;
    }
    update();
  };

  const saveSlots = () => {
    if (!canSaveSlots || !isAdmin || saveLoop.isPending) return;
    putLoop(
      {
        template: {
          source: template.source,
          ref: template.ref,
          // The BOUND version: editing slot values re-renders the prompts the
          // board already agreed to, and must never smuggle in an upgrade.
          version: template.version,
          slot_values: merged,
        },
      },
    );
  };

  const detach = () =>
    // `{}` is the documented DETACH lever: an omitted key means "unchanged",
    // so there is no other way to unbind.
    putLoop({ template: {} }, () => {
      setConfirmingDetach(false);
      onDetached();
    });

  const railValue = (rail: NumericRail) =>
    railEdits[rail] ?? railBaseline[rail];
  const changedRails = NUMERIC_RAILS.filter(
    (rail) => railValue(rail) !== railBaseline[rail],
  );
  const railsDirty = changedRails.length > 0;
  const sourceProvider = sourceProviderEdit ?? config?.provider ?? "";
  const sourceModel = sourceModelEdit ?? config?.model ?? "";
  const sourceDirty = sourceProvider !== (config?.provider ?? "") || sourceModel !== (config?.model ?? "");
  const proposedTemplate = binding ? {
    source: template.source,
    ref: template.ref,
    version: template.version,
    slot_values: merged,
  } : undefined;
  const proposedSourceConfig = {
    provider: sourceProvider,
    model: sourceModel,
    ...Object.fromEntries(changedRails.map((rail) => [rail, parseRail(rail, railValue(rail))])),
  };
  const policy = useCompletionPolicyDraft(slug, boardUuid, true, proposedSourceConfig, proposedTemplate);

  // Slot saves and version updates retain the SAVED policy and source config.
  // Their previews must not borrow compatibility from the separate policy draft.
  const savedPolicy = policy.current.data?.override ?? null;
  const bindingReady = bindingQuery.isSuccess && !!binding && !bindingQuery.isFetching && binding.template.version === template.version && binding.template.ref === template.ref;
  const savedPolicyReady = policy.current.isSuccess && !policy.current.isFetching && bindingReady;
  const updateTemplate = {
    source: template.source,
    ref: template.ref,
    version: drift?.current_version ?? template.version,
    slot_values: { ...merged, ...newSlotValues },
  };
  const slotsPreview = useCompletionPolicyPreview(slug, boardUuid, savedPolicy, savedPolicyReady && !!binding && dirty, undefined, proposedTemplate);
  const updatePreview = useCompletionPolicyPreview(slug, boardUuid, savedPolicy, savedPolicyReady && reviewing && !!binding, undefined, updateTemplate);
  const previewReady = (preview: typeof slotsPreview) => savedPolicyReady && preview.isSuccess && !preview.isFetching && !preview.data.incompatibilities.length && !preview.data.template_preview?.findings.length;
  const canSaveSlots = previewReady(slotsPreview);
  const canUpdate = previewReady(updatePreview);
  const needsUpdateSlots = (drift?.new_required_slots ?? []).some((slot) => !merged[slot]);
  const previewMessages = (preview: typeof slotsPreview) => [
    ...(preview.data?.incompatibilities ?? []),
    ...(preview.data?.template_preview?.findings ?? []),
  ];
  const errorMessage = (error: unknown) => {
    if (isApiError(error) && error.isConflict()) return t("boardLoop.templates.bound.actionConflict");
    if (isApiError(error) && error.isValidation()) {
      const detail = error.detail;
      if (Array.isArray(detail)) return parseFindings(detail).map(formatFinding).filter(Boolean).join("\n") || t("boardLoop.templates.bound.actionFailed");
      if (typeof detail === "string") return detail;
      if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") return detail.message;
    }
    return t("boardLoop.templates.bound.actionFailed");
  };
  const reloadBinding = () => {
    setActionError(undefined);
    void bindingQuery.refetch();
    void detailQuery.refetch();
    void policy.current.refetch();
    if (reviewing) void diffQuery.refetch();
    if (dirty) void slotsPreview.refetch();
    if (reviewing) void updatePreview.refetch();
  };
  const previewStatus = (preview: typeof slotsPreview, active: boolean) => active && (
    <div className="space-y-2 text-xs" aria-live="polite">
      {(preview.isFetching || (!savedPolicyReady && !bindingQuery.isError)) && <p role="status">{t("boardLoop.templates.bound.actionPreviewPending")}</p>}
      {preview.isError && <div role="alert"><p>{errorMessage(preview.error)}</p><Button type="button" size="sm" variant="outline" onClick={reloadBinding}>{t("completionPolicy.reload")}</Button></div>}
      {!preview.isFetching && previewMessages(preview).map((finding, index) => <p role="alert" key={index}>{finding.message}</p>)}
    </div>
  );

  useEffect(() => {
    const unfilled = readUnfilledSlots(updatePreview.error);
    if (unfilled?.length) setPendingSlots(unfilled);
  }, [updatePreview.error]);

  const applyPolicy = () => {
    if (!isAdmin || !bindingReady || !policy.canSave || saveLoop.isPending || !policy.preview.isSuccess) return;
    if (changedRails.some((rail) => parseRail(rail, railValue(rail)) === undefined)) {
      setRailFindings([{ field: "", message: t("boardLoop.invalidNumbers") }]);
      return;
    }
    setPolicySaveError(false);
    putLoop({
      ...policy.loopConfig,
      template: proposedTemplate,
      completion_policy: policy.value,
    }, undefined, () => setPolicySaveError(true));
  };


  useEffect(() => {
    onDirtyChange?.(railsDirty || policy.dirty || sourceDirty || dirty);
  }, [railsDirty, policy.dirty, sourceDirty, dirty, onDirtyChange]);

  // Only the edited rails go on the wire: the PUT merge keeps the rest, and
  // echoing `loop_landing` back would trip the server's done-gate auto-relax.
  // The typed values survive every failure: after a 409 the refetch moves the
  // baseline, and the operator re-applies rather than re-types.
  const saveRails = () => {
    const body: Record<string, number> = {};
    for (const rail of changedRails) {
      const parsed = parseRail(rail, railValue(rail));
      if (parsed === undefined) {
        setRailFindings([{ field: "", message: t("boardLoop.invalidNumbers") }]);
        return;
      }
      body[rail] = parsed;
    }
    setRailFindings([]);
    putLoop(body, undefined, (error) => {
      if (isApiError(error) && error.isValidation()) {
        setRailFindings(parseFindings(error.detail));
      } else if (isApiError(error) && error.isConflict()) {
        toast.error(t("boardLoop.saveConflict"));
      } else {
        toast.error(t("boardLoop.saveError"));
      }
    });
  };

  // Mirrors BoardLoopDialog: enabling an empty loop_prompt 422s server-side,
  // so the control is withheld with a hint; turning OFF is always allowed.
  const needsPromptToEnable =
    !!config && !config.enabled && config.loop_prompt.trim() === "";
  const canToggle = !setLoopState.isPending && !needsPromptToEnable && (
    config?.enabled || (!policy.dirty && !sourceDirty && (!(config?.completion_policy || policy.explicit) || policy.compatible))
  );

  const toggleEnabled = (next: boolean) => {
    if (next && !canToggle) return;
    setLoopState.mutate(
      { enabled: next, reason: "" },
      { onError: () => toast.error(t("boardLoop.toggleError")) },
    );
  };

  const running = statusQuery.data?.state === "running";
  const disabledReason = statusQuery.data?.disabled_reason;

  return (
    <div className="space-y-4" data-testid="board-loop-panel-bound">
      <div className="flex items-center gap-2 rounded-md border p-3">
        {emoji ? <span aria-hidden="true">{emoji}</span> : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{name}</span>
            <span
              className="text-muted-foreground text-xs"
              data-testid="bound-version"
            >
              v{template.version}
            </span>
          </div>
          {tagline ? (
            <p className="text-muted-foreground truncate text-xs">{tagline}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="bound-view-profile"
          onClick={() => setProfileOpen(true)}
        >
          {t("boardLoop.templates.bound.viewProfile")}
        </Button>
      </div>

      {running && (
        <p
          role="status"
          data-testid="bound-running-notice"
          className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {t("boardLoop.templates.bound.runningNotice")}
        </p>
      )}

      {disabledReason && (
        <p
          className="text-muted-foreground text-xs"
          data-testid="bound-disabled-reason"
        >
          {disabledReason}
        </p>
      )}

      {hasDrift && drift && (
        <div
          data-testid="bound-drift"
          role="status"
          className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p>
            {t(DRIFT_COPY_KEY[drift.kind] ?? DRIFT_COPY_KEY.template_newer, {
              version: drift.current_version ?? template.version,
            })}
          </p>
          {!reviewing && binding?.diff_available && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="bound-drift-review"
              onClick={() => setReviewing(true)}
            >
              {t("boardLoop.templates.bound.drift.review")}
            </Button>
          )}
          {reviewing && diffQuery.data && (
            <div className="space-y-2">
              <BoundDiffPanel diff={diffQuery.data} />
              <Button
                type="button"
                size="sm"
                data-testid="bound-update"
                disabled={!isAdmin || saveLoop.isPending || (!needsUpdateSlots && !canUpdate)}
                onClick={startUpdate}
              >
                {t("boardLoop.templates.bound.drift.update", {
                  version: drift.current_version ?? template.version,
                })}
              </Button>
              {previewStatus(updatePreview, true)}
            </div>
          )}
        </div>
      )}

      {pendingSlots && pendingSlots.length > 0 && (
        <div
          className="space-y-2 rounded-md border p-3"
          data-testid="bound-new-slots"
        >
          <p className="text-xs font-medium">
            {t("boardLoop.templates.bound.drift.newSlotsTitle")}
          </p>
          {pendingSlots.map((slot) => (
            <label key={slot} className="block space-y-1 text-xs">
              <span className="font-mono">{slot}</span>
              <input
                className={INPUT_CLASS}
                data-testid={`bound-new-slot-${slot}`}
                value={newSlotValues[slot] ?? ""}
                onChange={(event) =>
                  setNewSlotValues((prev) => ({
                    ...prev,
                    [slot]: event.target.value,
                  }))
                }
              />
            </label>
          ))}
          <Button
            type="button"
            size="sm"
            data-testid="bound-new-slots-submit"
            disabled={
              !isAdmin || saveLoop.isPending || !canUpdate ||
              pendingSlots.some((slot) => !newSlotValues[slot])
            }
            onClick={update}
          >
            {t("boardLoop.templates.bound.drift.newSlotsSubmit")}
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          {t("boardLoop.templates.bound.explainer")}
        </p>
        {Object.keys(slotValues).map((slot) => (
          <label key={slot} className="block space-y-1 text-xs">
            <span className="font-mono">{slot}</span>
            <input
              className={INPUT_CLASS}
              data-testid={`bound-slot-${slot}`}
              value={merged[slot] ?? ""}
              onChange={(event) =>
                setEdits((prev) => ({ ...prev, [slot]: event.target.value }))
              }
            />
          </label>
        ))}
        {Object.keys(slotValues).length > 0 && (
          <Button
            type="button"
            size="sm"
            data-testid="bound-save-slots"
            disabled={!isAdmin || !dirty || saveLoop.isPending || !canSaveSlots}
            onClick={saveSlots}
          >
            {t("boardLoop.templates.bound.saveSlots")}
          </Button>
        )}
      </div>

      {bindingQuery.isError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{t("boardLoop.templates.bound.actionFailed")}</p><Button type="button" size="sm" variant="outline" onClick={reloadBinding}>{t("completionPolicy.reload")}</Button></div>}
      {previewStatus(slotsPreview, dirty)}
      {actionError !== undefined && <div role="alert" className="space-y-2 text-sm text-destructive"><p className="whitespace-pre-wrap">{errorMessage(actionError)}</p><Button type="button" size="sm" variant="outline" onClick={reloadBinding}>{t("completionPolicy.reload")}</Button></div>}

      {isAdmin && policy.current.isError && <div role="status" className="space-y-2 text-sm text-destructive"><p>{t("completionPolicy.previewFailed")}</p><Button type="button" size="sm" variant="outline" onClick={() => void policy.current.refetch()}>{t("completionPolicy.reload")}</Button></div>}

      {isAdmin && config && policy.current.isSuccess && binding && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              {t("boardLoop.providerLabel")}
              <Input value={sourceProvider} disabled={saveLoop.isPending} onChange={(event) => setSourceProviderEdit(event.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              {t("boardLoop.modelLabel")}
              <Input value={sourceModel} disabled={saveLoop.isPending} onChange={(event) => setSourceModelEdit(event.target.value)} />
            </label>
          </div>
          <LandingPolicyEditor slug={slug} boardId={boardUuid} value={policy.value} loopConfig={policy.loopConfig} template={proposedTemplate} onChange={policy.onChange} onApply={applyPolicy} hideApply disabled={saveLoop.isPending} />
          <p className="text-xs text-muted-foreground">{t("completionPolicy.rebindHint")}</p>
          <Button type="button" onClick={applyPolicy} disabled={saveLoop.isPending || !bindingReady || !policy.canSave || !policy.preview.isSuccess || policy.preview.isFetching}>
            {t("completionPolicy.applyAndRebind")}
          </Button>
          {policySaveError && <p role="alert" className="text-sm text-destructive">{t("completionPolicy.saveFailed")}</p>}
        </div>
      )}

      {config ? (
        <div className="space-y-3 rounded-md border p-3" data-testid="bound-rails">
          <div>
            <p className="text-sm font-medium">
              {t("boardLoop.templates.bound.rails.title")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("boardLoop.templates.bound.rails.hint")}
            </p>
          </div>
          <Checkbox
            id={`${railFieldId}-enabled`}
            data-testid="bound-rails-enabled"
            checked={config.enabled}
            disabled={!canToggle}
            onCheckedChange={toggleEnabled}
            label={t("boardLoop.enableLabel")}
            description={
              needsPromptToEnable
                ? t("boardLoop.enableRequiresPrompt")
                : t("boardLoop.enableHint")
            }
          />
          <p className="text-xs text-muted-foreground">{t("boardLoop.budgetEpochHint")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {NUMERIC_RAILS.map((rail) => (
              <NumberField
                key={rail}
                id={`${railFieldId}-${rail}`}
                label={t(RAIL_FIELDS[rail].labelKey)}
                value={railValue(rail)}
                onChange={(value) =>
                  setRailEdits((prev) => ({ ...prev, [rail]: value }))
                }
                min={RAIL_FIELDS[rail].min}
                step={RAIL_FIELDS[rail].step}
                // PUT /loop is admin-only; a field you can type into but
                // never save is a trap. The enable toggle above stays open:
                // PATCH /loop/state is member-level, as in the dialog.
                disabled={!isAdmin}
              />
            ))}
          </div>
          <FieldError messages={railFindings.map(formatFinding)} />
          <Button
            type="button"
            size="sm"
            data-testid="bound-save-rails"
            disabled={!isAdmin || !railsDirty || saveLoop.isPending}
            onClick={saveRails}
          >
            {t("boardLoop.templates.bound.rails.save")}
          </Button>
        </div>
      ) : null}

      {dirty && (confirmingDetach || confirmingChange) && (
        <p
          role="alert"
          data-testid="bound-unsaved-warning"
          className="text-destructive text-xs"
        >
          {t("boardLoop.templates.bound.unsavedWarning")}
        </p>
      )}

      <div className="flex justify-end gap-2 border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          data-testid="bound-change"
          onClick={() => setConfirmingChange(true)}
        >
          {t("boardLoop.templates.bound.change")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setConfirmingDetach(true)}
          data-testid="bound-detach"
        >
          {t("boardLoop.templates.bound.editRaw")}
        </Button>
      </div>

      {/* Not destructive: unlinking keeps the rendered prompts and only stops
          template tracking, so the confirm reads as an unlock, not a delete. */}
      <ConfirmDialog
        open={confirmingDetach}
        onOpenChange={setConfirmingDetach}
        title={t("boardLoop.templates.bound.editRawTitle")}
        description={t("boardLoop.templates.bound.editRawBody")}
        confirmLabel={t("boardLoop.templates.bound.editRawConfirm")}
        destructive={false}
        pending={saveLoop.isPending}
        onConfirm={detach}
      />

      {/* Reuses the clobber-confirm copy rather than inventing new wording:
          changing template overwrites the rendered prompts exactly as applying
          one from the raw dialog does. */}
      <ConfirmDialog
        open={confirmingChange}
        onOpenChange={setConfirmingChange}
        title={t("boardLoop.templates.bound.change")}
        description={t("boardLoop.template.confirmBody", { name })}
        confirmLabel={t("boardLoop.template.confirmApply")}
        cancelLabel={t("boardLoop.template.confirmCancel")}
        onConfirm={() => {
          setConfirmingChange(false);
          onChangeTemplate();
        }}
      />

      <LoopTemplateProfileSheet
        slug={slug}
        templateRef={template.ref}
        open={profileOpen}
        onOpenChange={setProfileOpen}
      />
    </div>
  );
}
