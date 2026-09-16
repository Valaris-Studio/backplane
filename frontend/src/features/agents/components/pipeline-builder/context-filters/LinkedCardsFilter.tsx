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
import { LINKED_CARDS_DIRECTIONS } from "../../../lib/contextSourceCatalog";

// Wire shape: `{ filter: { direction?: "depends_on" | "blocks" | "both", limit?: number } }`.
// Backend treats omitted fields as "no constraint on this dimension".
export interface LinkedCardsFilterValue {
  direction?: string;
  limit?: number;
}

interface Props {
  value: LinkedCardsFilterValue;
  onChange: (next: LinkedCardsFilterValue) => void;
  id?: string;
}

const ANY_SENTINEL = "__any__";

function patch(
  current: LinkedCardsFilterValue,
  field: keyof LinkedCardsFilterValue,
  value: string | number | undefined,
): LinkedCardsFilterValue {
  const next = { ...current };
  if (value === undefined || value === "") {
    delete next[field];
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (next as any)[field] = value;
  }
  return next;
}

export function LinkedCardsFilter({ value, onChange, id }: Props) {
  const { t } = useTranslation();
  const directionValue =
    value.direction === undefined || value.direction === ""
      ? ANY_SENTINEL
      : value.direction;

  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid={id}>
      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.linkedCards.direction")}
        </label>
        <Select
          value={directionValue}
          onValueChange={(v) =>
            onChange(patch(value, "direction", v === ANY_SENTINEL ? undefined : v))
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue>
              {value.direction ||
                t(
                  "pipelineBuilder.llm.contextSources.filter.linkedCards.anyDirection",
                )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_SENTINEL}>
              {t(
                "pipelineBuilder.llm.contextSources.filter.linkedCards.anyDirection",
              )}
            </SelectItem>
            {LINKED_CARDS_DIRECTIONS.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.linkedCards.limit")}
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
