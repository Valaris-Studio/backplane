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
import { useTimelineHistory } from "../api/use-timeline-history";
import { TimelineHistoryOverview } from "./TimelineHistoryOverview";
import { usePlayback } from "../hooks/use-playback";
import { useSpotlight } from "../hooks/use-spotlight";
import { useViewMode } from "../hooks/use-view-mode";
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

const EMPTY_EVENTS: HistoryWindow["events"] = [];
const UNKNOWN_ANCHOR: HistoryAnchor = { through_seq: null, state: { columns: [], cards: [] }, coverage: { quality: "partial", unknown_origin: true, missing_structural_snapshots: "0", reasons: ["unknown_origin"] } };

export function TimelineSimulator({ slug, boardId }: Props) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const history = useTimelineHistory(slug, boardId);
  const readyWindow = history.status === "ready" && history.window?.status === "ready" ? history.window : undefined;
  const events = readyWindow?.events ?? EMPTY_EVENTS;
  const anchor = readyWindow?.anchor ?? UNKNOWN_ANCHOR;
  const anchorState = anchor.state;
  const [observing, setObserving] = useState(false);
  const observedQuery = useQuery({
    queryKey: [...timelineKeys.history(slug, boardId), history.generation?.id, "live-head"],
    queryFn: async ({ signal }) => (await api.get<HistoryLiveHead>(`/workspaces/${slug}/boards/${boardId}/timeline/generations/${history.generation?.id}/live-head`, { signal })).data,
    enabled: observing && Boolean(history.generation), retry: false, staleTime: Infinity,
  });
  const isLoading = history.status === "loading" || observing && observedQuery.isPending;
  const [continuePlayback, setContinuePlayback] = useState(false);
  const playback = usePlayback(events.length, () => {
    if (readyWindow?.window.next_cursor) {
      selectWindow({ cursor: readyWindow.window.next_cursor });
      setContinuePlayback(true);
    }
  });
  const { viewMode, setViewMode } = useViewMode();
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  // Flags MARK matching events on the scrubber (search text + actor chips);
  // the replay fold and the board are never filtered by them.
  const [flagQuery, setFlagQuery] = useState<FlagQuery>(EMPTY_FLAG_QUERY);

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
  const pendingSelection = useRef<HistorySelector | null>(null);
  const pendingEnd = useRef(false);
  const previousWindow = useRef<string | undefined>(undefined);
  const { seek, play, pause } = playback;
  useEffect(() => {
    if (!readyWindow) return;
    const identity = `${readyWindow.generation_id}:${readyWindow.window.first_seq}`;
    if (previousWindow.current === identity) return;
    previousWindow.current = identity;
    const target = pendingSelection.current;
    let index = pendingEnd.current ? events.length - 1 : 0;
    pendingEnd.current = false;
    if (target && "at_seq" in target) {
      index = events.findIndex((event) => BigInt(event.seq) >= BigInt(target.at_seq!));
      if (index < 0) index = events.length - 1;
    } else if (target && "at_time" in target && events.length) {
      const time = Date.parse(target.at_time!);
      index = events.reduce((closest, event, candidate) => Math.abs(Date.parse(event.created_at) - time) < Math.abs(Date.parse(events[closest]!.created_at) - time) ? candidate : closest, 0);
    }
    seek(index);
    pendingSelection.current = null;
    if (continuePlayback) { play(); setContinuePlayback(false); }
  }, [readyWindow, events, seek, play, selectionRevision, continuePlayback]);
  useEffect(() => {
    if (["preparing", "failed", "expired", "error"].includes(history.status)) setContinuePlayback(false);
  }, [history.status]);
  const { playing, toggle, atStart, atEnd, stepBack: stepBackWithin, stepForward: stepForwardWithin } = playback;
  const selectHistoryWindow = history.selectWindow;
  const selectWindow = useCallback((selector: HistorySelector) => {
    pause();
    setContinuePlayback(false);
    setObserving(false);
    setSelectedCardId(null);
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
    selectWindow(selected ? { at_seq: selected.seq } : {});
    history.refresh();
  };

  const currentEvent = observing ? null : events[playback.frameIndex] ?? null;
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
    if (!selectedCardId) return null;
    for (const column of frame.columns) {
      const found = column.cards.find((c) => c.snapshot.id === selectedCardId);
      if (found) return found.snapshot;
    }
    return null;
  }, [frame, selectedCardId]);

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
        {observing && observedQuery.data && <p role="status" className="text-xs text-muted-foreground">{t("timeline.history.observation", { time: formatDateTime(observedQuery.data.observed_at) })}</p>}
        {!observing && readyWindow && (frame.partial || readyWindow.coverage.quality === "partial") && <p data-testid="timeline-partial-note" className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">{t("timeline.history.partial")}</p>}
        {continuePlayback && !readyWindow && <Button variant="outline" onClick={() => setContinuePlayback(false)}>{t("timeline.transport.pause")}</Button>}
        <div hidden={observing || !readyWindow} className="space-y-2">
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
            event={currentEvent}
            descriptor={descriptor}
            columnNames={columnNames}
            cardTitles={cardTitles}
            agentRoleIndex={agentRoleIndex}
            firstEventAt={firstEventAt}
            prevEventAt={prevEventAt}
            reducedMotion={reducedMotion}
            onInspect={() => {
              if (playback.playing) playback.toggle();
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
        ) : history.status === "error" || history.status === "expired" || observedQuery.isError && observing ? (
          <div data-testid="timeline-error"><EmptyState icon={AlertTriangle} title={t(expired ? "timeline.history.expiredTitle" : "timeline.error.title")} description={t(expired ? "timeline.history.expired" : "timeline.error.body")} action={<Button variant="outline" onClick={() => { if (expired) refresh(); else if (observing) void observedQuery.refetch(); else history.retry(); }}>{t(expired ? "timeline.history.refresh" : "timeline.error.retry")}</Button>} /></div>
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
        open={selectedCard !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedCardId(null);
        }}
        card={selectedCard}
        analytics={analytics}
        analyticsScope={observing ? undefined : t("timeline.history.analyticsScope")}
        columnNames={columnNames}
      />
    </div>
  );
}
