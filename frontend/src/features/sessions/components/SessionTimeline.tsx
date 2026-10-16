// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefCallback } from "react";
import { useTranslation } from "react-i18next";
import { Layers, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentSession, CallFilter, SessionCallItem, SessionWorkLink } from "@/types/agent-session";
import { useSessionCalls, useSessionLinks } from "../api/use-sessions";
import { sameWorkRelationship, type SessionWorkIdentity } from "../api/use-session-evidence";
import { useWorkTarget } from "../api/use-work-title";
import { formatClock, formatWallTime, isLive } from "../utils/format";
import { buildTimeline, mergeCallPages, runToolCounts, type TimelineEntry, type TimelineTurn } from "../utils/timeline";
import { CallRow } from "./CallRow";
import { Segmented } from "./controls";
import { PromptText } from "./PromptText";
import { SubagentRow } from "./SubagentRow";
import { WithheldChip } from "./WithheldChip";
import { formatBytes } from "../utils/format";

// Screen readers hear new calls in batches, never more than once per window.
const ANNOUNCE_WINDOW_MS = 10_000;

interface SessionTimelineProps {
  slug: string;
  session: AgentSession;
  // Inside the mobile "Timeline" tab the visible heading would repeat the tab.
  headingHidden?: boolean;
  selectedWork?: SessionWorkIdentity | null;
  headingRef?: RefCallback<HTMLElement>;
  onReturn?: () => void;
  onReadContent?: () => void;
}

export function SessionTimeline({ slug, session, headingHidden = false, selectedWork, headingRef, onReturn, onReadContent }: SessionTimelineProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const [filter, setFilter] = useState<CallFilter>("all");
  const callFilter = selectedWork ? "work" : filter;
  const calls = useSessionCalls(slug, session.id, callFilter, true);
  const links = useSessionLinks(slug, session.id, !!selectedWork);
  const merged = useMemo(() => mergeCallPages(calls.isPlaceholderData ? [] : calls.data?.pages ?? []), [calls.data, calls.isPlaceholderData]);
  const turns = useMemo(() => buildTimeline(merged.items, filter === "all" ? merged.turns : []).map((turn) =>
    filter === "all" ? turn : { ...turn, entries: turn.entries.filter((entry) => entry.type !== "idle") }), [merged, filter]);
  const live = isLive(session);
  const announcement = useNewCallAnnouncement(merged.items.length, live && filter === "all" && !selectedWork, `${slug}/${session.id}/${callFilter}`);

  const summary = [
    t("sessions.timeline.turns", { count: session.prompt_count }),
    t("sessions.timeline.calls", { count: session.tool_call_count }),
  ].join(" · ");

  if (selectedWork) {
    const link = links.isSuccess ? links.data.items.find((candidate) => sameWorkRelationship(candidate, selectedWork)) : undefined;
    const frame = { headingId, headingRef, onReturn, onReadContent };
    if (!link) return <EvidenceFrame {...frame} title={t("sessions.evidence.heading")}>
      {links.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("sessions.evidence.loading")}</p> : links.isError ? (
        <EvidenceError onRetry={() => void links.refetch()} retrying={links.isFetching} />
      ) : <p className="text-sm text-muted-foreground">{t("sessions.evidence.missing")}</p>}
    </EvidenceFrame>;
    return <WorkEvidence {...frame} slug={slug} sessionId={session.id} link={link} calls={calls} items={merged.items} />;
  }

  return (
    <section
      aria-labelledby={headingId}
      ref={headingHidden ? headingRef : undefined}
      tabIndex={headingHidden ? -1 : undefined}
      onKeyDown={jumpBetweenTurns}
      className="scroll-mt-[calc(var(--topbar-height)+1rem)] overflow-hidden rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] shadow-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-[var(--card-padding)] py-2.5">
        <h2 id={headingId} ref={headingHidden ? undefined : headingRef} tabIndex={-1} className={headingHidden ? "sr-only" : "scroll-mt-[calc(var(--topbar-height)+1rem)] rounded-[var(--radius-cap)] text-base font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"}>
          {t("sessions.timeline.title")}
        </h2>
        <p className="text-[0.82rem] tabular-nums text-muted-foreground">{t("sessions.evidence.sessionTotals")}: {summary}</p>
        <Segmented
          className="ml-auto"
          label={t("sessions.timeline.filterLabel")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("sessions.timeline.filters.all") },
            { value: "work", label: t("sessions.timeline.filters.work") },
            { value: "failures", label: t("sessions.timeline.filters.failures") },
          ]}
        />
      </header>

      {calls.hasNextPage ? (
        <div className="flex justify-center border-b border-border/60 py-2">
          <Button variant="ghost" size="sm" className="aria-disabled:opacity-45" aria-disabled={calls.isFetching}
            onClick={() => { if (!calls.isFetching) void calls.fetchNextPage({ cancelRefetch: false }); }}>
            {calls.isFetchingNextPage ? t("sessions.timeline.loadingEarlier") : t("sessions.timeline.loadEarlier")}
          </Button>
        </div>
      ) : null}

      {calls.isPending || calls.isPlaceholderData ? (
        <TimelineSkeleton />
      ) : calls.isError ? (
        <div className="flex flex-col items-center gap-3 px-[var(--card-padding)] py-10 text-center text-sm text-muted-foreground">
          <p>{t("sessions.timeline.loadError")}</p>
          <Button variant="outline" size="sm" onClick={() => void calls.refetch()}>
            <RotateCw aria-hidden />
            {t("sessions.timeline.retry")}
          </Button>
        </div>
      ) : turns.length === 0 ? (
        <p className="px-[var(--card-padding)] py-10 text-center text-sm text-muted-foreground">
          {filter === "work"
            ? t("sessions.timeline.emptyWork")
            : filter === "failures"
              ? t("sessions.timeline.emptyFailures")
              : t("sessions.timeline.empty")}
        </p>
      ) : (
        <div className="pb-2 pt-1">
          {turns.map((turn) => (
            <TurnView key={turn.turnIndex} slug={slug} sessionId={session.id} turn={turn} />
          ))}
        </div>
      )}

      {live || turns.length > 1 ? (
        <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-border/60 px-[var(--card-padding)] py-2.5 text-[0.8rem] text-muted-foreground">
          {live ? <p>{t("sessions.timeline.liveFooter")}</p> : null}
          {/* Only useful with more than one turn to move between. */}
          {turns.length > 1 ? <p className="max-sm:hidden">{t("sessions.timeline.turnKeysHint")}</p> : null}
        </footer>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}

interface EvidenceFrameProps {
  headingId: string;
  headingRef?: RefCallback<HTMLElement>;
  title: string;
  relation?: SessionWorkLink["relation"];
  onReturn?: () => void;
  onReadContent?: () => void;
  children: ReactNode;
}

function EvidenceFrame({ headingId, headingRef, title, relation, onReturn, onReadContent, children }: EvidenceFrameProps) {
  const { t } = useTranslation();
  return <section aria-labelledby={headingId} className="min-w-0 overflow-hidden rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] shadow-panel">
    <header className="grid gap-2 border-b border-border px-[var(--card-padding)] py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="min-w-0 scroll-mt-[calc(var(--topbar-height)+1rem)] break-words rounded-[var(--radius-cap)] text-base font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{title}</h2>
        {relation ? <span className="text-sm font-semibold text-muted-foreground">{t(`sessions.work.${relation}`)}</span> : null}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" className="-ml-3 max-sm:min-h-[44px]" onClick={onReturn}>{t("sessions.evidence.return")}</Button>
        {onReadContent ? <Button variant="ghost" size="sm" className="max-sm:min-h-[44px]" onClick={onReadContent}>{t("sessions.evidence.read")}</Button> : null}
      </div>
    </header>
    <div className="grid gap-3 px-[var(--card-padding)] py-4">{children}</div>
  </section>;
}

function EvidenceError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation();
  return <div className="grid justify-items-start gap-2 text-sm text-muted-foreground">
    <p role="alert">{t("sessions.evidence.error")}</p>
    <Button variant="outline" size="sm" className="max-sm:min-h-[44px]" onClick={onRetry} disabled={retrying}>{t("sessions.work.retry")}</Button>
  </div>;
}

function WorkEvidence({ slug, sessionId, link, calls, items, ...frame }: Omit<EvidenceFrameProps, "title" | "children"> & {
  slug: string;
  sessionId: string;
  link: SessionWorkLink;
  calls: ReturnType<typeof useSessionCalls>;
  items: SessionCallItem[];
}) {
  const { t } = useTranslation();
  const target = useWorkTarget(link);
  const matches = items.flatMap((item) => {
    const ref = item.work_refs.find((candidate) => sameWorkRelationship(candidate, link));
    return ref ? [{ item, provenance: ref.provenance }] : [];
  });
  return <EvidenceFrame {...frame} title={target.status === "available" ? t("sessions.evidence.title", { title: target.title }) : t("sessions.evidence.heading")} relation={link.relation}>
    {target.status !== "available" ? <div className="grid justify-items-start gap-2 text-sm text-muted-foreground">
      <p role={target.status === "loading" ? "status" : undefined}>{t(target.status === "loading" ? "sessions.work.loadingTitle" : target.status === "error" ? "sessions.work.loadError" : "sessions.work.unavailable")}</p>
      {target.status === "error" ? <Button variant="outline" size="sm" className="max-sm:min-h-[44px]" onClick={() => void target.refetch()}>{t("sessions.work.retry")}</Button> : null}
    </div> : calls.isPending || calls.isPlaceholderData ? (
      <p role="status" className="text-sm text-muted-foreground">{t("sessions.evidence.loading")}</p>
    ) : calls.isError ? <EvidenceError onRetry={() => void calls.refetch()} retrying={calls.isFetching} /> : <>
      <div className="grid gap-1">
        <p className="text-sm font-semibold tabular-nums">{t("sessions.evidence.loaded", { count: matches.length })}</p>
        <p className="text-sm text-muted-foreground">{t("sessions.evidence.scope")}</p>
      </div>
      {calls.hasNextPage ? <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border/60 py-2">
        <p className="text-sm text-muted-foreground">{t("sessions.evidence.earlier")}</p>
        <Button variant="ghost" size="sm" className="aria-disabled:opacity-45 max-sm:min-h-[44px]" aria-disabled={calls.isFetching}
          onClick={() => { if (!calls.isFetching) void calls.fetchNextPage({ cancelRefetch: false }); }}>{t(calls.isFetchingNextPage ? "sessions.timeline.loadingEarlier" : "sessions.timeline.loadEarlier")}</Button>
      </div> : null}
      {matches.length ? <ul className="grid gap-4">{matches.map(({ item, provenance }) => <CallRow key={item.key} slug={slug} sessionId={sessionId} item={item} evidenceProvenance={provenance} />)}</ul> : <p className="py-4 text-sm text-muted-foreground">{t("sessions.evidence.empty")}</p>}
    </>}
  </EvidenceFrame>;
}

// `[` and `]` step to the previous or next turn from anywhere in the timeline
// (never while typing), the keyboard counterpart of scanning by prompt.
function jumpBetweenTurns(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "[" && event.key !== "]") return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, [contenteditable='true']")) return;
  const turns = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-turn]")];
  if (!turns.length) return;
  const current = target.closest<HTMLElement>("[data-turn]");
  const index = current ? turns.indexOf(current) : -1;
  const next = event.key === "]" ? turns[Math.min(index + 1, turns.length - 1)] : turns[Math.max(index - 1, 0)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function useNewCallAnnouncement(itemCount: number, active: boolean, source: string): string {
  const { t } = useTranslation();
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<{ count: number; active: boolean; source: string } | null>(null);
  const pending = useRef(0);
  const lastAnnounced = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = { count: itemCount, active, source };
    // Cached subsets have different counts. They start a new baseline, and a
    // queued batch must not announce after the operator leaves its source.
    if (!active || !before || before.source !== source || before.active !== active) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = 0;
      lastAnnounced.current = 0;
      setAnnouncement("");
      return;
    }
    if (itemCount <= before.count) return;
    pending.current += itemCount - before.count;
    if (timer.current) return;
    const wait = Math.max(0, lastAnnounced.current + ANNOUNCE_WINDOW_MS - Date.now());
    timer.current = setTimeout(() => {
      setAnnouncement(t("sessions.timeline.newCalls", { count: pending.current }));
      pending.current = 0;
      lastAnnounced.current = Date.now();
      timer.current = null;
    }, wait);
  }, [itemCount, active, source, t]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return announcement;
}

function TimelineSkeleton() {
  return (
    <div aria-hidden className="grid gap-5 px-[var(--card-padding)] py-4">
      {[0, 1, 2].map((turn) => (
        <div key={turn} className="grid grid-cols-[3.6rem_1fr] gap-3">
          <Skeleton className="h-3.5 w-10 justify-self-end" />
          <div className="grid gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface TurnViewProps {
  slug: string;
  sessionId: string;
  turn: TimelineTurn;
}

function TurnView({ slug, sessionId, turn }: TurnViewProps) {
  const { t } = useTranslation();
  const promptId = useId();
  const timeId = useId();
  const startedAt = turn.prompt?.started_at ?? turn.stats?.started_at ?? turn.entries.find(hasItem)?.item.started_at;
  const promptWithheld = turn.prompt?.withheld.find((entry) => entry.field === "prompt");
  const stats = turn.stats;

  return (
    <article
      aria-labelledby={`${timeId} ${promptId}`}
      tabIndex={-1}
      data-turn=""
      data-started={startedAt}
      className="scroll-mt-[calc(var(--topbar-height)+1rem)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring grid grid-cols-[4.6rem_minmax(0,1fr)] border-t border-border/60 pb-1.5 pr-[var(--card-padding)] pt-3.5 first:border-t-0 max-sm:grid-cols-[minmax(0,1fr)] max-sm:pl-[calc(var(--card-padding)+0.25rem)] [content-visibility:auto] [contain-intrinsic-size:auto_12rem]"
    >
      {/* Below 640px the gutter would eat a fifth of the width; the time moves
          into the label row and stays here only for the turn's label. */}
      <p className="whitespace-nowrap pr-3.5 pt-[0.2rem] text-right text-[0.8rem] font-semibold tabular-nums text-muted-foreground max-sm:sr-only">
        {startedAt ? (
          <time id={timeId} dateTime={startedAt}>
            {formatClock(startedAt)}
          </time>
        ) : null}
      </p>
      <div className="relative border-l border-border pl-4">
        <div className="relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <span
            aria-hidden
            className="absolute -left-[calc(1rem+4.5px)] top-[0.42rem] size-2 rounded-full bg-[color:var(--color-kind-prompt)] shadow-[0_0_0_3px_var(--color-surface-1)]"
          />
          <div id={promptId} className="min-w-0">
            {turn.prompt ? (
              <>
                <span className="mb-0.5 block text-[0.75rem] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                  {t("sessions.timeline.you")}
                  {startedAt ? (
                    <span aria-hidden className="ml-2 font-semibold normal-case tracking-normal tabular-nums sm:hidden">
                      {formatClock(startedAt)}
                    </span>
                  ) : null}
                </span>
                {turn.prompt.prompt_preview ? (
                  <p className="max-w-[68ch] whitespace-pre-line break-words text-[0.97rem] font-semibold leading-normal text-foreground">
                    <PromptText text={turn.prompt.prompt_preview} />
                  </p>
                ) : promptWithheld ? (
                  <WithheldChip
                    label={
                      promptWithheld.bytes
                        ? t("sessions.timeline.promptWithheldSize", { size: formatBytes(promptWithheld.bytes) })
                        : t("sessions.timeline.promptWithheld")
                    }
                  />
                ) : null}
              </>
            ) : turn.turnIndex === 0 ? (
              <span className="block text-[0.72rem] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                {t("sessions.timeline.beforeFirstPrompt")}
              </span>
            ) : null}
          </div>
          {stats ? (
            <p className="flex gap-3 whitespace-nowrap pt-0.5 text-[0.8rem] tabular-nums text-muted-foreground">
              <span>{t("sessions.timeline.calls", { count: stats.call_count })}</span>
              {stats.failure_count ? (
                <span className="font-semibold text-[color:var(--color-error-ink)]">
                  {t("sessions.timeline.failed", { count: stats.failure_count })}
                </span>
              ) : null}
              {stats.reasoning_count ? (
                <span className="max-md:hidden">{t("sessions.timeline.reasoning", { count: stats.reasoning_count })}</span>
              ) : null}
              <span>{formatWallTime((Date.parse(stats.ended_at) - Date.parse(stats.started_at)) / 1000)}</span>
            </p>
          ) : null}
        </div>
        {turn.entries.length ? (
          <ul className="mb-1 mt-2 flex flex-col">
            {turn.entries.map((entry) => (
              <EntryView key={entryKey(entry)} slug={slug} sessionId={sessionId} entry={entry} />
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

function hasItem(entry: TimelineEntry): entry is Extract<TimelineEntry, { item: SessionCallItem }> {
  return entry.type === "call" || entry.type === "subagent";
}

function entryKey(entry: TimelineEntry): string {
  return hasItem(entry) ? entry.item.key : entry.key;
}

function EntryView({ slug, sessionId, entry }: { slug: string; sessionId: string; entry: TimelineEntry }) {
  const { t } = useTranslation();
  switch (entry.type) {
    case "call":
      return <CallRow slug={slug} sessionId={sessionId} item={entry.item} />;
    case "subagent":
      return entry.item.subagent ? <SubagentRow slug={slug} session={entry.item.subagent} /> : null;
    case "idle":
      return (
        <li className="my-1.5 flex items-center gap-2 text-[0.8rem] text-muted-foreground before:flex-1 before:border-t before:border-dashed before:border-border after:flex-1 after:border-t after:border-dashed after:border-border">
          {t("sessions.timeline.idle", { duration: formatWallTime(entry.seconds) })}
        </li>
      );
    case "run":
      return <CollapsedRun slug={slug} sessionId={sessionId} items={entry.items} />;
  }
}

function CollapsedRun({ slug, sessionId, items }: { slug: string; sessionId: string; items: SessionCallItem[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <>
        {items.map((item) => (
          <CallRow key={item.key} slug={slug} sessionId={sessionId} item={item} />
        ))}
      </>
    );
  }
  const counts = runToolCounts(items)
    .map(({ name, count }) => (count > 1 ? `${name} ×${count}` : name))
    .join(" · ");
  return (
    <li className="-mx-2 grid grid-cols-[1.6rem_minmax(0,1fr)_auto] items-center gap-x-2.5 px-2 py-1 text-[0.89rem]">
      <span aria-hidden className="grid size-[1.6rem] place-items-center rounded-[var(--radius-cap)] bg-[color:color-mix(in_oklab,var(--color-kind-tool)_12%,transparent)] text-[color:var(--color-kind-tool)]">
        <Layers className="size-[0.9rem]" />
      </span>
      <p className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-bold">{t("sessions.timeline.collapsedRun", { count: items.length })}</span>
        <span className="truncate text-[0.82rem] text-muted-foreground">{counts}</span>
      </p>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={t("sessions.timeline.showRun", { count: items.length })}>
        {t("sessions.timeline.show")}
      </Button>
    </li>
  );
}
