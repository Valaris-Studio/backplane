// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Info, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CONTEXT_SOURCE_CATALOG,
  lookupContextSource,
} from "../../lib/contextSourceCatalog";
import type { ContextSourceEntry } from "../../api/pipelineConfig";
import { CardNotesFilter } from "./context-filters/CardNotesFilter";
import {
  SiblingCardsFilter,
  type SiblingCardsFilterValue,
} from "./context-filters/SiblingCardsFilter";
import {
  BoardSnapshotFilter,
  type BoardSnapshotFilterValue,
} from "./context-filters/BoardSnapshotFilter";
import {
  LinkedCardsFilter,
  type LinkedCardsFilterValue,
} from "./context-filters/LinkedCardsFilter";
import {
  ExecutionHistoryFilter,
  type ExecutionHistoryFilterValue,
} from "./context-filters/ExecutionHistoryFilter";
import {
  CardActivityFilter,
  type CardActivityFilterValue,
} from "./context-filters/CardActivityFilter";
import {
  PipelineExpectationsFilter,
  type PipelineExpectationsFilterValue,
} from "./context-filters/PipelineExpectationsFilter";

interface Props {
  value: ContextSourceEntry[];
  onChange: (next: ContextSourceEntry[]) => void;
  id?: string;
}

const DEFAULT_KIND = CONTEXT_SOURCE_CATALOG[0]?.kind ?? "card_notes";

export function ContextSourcePicker({ value, onChange, id }: Props) {
  const { t } = useTranslation();
  const rootId = useId();

  function addRow() {
    onChange([...value, { kind: DEFAULT_KIND }]);
  }

  function updateRow(index: number, patch: Partial<ContextSourceEntry>) {
    const next = value.map((entry, i) =>
      i === index ? { ...entry, ...patch } : entry,
    );
    onChange(next);
  }

  function removeRow(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <div id={id} className="space-y-2">
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {value.map((entry, index) => {
            const catalog = lookupContextSource(entry.kind);
            const rowId = `${rootId}-row-${index}`;
            return (
              <li
                key={index}
                className="rounded-[var(--radius-sm)] border border-border/70 bg-surface-1/40 p-2"
                data-testid={`context-source-row-${index}`}
              >
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <div>
                    <label
                      htmlFor={`${rowId}-kind`}
                      className="mb-1 flex items-center gap-1 text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      <span>{t("pipelineBuilder.llm.contextSources.kindLabel")}</span>
                      <RichTooltip i18nKey="pipelineContextSourceKind" side="top">
                        <Info className="h-3 w-3 text-muted-foreground/70" aria-hidden />
                      </RichTooltip>
                    </label>
                    <Select
                      value={entry.kind}
                      onValueChange={(kind) =>
                        // Reset filter when switching kinds — schemas don't
                        // overlap and stale keys would silently fail validation.
                        updateRow(index, { kind, filter: undefined })
                      }
                    >
                      <SelectTrigger id={`${rowId}-kind`} className="h-9 text-xs">
                        <SelectValue>
                          {catalog ? t(catalog.displayNameKey) : entry.kind}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {CONTEXT_SOURCE_CATALOG.map((opt) => (
                          <SelectItem key={opt.kind} value={opt.kind}>
                            {t(opt.displayNameKey)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor={`${rowId}-filter`}
                      className="mb-1 flex items-center gap-1 text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      <span>{t("pipelineBuilder.llm.contextSources.filterLabel")}</span>
                      <RichTooltip i18nKey="pipelineContextSourceFilter" side="top">
                        <Info className="h-3 w-3 text-muted-foreground/70" aria-hidden />
                      </RichTooltip>
                    </label>
                    {entry.kind === "card_notes" ? (
                      <CardNotesFilter
                        id={`${rowId}-filter`}
                        value={(entry.filter?.kind as string | undefined) ?? ""}
                        onChange={(noteKind) =>
                          updateRow(index, {
                            filter: noteKind ? { kind: noteKind } : undefined,
                          })
                        }
                      />
                    ) : entry.kind === "sibling_cards" ? (
                      <SiblingCardsFilter
                        id={`${rowId}-filter`}
                        value={(entry.filter as SiblingCardsFilterValue) ?? {}}
                        onChange={(next) =>
                          updateRow(index, {
                            filter:
                              Object.keys(next).length === 0
                                ? undefined
                                : (next as Record<string, unknown>),
                          })
                        }
                      />
                    ) : entry.kind === "board_snapshot" ? (
                      <BoardSnapshotFilter
                        id={`${rowId}-filter`}
                        value={(entry.filter as BoardSnapshotFilterValue) ?? {}}
                        onChange={(next) =>
                          updateRow(index, {
                            filter:
                              Object.keys(next).length === 0
                                ? undefined
                                : (next as Record<string, unknown>),
                          })
                        }
                      />
                    ) : entry.kind === "linked_cards" ? (
                      <LinkedCardsFilter
                        id={`${rowId}-filter`}
                        value={(entry.filter as LinkedCardsFilterValue) ?? {}}
                        onChange={(next) =>
                          updateRow(index, {
                            filter:
                              Object.keys(next).length === 0
                                ? undefined
                                : (next as Record<string, unknown>),
                          })
                        }
                      />
                    ) : entry.kind === "execution_history" ? (
                      <ExecutionHistoryFilter
                        id={`${rowId}-filter`}
                        value={
                          (entry.filter as ExecutionHistoryFilterValue) ?? {}
                        }
                        onChange={(next) =>
                          updateRow(index, {
                            filter:
                              Object.keys(next).length === 0
                                ? undefined
                                : (next as Record<string, unknown>),
                          })
                        }
                      />
                    ) : entry.kind === "card_activity" ? (
                      <CardActivityFilter
                        id={`${rowId}-filter`}
                        value={(entry.filter as CardActivityFilterValue) ?? {}}
                        onChange={(next) =>
                          updateRow(index, {
                            filter:
                              Object.keys(next).length === 0
                                ? undefined
                                : (next as Record<string, unknown>),
                          })
                        }
                      />
                    ) : entry.kind === "pipeline_expectations" ? (
                      <PipelineExpectationsFilter
                        id={`${rowId}-filter`}
                        value={
                          (entry.filter as PipelineExpectationsFilterValue) ?? {}
                        }
                        onChange={(next) =>
                          updateRow(index, {
                            filter:
                              Object.keys(next).length === 0
                                ? undefined
                                : (next as Record<string, unknown>),
                          })
                        }
                      />
                    ) : (
                      <p className="flex h-9 items-center text-xs text-muted-foreground">
                        {t("pipelineBuilder.llm.contextSources.filter.none")}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor={`${rowId}-as`}
                      className="mb-1 flex items-center gap-1 text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      <span>{t("pipelineBuilder.llm.contextSources.asLabel")}</span>
                      <RichTooltip i18nKey="pipelineContextSourceAs" side="top">
                        <Info className="h-3 w-3 text-muted-foreground/70" aria-hidden />
                      </RichTooltip>
                    </label>
                    <Input
                      id={`${rowId}-as`}
                      value={entry.as ?? ""}
                      onChange={(e) => {
                        const trimmed = e.target.value;
                        updateRow(index, {
                          as: trimmed === "" ? undefined : trimmed,
                        });
                      }}
                      placeholder={t(
                        "pipelineBuilder.llm.contextSources.asPlaceholder",
                      )}
                      className="h-9 text-xs"
                    />
                  </div>

                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={() => removeRow(index)}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground hover:bg-muted/40 hover:text-destructive"
                      aria-label={t(
                        "pipelineBuilder.llm.contextSources.removeSource",
                      )}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={addRow}
        className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-border/70 px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/40"
      >
        <Plus className="h-3 w-3" />
        {t("pipelineBuilder.llm.contextSources.addSource")}
      </button>
    </div>
  );
}
