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
import { TagInput } from "@/components/shared/TagInput";
import { FieldLabel } from "./FieldLabel";
import { JsonField } from "./JsonField";
import type { KindEditorProps } from "./types";

const STRATEGIES = ["unassigned_or_rework", "column_scan", "label_scan"] as const;
type Strategy = (typeof STRATEGIES)[number];

export function DiscoverEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"discover">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor={id("strategy")} tooltipKey="pipelineDiscoverStrategy">
            {t("pipelineBuilder.lifecycle.kinds.discover.params.strategy.label")}
          </FieldLabel>
          <Select
            value={params.strategy ?? ""}
            onValueChange={(v) => patch({ strategy: (v || undefined) as Strategy | undefined })}
          >
            <SelectTrigger id={id("strategy")} className="h-9 text-xs" disabled={disabled}>
              <SelectValue>
                {params.strategy
                  ? t(
                      `pipelineBuilder.lifecycle.kinds.discover.params.strategy.options.${params.strategy}`,
                    )
                  : ""}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STRATEGIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`pipelineBuilder.lifecycle.kinds.discover.params.strategy.options.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <FieldLabel htmlFor={id("columnType")} tooltipKey="pipelineDiscoverColumnType">
            {t("pipelineBuilder.lifecycle.kinds.discover.params.column_type.label")}
          </FieldLabel>
          <Input
            id={id("columnType")}
            value={params.column_type ?? ""}
            disabled={disabled}
            placeholder={t(
              "pipelineBuilder.lifecycle.kinds.discover.params.column_type.placeholder",
            )}
            onChange={(e) => patch({ column_type: e.target.value })}
            className="h-9 text-xs"
          />
        </div>

        <div>
          <FieldLabel htmlFor={id("columnTypeExclude")} tooltipKey="pipelineDiscoverColumnTypeExclude">
            {t("pipelineBuilder.lifecycle.kinds.discover.params.column_type_exclude.label")}
          </FieldLabel>
          <Input
            id={id("columnTypeExclude")}
            value={params.column_type_exclude ?? ""}
            disabled={disabled}
            placeholder={t(
              "pipelineBuilder.lifecycle.kinds.discover.params.column_type_exclude.placeholder",
            )}
            onChange={(e) => patch({ column_type_exclude: e.target.value })}
            className="h-9 text-xs"
          />
        </div>

        <div>
          <FieldLabel htmlFor={id("preconditions")} tooltipKey="pipelineDiscoverPreconditions">
            {t("pipelineBuilder.lifecycle.kinds.discover.params.preconditions.label")}
          </FieldLabel>
          <TagInput
            id={id("preconditions")}
            tags={params.preconditions ?? []}
            onChange={(tags) => patch({ preconditions: tags })}
            placeholder={t(
              "pipelineBuilder.lifecycle.kinds.discover.params.preconditions.placeholder",
            )}
          />
        </div>
      </div>

      <JsonField
        label={t("pipelineBuilder.lifecycle.kinds.discover.params.filters.label")}
        help={t("pipelineBuilder.lifecycle.kinds.discover.params.filters.help")}
        tooltipKey="pipelineDiscoverFilters"
        value={params.filters}
        disabled={disabled}
        onChange={(v) => patch({ filters: v })}
      />
    </div>
  );
}
