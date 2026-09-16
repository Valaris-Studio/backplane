// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "./FieldLabel";
import type { KindEditorProps } from "./types";

const COLUMN_TYPES = ["backlog", "active", "review", "done", "blocked"] as const;
type ColumnType = (typeof COLUMN_TYPES)[number];

const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
type CardPriority = (typeof PRIORITIES)[number];

// Labels persist as `string[]` to match the backend params_schema; the UI
// surfaces them as a comma-separated field (mirrors WakeRoleEditor's roles).
function parseLabels(raw: string): string[] {
  return raw
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function CreateFixCardsEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"create_fix_cards">) {
  const { t } = useTranslation();
  const rootId = useId();
  const columnId = `${rootId}-toColumnType`;
  const labelsId = `${rootId}-labels`;
  const priorityId = `${rootId}-priority`;
  const base = "pipelineBuilder.lifecycle.kinds.create_fix_cards.params";

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel htmlFor={columnId} tooltipKey="pipelineCreateFixCardsToColumnType">
          {t(`${base}.to_column_type.label`)}
        </FieldLabel>
        <Select
          value={params.to_column_type ?? ""}
          onValueChange={(v) =>
            onChange({
              ...params,
              to_column_type: (v || undefined) as ColumnType | undefined,
            })
          }
        >
          <SelectTrigger id={columnId} className="h-9 text-xs" disabled={disabled}>
            <SelectValue>
              {params.to_column_type
                ? t(`${base}.to_column_type.options.${params.to_column_type}`)
                : ""}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {COLUMN_TYPES.map((c) => (
              <SelectItem key={c} value={c}>
                {t(`${base}.to_column_type.options.${c}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <FieldLabel htmlFor={labelsId} tooltipKey="pipelineCreateFixCardsLabels">
          {t(`${base}.labels.label`)}
        </FieldLabel>
        <Input
          id={labelsId}
          value={(params.labels ?? []).join(", ")}
          disabled={disabled}
          placeholder={t(`${base}.labels.placeholder`)}
          onChange={(e) => onChange({ ...params, labels: parseLabels(e.target.value) })}
          className="h-9 text-xs"
        />
      </div>

      <div>
        <FieldLabel htmlFor={priorityId} tooltipKey="pipelineCreateFixCardsPriority">
          {t(`${base}.priority.label`)}
        </FieldLabel>
        <Select
          value={params.priority ?? ""}
          onValueChange={(v) =>
            onChange({
              ...params,
              priority: (v || undefined) as CardPriority | undefined,
            })
          }
        >
          <SelectTrigger id={priorityId} className="h-9 text-xs" disabled={disabled}>
            <SelectValue>
              {params.priority ? t(`${base}.priority.options.${params.priority}`) : ""}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                {t(`${base}.priority.options.${p}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
