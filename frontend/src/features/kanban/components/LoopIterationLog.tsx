// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatDateTime, formatDuration } from "@/lib/format";
import { type ExecutionSummary } from "@/features/agents/api/agents";
import {
  LOOP_LOG_PAGE_SIZE,
  LOOP_OUTCOMES,
  useLoopIterationLog,
  type LoopOutcome,
} from "../api/use-loop-iteration-log";

// Card 6c036f0b — the full run history. "Recent iterations" above answers
// "what just happened"; this answers "what happened across the whole run",
// which for a 30-70 iteration loop is a different question.

// The runner writes the outcome as an `outcome=<value>` token at the head of
// output_summary. Parsing it here is what lets a row render the outcome as a
// badge instead of making the operator read it out of the raw string.
const OUTCOME_PATTERN = /outcome=([a-z_]+)/i;

function parseOutcome(summary: string | null): string | null {
  if (!summary) return null;
  return summary.match(OUTCOME_PATTERN)?.[1] ?? null;
}

interface LoopIterationLogProps {
  slug: string;
  boardId: string;
  boardUuid: string | undefined;
}

export function LoopIterationLog({
  slug,
  boardId,
  boardUuid,
}: LoopIterationLogProps) {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState<LoopOutcome | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebouncedValue(search);

  // Paging is only meaningful within one result set: keeping the offset while
  // the filters narrow can land past the end of the new set, which renders an
  // empty panel over data that is actually there.
  useEffect(() => {
    setPage(0);
  }, [outcome, debouncedSearch]);

  const query = useLoopIterationLog(
    slug,
    boardId,
    boardUuid,
    { outcome, q: debouncedSearch, page },
    true,
  );

  const executions = query.data?.executions ?? [];
  const total = query.data?.total ?? 0;
  const shownUpTo = page * LOOP_LOG_PAGE_SIZE + executions.length;
  const hasNextPage = shownUpTo < total;

  return (
    <div
      data-testid="loop-iteration-log"
      className="space-y-3 rounded-[var(--radius-sm)] border border-border/60 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-testid="loop-iteration-log-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("boardLoop.iterationLog.searchPlaceholder")}
          aria-label={t("boardLoop.iterationLog.searchLabel")}
          className="h-8 max-w-64 text-xs"
        />
        <div className="flex flex-wrap gap-1">
          {LOOP_OUTCOMES.map((value) => {
            const active = outcome === value;
            return (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                data-testid={`loop-iteration-log-chip-${value}`}
                aria-pressed={active}
                className="h-7 px-2 text-xs"
                // Clicking the active chip clears it — a filter you cannot
                // switch off is a trap when the chips are the only control.
                onClick={() => setOutcome(active ? undefined : value)}
              >
                {t(`boardLoop.iterationLog.outcomes.${value}`)}
              </Button>
            );
          })}
        </div>
      </div>

      {query.isError ? (
        <p
          data-testid="loop-iteration-log-error"
          role="status"
          className="text-xs text-destructive"
        >
          {t("boardLoop.iterationLog.error")}
        </p>
      ) : query.isPending ? (
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : executions.length === 0 ? (
        <p
          data-testid="loop-iteration-log-empty"
          className="text-xs text-muted-foreground"
        >
          {t("boardLoop.iterationLog.empty")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {executions.map((execution) => (
            <LogRow key={execution.id} execution={execution} slug={slug} />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2">
        <span
          data-testid="loop-iteration-log-count"
          className="text-xs text-muted-foreground"
        >
          {t("boardLoop.iterationLog.showing", {
            shown: executions.length,
            total,
          })}
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            data-testid="loop-iteration-log-prev"
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
          >
            {t("boardLoop.iterationLog.previous")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            data-testid="loop-iteration-log-next"
            disabled={!hasNextPage}
            onClick={() => setPage((current) => current + 1)}
          >
            {t("boardLoop.iterationLog.next")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function LogRow({ execution, slug }: { execution: ExecutionSummary; slug: string }) {
  const outcome = parseOutcome(execution.output_summary);
  const StatusIcon =
    execution.status === "completed"
      ? CheckCircle2
      : execution.status === "failed" || execution.status === "aborted"
        ? XCircle
        : execution.status === "started" || execution.status === "running"
          ? Loader2
          : CircleDashed;

  return (
    <li
      data-outcome={outcome ?? undefined}
      className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-border/60 px-2.5 py-1.5 text-xs"
    >
      <StatusIcon
        aria-hidden
        className={
          execution.status === "failed" || execution.status === "aborted"
            ? "mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
            : execution.status === "started" || execution.status === "running"
              ? "mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
              : "mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-success-foreground)]"
        }
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
          <Link
            to={`/${slug}/runner/executions/${execution.id}`}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {execution.input_summary}
          </Link>
          <span>{formatDateTime(execution.started_at)}</span>
          {execution.duration_seconds != null && (
            <span>{formatDuration(execution.duration_seconds)}</span>
          )}
          {outcome && (
            <span className="rounded-full border border-border/60 px-1.5 py-0.5">
              {outcome}
            </span>
          )}
        </div>
        {execution.output_summary && (
          <p className="break-words">{execution.output_summary}</p>
        )}
      </div>
    </li>
  );
}
