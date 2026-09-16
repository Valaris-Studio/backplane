// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "./FieldLabel";
import type { KindEditorProps } from "./types";

export function CreatePREditor({
  params,
  onChange,
  disabled,
}: KindEditorProps<"create_pr">) {
  const { t } = useTranslation();
  const rootId = useId();
  const id = (n: string) => `${rootId}-${n}`;
  const patch = (diff: Partial<typeof params>) => onChange({ ...params, ...diff });

  return (
    <div className="space-y-3">
      <div
        role="note"
        className="flex items-start gap-2 rounded-md border border-muted bg-muted/30 p-2 text-xs text-muted-foreground"
      >
        <Info className="mt-0.5 h-3.5 w-3.5" aria-hidden />
        <span>{t("pipelineBuilder.lifecycle.kinds.create_pr.templateReservedNote")}</span>
      </div>
      <div>
        <FieldLabel htmlFor={id("titleFrom")} tooltipKey="pipelineCreatePrTitleFrom">
          {t("pipelineBuilder.lifecycle.kinds.create_pr.params.title_from.label")}
        </FieldLabel>
        <Input
          id={id("titleFrom")}
          value={params.title_from ?? ""}
          disabled={disabled}
          placeholder={t(
            "pipelineBuilder.lifecycle.kinds.create_pr.params.title_from.placeholder",
          )}
          onChange={(e) => patch({ title_from: e.target.value })}
          className="h-9 text-xs"
        />
      </div>
      <div>
        <FieldLabel htmlFor={id("bodyFrom")} tooltipKey="pipelineCreatePrBodyFrom">
          {t("pipelineBuilder.lifecycle.kinds.create_pr.params.body_from.label")}
        </FieldLabel>
        <Input
          id={id("bodyFrom")}
          value={params.body_from ?? ""}
          disabled={disabled}
          placeholder={t(
            "pipelineBuilder.lifecycle.kinds.create_pr.params.body_from.placeholder",
          )}
          onChange={(e) => patch({ body_from: e.target.value })}
          className="h-9 text-xs"
        />
      </div>
    </div>
  );
}
