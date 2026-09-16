// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Link2,
  MoveHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
  Upload,
  UserMinus,
  UserPlus,
} from "lucide-react";
import type { TFunction } from "i18next";
import { useActivity } from "../api/use-activity";
import {
  groupActivityStream,
  lastMeaningfulTransition,
  type ActivityStreamItem,
} from "../utils/group-activity-stream";
import { resolveActivityMessage } from "../utils/resolve-activity-message";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EntityLink } from "@/components/shared/EntityLink";
import { EmptyState } from "@/components/layout/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatAbsolute, formatRelative } from "@/lib/date-format";
import { formatDate, formatTime } from "@/lib/format";
import { scaleIn, staggerChildren } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { Activity, ActivityAction, ActivityFilters } from "@/types/activity";

interface ActivityTimelineProps {
  slug: string;
  boardId?: string;
  filters?: ActivityFilters;
}

const actionIcons: Record<ActivityAction, typeof Plus> = {
  created: Plus,
  updated: Pencil,
  deleted: Trash2,
  moved: MoveHorizontal,
  uploaded: Upload,
  archived: Archive,
  added_member: UserPlus,
  removed_member: UserMinus,
  dependency_added: Link2,
  dependency_removed: Unlink,
  dependencies_replaced: RefreshCw,
};

function timeOnly(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return formatTime(d, { hour: "2-digit", minute: "2-digit" });
}

type DateGroup = { label: string; items: ActivityStreamItem[] };

function groupByDate(items: ActivityStreamItem[], t: TFunction): DateGroup[] {
  const groups: DateGroup[] = [];
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  const dateOf = (item: ActivityStreamItem) =>
    item.kind === "cycle" ? item.endedAt : item.activity.created_at;

  for (const item of items) {
    const dateStr = new Date(dateOf(item)).toDateString();
    let label: string;
    if (dateStr === today) label = t("activity.today");
    else if (dateStr === yesterday) label = t("activity.yesterday");
    else label = formatDate(new Date(dateOf(item)));

    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.label === label) lastGroup.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export function ActivityTimeline({ slug, boardId, filters }: ActivityTimelineProps) {
  const { t } = useTranslation();
  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useActivity(slug, boardId, filters);
  const reducedMotion = useReducedMotion();
  const groupsRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const activities = useMemo(() => data?.pages.flat() ?? [], [data]);
  const stream = useMemo(() => groupActivityStream(activities), [activities]);
  // The newest lifecycle transition is the live/historical boundary: anything
  // older than it is settled churn, not an in-flight incident.
  const staleBoundary = useMemo(
    () => lastMeaningfulTransition(activities),
    [activities],
  );
  const dateGroups = useMemo(() => groupByDate(stream, t), [stream, t]);

  // Infinite scroll via IntersectionObserver
  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(handleIntersect, {
      rootMargin: "200px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleIntersect]);

  useEffect(() => {
    if (isLoading || reducedMotion) return;
    const tween = staggerChildren(
      groupsRef.current,
      "[data-stagger-item]",
      scaleIn,
      { stagger: 0.04, duration: 0.18, maxStaggered: 12 },
    );
    // progress(1) BEFORE kill: the entrance starts entries at autoAlpha 0, so a
    // bare mid-flight kill strands them invisible.
    return () => {
      tween?.progress(1).kill();
    };
    // Deliberately NOT keyed on the stream length: infinite scroll appends to
    // the same list, and re-running the entrance would replay it from
    // autoAlpha 0 across every already-visible entry. Runs once per load.
  }, [isLoading, reducedMotion]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton
            key={index}
            className="h-24 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))]"
          />
        ))}
      </div>
    );
  }

  if (!activities.length) {
    return (
      <EmptyState
        icon={Clock}
        title={t("dashboard.recentActivity")}
        description={t("activity.empty")}
      />
    );
  }

  // The stale divider is drawn once, immediately AFTER the boundary transition.
  const boundaryId = staleBoundary?.id;
  let dividerDrawn = false;

  return (
    <div ref={groupsRef} className="space-y-8">
      {dateGroups.map((group) => (
        <section key={group.label} className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {group.label}
          </h2>
          <div className="space-y-4">
            {group.items.map((item) => {
              const key = item.kind === "cycle" ? item.items[0]!.id : item.activity.id;
              const row =
                item.kind === "cycle" ? (
                  <CycleRow item={item} t={t} />
                ) : (
                  <EventRow item={item} t={t} slug={slug} />
                );

              // Emit the divider right after the boundary transition row.
              const isBoundary =
                !dividerDrawn &&
                item.kind === "event" &&
                item.activity.id === boundaryId;
              if (isBoundary) dividerDrawn = true;

              return (
                <div key={key} className="space-y-4">
                  {row}
                  {isBoundary && hasOlderItems(group, item) ? (
                    <StaleDivider boundary={staleBoundary!} t={t} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* Sentinel for infinite scroll */}
      <div ref={sentinelRef} className="h-1" />
      {isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function hasOlderItems(group: DateGroup, item: ActivityStreamItem): boolean {
  return group.items.indexOf(item) < group.items.length - 1;
}

function StaleDivider({ boundary, t }: { boundary: Activity; t: TFunction }) {
  return (
    <div className="flex items-center gap-3 py-1" aria-hidden>
      <div className="h-px flex-1 bg-border" />
      <span className="text-[0.65rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {t("activity.resolvedBoundary", { time: formatRelative(boundary.created_at) })}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// Entity types that resolve to a real in-app route (via EntityLink). Only these
// get a clickable title chip; everything else stays plain text.
const LINKABLE_ENTITY_TYPES = new Set(["card", "note"]);

function EventRow({
  item,
  t,
  slug,
}: {
  item: Extract<ActivityStreamItem, { kind: "event" }>;
  t: TFunction;
  slug: string;
}) {
  const { activity, isStateTransition } = item;
  const isAgent = !!activity.agent_id;
  const Icon = isAgent ? Bot : actionIcons[activity.action] || Pencil;
  const actorLabel = activity.actor_name || activity.actor_email;
  const linkedEntity =
    activity.entity_title && LINKABLE_ENTITY_TYPES.has(activity.entity_type)
      ? activity.entity_title
      : null;

  return (
    <Card
      data-stagger-item
      className={cn(
        "overflow-hidden border-border/75",
        // State transitions dominate; churn/edits recede.
        isStateTransition && "border-primary/40 shadow-soft ring-1 ring-primary/15",
        !isStateTransition && isAgent && "border-border/50 bg-muted/20",
      )}
    >
      <CardContent className="relative p-[var(--card-padding)] pl-16">
        <div className="absolute left-7 top-0 h-full w-px bg-gradient-to-b from-primary/40 via-border to-transparent" />
        <div
          className={cn(
            "absolute left-0 top-[var(--card-padding)] flex h-11 w-11 items-center justify-center rounded-full border shadow-soft",
            isStateTransition
              ? "border-primary/40 bg-primary/15 text-primary"
              : isAgent
                ? "border-info/30 bg-info/12 text-[color:var(--color-info-foreground)]"
                : "border-primary/18 bg-primary/10 text-primary",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{t(`activity.entityTypes.${activity.entity_type}`)}</Badge>
            {isStateTransition && (
              <Badge variant="info">{t("activity.stateChange")}</Badge>
            )}
            {isAgent && !isStateTransition && (
              <Badge variant="outline">{t("activity.agentAction")}</Badge>
            )}
            <span
              className="text-xs uppercase tracking-[0.16em] text-muted-foreground"
              title={formatAbsolute(activity.created_at, "second")}
            >
              {formatRelative(activity.created_at)}
            </span>
          </div>
          <p
            className={cn(
              "text-sm leading-6 text-foreground",
              isStateTransition && "font-medium",
            )}
          >
            {actorLabel ? <span className="font-medium">{actorLabel} </span> : null}
            {activity.via_api_key ? (
              <span className="text-muted-foreground">
                {t("activity.viaApiKey", { apiKey: activity.via_api_key })}{" "}
              </span>
            ) : null}
            {linkedEntity ? (
              <>
                <EntityLink
                  type={activity.entity_type as "card" | "note"}
                  id={activity.entity_id}
                  slug={slug}
                  boardId={activity.board_id ?? undefined}
                  className="font-medium text-primary hover:underline"
                >
                  {linkedEntity}
                </EntityLink>{" "}
              </>
            ) : null}
            {resolveActivityMessage(activity, t)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function CycleRow({
  item,
  t,
}: {
  item: Extract<ActivityStreamItem, { kind: "cycle" }>;
  t: TFunction;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <Card
      data-stagger-item
      className={cn(
        "overflow-hidden border-dashed",
        item.resolved
          ? "border-border/50 bg-muted/15 opacity-75"
          : "border-warning/40 bg-warning/5",
      )}
    >
      <CardContent className="p-[var(--card-padding)]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border",
              item.resolved
                ? "border-border/60 bg-muted/40 text-muted-foreground"
                : "border-warning/40 bg-warning/10 text-[color:var(--color-warning-foreground)]",
            )}
          >
            {item.resolved ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </span>

          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "text-sm font-medium",
                  item.resolved && "text-muted-foreground line-through decoration-1",
                )}
              >
                {t("activity.cycle.title", { count: item.count })}
              </span>
              {item.resolved ? (
                <Badge variant="success">{t("activity.cycle.resolved")}</Badge>
              ) : (
                <Badge variant="warning">{t("activity.cycle.live")}</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("activity.cycle.range", {
                start: timeOnly(item.startedAt),
                end: timeOnly(item.endedAt),
              })}
              {item.resolved && item.resolvedBy ? (
                <>
                  {" "}·{" "}
                  {t("activity.cycle.closedBy", {
                    summary: resolveActivityMessage(item.resolvedBy, t),
                  })}
                </>
              ) : null}
            </p>
          </div>

          <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        {expanded && (
          <ul className="mt-3 space-y-2 border-t border-border/60 pt-3">
            {item.items.map((a) => (
              <li
                key={a.id}
                className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground"
              >
                <span className="truncate">{resolveActivityMessage(a, t)}</span>
                <span className="shrink-0 tabular-nums">{formatAbsolute(a.created_at, "second")}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
