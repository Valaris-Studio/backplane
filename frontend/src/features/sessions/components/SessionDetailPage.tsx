// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, SearchX } from "lucide-react";
import { EmptyState } from "@/components/layout/EmptyState";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { isApiError } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import type { AgentSession } from "@/types/agent-session";
import { useCompanionEnabled, useSession } from "../api/use-sessions";
import { useForgetSessionContent, useSessionRealtime } from "../api/use-session-realtime";
import { useNow } from "../hooks/use-now";
import { formatTokens, formatUsd, formatWallTime, sessionTotalTokens, sessionWallSeconds } from "../utils/format";
import { isUsageOnly } from "../utils/group-sessions";
import { CompanionGate } from "./CompanionGate";
import { SessionBanners } from "./SessionBanners";
import { SessionHeader } from "./SessionHeader";
import { CapturePanel, CostPanel, LinkedWorkPanel, SubagentsPanel, TokensPanel } from "./SessionRail";
import { COMPACT_LIST_QUERY } from "./SessionsTable";
import { LoadErrorState } from "./SessionStates";
import { SessionTimeline } from "./SessionTimeline";
import { SessionTranscript } from "./SessionTranscript";
import { RhythmStrip } from "./RhythmStrip";

export function SessionDetailPage() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  return (
    <div className="flex flex-col gap-[var(--page-section-gap)]">
      <Link
        to={`/${slug}/sessions`}
        className="inline-flex w-fit items-center gap-1 rounded-[var(--radius-cap)] text-sm font-semibold text-foreground/75 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronLeft aria-hidden className="size-4" />
        {t("sessions.detail.back")}
      </Link>
      <CompanionGate>
        <SessionDetail />
      </CompanionGate>
    </div>
  );
}

export function SessionNotFound() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  return (
    <EmptyState
      icon={SearchX}
      title={t("sessions.detail.notFound.title")}
      description={t("sessions.detail.notFound.description")}
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
  const enabled = useCompanionEnabled() === true;
  useSessionRealtime(slug);
  const session = useSession(slug, sessionId, enabled);
  const gone = session.isError && isApiError(session.error) && session.error.status === 404;
  const forgetContent = useForgetSessionContent();
  useEffect(() => {
    if (gone) forgetContent(slug, sessionId);
  }, [gone, forgetContent, slug, sessionId]);

  if (session.isPending) return <SessionDetailSkeleton />;
  if (session.isError) {
    if (gone) return <SessionNotFound />;
    return (
      <LoadErrorState
        error={session.error}
        title={t("sessions.detail.loadError.title")}
        description={t("sessions.detail.loadError.description")}
        onRetry={() => void session.refetch()}
        retrying={session.isFetching}
      />
    );
  }

  return <SessionDetailBody slug={slug} session={session.data} />;
}

const WIDE_QUERY = "(min-width: 1280px)";

type CompactTab = "timeline" | "linked" | "cost";

function SessionDetailBody({ slug, session }: { slug: string; session: AgentSession }) {
  const wide = useMediaQuery(WIDE_QUERY);
  const compact = useMediaQuery(COMPACT_LIST_QUERY);
  const usageOnly = isUsageOnly(session);
  const timeline = (
    <div className="flex min-w-0 flex-col gap-3">
      <SessionBanners session={session} />
      {usageOnly ? null : <SessionTimeline slug={slug} session={session} headingHidden={compact} />}
      <SessionTranscript slug={slug} session={session} />
    </div>
  );

  if (compact) {
    return (
      <div className="flex flex-col gap-3">
        <SessionHeader slug={slug} session={session} />
        <SessionStatStrip session={session} />
        {usageOnly ? null : <RhythmStrip slug={slug} session={session} />}
        <CompactTabs slug={slug} session={session} timeline={timeline} />
      </div>
    );
  }

  const rail = (
    <>
      <CostPanel slug={slug} session={session} />
      <TokensPanel session={session} />
      <LinkedWorkPanel slug={slug} session={session} />
      <CapturePanel session={session} />
      <SubagentsPanel slug={slug} session={session} />
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <SessionHeader slug={slug} session={session} />
      {usageOnly ? null : <RhythmStrip slug={slug} session={session} />}
      {wide ? (
        <div className="grid grid-cols-[minmax(0,1fr)_23rem] items-start gap-4">
          {timeline}
          {/* Not sticky: the rail is taller than a laptop viewport, and a sticky
              rail would hide its last panels until the page ends. */}
          <aside className="flex flex-col gap-4">{rail}</aside>
        </div>
      ) : (
        <>
          <aside className="grid items-start gap-4 md:grid-cols-2">{rail}</aside>
          {timeline}
        </>
      )}
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

function CompactTabs({ slug, session, timeline }: { slug: string; session: AgentSession; timeline: ReactNode }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CompactTab>("timeline");
  const baseId = useId();
  const tabs: { id: CompactTab; label: string }[] = [
    { id: "timeline", label: t("sessions.detail.tabs.timeline") },
    { id: "linked", label: t("sessions.detail.tabs.linkedWork") },
    { id: "cost", label: t("sessions.detail.tabs.cost") },
  ];

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = tabs.findIndex((candidate) => candidate.id === tab);
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    if (!next) return;
    setTab(next.id);
    document.getElementById(`${baseId}-${next.id}-tab`)?.focus();
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={t("sessions.detail.tabs.label")} onKeyDown={moveFocus} className="grid grid-cols-3 border-b border-border">
        {tabs.map((candidate) => (
          <button
            key={candidate.id}
            id={`${baseId}-${candidate.id}-tab`}
            type="button"
            role="tab"
            aria-selected={tab === candidate.id}
            aria-controls={`${baseId}-${candidate.id}-panel`}
            tabIndex={tab === candidate.id ? 0 : -1}
            onClick={() => setTab(candidate.id)}
            className={cn(
              "-mb-px border-b-2 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              tab === candidate.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-${tab}-panel`} aria-labelledby={`${baseId}-${tab}-tab`} className="flex flex-col gap-3">
        {tab === "timeline" ? timeline : null}
        {tab === "linked" ? <LinkedWorkPanel slug={slug} session={session} /> : null}
        {tab === "cost" ? (
          <>
            <CostPanel slug={slug} session={session} />
            <TokensPanel session={session} />
            <CapturePanel session={session} />
            <SubagentsPanel slug={slug} session={session} />
          </>
        ) : null}
      </div>
    </div>
  );
}
