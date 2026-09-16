// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { HelpCircle } from "lucide-react";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import { RichTooltip } from "@/components/ui/rich-tooltip";

interface Props {
  value: string;
  onChange: (value: string) => void;
  workspaceSlug: string;
}

export function ScopeSection({ value, onChange, workspaceSlug }: Props) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {t("definitions.scopeLabel")}
        <RichTooltip i18nKey="workspace.definitions.scope" side="right">
          <HelpCircle
            aria-label={t("definitions.scopeLabel")}
            className="h-3.5 w-3.5 text-muted-foreground"
          />
        </RichTooltip>
      </label>
      <RichTextEditor
        content={value}
        onChange={onChange}
        placeholder={t("definitions.scopePlaceholder")}
        workspaceSlug={workspaceSlug}
        className="min-h-[220px] max-h-[70vh] overflow-y-auto"
      />
    </div>
  );
}
