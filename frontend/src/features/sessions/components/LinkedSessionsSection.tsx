// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, AudioWaveform, Eye, Lock, Pencil } from "lucide-react";
import { ContextLink } from "@/components/shared/ContextLink";
import { Button } from "@/components/ui/button";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import { formatDate } from "@/lib/format";
import { isApiError } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { CostBasis, LinkedSessionList, LinkedSessionRead } from "@/types/agent-session";
import type { SessionWorkIdentity } from "../api/use-session-evidence";
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
// How this history entry last showed the section: loaded when it came into
// view, or explicitly requested from the item's metadata.
type SectionOpening = "visible" | "requested";

interface CardSessionsSectionProps {
  slug: string;
  boardId: string;
  cardId: string;
  // From useLinkedSessionsJump: each increment reveals and focuses the section.
  jumpRequest?: number;
}

export function CardSessionsSection({ slug, boardId, cardId, jumpRequest = 0 }: CardSessionsSectionProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const load = useLoadWhenVisible(sentinel, `card:${cardId}`, jumpRequest);
  const list = useCardSessions(slug, boardId, cardId, load.enabled);
  const retry = useExplicitRetry(list, JSON.stringify(["card", slug, boardId, cardId]));
  return (
    <div ref={sentinel}>
      <LinkedSessions kind="card" entityId={cardId} slug={slug} boardId={boardId} list={list} retry={retry} hasDevices={load.hasDevices} requested={load.requested} jumpRequest={jumpRequest} />
    </div>
  );
}

interface NoteSessionsSectionProps {
  slug: string;
  noteId: string;
  boardId: string | null;
  // From useLinkedSessionsJump: each increment reveals and focuses the section.
  jumpRequest?: number;
}

export function NoteSessionsSection({ slug, noteId, boardId, jumpRequest = 0 }: NoteSessionsSectionProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  const load = useLoadWhenVisible(sentinel, `note:${noteId}`, jumpRequest);
  const list = useNoteSessions(slug, noteId, load.enabled);
  const retry = useExplicitRetry(list, JSON.stringify(["note", slug, noteId]));
  return (
    <div ref={sentinel}>
      <LinkedSessions kind="note" entityId={noteId} slug={slug} boardId={boardId} list={list} retry={retry} hasDevices={load.hasDevices} requested={load.requested} jumpRequest={jumpRequest} />
    </div>
  );
}

export function useLinkedSessionsJump() {
  const [request, setRequest] = useState(0);
  const jump = useCallback(() => setRequest((previous) => previous + 1), []);
  return { request, jump };
}

// A static entry near the item's metadata. It reads nothing itself: the one
// existing section below loads, counts and explains.
export function LinkedSessionsJump({ kind, onJump }: { kind: EntityKind; onJump: () => void }) {
  const { t } = useTranslation();
  const companionEnabled = useCompanionEnabled() === true;
  if (!companionEnabled) return null;
  return (
    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onJump}>
      <AudioWaveform aria-hidden className="size-3" />
      {t(kind === "card" ? "sessions.linked.cardTitle" : "sessions.linked.noteTitle")}
    </Button>
  );
}

// One request each, and only once the section scrolls into view: most people
// opening a card never look this far down. A jump, or a Return to the entry
// where the section was already open, loads it without waiting for the viewport.
function useLoadWhenVisible(sentinel: React.RefObject<HTMLDivElement | null>, entity: string, jumpRequest: number) {
  const companionEnabled = useCompanionEnabled() === true;
  const returnNavigation = useReturnNavigation();
  const { key: entryKey } = useLocation();
  const slot = `linked-sessions-opening:${entity}`;
  const [opening, setOpening] = useState(() => ({
    entryKey, slot, navigation: returnNavigation, value: returnNavigation?.readView<SectionOpening>(slot),
  }));
  const appliedJump = useRef(jumpRequest);
  useEffect(() => {
    if (appliedJump.current === jumpRequest) return;
    appliedJump.current = jumpRequest;
    setOpening({ entryKey, slot, navigation: returnNavigation, value: "requested" });
  }, [jumpRequest, entryKey, slot, returnNavigation]);
  // A mounted sheet can switch cards and history entries. Read the arrived
  // entry before the effect below can overwrite its saved requested opening.
  const retained = opening.entryKey === entryKey && opening.slot === slot && opening.navigation === returnNavigation
    ? opening.value : returnNavigation?.readView<SectionOpening>(slot);
  const inView = useInView(sentinel);
  const enabled = companionEnabled && (inView || retained !== undefined);
  const requested = companionEnabled && retained === "requested";
  // Re-runs for each history entry the open section is shown on.
  useEffect(() => {
    if (enabled) returnNavigation?.writeView(slot, requested ? "requested" : "visible");
  }, [enabled, requested, slot, returnNavigation]);
  const devices = useCompanionDevices(enabled);
  return {
    enabled,
    requested,
    hasDevices: devices.isSuccess ? devices.data.length > 0 : devices.isError ? false : undefined,
  };
}

// Retrying a failure that never had data puts its query back to pending, which
// would swap the focused Retry for the loading line. The intent lives beside
// the query so the click's own render already sees the read it started, and it
// holds while that read runs or waits for connectivity for the same item.
function useExplicitRetry(list: UseQueryResult<LinkedSessionList>, scope: string) {
  const [retriedScope, setRetriedScope] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ scope: string; error: unknown } | null>(null);
  useEffect(() => {
    if (list.isError && !list.data) setFailure({ scope, error: list.error });
    else if (list.isSuccess) setFailure(null);
  }, [list.isError, list.isSuccess, list.data, list.error, scope]);
  const held = list.fetchStatus !== "idle"
    && (retriedScope === scope || (!list.data && failure?.scope === scope));
  useEffect(() => {
    if (retriedScope !== null && !held) setRetriedScope(null);
  }, [retriedScope, held]);
  return {
    held,
    heldError: held && failure?.scope === scope ? failure.error : null,
    start: () => {
      if (list.fetchStatus !== "idle") return;
      setRetriedScope(scope);
      void list.refetch();
    },
  };
}

interface LinkedSessionsProps {
  kind: EntityKind;
  entityId: string;
  slug: string;
  boardId: string | null;
  list: UseQueryResult<LinkedSessionList>;
  retry: ReturnType<typeof useExplicitRetry>;
  hasDevices: boolean | undefined;
  requested: boolean;
  jumpRequest: number;
}

function LinkedSessions({ kind, entityId, slug, boardId, list, retry, hasDevices, requested, jumpRequest }: LinkedSessionsProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusScope = JSON.stringify([kind, slug, boardId, entityId]);
  const [focusedScope, setFocusedScope] = useState<string | null>(null);
  useEffect(() => {
    setFocusedScope((previous) => previous === focusScope ? previous : null);
  }, [focusScope]);
  const focusWithin = focusedScope === focusScope;
  const retryButton = useRef<HTMLButtonElement | null>(null);
  const restoreRetryFocus = useRef<string | null>(null);
  const setRetryButton = useCallback((node: HTMLButtonElement | null) => {
    if (!node && retryButton.current === document.activeElement) restoreRetryFocus.current = focusScope;
    retryButton.current = node;
  }, [focusScope]);
  useLayoutEffect(() => {
    if (restoreRetryFocus.current === focusScope) heading.current?.focus({ preventScroll: true });
    restoreRetryFocus.current = null;
  });
  const focusedJump = useRef(jumpRequest);
  // A jump can arrive while the section is still quiet; focus once its
  // heading renders, then never again for the same request.
  useEffect(() => {
    if (focusedJump.current === jumpRequest || !heading.current) return;
    focusedJump.current = jumpRequest;
    heading.current.scrollIntoView?.({ block: "start" });
    heading.current.focus({ preventScroll: true });
  });

  const error = list.error ?? retry.heldError;
  const denied = isApiError(error) && [401, 403, 404].includes(error.status);
  const items = list.data?.items ?? [];
  // A held explicit retry keeps its error row, and the section, in place.
  const failed = list.isError || retry.held;
  // Requested sections always explain themselves; otherwise stay quiet until
  // both answers are in, so teammates without Companion never see the section
  // flash in and out.
  if (!requested && !focusWithin) {
    if (hasDevices === undefined || (list.isPending && !retry.held)) return null;
    // 404/403: capture off or an agent key. Nothing to say to this viewer.
    if (denied) return null;
    if (!failed && !items.length && !hasDevices) return null;
  }

  const allSessions = new URLSearchParams();
  if (boardId) allSessions.set("board", boardId);
  allSessions.set("period", "30d");

  return (
    <section aria-labelledby={headingId} className={cn("space-y-2", kind === "note" && "mt-6")}
      onFocusCapture={() => setFocusedScope(focusScope)}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setFocusedScope(null);
      }}>
      <div className="flex items-center gap-2">
        <AudioWaveform aria-hidden className="size-4 text-muted-foreground" />
        <h3 id={headingId} ref={heading} tabIndex={-1} className="rounded-[var(--radius-cap)] text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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

      {list.isPending && !retry.held ? (
        <p role="status" className="text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : denied || failed ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <p>{t(denied ? "sessions.discovery.accessLost" : "sessions.linked.loadError")}</p>
          {/* Native disabling would strand keyboard focus on the page body. */}
          <Button ref={setRetryButton} variant="ghost" size="sm" className="h-6 px-2 text-xs aria-disabled:opacity-45"
            aria-disabled={retry.held || undefined} aria-busy={retry.held || undefined}
            onClick={() => { if (!retry.held) retry.start(); }}>
            {t("sessions.loadError.retry")}
          </Button>
        </div>
      ) : items.length && list.data ? (
        <>
          <SummaryLine list={list.data} />
          <LinkedRows items={items} kind={kind} entityId={entityId} originSlug={slug} />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(kind === "card" ? "sessions.linked.noneCard" : "sessions.linked.noneNote")}
        </p>
      )}

      {denied ? null : <p className="flex items-start gap-1.5 border-t border-border/65 pt-2 text-xs text-muted-foreground">
        <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
        {t(kind === "card" ? "sessions.linked.privacyCard" : "sessions.linked.privacyNote")}
      </p>}
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

function LinkedRows({ items, kind, entityId, originSlug }: { items: LinkedSessionRead[]; kind: EntityKind; entityId: string; originSlug: string }) {
  const listed = new Set(items.map((item) => item.session.id));
  // The item's workspace comes from the authorized inventory, never from a
  // session's: one session can touch work in another workspace.
  const workspaces = useWorkspaces();
  const originWorkspaceId = workspaces.isSuccess ? workspaces.data.find((candidate) => candidate.slug === originSlug)?.id : undefined;
  return (
    <ul>
      {items.map((item) => (
        <LinkedRow
          key={item.session.id}
          item={item}
          parentListed={!!item.session.parent_session_id && listed.has(item.session.parent_session_id)}
          kind={kind}
          entityId={entityId}
          originWorkspaceId={originWorkspaceId}
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

function LinkedRow({ item, parentListed, kind, entityId, originWorkspaceId }: {
  item: LinkedSessionRead;
  parentListed: boolean;
  kind: EntityKind;
  entityId: string;
  originWorkspaceId: string | undefined;
}) {
  const { t } = useTranslation();
  const { session } = item;
  const title = useSessionTitle(session);
  const workspace = useWorkspaceTarget(session.workspace_id);
  const changed = item.relations.includes("changed");
  const consulted = item.relations.includes("consulted");
  // Opening the session inspects this item's evidence: what it changed, else
  // what it consulted. Without both identities the row is an ordinary link.
  const relation = changed ? "changed" : consulted ? "consulted" : null;
  const work: SessionWorkIdentity | undefined = originWorkspaceId && relation
    ? { workspace_id: originWorkspaceId, entity_type: kind, entity_id: entityId, relation } : undefined;

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
          <ContextLink
            id={`linked-session-${kind}-${entityId}-${session.id}`}
            to={`/${workspace.slug}/sessions/${session.id}`}
            handoff={work}
            className={cn(
              "min-w-0 truncate rounded-[var(--radius-cap)] font-semibold text-foreground underline-offset-[0.18em] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              title.kind !== "title" && "font-medium text-muted-foreground",
            )}
          >
            {title.kind === "title" ? <PromptText text={title.text} /> : title.text}
          </ContextLink>
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
