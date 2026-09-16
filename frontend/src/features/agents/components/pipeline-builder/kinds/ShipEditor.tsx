// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
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

export function ShipEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"ship">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = `${rootId}-toColumnType`;

  return (
    <div>
      <FieldLabel htmlFor={id} tooltipKey="pipelineShipToColumnType">
        {t("pipelineBuilder.lifecycle.kinds.ship.params.to_column_type.label")}
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
        <SelectTrigger id={id} className="h-9 text-xs" disabled={disabled}>
          <SelectValue>
            {params.to_column_type
              ? t(
                  `pipelineBuilder.lifecycle.kinds.ship.params.to_column_type.options.${params.to_column_type}`,
                )
              : ""}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {COLUMN_TYPES.map((c) => (
            <SelectItem key={c} value={c}>
              {t(
                `pipelineBuilder.lifecycle.kinds.ship.params.to_column_type.options.${c}`,
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
