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

const STRATEGIES = ["merge", "squash", "rebase"] as const;
type Strategy = (typeof STRATEGIES)[number];

export function EnableAutoMergeEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"enable_auto_merge">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = `${rootId}-strategy`;

  return (
    <div>
      <FieldLabel htmlFor={id} tooltipKey="pipelineEnableAutoMergeStrategy">
        {t("pipelineBuilder.lifecycle.kinds.enable_auto_merge.params.strategy.label")}
      </FieldLabel>
      <Select
        value={params.strategy ?? ""}
        onValueChange={(v) =>
          onChange({ ...params, strategy: (v || undefined) as Strategy | undefined })
        }
      >
        <SelectTrigger id={id} className="h-9 text-xs" disabled={disabled}>
          <SelectValue>
            {params.strategy
              ? t(
                  `pipelineBuilder.lifecycle.kinds.enable_auto_merge.params.strategy.options.${params.strategy}`,
                )
              : ""}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {STRATEGIES.map((s) => (
            <SelectItem key={s} value={s}>
              {t(
                `pipelineBuilder.lifecycle.kinds.enable_auto_merge.params.strategy.options.${s}`,
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
