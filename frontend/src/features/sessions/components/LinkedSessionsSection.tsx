// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useMemo, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, AudioWaveform, Eye, Lock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { isApiError } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import type { CostBasis, LinkedSessionList, LinkedSessionRead } from "@/types/agent-session";
import { useCompanionEnabled } from "../api/use-sessions";
import { useWorkspaceTarget } from "../api/use-work-title";
import { useCardSessions, useCompanionDevices, useNoteSessions } from "../api/use-linked-sessions";
import { useInView } from "../hooks/use-in-view";
import { formatClock, formatTokens, formatUsd, formatWallTime, isLive } from "../utils/format";
import { AgentMark } from "./AgentMark";
import { PromptText } from "./PromptText";
import { SessionStateBadge } from "./SessionStateBadge";
import { useSessionTitle, WithheldTitleGlyph } from "./SessionTitle";

type EntityKind = "card" | "note";

interface CardSessionsSectionProps {
  slug: string;
  boardId: string;
  cardId: string;
}

export function CardSessionsSection({ slug, boardId, cardId }: CardSessionsSectionProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const load = useLoadWhenVisible(sentinel);
  const list = useCardSessions(slug, boardId, cardId, load.enabled);
  return (
    <div ref={sentinel}>
      <LinkedSessions kind="card" slug={slug} boardId={boardId} list={list} hasDevices={load.hasDevices} />
    </div>
  );
}

interface NoteSessionsSectionProps {
  slug: string;
  noteId: string;
  boardId: string | null;
}

export function NoteSessionsSection({ slug, noteId, boardId }: NoteSessionsSectionProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const load = useLoadWhenVisible(sentinel);
  const list = useNoteSessions(slug, noteId, load.enabled);
  return (
    <div ref={sentinel}>
      <LinkedSessions kind="note" slug={slug} boardId={boardId} list={list} hasDevices={load.hasDevices} />
    </div>
  );
}

// One request each, and only once the section scrolls into view: most people
// opening a card never look this far down.
function useLoadWhenVisible(sentinel: React.RefObject<HTMLDivElement | null>) {
  const companionEnabled = useCompanionEnabled() === true;
  const inView = useInView(sentinel);
  const enabled = companionEnabled && inView;
  const devices = useCompanionDevices(enabled);
  return {
    enabled,
    hasDevices: devices.isSuccess ? devices.data.length > 0 : devices.isError ? false : undefined,
  };
}

interface LinkedSessionsProps {
  kind: EntityKind;
  slug: string;
  boardId: string | null;
  list: UseQueryResult<LinkedSessionList>;
  hasDevices: boolean | undefined;
}

function LinkedSessions({ kind, slug, boardId, list, hasDevices }: LinkedSessionsProps) {
  const { t } = useTranslation();
  const headingId = useId();

  // Quiet until both answers are in, so teammates without Companion never see
  // the section flash in and out.
  if (hasDevices === undefined || list.isPending) return null;
  // 404/403: capture off or an agent key. Nothing to say to this viewer.
  if (list.isError && isApiError(list.error) && list.error.status < 500) return null;
  const items = list.data?.items ?? [];
  if (!list.isError && !items.length && !hasDevices) return null;

  const allSessions = new URLSearchParams();
  if (boardId) allSessions.set("board", boardId);
  allSessions.set("period", "30d");

  return (
    <section aria-labelledby={headingId} className={cn("space-y-2", kind === "note" && "mt-6")}>
      <div className="flex items-center gap-2">
        <AudioWaveform aria-hidden className="size-4 text-muted-foreground" />
        <h3 id={headingId} className="text-sm font-medium">
          {t(kind === "card" ? "sessions.linked.cardTitle" : "sessions.linked.noteTitle")}
        </h3>
        <Link
          to={`/${slug}/sessions?${allSessions.toString()}`}
          className="ml-auto inline-flex items-center gap-1 rounded-[var(--radius-cap)] text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("sessions.linked.allSessions")}
          <ArrowRight aria-hidden className="size-3" />
        </Link>
      </div>

      {list.isError ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <p>{t("sessions.linked.loadError")}</p>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void list.refetch()} disabled={list.isFetching}>
            {t("sessions.loadError.retry")}
          </Button>
        </div>
      ) : items.length && list.data ? (
        <>
          <SummaryLine list={list.data} />
          <LinkedRows items={items} />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(kind === "card" ? "sessions.linked.noneCard" : "sessions.linked.noneNote")}
        </p>
      )}

      <p className="flex items-start gap-1.5 border-t border-border/65 pt-2 text-xs text-muted-foreground">
        <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
        {t(kind === "card" ? "sessions.linked.privacyCard" : "sessions.linked.privacyNote")}
      </p>
    </section>
  );
}

function Fact({ value, label }: { value: ReactNode; label: string }) {
  return (
    <span>
      <b className="font-semibold tabular-nums text-foreground">{value}</b> {label}
    </span>
  );
}

const BASIS_ORDER: CostBasis[] = ["api_equivalent", "spend"];

// Wall time (overlapping subagents counted once) and costs per basis: an
// API-equivalent amount is not money spent, so the two are never added.
function SummaryLine({ list }: { list: LinkedSessionList }) {
  const { t } = useTranslation();
  const { summary, items } = list;
  const tokens = summary.input_tokens + summary.output_tokens + summary.cache_read_tokens + summary.cache_creation_tokens;
  const costByBasis = useMemo(() => {
    const totals = new Map<CostBasis, number>();
    items.forEach(({ session }) => {
      if (session.cost_usd === null || !session.cost_basis) return;
      totals.set(session.cost_basis, (totals.get(session.cost_basis) ?? 0) + session.cost_usd);
    });
    return BASIS_ORDER.filter((basis) => totals.has(basis)).map((basis) => ({ basis, amount: totals.get(basis) ?? 0 }));
  }, [items]);
  const unpriced = !summary.cost_complete;

  return (
    <p data-testid="linked-sessions-summary" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <Fact value={summary.session_count} label={t("sessions.linked.countLabel", { count: summary.session_count })} />
      <Fact value={formatWallTime(summary.wall_duration_seconds)} label={t("sessions.facts.wallTime")} />
      <Fact value={formatTokens(tokens)} label={t("sessions.facts.tokens")} />
      {costByBasis.map(({ basis, amount }) => (
        <Fact
          key={basis}
          value={unpriced ? `${formatUsd(amount)}+` : formatUsd(amount)}
          label={t(basis === "spend" ? "sessions.cost.spend" : "sessions.cost.apiEquivalent")}
        />
      ))}
    </p>
  );
}

function LinkedRows({ items }: { items: LinkedSessionRead[] }) {
  const listed = new Set(items.map((item) => item.session.id));
  return (
    <ul>
      {items.map((item) => (
        <LinkedRow
          key={item.session.id}
          item={item}
          parentListed={!!item.session.parent_session_id && listed.has(item.session.parent_session_id)}
        />
      ))}
    </ul>
  );
}

function sessionSpan(item: LinkedSessionRead, t: (key: string, options?: Record<string, unknown>) => string): string {
  const { session } = item;
  const start = new Date(session.started_at);
  const sameDay = start.toDateString() === new Date().toDateString();
  const startLabel = sameDay
    ? formatClock(session.started_at)
    : `${formatDate(start, { month: "short", day: "numeric" })}, ${formatClock(session.started_at)}`;
  if (isLive(session)) return t("sessions.linked.spanLive", { start: startLabel });
  return `${startLabel} – ${formatClock(session.last_event_at)}`;
}

// A visible middle dot between facts that assistive tech skips (a CSS
// ::before dot is read aloud as "dot" by some screen readers).
function withSeparators(parts: (ReactNode | null)[]): ReactNode[] {
  return parts
    .filter((part) => part !== null)
    .flatMap((part, index) =>
      index === 0
        ? [part]
        : [
            <span key={`sep-${index}`} aria-hidden className="opacity-60">
              ·
            </span>,
            part,
          ],
    );
}

function LinkedRow({ item, parentListed }: { item: LinkedSessionRead; parentListed: boolean }) {
  const { t } = useTranslation();
  const { session } = item;
  const title = useSessionTitle(session);
  const workspace = useWorkspaceTarget(session.workspace_id);
  const changed = item.relations.includes("changed");
  const consulted = item.relations.includes("consulted");

  if (workspace.status !== "available") {
    return <li className="flex flex-wrap items-center gap-2 border-t border-border/65 py-2 text-sm text-muted-foreground first:border-t-0">
      <span>{t(workspace.status === "loading" ? "sessions.linked.loadingWorkspace"
        : workspace.status === "error" ? "sessions.linked.workspaceError" : "sessions.linked.workspaceUnavailable")}</span>
      {workspace.status === "error" ? <Button variant="ghost" size="sm" className="max-sm:min-h-[44px]" onClick={() => void workspace.refetch()}>
        {t("sessions.work.retry")}
      </Button> : null}
    </li>;
  }

  return (
    <li
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 border-t border-border/65 py-2 text-sm first:border-t-0",
        parentListed && "pl-6",
      )}
    >
      <AgentMark harness={session.harness} displayName={session.harness_display_name} size="sm" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          {title.kind === "withheld" ? <WithheldTitleGlyph /> : null}
          <Link
            to={`/${workspace.slug}/sessions/${session.id}`}
            className={cn(
              "min-w-0 truncate rounded-[var(--radius-cap)] font-semibold text-foreground underline-offset-[0.18em] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              title.kind !== "title" && "font-medium text-muted-foreground",
            )}
          >
            {title.kind === "title" ? <PromptText text={title.text} /> : title.text}
          </Link>
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {withSeparators([
            changed ? (
              <span key="changed" className="inline-flex items-center gap-1 font-bold text-[color:color-mix(in_oklab,var(--color-primary)_72%,var(--color-foreground))]">
                <Pencil aria-hidden className="size-3" />
                {t("sessions.work.changed")}
              </span>
            ) : null,
            consulted ? (
              <span key="consulted" className="inline-flex items-center gap-1">
                {changed ? null : <Eye aria-hidden className="size-3" />}
                {t("sessions.work.consulted")}
              </span>
            ) : null,
            item.provenance === "correlated" ? (
              <span key="timing" title={t("sessions.work.correlatedHint")} className="cursor-help">
                {t("sessions.rail.linked.matchedByTiming")}
              </span>
            ) : null,
            parentListed ? (
              <span key="parent">{t("sessions.linked.subagentOfAbove")}</span>
            ) : (
              <span key="span" className="tabular-nums">
                {sessionSpan(item, t)}
              </span>
            ),
          ])}
        </p>
      </div>
      <SessionStateBadge session={session} />
    </li>
  );
}
