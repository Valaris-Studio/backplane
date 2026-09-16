// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SIBLING_COLUMN_TYPES,
  SIBLING_PRIORITIES,
} from "../../../lib/contextSourceCatalog";

// Wire shape: `{ filter: { column_type?, column?, label?, priority?, limit? } }`.
// Backend treats omitted/empty fields as "no filter on this dimension".
export interface SiblingCardsFilterValue {
  column_type?: string;
  column?: string;
  label?: string;
  priority?: string;
  limit?: number;
}

interface Props {
  value: SiblingCardsFilterValue;
  onChange: (next: SiblingCardsFilterValue) => void;
  id?: string;
}

const ANY_SENTINEL = "__any__";

function patch(
  current: SiblingCardsFilterValue,
  field: keyof SiblingCardsFilterValue,
  value: string | number | undefined,
): SiblingCardsFilterValue {
  const next = { ...current };
  if (value === undefined || value === "") {
    delete next[field];
  } else {
    // TS: index-signature narrowing handled by per-field caller below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (next as any)[field] = value;
  }
  return next;
}

export function SiblingCardsFilter({ value, onChange, id }: Props) {
  const { t } = useTranslation();
  const colTypeValue =
    value.column_type === undefined || value.column_type === ""
      ? ANY_SENTINEL
      : value.column_type;
  const priorityValue =
    value.priority === undefined || value.priority === ""
      ? ANY_SENTINEL
      : value.priority;

  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid={id}>
      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.siblingCards.columnType")}
        </label>
        <Select
          value={colTypeValue}
          onValueChange={(v) =>
            onChange(patch(value, "column_type", v === ANY_SENTINEL ? undefined : v))
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue>
              {value.column_type ||
                t(
                  "pipelineBuilder.llm.contextSources.filter.siblingCards.anyColumnType",
                )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_SENTINEL}>
              {t(
                "pipelineBuilder.llm.contextSources.filter.siblingCards.anyColumnType",
              )}
            </SelectItem>
            {SIBLING_COLUMN_TYPES.map((ct) => (
              <SelectItem key={ct} value={ct}>
                {ct}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.siblingCards.column")}
        </label>
        <Input
          value={value.column ?? ""}
          onChange={(e) =>
            onChange(patch(value, "column", e.target.value || undefined))
          }
          placeholder={t(
            "pipelineBuilder.llm.contextSources.filter.siblingCards.columnPlaceholder",
          )}
          className="h-8 text-xs"
        />
      </div>

      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.siblingCards.label")}
        </label>
        <Input
          value={value.label ?? ""}
          onChange={(e) =>
            onChange(patch(value, "label", e.target.value || undefined))
          }
          placeholder={t(
            "pipelineBuilder.llm.contextSources.filter.siblingCards.labelPlaceholder",
          )}
          className="h-8 text-xs"
        />
      </div>

      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.siblingCards.priority")}
        </label>
        <Select
          value={priorityValue}
          onValueChange={(v) =>
            onChange(patch(value, "priority", v === ANY_SENTINEL ? undefined : v))
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue>
              {value.priority ||
                t(
                  "pipelineBuilder.llm.contextSources.filter.siblingCards.anyPriority",
                )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_SENTINEL}>
              {t(
                "pipelineBuilder.llm.contextSources.filter.siblingCards.anyPriority",
              )}
            </SelectItem>
            {SIBLING_PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.siblingCards.limit")}
        </label>
        <Input
          type="number"
          min={1}
          max={50}
          value={value.limit ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(patch(value, "limit", undefined));
              return;
            }
            const n = Number.parseInt(raw, 10);
            onChange(patch(value, "limit", Number.isFinite(n) ? n : undefined));
          }}
          placeholder="10"
          className="h-8 text-xs"
        />
      </div>
    </div>
  );
}
