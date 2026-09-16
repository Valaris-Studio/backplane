// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Clapperboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/EmptyState";
import { useTimeline } from "../api/use-timeline";
import { usePlayback } from "../hooks/use-playback";
import { useSpotlight } from "../hooks/use-spotlight";
import { useViewMode } from "../hooks/use-view-mode";
import { buildActorAccents, eventActorKey } from "../utils/actor-colors";
import { reconstructState } from "../utils/replay-engine";
import { buildDisplayColumns } from "../utils/display-columns";
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
import type { ColumnSnapshot, TimelineEvent } from "../types";

interface Props {
  slug: string;
  boardId: string;
}

// Build a column_id -> name map from EVERY column snapshot in the log so
// captions and dwell labels resolve names even for columns absent from the
// current frame (e.g. deleted, or not yet created at this index).
function buildColumnNames(events: TimelineEvent[], baselineColumns: ColumnSnapshot[]): Record<string, string> {
  const names: Record<string, string> = Object.fromEntries(baselineColumns.map((column) => [column.id, column.name]));
  for (const event of events) {
    if (event.entity_type !== "column") continue;
    const snapshot = (event.after_state ?? event.before_state) as ColumnSnapshot | null;
    if (snapshot && typeof snapshot.id === "string" && typeof snapshot.name === "string") {
      names[snapshot.id] = snapshot.name;
    }
  }
  return names;
}

const EMPTY_EVENTS: TimelineEvent[] = [];

export function TimelineSimulator({ slug, boardId }: Props) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const { data, isLoading, isError, refetch } = useTimeline(slug, boardId);

  // Keep the loading skeleton in the board region so transport stays available.
  const events = data?.events ?? EMPTY_EVENTS;
  const generatedAt = data?.generated_at ?? "";
  // v1.1: the current-state baseline seeds the engine so legacy boards render
  // real titles/columns instead of synthetic Untitled cards (absent on old
  // backends → undefined → engine behaves as v1).
  const baseline = data?.baseline ?? undefined;
  const playback = usePlayback(events.length);
  const { viewMode, setViewMode } = useViewMode();
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  // Flags MARK matching events on the scrubber (search text + actor chips);
  // the replay fold and the board are never filtered by them.
  const [flagQuery, setFlagQuery] = useState<FlagQuery>(EMPTY_FLAG_QUERY);

  const columnNames = useMemo(() => buildColumnNames(events, baseline?.columns ?? []), [events, baseline]);
  const cardFacets = useMemo(() => buildCardFacets(events, baseline), [events, baseline]);
  const cardTitles = useMemo(() => Object.fromEntries(cardFacets.map((card) => [card.id, card.title])), [cardFacets]);
  // agent_id → role across the whole log, so the step panel can name the runner
  // role behind an agent-driven step even when that agent isn't a participant on
  // the current card's snapshot (it's a participant on some card in the log).
  const agentRoleIndex = useMemo(
    () => buildAgentRoleIndex(events, baseline),
    [events, baseline],
  );
  const actorFacets = useMemo(
    () => buildActorFacets(events, agentRoleIndex),
    [events, agentRoleIndex],
  );
  const actorAccents = useMemo(() => buildActorAccents(events.map(eventActorKey)), [events]);
  const eventFacets = useMemo(() => buildEventFacets(events), [events]);
  const flaggedIndices = useMemo(
    () => computeFlaggedIndices(events, flagQuery, cardTitles),
    [events, flagQuery, cardTitles],
  );
  const frame = useMemo(
    () => reconstructState(events, playback.frameIndex, baseline),
    [events, playback.frameIndex, baseline],
  );
  // Stable column lanes (every column the board ever had) + current-frame card
  // placement, so column chrome stays put while cards animate between lanes.
  // The baseline supplies lanes for legacy boards whose log has no column events.
  const displayColumns = useMemo(
    () => buildDisplayColumns(events, frame, baseline),
    [events, frame, baseline],
  );

  // The partial-history note reflects the WHOLE log, not just the current frame:
  // if ANY card/column event lacks a snapshot, history is reconstructed
  // best-effort and the note stays up regardless of where the scrubber sits.
  const hasLegacyEvent = useMemo(
    () =>
      events.some(
        (e) =>
          (e.entity_type === "card" || e.entity_type === "column") &&
          e.action !== "deleted" &&
          e.after_state === null,
      ),
    [events],
  );

  const currentEvent = events[playback.frameIndex] ?? null;
  // Board-time anchors for the StepPanel chips: the log's first event dates
  // "Day N"; the previous event exposes the real gap the uniform playback
  // cadence hides. Derived here so StepPanel stays pure.
  const firstEventAt = events[0]?.created_at;
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
  const { toggle, stepBack, stepForward } = playback;
  const detailOpen = selectedCardId !== null;
  useEffect(() => {
    if (events.length === 0 || detailOpen) return;
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
        toggle();
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
  }, [events.length, detailOpen, toggle, stepBack, stepForward]);

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
      selectedCardId && generatedAt
        ? computeCardAnalytics(events.slice(0, playback.frameIndex + 1), selectedCardId, currentEvent?.created_at ?? generatedAt)
        : null,
    [events, selectedCardId, generatedAt, playback.frameIndex, currentEvent],
  );

  const seekToEvent = (index: number) => {
    if (playback.playing) playback.toggle();
    playback.seek(index);
  };

  if (isError) {
    return (
      <div data-testid="timeline-error">
        <EmptyState
          icon={AlertTriangle}
          title={t("timeline.error.title")}
          description={t("timeline.error.body")}
          action={
            <Button variant="outline" onClick={() => void refetch()}>
              {t("timeline.error.retry")}
            </Button>
          }
        />
      </div>
    );
  }

  // Loaded but truly empty — no history to replay AND no current cards to show.
  // A legacy board with cards but only null-snapshot events (or no events at
  // all) still has a baseline to render, so it must NOT fall into the empty
  // state; only a board with neither events nor baseline cards is truly empty.
  const baselineCardCount = baseline?.cards.length ?? 0;
  if (!isLoading && events.length === 0 && baselineCardCount === 0) {
    return (
      <div data-testid="timeline-empty">
        <EmptyState
          icon={Clapperboard}
          title={t("timeline.empty.title")}
          description={t("timeline.empty.body")}
        />
      </div>
    );
  }

  const transportControls = (
    <TransportControls
      playing={playback.playing}
      speed={playback.speed}
      atStart={playback.atStart}
      atEnd={playback.atEnd}
      currentTimestamp={null}
      caption=""
      onToggle={playback.toggle}
      onStepBack={playback.stepBack}
      onStepForward={playback.stepForward}
      onSpeedCycle={playback.cycleSpeed}
    />
  );
  const viewToggle = <ViewToggle viewMode={viewMode} onChange={setViewMode} />;

  return (
    <div className="flex h-full flex-col gap-2">
      <div data-testid="timeline-controls" className="shrink-0 space-y-2">
        {data?.truncated ? (
          <div
            data-testid="timeline-truncated-note"
            className="rounded-[calc(var(--radius-md))] border-l-2 border-l-[color:var(--color-warning)] bg-warning/10 px-3 py-2 text-xs text-[color:var(--color-warning-foreground)]"
          >
            {t("timeline.partial.truncated", { count: events.length })}
          </div>
        ) : null}
        {hasLegacyEvent || frame.partial ? (
          <div
            data-testid="timeline-partial-note"
            className="rounded-[calc(var(--radius-md))] border-l-2 border-l-[color:var(--color-warning)] bg-warning/10 px-3 py-2 text-xs text-[color:var(--color-warning-foreground)]"
          >
            {t("timeline.partial.note")}
          </div>
        ) : null}

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

      <div className="relative min-h-[24rem] flex-1">
        {isLoading ? (
          <div data-testid="timeline-loading" className="space-y-4">
            <Skeleton className="h-[28rem] rounded-[calc(var(--radius-xl))]" />
          </div>
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
        columnNames={columnNames}
      />
    </div>
  );
}
