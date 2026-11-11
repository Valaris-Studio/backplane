// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ActivityFiltersBar } from "@/features/activity/components/ActivityFilters";
import { ActivityTimeline } from "@/features/activity/components/ActivityTimeline";
import { PageHeader } from "@/components/layout/PageHeader";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { ActivityFilters } from "@/types/activity";

interface HistoryFiltersView {
  filters: ActivityFilters;
  searchInput: string;
}

export function WorkspaceHistoryPage() {
  const { slug = "" } = useParams();
  const location = useLocation();
  return <WorkspaceHistoryView key={`${slug}:${location.key}`} slug={slug} />;
}

function WorkspaceHistoryView({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const returnNavigation = useReturnNavigation();
  const viewKey = `workspace-history-filter-input:${slug}`;
  const [view, setView] = useState<HistoryFiltersView>(() =>
    returnNavigation?.readView<HistoryFiltersView>(viewKey) ?? { filters: {}, searchInput: "" },
  );
  const { filters, searchInput } = view;

  const updateFilters = useCallback((filters: ActivityFilters) => {
    const next = { filters, searchInput };
    returnNavigation?.writeView(viewKey, next);
    setView(next);
  }, [returnNavigation, searchInput, viewKey]);

  function updateSearchInput(searchInput: string) {
    // Capture pending text before navigation can unmount the debounce timer.
    const next = { filters, searchInput };
    returnNavigation?.writeView(viewKey, next);
    setView(next);
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        eyebrow={t("common.workspace")}
        title={t("activity.workspaceHistory")}
      />
      <ActivityFiltersBar
        filters={filters}
        onChange={updateFilters}
        searchInput={searchInput}
        onSearchInputChange={updateSearchInput}
      />
      <ActivityTimeline slug={slug} filters={filters} />
    </div>
  );
}
