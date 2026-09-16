// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

// Shown while a lazily-loaded route module's chunk downloads. Sits inside the
// AppShell/BoardLayout/RunnerLayout content area so the persistent chrome (sidebar,
// tab nav) stays put — only the page body shows this during a route transition.
export function RouteFallback() {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-1 items-center justify-center py-24 text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      <span className="sr-only">{t("common.loading")}</span>
    </div>
  );
}
