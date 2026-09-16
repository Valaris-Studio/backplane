// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, GitMerge } from "lucide-react";
import {
  useCancelMergeQueueEntry,
  useMergeQueue,
  useReEnqueueMergeQueueEntry,
} from "../api/use-merge-queue";
import {
  MERGE_QUEUE_STALE_THRESHOLD_SECONDS,
  classifyStaleEntry,
  queueAgeSeconds,
  type StaleClassification,
} from "../utils/staleness";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/layout/EmptyState";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import type { MergeQueueEntry, MergeQueueState } from "@/types/merge-queue";

// Queue progression order: what is moving now, then what is waiting, then what
// needs a human, then terminal outcomes. NOT the enum's declaration order.
const STATE_ORDER: MergeQueueState[] = [
  "merging",
  "queued",
  "conflict",
  "blocked_pending_consolidation",
  "failed",
  "merged",
];

const STATE_TINT: Record<MergeQueueState, "info" | "muted" | "warning" | "secondary" | "success"> = {
  merging: "info",
  queued: "muted",
  conflict: "warning",
  blocked_pending_consolidation: "warning",
  failed: "secondary",
  merged: "success",
};

// The backend accepts 1..720 (30 days); one day is the window an operator
// actually wants when asking "did my card land?" without dragging in history.
export const RECENTLY_MERGED_WINDOW_HOURS = 24;

// Longer than this and the message gets collapsed behind a details toggle —
// merge errors routinely carry whole git stderr dumps.
const INLINE_ERROR_MAX_CHARS = 160;

function relativeAge(ageSeconds: number): { key: string; count: number } {
  const elapsedMinutes = Math.floor(ageSeconds / 60);
  if (elapsedMinutes < 60) return { key: "minutes", count: elapsedMinutes };
  if (elapsedMinutes < 60 * 24) return { key: "hours", count: Math.floor(elapsedMinutes / 60) };
  return { key: "days", count: Math.floor(elapsedMinutes / (60 * 24)) };
}

const STALE_TINT: Record<StaleClassification, "warning" | "secondary"> = {
  entry_failing: "secondary",
  worker_stalled: "warning",
};

interface EntryRowProps {
  entry: MergeQueueEntry;
  slug: string;
  now: number;
  onReEnqueue: (cardId: string) => void;
  onCancel: (entryId: string) => void;
  actionsDisabled: boolean;
}

function EntryRow({ entry, slug, now, onReEnqueue, onCancel, actionsDisabled }: EntryRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // Age is measured from first_enqueued_at, so a retrying entry accumulates
  // time instead of resetting to zero every attempt.
  const age = relativeAge(queueAgeSeconds(entry, now));
  const stale = classifyStaleEntry(entry, now);
  const error = entry.error_message ?? "";
  const isLongError = error.length > INLINE_ERROR_MAX_CHARS;

  return (
    <li
      data-testid={`merge-queue-entry-${entry.id}`}
      data-stale={stale ?? undefined}
      className={
        stale
          ? "flex flex-col gap-2 rounded-lg border border-warning/60 bg-warning/8 p-3"
          : "flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Pill tint={STATE_TINT[entry.state]}>{t(`mergeQueue.state.${entry.state}`)}</Pill>

        {stale && (
          <Pill tint={STALE_TINT[stale]} title={t(`mergeQueue.stale.${stale}Hint`)}>
            <AlertTriangle className="mr-1 size-3 shrink-0" aria-hidden />
            {t(`mergeQueue.stale.${stale}`)}
          </Pill>
        )}

        <span className="flex items-center gap-1.5 font-mono text-xs">
          <span className="text-foreground">{entry.pr_branch}</span>
          <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">{entry.integration_branch}</span>
        </span>

        <Link
          to={`/${slug}/boards/${entry.card_id}`}
          className="text-xs font-medium text-primary hover:underline"
        >
          {t("mergeQueue.viewCard")}
        </Link>

        {entry.pr_url && (
          <a
            href={entry.pr_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-primary hover:underline"
          >
            {t("mergeQueue.viewPr")}
          </a>
        )}

        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>{t(`mergeQueue.age.${age.key}`, { count: age.count })}</span>
          <span title={t("mergeQueue.attempts")}>
            {t("mergeQueue.attemptsShort")} <span className="tabular-nums">{entry.attempt_count}</span>
          </span>
        </span>

        {entry.state === "failed" && (
          <Button
            size="sm"
            variant="outline"
            disabled={actionsDisabled}
            onClick={() => onReEnqueue(entry.card_id)}
          >
            {t("mergeQueue.actions.reEnqueue")}
          </Button>
        )}
        {entry.state === "queued" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={actionsDisabled}
            onClick={() => onCancel(entry.id)}
          >
            {t("mergeQueue.actions.cancel")}
          </Button>
        )}
      </div>

      {error &&
        (isLongError ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              className="h-auto px-0 text-xs text-muted-foreground"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t("mergeQueue.hideDetails") : t("mergeQueue.showDetails")}
            </Button>
            {expanded && (
              <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
                {error}
              </pre>
            )}
          </div>
        ) : (
          <p className="break-all font-mono text-xs text-muted-foreground">{error}</p>
        ))}
    </li>
  );
}

interface MergeQueuePanelProps {
  slug: string;
}

export function MergeQueuePanel({ slug }: MergeQueuePanelProps) {
  const { t } = useTranslation();
  const [showRecentlyMerged, setShowRecentlyMerged] = useState(false);
  const { data, isLoading, isError } = useMergeQueue(
    slug,
    showRecentlyMerged ? RECENTLY_MERGED_WINDOW_HOURS : undefined,
  );
  const reEnqueue = useReEnqueueMergeQueueEntry(slug);
  const cancel = useCancelMergeQueueEntry(slug);

  const entries = useMemo(() => data ?? [], [data]);

  // One timestamp per render keeps every row's age computed against the same
  // instant instead of drifting across the list.
  const now = Date.now();

  const grouped = useMemo(
    () =>
      STATE_ORDER.map((state) => ({
        state,
        entries: entries.filter((entry) => entry.state === state),
      })).filter((group) => group.entries.length > 0),
    [entries],
  );

  // A wedged queue is the one thing an operator must not have to scroll for:
  // the per-row pills are the detail, this is the "is anything stuck" answer.
  const staleCount = entries.filter((entry) => classifyStaleEntry(entry, now) !== null).length;

  return (
    <div className="space-y-4">
      <PageHeader title={t("mergeQueue.title")} description={t("mergeQueue.description")} />

      {staleCount > 0 && (
        <div
          data-testid="merge-queue-stale-banner"
          role="status"
          className="flex items-start gap-2 rounded-lg border border-warning/60 bg-warning/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[color:var(--color-warning-foreground)]" aria-hidden />
          <div>
            <p className="font-medium">{t("mergeQueue.stale.banner", { count: staleCount })}</p>
            <p className="text-xs text-muted-foreground">
              {t("mergeQueue.stale.bannerHint", {
                minutes: Math.round(MERGE_QUEUE_STALE_THRESHOLD_SECONDS / 60),
              })}
            </p>
          </div>
        </div>
      )}

      <Button
        size="sm"
        variant={showRecentlyMerged ? "secondary" : "outline"}
        aria-pressed={showRecentlyMerged}
        onClick={() => setShowRecentlyMerged((shown) => !shown)}
      >
        {t("mergeQueue.actions.showRecentlyMerged", { hours: RECENTLY_MERGED_WINDOW_HOURS })}
      </Button>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError ? (
        <EmptyState
          icon={GitMerge}
          title={t("mergeQueue.loadError")}
          description={t("mergeQueue.loadErrorHint")}
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={GitMerge}
          title={t("mergeQueue.empty")}
          description={t("mergeQueue.emptyHint")}
        />
      ) : (
        grouped.map((group) => (
          <section key={group.state} data-testid={`merge-queue-group-${group.state}`}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t(`mergeQueue.state.${group.state}`)}{" "}
              <span className="tabular-nums">({group.entries.length})</span>
            </h2>
            <ul className="space-y-2">
              {group.entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  slug={slug}
                  now={now}
                  onReEnqueue={(card_id) => reEnqueue.mutate({ card_id })}
                  onCancel={(entryId) => cancel.mutate({ entryId })}
                  actionsDisabled={reEnqueue.isPending || cancel.isPending}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
