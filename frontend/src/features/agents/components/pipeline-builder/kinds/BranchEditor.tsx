// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "./FieldLabel";
import { JsonField } from "./JsonField";
import type { KindEditorProps } from "./types";

export function BranchEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"branch">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel htmlFor={id("expression")} tooltipKey="pipelineBranchExpression">
          {t("pipelineBuilder.lifecycle.kinds.branch.params.expression.label")}
        </FieldLabel>
        <Input
          id={id("expression")}
          value={params.expression ?? ""}
          disabled={disabled}
          placeholder={t("pipelineBuilder.lifecycle.kinds.branch.params.expression.placeholder")}
          onChange={(e) => patch({ expression: e.target.value })}
          className="h-9 text-xs"
        />
      </div>
      <JsonField
        label={t("pipelineBuilder.lifecycle.kinds.branch.params.cases.label")}
        help={t("pipelineBuilder.lifecycle.kinds.branch.params.cases.help")}
        tooltipKey="pipelineBranchCases"
        value={params.cases}
        disabled={disabled}
        onChange={(v) => patch({ cases: v })}
      />
    </div>
  );
}
