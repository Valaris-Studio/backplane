// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ActivityFiltersBar } from "@/features/activity/components/ActivityFilters";
import { ActivityTimeline } from "@/features/activity/components/ActivityTimeline";
import { PageHeader } from "@/components/layout/PageHeader";
import type { ActivityFilters } from "@/types/activity";

export function WorkspaceHistoryPage() {
  const { slug = "" } = useParams();
  const { t } = useTranslation();
  const [filters, setFilters] = useState<ActivityFilters>({});

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        eyebrow={t("common.workspace")}
        title={t("activity.workspaceHistory")}
      />
      <ActivityFiltersBar filters={filters} onChange={setFilters} />
      <ActivityTimeline slug={slug} filters={filters} />
    </div>
  );
}
