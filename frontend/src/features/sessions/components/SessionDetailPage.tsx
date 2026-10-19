// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigationType, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, RotateCw, SearchX } from "lucide-react";
import { EmptyState } from "@/components/layout/EmptyState";
import { Button, buttonVariants } from "@/components/ui/button";
import { ReturnLink } from "@/components/shared/ContextLink";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { isApiError } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import type { AgentSession } from "@/types/agent-session";
import { useCompanionEnabled, useSession } from "../api/use-sessions";
import { useRefreshSessionEvidence, type SessionWorkIdentity } from "../api/use-session-evidence";
import { useNow } from "../hooks/use-now";
import { formatTokens, formatUsd, formatWallTime, sessionTotalTokens, sessionWallSeconds } from "../utils/format";
import { isUsageOnly } from "../utils/group-sessions";
import { CompanionGate } from "./CompanionGate";
import { SessionBanners } from "./SessionBanners";
import { SessionHeader } from "./SessionHeader";
import { CapturePanel, CostPanel, LinkedWorkPanel, SubagentsPanel, TokensPanel } from "./SessionRail";
import { LoadErrorState } from "./SessionStates";
import { SessionTimeline } from "./SessionTimeline";
import { SessionTranscript } from "./SessionTranscript";
import { RhythmStrip } from "./RhythmStrip";
import { SessionReaderActive } from "../api/use-session-contents";

export function SessionDetailPage() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  return (
    <div className="flex flex-col gap-[var(--page-section-gap)]">
      <ReturnLink
        to={`/${slug}/sessions`}
        returnLabel={<><ChevronLeft aria-hidden className="size-4" />{t("navigation.returnToPrevious")}</>}
        className="inline-flex w-fit items-center gap-1 rounded-[var(--radius-cap)] text-sm font-semibold text-foreground/75 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeft aria-hidden className="size-4" />
        {t("sessions.detail.back")}
      </ReturnLink>
      <CompanionGate>
        <SessionDetail />
      </CompanionGate>
    </div>
  );
}

export function SessionNotFound({ accessLost = false }: { accessLost?: boolean }) {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  return (
    <EmptyState
      icon={SearchX}
      title={t(accessLost ? "sessions.detail.accessLost.title" : "sessions.detail.notFound.title")}
      description={t(accessLost ? "sessions.detail.accessLost.description" : "sessions.detail.notFound.description")}
      action={
        <Link to={`/${slug}/sessions`} className={buttonVariants({ variant: "outline" })}>
          {t("sessions.detail.notFound.back")}
        </Link>
      }
    />
  );
}

export function SessionDetailSkeleton() {
  return (
    <div aria-hidden data-testid="session-detail-skeleton" className="flex flex-col gap-4">
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
        <Skeleton className="hidden h-72 w-full xl:block" />
      </div>
    </div>
  );
}

function SessionDetail() {
  const { t } = useTranslation();
  const { slug = "", sessionId = "" } = useParams();
  const location = useLocation();
  const returnNavigation = useReturnNavigation();
  const enabled = useCompanionEnabled() === true;
  const session = useSession(slug, sessionId, enabled);
  const errorStatus = isApiError(session.error) ? session.error.status : 0;
  const accessLost = session.isError && [401, 403, 404].includes(errorStatus);
  const gone = accessLost && errorStatus === 404;
  const retainSession = !!session.data && (!session.isError || errorStatus === 0 || errorStatus === 408 || errorStatus === 429 || errorStatus >= 500);
  useLayoutEffect(() => {
    if (accessLost || session.data === null) returnNavigation?.forget(location.pathname);
  }, [accessLost, session.data, returnNavigation, location.pathname]);
  if (session.isPending) return <SessionDetailSkeleton />;
  if (gone) return <SessionNotFound />;
  if (session.data === null && !session.isError) return <SessionNotFound accessLost />;
  return <>
    {session.isError ? retainSession ? (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-cap)] border border-border px-[var(--card-padding)] py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("sessions.detail.loadError.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("sessions.detail.loadError.description")}</p>
        </div>
        <Button variant="outline" size="sm" className="max-sm:min-h-[44px] max-sm:min-w-[44px]" onClick={() => void session.refetch()} disabled={session.isFetching}>
          <RotateCw aria-hidden className={session.isFetching ? "motion-safe:animate-spin" : undefined} />
          {t("sessions.loadError.retry")}
        </Button>
      </div>
    ) : (
      <LoadErrorState
        error={session.error}
        title={t("sessions.detail.loadError.title")}
        description={t("sessions.detail.loadError.description")}
        onRetry={() => void session.refetch()}
        retrying={session.isFetching}
      />
    ) : null}
    {retainSession && session.data ? <SessionDetailBody key={`${slug}/${session.data.id}`} slug={slug} session={session.data} /> : null}
  </>;
}

type ReaderTab = "timeline" | "transcript" | "details";

function SessionDetailBody({ slug, session }: { slug: string; session: AgentSession }) {
  const { t } = useTranslation();
  const compact = !useMediaQuery("(min-width: 1280px)");
  const location = useLocation();
  const navigationType = useNavigationType();
  const returnNavigation = useReturnNavigation();
  const tabKey = `session-reader-tab:${slug}/${session.id}`;
  const [tab, setTabState] = useState<ReaderTab>(() => returnNavigation?.readView<ReaderTab>(tabKey) ?? (location.hash.startsWith("#content-") ? "transcript" : "timeline"));
  const setTab = useCallback((next: ReaderTab) => {
    returnNavigation?.writeView(tabKey, next);
    setTabState(next);
  }, [returnNavigation, tabKey]);
  const tabEntry = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (tabEntry.current === location.key) return;
    const replacingEntry = tabEntry.current !== null && navigationType === "REPLACE";
    tabEntry.current = location.key;
    // REPLACE keeps this reader mounted but creates a new history entry key.
    if (replacingEntry) {
      returnNavigation?.writeView(tabKey, tab);
      return;
    }
    const retainedTab = returnNavigation?.readView<ReaderTab>(tabKey);
    setTab(retainedTab ?? (location.hash.startsWith("#content-") ? "transcript" : "timeline"));
  }, [location.hash, location.key, navigationType, returnNavigation, tabKey, tab, setTab]);
  useEffect(() => { if (!compact && tab === "details") setTab("timeline"); }, [compact, tab, setTab]);
  const [selectedWork, setSelectedWork] = useState<SessionWorkIdentity | null>(null);
  const [timelineTarget, setTimelineTarget] = useState<HTMLElement | null>(null);
  const [readerTarget, setReaderTarget] = useState<HTMLHeadingElement | null>(null);
  const [navigation, setNavigation] = useState<{ destination: "timeline" | "reader"; request: number } | null>(null);
  const appliedNavigation = useRef<number | null>(null);
  const { refresh, refreshing } = useRefreshSessionEvidence(slug, session.id);
  const usageOnly = isUsageOnly(session);

  function navigateTo(destination: "timeline" | "reader") {
    setTab(destination === "reader" ? "transcript" : "timeline");
    setNavigation((previous) => ({ destination, request: (previous?.request ?? 0) + 1 }));
  }

  useEffect(() => {
    if (!navigation || appliedNavigation.current === navigation.request) return;
    const target = navigation.destination === "timeline" ? timelineTarget : readerTarget;
    if (!target?.isConnected || target.closest("[hidden]")) return;
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
    appliedNavigation.current = navigation.request;
  }, [navigation, timelineTarget, readerTarget, compact, tab]);

  const timeline = (
    <SessionReaderActive.Provider value={tab === "timeline"}>
    <div className="flex min-w-0 flex-col gap-3">
      <SessionBanners session={session} />
      {usageOnly ? null : <RhythmStrip slug={slug} session={session} />}
      {usageOnly ? null : <SessionTimeline
        slug={slug} session={session} headingHidden={false} selectedWork={selectedWork}
        headingRef={setTimelineTarget}
        onReturn={() => { setSelectedWork(null); navigateTo("timeline"); }}
        onReadContent={() => navigateTo("reader")}
      />}
    </div>
    </SessionReaderActive.Provider>
  );

  return (
    <div className={cn("flex flex-col", compact ? "gap-3" : "gap-4")}>
      <SessionHeader slug={slug} session={session} />
      {compact ? <SessionStatStrip session={session} /> : null}
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className="aria-disabled:opacity-45 max-sm:min-h-[44px] max-sm:min-w-[44px]"
          aria-disabled={refreshing} onClick={() => { if (!refreshing) void refresh(); }}>
          <RotateCw aria-hidden className={refreshing ? "motion-safe:animate-spin" : undefined} />
          {t("sessions.evidence.refresh")}
        </Button>
      </div>
      <SessionPanels slug={slug} session={session} timeline={timeline} transcript={<SessionTranscript slug={slug} session={session} active={tab === "transcript"} headingRef={setReaderTarget} />} compact={compact} tab={tab} onTabChange={setTab}
        onInspect={usageOnly ? undefined : (identity) => { setSelectedWork(identity); navigateTo("timeline"); }} />
    </div>
  );
}

function SessionStatStrip({ session }: { session: AgentSession }) {
  const { t } = useTranslation();
  const now = useNow();
  const cells = [
    { value: formatWallTime(sessionWallSeconds(session, now)), label: t("sessions.facts.wallTime") },
    { value: formatTokens(sessionTotalTokens(session)), label: t("sessions.facts.tokens") },
    {
      value: session.cost_usd === null ? "—" : formatUsd(session.cost_usd),
      label: session.cost_basis === "spend" ? t("sessions.cost.spend") : t("sessions.cost.apiEquivalent"),
    },
  ];
  return (
    <dl className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-[var(--radius-cap)] border border-border bg-[color:var(--color-surface-1)]">
      {cells.map((cell) => (
        <div key={cell.label} className="flex flex-col-reverse px-3 py-2.5">
          <dt className="text-[0.78rem] text-muted-foreground">{cell.label}</dt>
          <dd className="font-display text-lg font-bold tabular-nums tracking-[-0.03em]">{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SessionPanels({ slug, session, timeline, transcript, compact, tab, onTabChange, onInspect }: { slug: string; session: AgentSession; timeline: ReactNode; transcript: ReactNode; compact: boolean; tab: ReaderTab; onTabChange: (tab: ReaderTab) => void; onInspect?: (identity: SessionWorkIdentity) => void }) {
  const { t } = useTranslation();
  const baseId = useId();
  const tabs: { id: ReaderTab; label: string }[] = [
    { id: "timeline", label: t("sessions.detail.tabs.timeline") },
    { id: "transcript", label: t("sessions.detail.tabs.transcript") },
    ...(compact ? [{ id: "details" as const, label: t("sessions.detail.tabs.details") }] : []),
  ];

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((candidate) => candidate.id === tab);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    const next = tabs[nextIndex]!;
    onTabChange(next.id);
    document.getElementById(`${baseId}-${next.id}-tab`)?.focus();
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={t("sessions.detail.tabs.label")} onKeyDown={moveFocus} className="flex border-b border-border">
        {tabs.map((candidate) => (
          <button key={candidate.id} id={`${baseId}-${candidate.id}-tab`} type="button" role="tab"
            aria-selected={tab === candidate.id} aria-controls={`${baseId}-${candidate.id}-panel`}
            tabIndex={tab === candidate.id ? 0 : -1} onClick={() => onTabChange(candidate.id)}
            className={cn("-mb-px min-h-[44px] min-w-[44px] flex-1 border-b-2 px-3 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex-none",
              tab === candidate.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {candidate.label}
          </button>
        ))}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className={cn("min-w-0", tab === "details" && "hidden")}>
          <div role="tabpanel" id={`${baseId}-timeline-panel`} aria-labelledby={`${baseId}-timeline-tab`}
            hidden={tab !== "timeline"} className={cn("min-w-0", tab !== "timeline" && "hidden")}>{timeline}</div>
          <div role="tabpanel" id={`${baseId}-transcript-panel`} aria-labelledby={`${baseId}-transcript-tab`}
            hidden={tab !== "transcript"} className={cn("min-w-0", tab !== "transcript" && "hidden")}>{transcript}</div>
        </div>
        <aside role={compact ? "tabpanel" : undefined} id={`${baseId}-details-panel`}
          aria-labelledby={compact ? `${baseId}-details-tab` : undefined}
          hidden={compact && tab !== "details"}
          className={cn("grid min-w-0 items-start gap-4 md:grid-cols-2 xl:grid-cols-1", compact && tab !== "details" && "hidden")}>
          <LinkedWorkPanel slug={slug} session={session} onInspect={onInspect} />
          <CapturePanel session={session} />
          <CostPanel slug={slug} session={session} />
          <TokensPanel session={session} />
          <SubagentsPanel slug={slug} session={session} />
        </aside>
      </div>
    </div>
  );
}
