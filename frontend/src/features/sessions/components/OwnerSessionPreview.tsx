// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { ContextLink } from "@/components/shared/ContextLink";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function OwnerSessionPreview({ viewAllHref, children }: { viewAllHref?: string; children: ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-sm font-semibold">{t("sessions.discovery.title")}</h2>
          <p id={`${id}-description`} className="sr-only">{t("sessions.discovery.description")}</p>
        </div>
        {viewAllHref ? <ContextLink to={viewAllHref} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0")}>{t("sessions.discovery.viewAll")}<ArrowRight className="size-4" aria-hidden /></ContextLink> : null}
      </div>
      {children}
    </section>
  );
}
