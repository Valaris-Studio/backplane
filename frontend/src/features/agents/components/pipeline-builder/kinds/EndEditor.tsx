// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import type { KindEditorProps } from "./types";

export function EndEditor(_props: KindEditorProps<"end">) {
  const { t } = useTranslation();
  return (
    // A flex row holding an info tooltip (RichTooltip renders a <div>), so this
    // wrapper must be a <div>, not a <p> — <div> inside <p> is invalid HTML.
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>{t("pipelineBuilder.lifecycle.kinds.end.description")}</span>
      <RichTooltip i18nKey="pipelineEnd" side="top">
        <Info className="h-3 w-3 text-muted-foreground/70" aria-hidden />
      </RichTooltip>
    </div>
  );
}
