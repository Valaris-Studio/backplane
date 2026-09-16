// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "./FieldLabel";
import type { KindEditorProps } from "./types";

export function RemoveLabelEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"remove_label">) {
  const { t } = useTranslation();
  const id = useId();

  return (
    <div>
      <FieldLabel htmlFor={id} tooltipKey="pipelineRemoveLabel">
        {t("pipelineBuilder.lifecycle.kinds.remove_label.params.label.label")}
      </FieldLabel>
      <Input
        id={id}
        value={params.label ?? ""}
        disabled={disabled}
        placeholder={t("pipelineBuilder.lifecycle.kinds.remove_label.params.label.placeholder")}
        onChange={(e) => onChange({ ...params, label: e.target.value })}
        className="h-9 text-xs"
      />
    </div>
  );
}
