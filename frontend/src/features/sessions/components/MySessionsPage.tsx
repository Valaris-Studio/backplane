// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ListFilter, Lock } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/layout/EmptyState";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n/config";
import { useBoards } from "@/features/kanban/api/use-boards";
import type { AgentSession, AgentSessionPage } from "@/types/agent-session";
import { useCompanionEnabled, useSessionList, useSessionSummary } from "../api/use-sessions";
import { useCompanionDevices } from "../api/use-linked-sessions";
import { useNow } from "../hooks/use-now";
import {
  displayStateFor,
  hasChosenFilters,
  periodStart,
  toListQuery,
  useSessionFilters,
  type SessionFilters,
} from "../hooks/use-session-filters";
import { groupSessionsByDay, ungrouped } from "../utils/group-sessions";
import { AGENT_KEY_ORDER, agentKey, agentKeyName, markHarnessFor, serverHarnessFor } from "./AgentMark";
import { PeriodTotals } from "./PeriodTotals";
import { SessionsTabs } from "./SessionsTabs";
import { CompanionGate } from "./CompanionGate";
import { NoActiveComputerNotice } from "./GetCompanion";
import { HidePromptsToggle } from "./HidePromptsToggle";
import { PeriodPicker, SessionsFilterBar, SortSelect, type AgentOption } from "./SessionsFilterBar";
import { SessionsTable } from "./SessionsTable";
import { FirstRunState, LoadErrorState, SessionListSkeleton } from "./SessionStates";

export function MySessionsPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-[var(--page-section-gap)]">
      <PageHeader
        title={t("sessions.title")}
        description={
          <span className="inline-flex items-center gap-1.5">
            <Lock aria-hidden className="size-3.5 shrink-0" />
            {t("sessions.description")}
          </span>
        }
        actions={<HidePromptsToggle />}
      />
      <CompanionGate>
        <SessionsTabs />
        <SessionsList />
      </CompanionGate>
    </div>
  );
}

// Agent toggles cover the known agents plus any other agent actually seen,
// and stay put while one is selected.
function useSeenAgents(sessions: AgentSession[], selected: string | null): AgentOption[] {
  const [seen, setSeen] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    const unseen = sessions.filter((session) => !seen.has(agentKey(session.harness)));
    if (!unseen.length) return;
    setSeen((current) => {
      const next = new Map(current);
      unseen.forEach((session) => next.set(agentKey(session.harness), agentKeyName(agentKey(session.harness), session.harness_display_name)));
      return next;
    });
  }, [sessions, seen]);

  return useMemo(() => {
    // Known families are always offered, so a deep link to one agent can
    // switch to another without clearing first.
    const options = new Map(AGENT_KEY_ORDER.map((key) => [key, agentKeyName(key)]));
    seen.forEach((name, key) => options.set(key, name));
    if (selected && !options.has(selected)) options.set(selected, agentKeyName(selected));
    const rank = (key: string) => {
      const known = AGENT_KEY_ORDER.indexOf(key);
      return known === -1 ? AGENT_KEY_ORDER.length : known;
    };
    return [...options.entries()]
      .map(([key, displayName]) => ({ key, harness: markHarnessFor(key), displayName }))
      .sort((a, b) => rank(a.key) - rank(b.key) || a.displayName.localeCompare(b.displayName));
  }, [seen, selected]);
}

function hasFirstItem(probe: { pages: AgentSessionPage[] } | undefined): boolean {
  return !!probe?.pages[0]?.items.length;
}

function SessionsList() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  const enabled = useCompanionEnabled() === true;
  const now = useNow();
  const { filters, updateFilters, clearFilters } = useSessionFilters();
  const since = useMemo(() => new Date(periodStart(filters.period, now)).toISOString(), [filters.period, now]);
  const listQuery = useMemo(() => toListQuery(filters, since), [filters, since]);
  const list = useSessionList(slug, listQuery, enabled);

  const loaded = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  // The server filters one exact harness; a family with several hosts (the
  // Codex CLI and app) is narrowed here, on the rows already loaded.
  const shown = useMemo(
    () => (filters.agent ? loaded.filter((session) => agentKey(session.harness) === filters.agent) : loaded),
    [loaded, filters.agent],
  );
  const agents = useSeenAgents(loaded, filters.agent);
  // Day groups only make sense in the order of last activity.
  const groups = useMemo(
    () => (filters.sort === "recent" ? groupSessionsByDay(shown, now) : ungrouped(shown)),
    [shown, now, filters.sort],
  );
  const canLoadMore = !!list.hasNextPage;

  // The summary takes the period, board, one harness and subagents; search,
  // state, linked work and a two-host agent family it cannot apply.
  const summaryHarness = filters.agent ? serverHarnessFor(filters.agent) : undefined;
  const totalsPartial = {
    filters: !!(filters.q.trim() || filters.state || filters.linkedOnly),
    agent: !!filters.agent && !summaryHarness,
  };
  const summaryQuery = useMemo(
    () => ({
      since,
      root_only: !filters.subagents,
      ...(filters.board ? { board_id: filters.board } : {}),
      ...(summaryHarness ? { harness: summaryHarness } : {}),
    }),
    [since, filters.subagents, filters.board, summaryHarness],
  );
  const summary = useSessionSummary(slug, summaryQuery, enabled);
  const periodPhrase = t(`sessions.period.phrase.${filters.period === "today" ? "today" : filters.period === "7d" ? "d7" : "d30"}`);

  // Empty without chosen filters can still hide earlier work: sessions older
  // than the period, or subagent threads. Ask once (one row each, no period)
  // whether anything was ever captured before calling it a first run.
  const emptyUnfiltered = list.isSuccess && !loaded.length && !hasChosenFilters(filters);
  const anyRootSession = useSessionList(slug, { root_only: true }, enabled && emptyUnfiltered && !filters.subagents, 1);
  const anySession = useSessionList(slug, { root_only: false }, enabled && emptyUnfiltered, 1);
  const probing = emptyUnfiltered && (anySession.isPending || (!filters.subagents && anyRootSession.isPending));
  const capturedBeforePeriod =
    emptyUnfiltered && hasFirstItem(filters.subagents ? anySession.data : anyRootSession.data);
  const subagentsOnly = emptyUnfiltered && !filters.subagents && !capturedBeforePeriod && hasFirstItem(anySession.data);
  const firstRun = emptyUnfiltered && !capturedBeforePeriod && !subagentsOnly;
  const failedHistoryQuery = anySession.isError
    ? anySession
    : !filters.subagents && anyRootSession.isError ? anyRootSession : null;
  const failedQuery = list.isError ? list : emptyUnfiltered ? failedHistoryQuery : null;

  // Whoever has no paired computer left is told how to capture again, even
  // with older sessions in the list; the first run already teaches it.
  const devices = useCompanionDevices(enabled);
  const noActiveComputer = devices.isSuccess && !devices.data.some((device) => !device.revoked_at);

  let body: React.ReactNode;
  if (list.isPending || probing) {
    body = <SessionListSkeleton />;
  } else if (failedQuery) {
    body = (
      <LoadErrorState
        error={failedQuery.error}
        title={t("sessions.loadError.title")}
        description={t("sessions.loadError.description")}
        onRetry={() => void failedQuery.refetch()}
        retrying={failedQuery.isFetching}
      />
    );
  } else if (firstRun) {
    body = <FirstRunState />;
  } else if (subagentsOnly) {
    body = (
      <EmptyState
        icon={ListFilter}
        title={t("sessions.noMatch.title")}
        description={t("sessions.noMatch.subagentsOnly")}
        action={
          <Button variant="outline" onClick={() => updateFilters({ subagents: true })}>
            {t("sessions.filters.showSubagents")}
          </Button>
        }
      />
    );
  } else if (!groups.length) {
    body = (
      <NoMatchState
        slug={slug}
        filters={filters}
        agents={agents}
        periodPhrase={periodPhrase}
        onClear={clearFilters}
        onWiden={filters.period === "30d" ? undefined : () => updateFilters({ period: "30d" })}
        // Only the Codex family filter runs on loaded rows; later pages may match.
        onLoadMore={canLoadMore ? () => void list.fetchNextPage() : undefined}
        loadingMore={list.isFetchingNextPage}
      />
    );
  } else {
    body = (
      <section className="overflow-hidden rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] shadow-panel">
        <SessionsTable slug={slug} groups={groups} now={now} />
        <footer className="flex items-center justify-between gap-3 border-t border-border bg-[color:var(--color-surface-2)] px-[var(--card-padding)] py-2.5 text-[0.85rem] text-muted-foreground">
          <p aria-live="polite">
            {summary.data && !totalsPartial.filters && !totalsPartial.agent
              ? t("sessions.list.showingOf", { shown: shown.length, count: summary.data.session_count, period: periodPhrase })
              : t("sessions.list.showing", { count: shown.length, period: periodPhrase })}
          </p>
          {canLoadMore ? (
            <Button variant="outline" size="sm" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? t("sessions.list.loadingMore") : t("sessions.list.loadMore")}
            </Button>
          ) : null}
        </footer>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {noActiveComputer && !firstRun ? <NoActiveComputerNotice /> : null}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <PeriodPicker period={filters.period} onChange={(period) => updateFilters({ period })} />
        {summary.data ? <PeriodTotals summary={summary.data} periodPhrase={periodPhrase} partial={totalsPartial} /> : null}
      </div>
      <SessionsFilterBar
        slug={slug}
        filters={filters}
        agents={agents}
        onChange={updateFilters}
        trailing={<SortSelect sort={filters.sort} onChange={(sort) => updateFilters({ sort })} />}
      />
      {body}
    </div>
  );
}

interface NoMatchStateProps {
  slug: string;
  filters: SessionFilters;
  agents: AgentOption[];
  periodPhrase: string;
  onClear: () => void;
  onWiden?: () => void;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}

// The sentence is built from the active filters only: names and words the
// viewer chose, nothing inferred.
function NoMatchState({ slug, filters, agents, periodPhrase, onClear, onWiden, onLoadMore, loadingMore }: NoMatchStateProps) {
  const { t } = useTranslation();
  const boards = useBoards(slug);
  const parts: string[] = [];
  if (filters.agent) {
    parts.push(agents.find((agent) => agent.key === filters.agent)?.displayName ?? agentKeyName(filters.agent));
  }
  if (filters.q.trim()) parts.push(t("sessions.filters.querySummary", { q: filters.q.trim() }));
  if (filters.state) parts.push(t(`sessions.states.${displayStateFor(filters.state)}`));
  if (filters.board) {
    const board = boards.data?.find((candidate) => candidate.id === filters.board);
    if (board) parts.push(t("sessions.filters.boardSummary", { board: board.name }));
  }
  if (filters.linkedOnly) parts.push(t("sessions.filters.linkedOnlySummary"));

  const description = parts.length
    ? t("sessions.noMatch.description", {
        period: periodPhrase,
        filters: new Intl.ListFormat(i18n.resolvedLanguage ?? "en", { type: "conjunction" }).format(parts),
      })
    : t("sessions.noMatch.descriptionNoFilters", { period: periodPhrase });

  return (
    <EmptyState
      icon={ListFilter}
      title={t("sessions.noMatch.title")}
      description={description}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {parts.length ? (
            <Button variant="outline" onClick={onClear}>
              {t("sessions.noMatch.clear")}
            </Button>
          ) : null}
          {onLoadMore ? (
            <Button variant="outline" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? t("sessions.list.loadingMore") : t("sessions.list.loadMore")}
            </Button>
          ) : null}
          {onWiden ? (
            <Button variant="ghost" onClick={onWiden}>
              {t("sessions.noMatch.widen")}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
