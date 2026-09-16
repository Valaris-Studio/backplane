// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { useTemplateDraftContext } from "../hooks/TemplateDraftProvider";

/**
 * Why this template cannot be edited, said once above the tabs.
 *
 * The four editing tabs each carry their own read-only line, and all four say
 * "System templates are defined in code" — true when `is_system` was the only
 * way a store could be read-only, and a flat lie for a MEMBER holding a
 * workspace template. The store now reports a REASON, so the shell can name
 * the actual remedy: duplicate a built-in, or ask for a role.
 */
export function TemplateReadOnlyBanner() {
  const { readOnlyReason } = useTemplateDraftContext();

  const { t } = useTranslation();

  if (!readOnlyReason) return null;

  return (
    <p
      data-testid="loop-template-readonly-banner"
      data-reason={readOnlyReason}
      className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
    >
      <Lock className="h-4 w-4 shrink-0" aria-hidden />
      {t(`loopTemplates.draft.readOnly.${readOnlyReason}`)}
    </p>
  );
}
