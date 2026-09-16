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
import { EXECUTION_STATUSES } from "../../../lib/contextSourceCatalog";

// Wire shape: `{ filter: { status?: <ExecutionStatus>, limit?: number } }`.
// Backend treats omitted fields as "no constraint on this dimension".
export interface ExecutionHistoryFilterValue {
  status?: string;
  limit?: number;
}

interface Props {
  value: ExecutionHistoryFilterValue;
  onChange: (next: ExecutionHistoryFilterValue) => void;
  id?: string;
}

const ANY_SENTINEL = "__any__";

function patch(
  current: ExecutionHistoryFilterValue,
  field: keyof ExecutionHistoryFilterValue,
  value: string | number | undefined,
): ExecutionHistoryFilterValue {
  const next = { ...current };
  if (value === undefined || value === "") {
    delete next[field];
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (next as any)[field] = value;
  }
  return next;
}

export function ExecutionHistoryFilter({ value, onChange, id }: Props) {
  const { t } = useTranslation();
  const statusValue =
    value.status === undefined || value.status === ""
      ? ANY_SENTINEL
      : value.status;

  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid={id}>
      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.executionHistory.status")}
        </label>
        <Select
          value={statusValue}
          onValueChange={(v) =>
            onChange(patch(value, "status", v === ANY_SENTINEL ? undefined : v))
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue>
              {value.status ||
                t(
                  "pipelineBuilder.llm.contextSources.filter.executionHistory.anyStatus",
                )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_SENTINEL}>
              {t(
                "pipelineBuilder.llm.contextSources.filter.executionHistory.anyStatus",
              )}
            </SelectItem>
            {EXECUTION_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">
          {t("pipelineBuilder.llm.contextSources.filter.executionHistory.limit")}
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
