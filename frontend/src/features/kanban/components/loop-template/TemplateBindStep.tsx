// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { FieldError } from "@/components/ui/field-error";
import { loopTemplateKeys } from "@/lib/query-keys";
import { isApiError } from "@/lib/api-error";
import {
  applyLoopTemplateFixes,
  fetchLoopTemplateFit,
  previewProposedTemplateFit,
  type LoopTemplateFit,
  type LoopTemplateFitApplyResult,
} from "@/features/loop-templates/api/loop-templates";
import { useLoopTemplateDetail } from "@/features/loop-templates/hooks/useLoopTemplateDetail";
import { useSaveBoardLoop } from "@/features/kanban/api/use-board-loop";
import {
  initialSlotValues,
  missingRequired,
  readBindSlots,
  resolveRails,
  slotErrorsFromDetail,
  slotValuesForWire,
  type BindSlot,
} from "./bind-model";

interface Props {
  slug: string;
  boardUuid: string;
  templateRef: string;
  source: "system" | "workspace";
  expectedVersion?: number;
  onBound: () => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

const STATUS_VARIANT = {
  ok: "success",
  missing: "destructive",
  warn: "warning",
} as const;

// `skipped_already_satisfied` is a SUCCESS: a retry or a double-click found the
// requirement already met, which is the fix doing its job. Only `rejected` — the
// server refusing with a reason — is a warning.
const OUTCOME_VARIANT = {
  applied: "success",
  skipped_already_satisfied: "success",
  rejected: "warning",
} as const;

/**
 * Fit this template to THIS board, then bind it.
 *
 * Three things happen here, in the order an operator needs them: the board is
 * judged against the template's setup contract (with the server's own one-click
 * repairs), the slots are filled (autofill first, so most of the form is
 * already right), and the result is saved as a template binding rather than as
 * rendered prose.
 */
export function TemplateBindStep({
  slug,
  boardUuid,
  templateRef,
  source,
  expectedVersion,
  onBound,
  onCancel,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation();
  const rootId = useId();
  const fid = (name: string) => `${rootId}-${name}`;
  const queryClient = useQueryClient();

  const detailQuery = useLoopTemplateDetail(slug, templateRef);
  const fitQuery = useQuery({
    queryKey: loopTemplateKeys.fit(slug, boardUuid, templateRef),
    queryFn: (): Promise<LoopTemplateFit> =>
      fetchLoopTemplateFit(slug, boardUuid, templateRef),
    enabled: !!slug && !!boardUuid && !!templateRef,
  });

  const content = detailQuery.data?.content;
  const slots = useMemo(() => readBindSlots(content), [content]);
  const autofill = fitQuery.data?.autofill;

  // Values are seeded once per (slots, autofill) resolution rather than held in
  // an effect: re-seeding on every fit refetch would discard the operator's
  // typing each time a Fix is applied.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const seeded = useMemo(
    () => initialSlotValues(slots, autofill ?? {}),
    [slots, autofill],
  );
  const values = { ...seeded, ...edits };
  const proposal = {
    slot_values: slotValuesForWire(slots, values),
    loop_config: resolveRails(content, slots, values),
    draft: false as const,
    version: detailQuery.data?.version ?? 0,
  };
  const proposedFit = useQuery({
    queryKey: loopTemplateKeys.proposedFit(slug, boardUuid, templateRef, proposal, fitQuery.dataUpdatedAt),
    queryFn: ({ signal }) => previewProposedTemplateFit(slug, boardUuid, templateRef, proposal, signal),
    enabled: detailQuery.isSuccess && fitQuery.isSuccess && proposal.version > 0 && !detailQuery.data.is_draft,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const proposedChecks = proposedFit.data?.fit.checks ?? [];
  const proposalBlocked = proposedChecks.some((check) => check.status === "missing") || !!proposedFit.data?.preview.findings.length || !!proposedFit.data?.preview.missing_required.length;
  const proposalReady = proposedFit.isSuccess && !proposedFit.isFetching && !proposalBlocked;
  const displayedFit = Object.keys(edits).length > 0 && proposedFit.data ? proposedFit.data.fit : fitQuery.data;

  const [slotErrors, setSlotErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  const setValue = (name: string, value: string) => {
    setEdits((prev) => {
      const next = { ...prev, [name]: value };
      onDirtyChange?.(true);
      return next;
    });
    setSlotErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  // What each fix ANSWERED, keyed by the CHECK id of the row that ran it.
  //
  // Check ids and fix ids are different namespaces — `pinned_note:seed` is
  // repaired by the bare `seed_note_skeleton` — so the row that owns an outcome
  // cannot be derived from the fix id afterwards. It is captured at click time
  // instead, when both ids are in hand.
  //
  // `apply` re-runs `check` from scratch, so the refreshed checklist and these
  // outcomes describe the same request at two different instants. They are kept
  // apart deliberately: the outcome is what HAPPENED, the checklist is what IS.
  // Folding one into the other makes a `rejected` fix beside a now-`ok` row read
  // as a contradiction.
  const [outcomes, setOutcomes] = useState<
    Record<string, LoopTemplateFitApplyResult>
  >({});

  const applyFix = useMutation({
    mutationFn: ({ fixId }: { checkId: string; fixId: string }) =>
      applyLoopTemplateFixes(slug, boardUuid, templateRef, [fixId]),
    // The apply response IS a fresh report, so seeding the cache with it avoids
    // a refetch round-trip and keeps one rendering path for the checklist.
    onSuccess: (fresh, { checkId, fixId }) => {
      queryClient.setQueryData(
        loopTemplateKeys.fit(slug, boardUuid, templateRef),
        fresh,
      );
      const result = (fresh.applied ?? []).find((it) => it.fix_id === fixId);
      if (result) setOutcomes((prev) => ({ ...prev, [checkId]: result }));
    },
  });

  const saveLoop = useSaveBoardLoop(slug, boardUuid);

  const handleSave = () => {
    setSaveError(null);
    const missing = missingRequired(slots, values);
    if (missing.length > 0) {
      setSlotErrors(
        Object.fromEntries(
          missing.map((name) => [name, t("boardLoop.templates.bind.required")]),
        ),
      );
      return;
    }

    if (!proposalReady || fitQuery.data?.board_frozen || applyFix.isPending) return;
    const slotValues = slotValuesForWire(slots, values);

    saveLoop.mutate(
      {
        // Template-owned fields (system_prompt/loop_prompt/tools) are
        // deliberately absent: sending a template ref alongside raw prompts is
        // a 422 by contract — the server renders them from the binding.
        template: {
          source,
          ref: templateRef,
          version: detailQuery.data?.version,
          slot_values: slotValues,
        },
        ...resolveRails(content, slots, values),
        ...(expectedVersion !== undefined
          ? { expected_version: expectedVersion }
          : {}),
      } as never,
      {
        onSuccess: () => {
          onDirtyChange?.(false);
          onBound();
        },
        onError: (error) => {
          const mapped = slotErrorsFromDetail(
            isApiError(error) ? error.detail : undefined,
          );
          if (Object.keys(mapped).length > 0) {
            setSlotErrors(mapped);
            return;
          }
          setSaveError(t("boardLoop.templates.bind.saveFailed"));
        },
      },
    );
  };

  const frozen = fitQuery.data?.board_frozen === true;

  return (
    <div className="space-y-5" data-testid="board-loop-panel-bind">
      <section className="space-y-2">
        <h3 className="text-sm font-medium">
          {t("boardLoop.templates.bind.fitTitle")}
        </h3>
        {fitQuery.isLoading ? (
          <p className="text-muted-foreground text-sm">
            {t("boardLoop.templates.bind.fitLoading")}
          </p>
        ) : (
          <ul className="space-y-1">
            {(displayedFit?.checks ?? []).map((check) => {
              // A check whose fix already ran keeps showing its outcome even
              // after the refreshed report withdrew the fix_id — that is the
              // whole point: the answer must outlive the button.
              const outcome = outcomes[check.id];
              return (
                <li
                  key={check.id}
                  data-testid={`fit-check-${check.id}`}
                  className="flex items-center justify-between gap-3 rounded-md border p-2"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2 text-sm">
                      <Badge variant={STATUS_VARIANT[check.status]}>
                        {t(`boardLoop.templates.bind.status.${check.status}`)}
                      </Badge>
                      {check.requirement}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {check.evidence}
                    </span>
                    {outcome ? (
                      <span
                        className="mt-1 flex items-center gap-2 text-xs"
                        data-testid={`fit-outcome-${check.id}`}
                        data-outcome={outcome.outcome}
                      >
                        <Badge variant={OUTCOME_VARIANT[outcome.outcome]}>
                          {t(
                            `boardLoop.templates.bind.outcome.${outcome.outcome}`,
                          )}
                        </Badge>
                        <span className="text-muted-foreground min-w-0">
                          {outcome.detail}
                        </span>
                      </span>
                    ) : null}
                  </span>
                  {/* Only fixes the report advertised — the UI never invents one. */}
                  {check.fix_id ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={frozen || applyFix.isPending}
                      onClick={() =>
                      applyFix.mutate({
                        checkId: check.id,
                        fixId: check.fix_id as string,
                      })
                    }
                      data-testid={`fit-fix-${check.id}`}
                    >
                      {t("boardLoop.templates.bind.autoFix")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {/* A failed apply leaves the checklist STALE. Saying so is the only
            thing that distinguishes it from a fix that did nothing. */}
        {applyFix.isError ? (
          <p className="text-destructive text-xs" data-testid="fit-apply-error">
            {t("boardLoop.templates.bind.applyFailed")}
          </p>
        ) : null}
        {frozen ? (
          <p className="text-muted-foreground text-xs">
            {t("boardLoop.templates.bind.frozen")}
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">
          {t("boardLoop.templates.bind.slotsTitle")}
        </h3>
        {slots.map((slot) => (
          <SlotField
            key={slot.name}
            slot={slot}
            id={fid(slot.name)}
            value={values[slot.name] ?? ""}
            source={autofill?.[slot.name]?.source}
            error={slotErrors[slot.name]}
            onChange={(next) => setValue(slot.name, next)}
          />
        ))}
      </section>

      {proposedFit.isFetching && <p role="status" className="text-sm text-muted-foreground">{t("completionPolicy.fitPending")}</p>}
      {(proposedFit.isError || detailQuery.isError || fitQuery.isError) && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{t("completionPolicy.fitFailed")}</p><Button type="button" variant="outline" size="sm" onClick={() => { void detailQuery.refetch(); void fitQuery.refetch(); void proposedFit.refetch(); }}>{t("completionPolicy.reload")}</Button></div>}
      {proposalBlocked && <p role="status" className="text-sm text-destructive">{t("completionPolicy.fitBlocked")}</p>}
      {(proposedFit.data?.preview.findings ?? []).map((finding, index) => <p className="text-sm text-destructive" key={`${finding.code}-${index}`}>{finding.message}</p>)}
      {proposedChecks.some((check) => check.status === "warn") && <p className="text-sm text-muted-foreground">{t("completionPolicy.fitWarnings")}</p>}
      {saveError ? <FieldError messages={saveError} /> : null}

      <div className="flex justify-end gap-2 border-t pt-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={saveLoop.isPending || applyFix.isPending || frozen || (missingRequired(slots, values).length === 0 && !proposalReady)}
          data-testid="bind-save"
        >
          {t("boardLoop.templates.bind.save")}
        </Button>
      </div>
    </div>
  );
}

interface SlotFieldProps {
  slot: BindSlot;
  id: string;
  value: string;
  source?: string;
  error?: string;
  onChange: (value: string) => void;
}

function SlotField({
  slot,
  id,
  value,
  source,
  error,
  onChange,
}: SlotFieldProps) {
  const { t } = useTranslation();

  if (slot.kind === "variant") {
    const chosen = slot.variants.find((variant) => variant.id === value);
    const fills = Object.keys(chosen?.fills ?? {});
    return (
      <fieldset
        className="space-y-1"
        role="radiogroup"
        aria-label={slot.label}
        data-testid={`slot-variant-${slot.name}`}
      >
        <legend className="text-sm font-medium">{slot.label}</legend>
        {slot.help ? (
          <p className="text-muted-foreground text-xs">{slot.help}</p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          {slot.variants.map((variant) => (
            <label key={variant.id} className="flex items-center gap-1 text-sm">
              <input
                type="radio"
                name={id}
                value={variant.id}
                checked={value === variant.id}
                onChange={() => onChange(variant.id)}
              />
              {variant.label}
            </label>
          ))}
        </div>
        {/* Which sub-slots this choice fills: without it, picking a variant
            changes the rendered prompt invisibly. */}
        {fills.length > 0 ? (
          <p
            className="text-muted-foreground text-xs"
            data-testid={`variant-fills-${slot.name}`}
          >
            {t("boardLoop.templates.bind.fills", { slots: fills.join(", ") })}
          </p>
        ) : null}
      </fieldset>
    );
  }

  const control =
    // A `list` slot is edited as multi-line text: one line is one item. The
    // array conversion happens at the wire boundary, not per keystroke.
    slot.kind === "block" || slot.kind === "list" ? (
      <Textarea
        id={id}
        value={value}
        rows={4}
        placeholder={slot.example}
        onChange={(event) => onChange(event.target.value)}
      />
    ) : slot.kind === "enum" && slot.enum_values.length > 0 ? (
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
      >
        <option value="">{t("boardLoop.templates.bind.choose")}</option>
        {slot.enum_values.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    ) : (
      <Input
        id={id}
        value={value}
        placeholder={slot.example}
        onChange={(event) => onChange(event.target.value)}
      />
    );

  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="flex items-center gap-2 text-sm font-medium"
      >
        {slot.label}
        {slot.required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </label>
      {slot.help ? (
        <p className="text-muted-foreground text-xs">{slot.help}</p>
      ) : null}
      {control}
      {/* Naming the SOURCE is what makes a pre-filled value trustworthy rather
          than mysterious. */}
      {source ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid={`slot-source-${slot.name}`}
        >
          {t("boardLoop.templates.bind.from", { source })}
        </p>
      ) : null}
      {error ? (
        <p
          className="text-destructive text-xs"
          data-testid={`slot-error-${slot.name}`}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
