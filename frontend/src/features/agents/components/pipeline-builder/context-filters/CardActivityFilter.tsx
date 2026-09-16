// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";

// Wire shape: `{ filter: { limit?: number } }`.
// Backend treats omitted limit as "use the default cap".
export interface CardActivityFilterValue {
  limit?: number;
}

interface Props {
  value: CardActivityFilterValue;
  onChange: (next: CardActivityFilterValue) => void;
  id?: string;
}

function patch(
  current: CardActivityFilterValue,
  value: number | undefined,
): CardActivityFilterValue {
  const next = { ...current };
  if (value === undefined) {
    delete next.limit;
  } else {
    next.limit = value;
  }
  return next;
}

export function CardActivityFilter({ value, onChange, id }: Props) {
  const { t } = useTranslation();

  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid={id}>
      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.cardActivity.limit")}
        </label>
        <Input
          type="number"
          min={1}
          max={50}
          value={value.limit ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(patch(value, undefined));
              return;
            }
            const n = Number.parseInt(raw, 10);
            onChange(patch(value, Number.isFinite(n) ? n : undefined));
          }}
          placeholder="10"
          className="h-8 text-xs"
        />
      </div>
    </div>
  );
}
