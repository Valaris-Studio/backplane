// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import type { ColumnType } from "@/types/kanban";
import { useTemplateDraftContext } from "../hooks/TemplateDraftProvider";
import {
  CONTRACT_FLAGS,
  CONTRACT_CHIP_LISTS,
  readSetupContract,
  writeSetupContract,
  type ContractChipList,
  type SetupContract,
} from "../lib/rails-catalog";

/**
 * The ColumnType union is the single source for this multi-select — the spec's
 * hardest rule is that the platform's column TYPES are this closed set and
 * that `todo`/`in_progress` are column NAMES, not types. Re-listing the
 * strings here would let the two drift; this array is the union's only
 * runtime witness and the type annotation makes a drift a BUILD error.
 */
const COLUMN_TYPES: readonly ColumnType[] = [
  "backlog",
  "active",
  "review",
  "done",
  "blocked",
] as const;

const INPUT_CLASS =
  "border-input bg-background h-8 w-full rounded-md border px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60";

// The slug/templateRef props are the SHELL's routing identity: this tab no
// longer reads them (the draft store is the shell's), but every tab keeps the
// same call signature so the shell mounts them uniformly.
export function LoopTemplateContractTab(_props: { slug: string; templateRef: string }) {
  const { t } = useTranslation();
  const draft = useTemplateDraftContext();
  const [chipDrafts, setChipDrafts] = useState<Record<string, string>>({});

  const content = draft.draft?.content;
  const contract = useMemo(() => readSetupContract(content), [content]);
  const setField = draft.setField;

  const commit = useCallback(
    (next: SetupContract) => {
      setField("content.setup_contract", writeSetupContract(next));
    },
    [setField],
  );

  const toggleColumnType = useCallback(
    (bucket: "required" | "optional", type: ColumnType) => {
      const requiredSet = new Set(contract.required_column_types);
      const optionalSet = new Set(contract.optional_column_types);
      const target = bucket === "required" ? requiredSet : optionalSet;
      const other = bucket === "required" ? optionalSet : requiredSet;

      if (target.has(type)) target.delete(type);
      else {
        target.add(type);
        // Required and optional are mutually exclusive: a type promoted to one
        // bucket must leave the other, or the fit check sees it twice.
        other.delete(type);
      }

      commit({
        ...contract,
        // Order follows the enum, so the stored list is stable regardless of
        // the order an operator happened to click the boxes in.
        required_column_types: COLUMN_TYPES.filter((c) => requiredSet.has(c)),
        optional_column_types: COLUMN_TYPES.filter((c) => optionalSet.has(c)),
      });
    },
    [contract, commit],
  );

  const addChip = useCallback(
    (list: ContractChipList, raw: string) => {
      const value = raw.trim();
      // A blank or duplicate entry is a no-op, not an autosave.
      if (!value || contract[list].includes(value)) return false;
      commit({ ...contract, [list]: [...contract[list], value] });
      return true;
    },
    [contract, commit],
  );

  const removeChip = useCallback(
    (list: ContractChipList, index: number) => {
      commit({
        ...contract,
        [list]: contract[list].filter((_, i) => i !== index),
      });
    },
    [contract, commit],
  );

  if (draft.isLoading || !draft.draft) {
    return (
      <Skeleton
        className="h-64 w-full"
        data-testid="loop-template-contract-loading"
      />
    );
  }

  const readOnly = draft.readOnly;

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="loop-template-contract-tab"
    >
      {readOnly && (
        <p
          data-testid="loop-template-contract-readonly"
          className="text-muted-foreground text-xs"
        >
          {t("loopTemplates.contract.readOnly")}
        </p>
      )}

      {(["required", "optional"] as const).map((bucket) => (
        <section key={bucket} className="space-y-2">
          <RichTooltip
            i18nKey={`loopTemplates.contract.${bucket}_column_types`}
            side="right"
          >
            <span className="text-foreground cursor-help text-sm font-medium underline decoration-dotted underline-offset-4">
              {t(`loopTemplates.contract.${bucket}ColumnTypes`)}
            </span>
          </RichTooltip>
          <div className="flex flex-wrap gap-3">
            {COLUMN_TYPES.map((type) => {
              const list =
                bucket === "required"
                  ? contract.required_column_types
                  : contract.optional_column_types;
              return (
                <label
                  key={type}
                  className="flex items-center gap-1.5 font-mono text-xs"
                >
                  <input
                    type="checkbox"
                    data-testid={`loop-template-contract-${bucket}-${type}`}
                    disabled={readOnly}
                    checked={list.includes(type)}
                    onChange={() => toggleColumnType(bucket, type)}
                  />
                  {type}
                </label>
              );
            })}
          </div>
        </section>
      ))}

      <section className="space-y-2">
        <span className="text-sm font-medium">
          {t("loopTemplates.contract.flags")}
        </span>
        <div className="flex flex-col gap-2">
          {CONTRACT_FLAGS.map((flag) => (
            <label key={flag} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                data-testid={`loop-template-contract-flag-${flag}`}
                disabled={readOnly}
                checked={contract[flag]}
                onChange={() => commit({ ...contract, [flag]: !contract[flag] })}
              />
              <RichTooltip
                i18nKey={`loopTemplates.contract.${flag}`}
                side="right"
              >
                <span className="text-foreground cursor-help font-mono underline decoration-dotted underline-offset-4">
                  {flag}
                </span>
              </RichTooltip>
            </label>
          ))}
        </div>
      </section>

      {CONTRACT_CHIP_LISTS.map((list) => (
        <section key={list} className="space-y-2">
          <RichTooltip i18nKey={`loopTemplates.contract.${list}`} side="right">
            <label
              htmlFor={`contract-${list}`}
              className="text-foreground cursor-help font-mono text-xs underline decoration-dotted underline-offset-4"
            >
              {list}
            </label>
          </RichTooltip>
          <div className="flex flex-wrap gap-1.5">
            {contract[list].map((entry, index) => (
              <span
                key={`${entry}-${index}`}
                data-testid={`loop-template-contract-chip-${list}-${index}`}
                className="bg-muted flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs"
              >
                {entry}
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={t("loopTemplates.contract.removeChip", {
                      value: entry,
                    })}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeChip(list, index)}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
          <input
            id={`contract-${list}`}
            data-testid={`loop-template-contract-list-${list}`}
            className={INPUT_CLASS}
            disabled={readOnly}
            placeholder={t("loopTemplates.contract.addChip")}
            value={chipDrafts[list] ?? ""}
            onChange={(e) =>
              setChipDrafts((drafts) => ({ ...drafts, [list]: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (addChip(list, e.currentTarget.value)) {
                setChipDrafts((drafts) => ({ ...drafts, [list]: "" }));
              }
            }}
          />
        </section>
      ))}

      <section className="space-y-1.5">
        <span className="text-sm font-medium">
          {t("loopTemplates.contract.summaryLabel")}
        </span>
        <p
          data-testid="loop-template-contract-summary"
          className="text-muted-foreground text-xs"
        >
          {t("loopTemplates.contract.summary", {
            required: contract.required_column_types.join(", ") || "—",
            optional: contract.optional_column_types.join(", ") || "—",
            flags:
              CONTRACT_FLAGS.filter((flag) => contract[flag]).join(", ") || "—",
            keys: contract.definition_keys.join(", ") || "—",
          })}
        </p>
      </section>
    </div>
  );
}
