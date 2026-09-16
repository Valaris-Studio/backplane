// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ActivityEntityType } from "@/types/activity";

interface ActivityTypeFilterProps {
  /** Entity types actually present in the feed, in display order. */
  entityTypes: ActivityEntityType[];
  selected: ActivityEntityType | null;
  onSelect: (entityType: ActivityEntityType | null) => void;
}

/**
 * Client-side entity-type chips over the dashboard's recent-activity feed.
 *
 * Chips are derived from the feed rather than from the ActivityEntityType enum:
 * the feed is short, so an enum-driven chip row would offer a dozen options that
 * each filter it down to nothing. One option is likewise no choice at all — the
 * row hides itself rather than render a chip that cannot change the result.
 */
export function ActivityTypeFilter({
  entityTypes,
  selected,
  onSelect,
}: ActivityTypeFilterProps) {
  const { t } = useTranslation();

  if (entityTypes.length < 2) return null;

  return (
    <div
      role="group"
      aria-label={t("dashboard.activityFilter.label")}
      className="mb-4 flex flex-wrap items-center gap-1"
    >
      <Chip
        testId="activity-type-chip-all"
        active={selected === null}
        onClick={() => onSelect(null)}
        label={t("dashboard.activityFilter.all")}
      />
      {entityTypes.map((entityType) => (
        <Chip
          key={entityType}
          testId={`activity-type-chip-${entityType}`}
          active={selected === entityType}
          // Clicking the active chip clears it — the chip is the only affordance
          // in reach once a filter is on.
          onClick={() => onSelect(selected === entityType ? null : entityType)}
          label={t(`activity.entityTypes.${entityType}`)}
        />
      ))}
    </div>
  );
}

interface ChipProps {
  testId: string;
  active: boolean;
  onClick: () => void;
  label: string;
}

function Chip({ testId, active, onClick, label }: ChipProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-activity-type-chip=""
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider transition-colors",
        active
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border/60 bg-transparent text-muted-foreground hover:bg-muted/40",
      )}
    >
      {label}
    </button>
  );
}
