// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { FieldCheckbox } from "../FieldCheckbox";
import { FieldLabel } from "./FieldLabel";
import type { KindEditorProps } from "./types";

export function CreateNoteEditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"create_note">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel htmlFor={id("kind")} tooltipKey="pipelineCreateNoteKind">
          {t("pipelineBuilder.lifecycle.kinds.create_note.params.kind.label")}
        </FieldLabel>
        <Input
          id={id("kind")}
          value={params.kind ?? ""}
          disabled={disabled}
          placeholder={t("pipelineBuilder.lifecycle.kinds.create_note.params.kind.placeholder")}
          onChange={(e) => patch({ kind: e.target.value })}
          className="h-9 text-xs"
        />
      </div>
      <FieldCheckbox
        id={id("fromLlmOutput")}
        label={t("pipelineBuilder.lifecycle.kinds.create_note.params.from_llm_output.label")}
        checked={Boolean(params.from_llm_output)}
        disabled={disabled}
        onChange={(v) => patch({ from_llm_output: v })}
        tooltipKey="pipelineCreateNoteFromLlmOutput"
      />
    </div>
  );
}
