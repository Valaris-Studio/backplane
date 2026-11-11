// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime, formatNumber } from "@/lib/format";
import { AlertTriangle, Clapperboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/EmptyState";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import { timelineKeys } from "@/lib/query-keys";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { useTimelineHistory } from "../api/use-timeline-history";
import { TimelineHistoryOverview } from "./TimelineHistoryOverview";
import { usePlayback } from "../hooks/use-playback";
import { useSpotlight } from "../hooks/use-spotlight";
import { useViewMode, type ViewMode } from "../hooks/use-view-mode";
import { buildActorAccents, eventActorKey } from "../utils/actor-colors";
import { reconstructWindowState } from "../utils/window-replay";
import { computeCardAnalytics } from "../utils/analytics";
import { describeEvent } from "../utils/event-descriptor";
import { buildAgentRoleIndex, resolveStepActor } from "../utils/step-role";
import {
  EMPTY_FLAG_QUERY,
  buildActorFacets,
  buildCardFacets,
  buildEventFacets,
  computeFlaggedIndices,
  type FlagQuery,
} from "../utils/event-flags";
import { ReplayBoard } from "./ReplayBoard";
import { TransportControls } from "./TransportControls";
import { TimelineScrubber } from "./TimelineScrubber";
import { TimelineFlagBar } from "./TimelineFlagBar";
import { TimelineCardDetail } from "./TimelineCardDetail";
import { StepPanel } from "./StepPanel";
import { BoardEdgePulse } from "./BoardEdgePulse";
import { ViewToggle } from "./ViewToggle";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { ColumnSnapshot, HistoryAnchor, HistoryLiveHead, HistorySelector, HistoryWindow, TimelineEvent } from "../types";

interface Props {
  slug: string;
  boardId: string;
}

// Build a column_id -> name map from EVERY column snapshot in the log so
// captions and dwell labels resolve names even for columns absent from the
// current frame (e.g. deleted, or not yet created at this index).
function buildColumnNames(events: TimelineEvent[], anchorColumns: ColumnSnapshot[]): Record<string, string> {
  const names: Record<string, string> = Object.fromEntries(anchorColumns.map((column) => [column.id, column.name]));
  for (const event of events) {
    if (event.entity_type !== "column") continue;
    const snapshot = (event.after_state ?? event.before_state) as ColumnSnapshot | null;
    if (snapshot && typeof snapshot.id === "string" && typeof snapshot.name === "string") {
      names[snapshot.id] = snapshot.name;
    }
  }
  return names;
}

const HOLD_EVENTS = ["pointerdown", "keydown"] as const;
const RELEASE_EVENTS = ["pointerup", "pointercancel", "keyup"] as const;
// Release settles a held scrub or step; this only covers a release the page
// never receives. It outlasts default OS key-repeat delays (Windows 500 ms,
// X11 660 ms) so a held key settles once instead of before its repeats begin.
const HELD_INPUT_IDLE_COMMIT_MS = 800;

const EMPTY_EVENTS: HistoryWindow["events"] = [];
const UNKNOWN_ANCHOR: HistoryAnchor = { through_seq: null, state: { columns: [], cards: [] }, coverage: { quality: "partial", unknown_origin: true, missing_structural_snapshots: "0", reasons: ["unknown_origin"] } };

export function TimelineSimulator({ slug, boardId }: Props) {
  const history = useTimelineHistory(slug, boardId);
  return <TimelineReplay key={`${history.viewIdentity}:${history.status === "denied"}`} slug={slug} boardId={boardId} history={history} />;
}

interface RetainedReplay {
  identity: string;
  moment: string | null;
  selectedSeq: string | null;
  selectedCardId: string | null;
  flagQuery: FlagQuery;
  viewMode: ViewMode;
  detailsOpen: boolean;
  observing: boolean;
}

function TimelineReplay({ slug, boardId, history }: Props & { history: ReturnType<typeof useTimelineHistory> }) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const returnNavigation = useReturnNavigation();
  const memoryKey = `timeline-replay:${slug}/${boardId}`;
  const [retained] = useState(() => {
    const saved = returnNavigation?.readView<RetainedReplay>(memoryKey);
    return history.status !== "denied" && saved?.identity === history.viewIdentity && saved.moment === history.moment ? saved : undefined;
  });
  const readyWindow = history.status === "ready" && history.window?.status === "ready" ? history.window : undefined;
  const events = readyWindow?.events ?? EMPTY_EVENTS;
  const anchor = readyWindow?.anchor ?? UNKNOWN_ANCHOR;
  const anchorState = anchor.state;
  const [observing, setObserving] = useState(retained?.observing ?? false);
  const observedQuery = useQuery({
    queryKey: [...timelineKeys.history(slug, boardId), history.generation?.id, "live-head"],
    queryFn: async ({ signal }) => (await api.get<HistoryLiveHead>(`/workspaces/${slug}/boards/${boardId}/timeline/generations/${history.generation?.id}/live-head`, { signal })).data,
    enabled: observing && Boolean(history.generation), retry: false, staleTime: Infinity,
  });
  const [continuePlayback, setContinuePlayback] = useState(false);
  const playback = usePlayback(events.length, () => {
    if (readyWindow?.window.next_cursor) {
      selectWindow({ cursor: readyWindow.window.next_cursor });
      setContinuePlayback(true);
    }
  });
  const { viewMode, setViewMode } = useViewMode();
  const [selectedCardId, setSelectedCardId] = useState<string | null>(retained?.selectedCardId ?? null);
  const [detailsOpen, setDetailsOpen] = useState(retained?.detailsOpen ?? false);
  useEffect(() => { if (retained) setViewMode(retained.viewMode); }, [retained, setViewMode]);
  // Flags MARK matching events on the scrubber (search text + actor chips);
  // the replay fold and the board are never filtered by them.
  const [flagQuery, setFlagQuery] = useState<FlagQuery>(retained?.flagQuery ?? EMPTY_FLAG_QUERY);

  const selectedPrefix = useMemo(() => events.slice(0, playback.frameIndex + 1), [events, playback.frameIndex]);
  const presentationState = observing && observedQuery.data ? observedQuery.data.state : anchorState;
  const columnNames = useMemo(() => buildColumnNames(selectedPrefix, presentationState.columns), [selectedPrefix, presentationState]);
  const cardFacets = useMemo(() => buildCardFacets(events, anchorState), [events, anchorState]);
  const flagCardTitles = useMemo(() => Object.fromEntries(cardFacets.map((card) => [card.id, card.title])), [cardFacets]);
  const cardTitles = useMemo(() => Object.fromEntries(buildCardFacets(selectedPrefix, presentationState).map((card) => [card.id, card.title])), [selectedPrefix, presentationState]);
  const agentRoleIndex = useMemo(() => buildAgentRoleIndex(selectedPrefix, presentationState), [selectedPrefix, presentationState]);
  const facetRoleIndex = useMemo(() => buildAgentRoleIndex(events, anchorState), [events, anchorState]);
  const actorFacets = useMemo(
    () => buildActorFacets(events, facetRoleIndex),
    [events, facetRoleIndex],
  );
  const actorAccents = useMemo(() => buildActorAccents(events.map(eventActorKey)), [events]);
  const eventFacets = useMemo(() => buildEventFacets(events), [events]);
  const flaggedIndices = useMemo(
    () => computeFlaggedIndices(events, flagQuery, flagCardTitles),
    [events, flagQuery, flagCardTitles],
  );
  const frame = useMemo(
    () => observing && observedQuery.data
      ? reconstructWindowState({ through_seq: observedQuery.data.head_seq, state: observedQuery.data.state, coverage: { quality: "reconstructed", unknown_origin: false, missing_structural_snapshots: "0", reasons: [] } }, [], -1)
      : reconstructWindowState(anchor, events, playback.frameIndex),
    [anchor, events, playback.frameIndex, observing, observedQuery.data],
  );
  const displayColumns = frame.columns;
  const [selectionRevision, setSelectionRevision] = useState(0);
  const pendingSelection = useRef<HistorySelector | null>(retained?.selectedSeq ? { at_seq: retained.selectedSeq } : null);
  const pendingEnd = useRef(false);
  const previousWindow = useRef<string | undefined>(undefined);
  const windowIdentity = readyWindow ? `${readyWindow.generation_id}:${readyWindow.window.first_seq}:${selectionRevision}` : null;
  const [positionedWindow, setPositionedWindow] = useState<string | null>(null);
  const [missingSelection, setMissingSelection] = useState(false);
  const positioned = windowIdentity !== null && positionedWindow === windowIdentity;
  const replayUnavailable = ["denied", "expired", "error", "invalid", "missing"].includes(history.status);
  // An explicitly requested observation has its own authorized response; a
  // pending replay window must neither hide it nor resume playback behind it.
  const observationReady = observing && Boolean(history.generation) && observedQuery.isSuccess && !replayUnavailable;
  const isLoading = observing
    ? !replayUnavailable && observedQuery.isPending
    : history.status === "loading" || Boolean(readyWindow && !positioned && !missingSelection);
  const { seek, play, pause } = playback;
  useEffect(() => {
    if (!readyWindow || !windowIdentity) return;
    if (previousWindow.current === windowIdentity) return;
    previousWindow.current = windowIdentity;
    const target = pendingSelection.current ?? history.selector;
    let index = pendingEnd.current ? events.length - 1 : 0;
    pendingEnd.current = false;
    if (target && "at_seq" in target) {
      index = events.findIndex((event) => event.seq === target.at_seq);
      if (index < 0) { pause(); setContinuePlayback(false); setMissingSelection(true); return; }
    } else if (target && "at_time" in target && events.length) {
      const time = Date.parse(target.at_time!);
      index = events.reduce((closest, event, candidate) => Math.abs(Date.parse(event.created_at) - time) < Math.abs(Date.parse(events[closest]!.created_at) - time) ? candidate : closest, 0);
    }
    seek(index);
    setPositionedWindow(windowIdentity);
    setMissingSelection(false);
    pendingSelection.current = null;
    if (continuePlayback) { play(); setContinuePlayback(false); }
  }, [readyWindow, windowIdentity, history.selector, events, seek, play, pause, continuePlayback]);
  useEffect(() => {
    if (["preparing", "failed", "expired", "error", "denied", "invalid", "missing"].includes(history.status)) { pause(); setContinuePlayback(false); }
  }, [history.status, pause]);
  const { playing, toggle, atStart, atEnd, stepBack: stepBackWithin, stepForward: stepForwardWithin } = playback;
  const selectHistoryWindow = history.selectWindow;
  const selectWindow = useCallback((selector: HistorySelector) => {
    pause();
    setContinuePlayback(false);
    setObserving(false);
    setSelectedCardId(null);
    setMissingSelection(false);
    pendingEnd.current = "cursor" in selector && selector.cursor === readyWindow?.window.previous_cursor;
    previousWindow.current = undefined;
    pendingSelection.current = selector;
    selectHistoryWindow(selector);
    setSelectionRevision((value) => value + 1);
  }, [pause, readyWindow?.window.previous_cursor, selectHistoryWindow]);
  const stepBack = useCallback(() => {
    if (atStart && readyWindow?.window.previous_cursor) selectWindow({ cursor: readyWindow.window.previous_cursor });
    else stepBackWithin();
  }, [atStart, readyWindow?.window.previous_cursor, selectWindow, stepBackWithin]);
  const stepForward = useCallback(() => {
    if (atEnd && readyWindow?.window.next_cursor) selectWindow({ cursor: readyWindow.window.next_cursor });
    else stepForwardWithin();
  }, [atEnd, readyWindow?.window.next_cursor, selectWindow, stepForwardWithin]);
  const firstHistorySeq = history.generation?.first_seq ?? history.overview?.first_seq;
  const togglePlayback = useCallback(() => {
    if (!playing && atEnd && readyWindow?.window.next_cursor) {
      selectWindow({ cursor: readyWindow.window.next_cursor });
      setContinuePlayback(true);
    } else if (!playing && atEnd && firstHistorySeq && readyWindow?.window.first_seq !== firstHistorySeq) {
      selectWindow({ at_seq: firstHistorySeq });
      setContinuePlayback(true);
    } else toggle();
  }, [playing, atEnd, readyWindow?.window.next_cursor, readyWindow?.window.first_seq, firstHistorySeq, selectWindow, toggle]);
  const refresh = () => {
    const selected = events[playback.frameIndex];
    history.refresh(selected?.seq);
  };

  const currentEvent = observing || !positioned || missingSelection ? null : events[playback.frameIndex] ?? null;
  const selectedSeq = positioned ? events[playback.frameIndex]?.seq ?? null : null;
  useEffect(() => {
    if (!positioned || missingSelection || history.status !== "ready") return;
    returnNavigation?.writeView(memoryKey, { identity: history.viewIdentity, moment: history.moment, selectedSeq, selectedCardId, flagQuery, viewMode, detailsOpen, observing } satisfies RetainedReplay);
  }, [positioned, missingSelection, history, selectedSeq, selectedCardId, flagQuery, viewMode, detailsOpen, observing, returnNavigation, memoryKey]);
  // A held pointer or key previews every frame in memory; only the settled
  // moment reaches the address bar. Each replace mints a router entry key, so
  // per-frame commits would evict the bounded return views, origin included.
  const inputHeld = useRef(false);
  const pendingMoment = useRef<(() => void) | null>(null);
  useEffect(() => {
    const hold = () => { inputHeld.current = true; };
    const release = () => {
      inputHeld.current = false;
      const settle = pendingMoment.current;
      pendingMoment.current = null;
      settle?.();
    };
    // Window capture records the press before any control seeks in response.
    for (const type of HOLD_EVENTS) window.addEventListener(type, hold, true);
    for (const type of RELEASE_EVENTS) window.addEventListener(type, release, true);
    return () => {
      for (const type of HOLD_EVENTS) window.removeEventListener(type, hold, true);
      for (const type of RELEASE_EVENTS) window.removeEventListener(type, release, true);
    };
  }, []);
  const { commitMoment } = history;
  const momentCommittable = positioned && !missingSelection && history.status === "ready" && !playing && !observing;
  useEffect(() => {
    if (!momentCommittable || !selectedSeq) return;
    const settle = () => commitMoment(selectedSeq);
    if (!inputHeld.current) { settle(); return; }
    pendingMoment.current = settle;
    const idleSettle = window.setTimeout(settle, HELD_INPUT_IDLE_COMMIT_MS);
    return () => {
      window.clearTimeout(idleSettle);
      if (pendingMoment.current === settle) pendingMoment.current = null;
    };
  }, [momentCommittable, selectedSeq, commitMoment]);
  // Board-time anchors for the StepPanel chips: the log's first event dates
  // "Day N"; the previous event exposes the real gap the uniform playback
  // cadence hides. Derived here so StepPanel stays pure.
  const firstEventAt = history.overview?.first_at ?? events[0]?.created_at;
  const prevEventAt =
    playback.frameIndex > 0 ? (events[playback.frameIndex - 1]?.created_at ?? null) : null;
  // The current step's structured descriptor drives the rich step panel, the
  // card spotlight, and the off-board edge pulse. Null when there's no step.
  const descriptor = useMemo(
    () => (currentEvent ? describeEvent(currentEvent) : null),
    [currentEvent],
  );
  // One card lights up per step (the card the step acts on/references). The burst
  // flourish fires only during active Play with motion on (shouldBurst).
  // NB: no auto-scroll — moving the viewport mid-playback fights the user trying
  // to navigate/pause, so the spotlight stays purely visual.
  const baseSpotlight = useSpotlight(descriptor, playback.playing, reducedMotion);
  // WHO performed the step, badged on the spotlighted card itself (runner
  // identity + acting role when the summary names one, or the human's name).
  // Merged here — actor is event-derived, not descriptor-derived — and it
  // fades with the spotlight (the linger clock zeroes cardId, hiding both).
  const spotlight = useMemo(
    () => ({
      ...baseSpotlight,
      actor: currentEvent ? resolveStepActor(currentEvent, agentRoleIndex) : null,
    }),
    [baseSpotlight, currentEvent, agentRoleIndex],
  );

  // Video-style keyboard transport: Space toggles play/pause, ←/→ step. We
  // bind on the document but BAIL when focus sits on an interactive control
  // (the scrubber range already maps arrows to seek; buttons map Space to
  // click; a card uses Space/Enter to open its detail) — so we never
  // double-fire or hijack a focused widget. Also bail while the read-only
  // detail panel is open so keys don't drive the board behind it. Only fires
  // when there's a log.
  const detailOpen = selectedCardId !== null;
  useEffect(() => {
    if (events.length === 0 || detailOpen || observing) return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        target !== document.body &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(target.tagName) ||
          target.getAttribute("role") === "button")
      ) {
        return;
      }
      if (e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        togglePlayback();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepForward();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepBack();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [events.length, detailOpen, observing, togglePlayback, stepBack, stepForward]);

  // Resolve the selected card's snapshot AT the current frame; if it's not in
  // the frame (created later / deleted earlier) keep the panel closed.
  const selectedCard = useMemo(() => {
    if (!selectedCardId || history.status !== "ready" || !positioned || missingSelection) return null;
    for (const column of frame.columns) {
      const found = column.cards.find((c) => c.snapshot.id === selectedCardId);
      if (found) return found.snapshot;
    }
    return null;
  }, [frame, selectedCardId, history.status, positioned, missingSelection]);

  const analytics = useMemo(
    () =>
      selectedCardId && currentEvent && !observing
        ? computeCardAnalytics(events.slice(0, playback.frameIndex + 1), selectedCardId, currentEvent.created_at)
        : null,
    [events, selectedCardId, observing, playback.frameIndex, currentEvent],
  );

  const seekToEvent = (index: number) => {
    if (playback.playing) playback.toggle();
    playback.seek(index);
  };

  const expired = history.status === "expired" || observing && observedQuery.error instanceof ApiError && observedQuery.error.status === 410;
  const missing = history.status === "missing" || missingSelection;
  const invalid = history.status === "invalid";
  const denied = history.status === "denied";
  const transportControls = (
    <TransportControls
      playing={playback.playing}
      speed={playback.speed}
      atStart={playback.atStart && !readyWindow?.window.previous_cursor}
      atEnd={playback.atEnd && !readyWindow?.window.next_cursor}
      currentTimestamp={null}
      caption=""
      onToggle={togglePlayback}
      onStepBack={stepBack}
      onStepForward={stepForward}
      onSpeedCycle={playback.cycleSpeed}
    />
  );
  const viewToggle = <ViewToggle viewMode={viewMode} onChange={setViewMode} />;

  return (
    <div className="flex h-full flex-col gap-2">
      <div data-testid="timeline-controls" className="shrink-0 space-y-2">
        {history.generation && history.overview && <TimelineHistoryOverview
          key={history.generation.id} slug={slug} boardId={boardId} generation={history.generation} overview={history.overview}
          window={readyWindow} hasNewActivity={history.hasNewActivity} busy={history.busy} observing={observing}
          onSelect={selectWindow} onRefresh={refresh} onObserve={() => { pause(); setContinuePlayback(false); setSelectedCardId(null); setObserving((value) => !value); }}
        />}
        {history.status === "ready" && <p className="text-xs text-muted-foreground">{t("timeline.history.reloadState")}</p>}
        {observationReady && observedQuery.data && <p role="status" className="text-xs text-muted-foreground">{t("timeline.history.observation", { time: formatDateTime(observedQuery.data.observed_at) })}</p>}
        {!observing && readyWindow && (frame.partial || readyWindow.coverage.quality === "partial") && <p data-testid="timeline-partial-note" className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">{t("timeline.history.partial")}</p>}
        {continuePlayback && !readyWindow && <Button variant="outline" onClick={() => setContinuePlayback(false)}>{t("timeline.transport.pause")}</Button>}
        <div hidden={observing || !readyWindow || !positioned || missingSelection} className="space-y-2">
        {events.length > 0 ? (
          <TimelineFlagBar
            query={flagQuery}
            facets={actorFacets}
            cardFacets={cardFacets}
            eventFacets={eventFacets}
            actorAccents={actorAccents}
            flags={flaggedIndices}
            frameIndex={playback.frameIndex}
            onQueryChange={setFlagQuery}
            onSeek={seekToEvent}
            transportControls={transportControls}
            viewToggle={viewToggle}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {transportControls}
            {viewToggle}
          </div>
        )}

        {currentEvent && descriptor ? (
          <StepPanel
            slug={slug}
            event={currentEvent}
            descriptor={descriptor}
            columnNames={columnNames}
            cardTitles={cardTitles}
            agentRoleIndex={agentRoleIndex}
            firstEventAt={firstEventAt}
            prevEventAt={prevEventAt}
            reducedMotion={reducedMotion}
            detailsOpen={detailsOpen}
            onDetailsOpenChange={setDetailsOpen}
            onInspect={() => {
              if (playback.playing) playback.toggle();
            }}
            onOpenCurrent={() => {
              pause();
              setContinuePlayback(false);
            }}
          />
        ) : null}

        <TimelineScrubber
          frameIndex={playback.frameIndex}
          frameCount={events.length}
          events={events}
          columnNames={columnNames}
          onSeek={seekToEvent}
          actorAccents={actorAccents}
          flags={flaggedIndices}
        />
        </div>
      </div>

      <div className="relative min-h-[24rem] flex-1">
        {isLoading ? (
          <div data-testid="timeline-loading" className="space-y-4">
            <Skeleton className="h-[28rem] rounded-[calc(var(--radius-xl))]" />
          </div>
        ) : history.status === "error" || expired || missing || invalid || denied || observedQuery.isError && observing ? (
          <div data-testid="timeline-error" role="alert"><EmptyState icon={AlertTriangle}
            title={t(expired ? "timeline.history.expiredTitle" : invalid ? "timeline.history.invalidMomentTitle" : missing ? "timeline.history.missingMomentTitle" : denied ? "timeline.history.accessLostTitle" : "timeline.error.title")}
            description={t(expired ? "timeline.history.expired" : invalid ? "timeline.history.invalidMoment" : missing ? "timeline.history.missingMoment" : denied ? "timeline.history.accessLost" : "timeline.error.body")}
            action={<Button variant="outline" onClick={() => {
              if (expired) refresh();
              else if (missing || invalid) { setMissingSelection(false); previousWindow.current = undefined; pendingSelection.current = null; history.chooseMoment(); }
              else if (observing && !denied) void observedQuery.refetch();
              else history.retry();
            }}>{t(expired ? "timeline.history.rebuildMoment" : missing || invalid ? "timeline.history.chooseMoment" : "timeline.error.retry")}</Button>}
          /></div>
        ) : !observing && history.window && history.window.status !== "ready" ? (
          <div role="status" className="space-y-3 py-8 text-center">
            <p className="text-sm font-medium">{t(history.window.status === "failed" ? "timeline.history.preparationFailed" : "timeline.history.preparing")}</p>
            <p className="text-xs tabular-nums text-muted-foreground">{t("timeline.history.progress", { total: formatNumber(BigInt(history.window.progress.processed_events)) })}</p>
            {(history.window.status === "preparing" || history.window.retryable) && <Button variant="outline" disabled={history.busy} onClick={history.retry}>{t(history.window.status === "preparing" ? "timeline.history.checkProgress" : "timeline.error.retry")}</Button>}
          </div>
        ) : !observing && !events.length && !anchorState.cards.length ? (
          <div data-testid="timeline-empty"><EmptyState icon={Clapperboard} title={t("timeline.empty.title")} description={t("timeline.empty.body")} /></div>
        ) : (
          <>
            {currentEvent && descriptor ? (
              <BoardEdgePulse
                eventId={currentEvent.id}
                descriptor={descriptor}
                reducedMotion={reducedMotion}
              />
            ) : null}
            <ReplayBoard
              frame={{ columns: displayColumns, partial: frame.partial }}
              selectedCardId={selectedCardId}
              onSelectCard={(cardId) => {
                if (playback.playing) playback.toggle();
                setSelectedCardId(cardId);
              }}
              reducedMotion={reducedMotion}
              viewMode={viewMode}
              spotlight={spotlight}
              burstKey={currentEvent?.id}
            />
          </>
        )}
      </div>

      <TimelineCardDetail
        slug={slug}
        boardId={boardId}
        open={selectedCard !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedCardId(null);
        }}
        card={selectedCard}
        analytics={analytics}
        analyticsScope={observing ? undefined : t("timeline.history.analyticsScope")}
        columnNames={columnNames}
        onOpenCurrent={() => {
          pause();
          setContinuePlayback(false);
        }}
      />
    </div>
  );
}
