// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";

// Wire shape: `{ filter: { include_done?: boolean, max_cards_per_column?: int } }`.
// Backend defaults: include_done=false, max_cards_per_column=20 (cap 100).
export interface BoardSnapshotFilterValue {
  include_done?: boolean;
  max_cards_per_column?: number;
}

interface Props {
  value: BoardSnapshotFilterValue;
  onChange: (next: BoardSnapshotFilterValue) => void;
  id?: string;
}

export function BoardSnapshotFilter({ value, onChange, id }: Props) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid={id}>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={Boolean(value.include_done)}
          onChange={(e) => {
            const next = { ...value };
            if (e.target.checked) {
              next.include_done = true;
            } else {
              delete next.include_done;
            }
            onChange(next);
          }}
          className="h-3.5 w-3.5 rounded border-border"
        />
        {t("pipelineBuilder.llm.contextSources.filter.boardSnapshot.includeDone")}
      </label>

      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.boardSnapshot.maxCards")}
        </label>
        <Input
          type="number"
          min={1}
          max={100}
          value={value.max_cards_per_column ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            const next = { ...value };
            if (raw === "") {
              delete next.max_cards_per_column;
            } else {
              const n = Number.parseInt(raw, 10);
              if (Number.isFinite(n)) {
                next.max_cards_per_column = n;
              } else {
                delete next.max_cards_per_column;
              }
            }
            onChange(next);
          }}
          placeholder="20"
          className="h-8 text-xs"
        />
      </div>
    </div>
  );
}
