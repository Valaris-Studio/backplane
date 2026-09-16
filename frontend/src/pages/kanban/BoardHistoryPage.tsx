// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Clapperboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActivityFiltersBar } from "@/features/activity/components/ActivityFilters";
import { ActivityTimeline } from "@/features/activity/components/ActivityTimeline";
import type { ActivityFilters } from "@/types/activity";

export function BoardHistoryPage() {
  const { slug = "", boardId = "" } = useParams();
  const { t } = useTranslation();
  const [filters, setFilters] = useState<ActivityFilters>({});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 rounded-[calc(var(--radius-lg))] border border-border/70 bg-[color:var(--color-surface-1)] px-4 py-3">
        <p className="text-sm text-muted-foreground">{t("timeline.historyCallout")}</p>
        <Link to={`/${slug}/boards/${boardId}/timeline`}>
          <Button variant="outline" className="gap-2">
            <Clapperboard className="h-4 w-4" />
            {t("timeline.openSimulator")}
          </Button>
        </Link>
      </div>
      <ActivityFiltersBar filters={filters} onChange={setFilters} />
      <ActivityTimeline slug={slug} boardId={boardId} filters={filters} />
    </div>
  );
}
