// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, CircleDashed } from "lucide-react";
import { EmptyState } from "@/components/layout/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import { useCompanionEnabled } from "../api/use-sessions";

// Session routes exist on every server; with capture off the endpoints 404 by
// design, so the screen explains the switch instead of calling them.
export function CompanionGate({ children }: { children: ReactNode }) {
  const enabled = useCompanionEnabled();
  const { slug = "" } = useParams();
  const { t } = useTranslation();

  if (enabled === undefined) {
    return <Skeleton className="h-40 w-full" data-testid="companion-gate-pending" />;
  }

  if (!enabled) {
    return (
      <EmptyState
        icon={CircleDashed}
        title={t("sessions.captureOff.title")}
        description={t("sessions.captureOff.description")}
        action={
          <Link
            to={`/${slug}/documentation/environment-variables`}
            className={buttonVariants({ variant: "ghost" })}
          >
            <BookOpen aria-hidden />
            {t("sessions.captureOff.docsLink")}
          </Link>
        }
      />
    );
  }

  return <>{children}</>;
}
