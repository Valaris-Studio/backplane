// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { createDateTimeFormatter } from "@/lib/format";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { buildActorAccents, eventActorKey } from "../utils/actor-colors";
import { StickyNote, Layers } from "lucide-react";
import { deriveCaption } from "../utils/caption";
import { CARD_KIND_ACCENTS, describeEvent } from "../utils/event-descriptor";
import type { TimelineEvent } from "../types";

interface Props {
  frameIndex: number;
  frameCount: number;
  events: TimelineEvent[];
  columnNames: Record<string, string>;
  onSeek: (index: number) => void;
  // Flagged event indices (ASC) — painted as clickable jump dots above the
  // track. Flags only MARK events; the log underneath is never filtered.
  flags?: number[];
  actorAccents?: Record<string, string>;
}

// Cap visible ticks so dense logs don't paint thousands of overlapping marks.
const MAX_TICKS = 120;
// Same cap for flag dots — a query matching most of the log would otherwise
// bury the track. Navigation (prev/next) still walks EVERY flag.
const MAX_FLAG_DOTS = 120;
// Cap day-boundary hairlines the same way — multi-month logs would otherwise
// turn the track to mud.
const MAX_DAY_MARKERS = 30;
// The tick/fill layers are inset-x-1 (4px each side) inside the track; the
// hover math must subtract this so pointer x maps to the same coordinate
// space the ticks are painted in.
const TRACK_INSET_PX = 4;

// The four card-step accents the legend teaches — derived from the SAME source
// describeEvent assigns per kind (the tokens the ticks and StepPanel paint),
// so the legend can never desynchronize from the story colors.
const LEGEND_KINDS = Object.entries(CARD_KIND_ACCENTS).map(([kind, token]) => ({
  kind,
  token,
}));

// Local calendar day (viewer TZ) — matches the StepPanel timestamp.
function localDayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function TimelineScrubber({
  frameIndex,
  frameCount,
  events,
  columnNames,
  onSeek,
  flags,
  actorAccents: providedActorAccents,
}: Props) {
  const { t, i18n } = useTranslation();
  const reducedMotion = useReducedMotion();
  const last = Math.max(0, frameCount - 1);
  const actorAccents = useMemo(
    () => providedActorAccents ?? buildActorAccents(events.map(eventActorKey)),
    [providedActorAccents, events],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(640);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setTrackWidth(width - TRACK_INSET_PX * 2);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Video-player-style hover preview: nearest event index + its track position.
  const [hoverTarget, setHover] = useState<{ index: number; pct: number; contextPosition?: number } | null>(
    null,
  );
  const contextGroups = useMemo(() => {
    const groups: { indices: number[]; position: number }[] = [];
    const minIndexGap = Math.max(1, (28 / Math.max(28, trackWidth)) * last);
    events.forEach((event, index) => {
      if (event.entity_type === "card") return;
      const previous = groups[groups.length - 1];
      if (previous && index - previous.position < minIndexGap) previous.indices.push(index);
      else groups.push({ indices: [index], position: index });
    });
    return groups;
  }, [events, last, trackWidth]);
  const hover = useMemo(() => {
    if (hoverTarget?.contextPosition === undefined) return hoverTarget;
    const group = contextGroups.find(({ position }) => position === hoverTarget.contextPosition);
    if (!group) return null;
    const index = group.indices.find((candidate) => candidate > frameIndex) ?? group.indices[0]!;
    return { index, pct: last > 0 ? (index / last) * 100 : 0 };
  }, [hoverTarget, contextGroups, frameIndex, last]);
  const hoverBubbleRef = useRef<HTMLDivElement>(null);

  const stride = frameCount > MAX_TICKS ? Math.ceil(frameCount / MAX_TICKS) : 1;
  const ticks = events
    .map((event, index) => ({ event, index }))
    .filter(({ index }) => index % stride === 0);

  // One descriptor pass over the log: per-tick accent = the same token the
  // StepPanel shows for that step, so the scrubber reads as a story arc.
  const tickAccents = useMemo(
    () => events.map((event) => `var(${describeEvent(event).accentToken})`),
    [events],
  );

  // Endpoint date labels — only meaningful when there's a range to read.
  const dateLabels = useMemo(() => {
    const first = events[0];
    const final = events[events.length - 1];
    if (events.length < 2 || !first || !final) return null;
    const start = new Date(first.created_at);
    const end = new Date(final.created_at);
    const formatter = createDateTimeFormatter(
      {
        month: "short",
        day: "numeric",
        // Year only when the range crosses years — keeps labels short otherwise.
        ...(start.getFullYear() !== end.getFullYear()
          ? { year: "numeric" }
          : {}),
      },
      i18n.resolvedLanguage,
    );
    return { start: formatter.format(start), end: formatter.format(end) };
  }, [events, i18n.resolvedLanguage]);

  // Indices where created_at crosses a local calendar day, stride-thinned past
  // the cap exactly like MAX_TICKS.
  const dayBoundaryIndices = useMemo(() => {
    const boundaries: number[] = [];
    let previousDay: string | null = null;
    events.forEach((event, index) => {
      const day = localDayKey(event.created_at);
      if (previousDay !== null && day !== previousDay) boundaries.push(index);
      previousDay = day;
    });
    if (boundaries.length <= MAX_DAY_MARKERS) return boundaries;
    const boundaryStride = Math.ceil(boundaries.length / MAX_DAY_MARKERS);
    return boundaries.filter((_, i) => i % boundaryStride === 0);
  }, [events]);

  // Hovered-event timestamp, local date + time (viewer TZ, viewer language).
  const hoverTimeFormatter = useMemo(
    () =>
      createDateTimeFormatter(
        {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        },
        i18n.resolvedLanguage,
      ),
    [i18n.resolvedLanguage],
  );

  const handlePointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    // Touch has no hover state — a finger would just hide the bubble it spawns.
    if (e.pointerType === "touch" || events.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const trackWidth = rect.width - TRACK_INSET_PX * 2;
    if (trackWidth <= 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (e.clientX - rect.left - TRACK_INSET_PX) / trackWidth),
    );
    const index = Math.round(ratio * last);
    // Same index → same object, so mousemove storms don't re-render.
    setHover((prev) =>
      prev?.index === index && prev.contextPosition === undefined
        ? prev
        : { index, pct: last > 0 ? (index / last) * 100 : 0 },
    );
  };

  // Clamp the bubble to the track edges. Done imperatively post-layout (left:%
  // + -translate-x-1/2 first, then a px override) because the clamp needs the
  // bubble's rendered width.
  useLayoutEffect(() => {
    const bubble = hoverBubbleRef.current;
    const layer = bubble?.parentElement;
    if (!bubble || !layer || !hover) return;
    const half = bubble.offsetWidth / 2;
    const layerWidth = layer.clientWidth;
    if (half === 0 || layerWidth === 0) return;
    const desired = (hover.pct / 100) * layerWidth;
    const clamped = Math.min(
      Math.max(desired, half),
      Math.max(half, layerWidth - half),
    );
    bubble.style.left = `${clamped}px`;
  }, [hover]);

  const previewAt = (index: number, contextPosition?: number) => setHover({ index, pct: last > 0 ? (index / last) * 100 : 0, contextPosition });
  const hoverEvent = hover ? events[hover.index] : undefined;

  const current = Math.min(frameIndex, last);
  const playheadPct = last > 0 ? (current / last) * 100 : 0;

  const flagsActive = (flags?.length ?? 0) > 0;
  const flagStride =
    flags && flags.length > MAX_FLAG_DOTS
      ? Math.ceil(flags.length / MAX_FLAG_DOTS)
      : 1;
  const flagDots = flags?.filter((_, i) => i % flagStride === 0) ?? [];

  return (
    <div ref={containerRef} className="space-y-1.5">
      <div className="relative h-6">
        {/* The "filled" portion of the track up to the playhead — reads as a
            video progress bar (how much of the story has played). */}
        <div className="pointer-events-none absolute inset-x-1 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted">
          <div
            data-testid="scrubber-progress-fill"
            className="h-full rounded-full bg-primary/40 transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${playheadPct}%` }}
          />
        </div>
        {/* Day-boundary hairlines — slightly taller than the event ticks and
            rendered first so they sit BEHIND them. */}
        <div className="pointer-events-none absolute inset-x-1 top-1/2 h-5 -translate-y-1/2">
          {dayBoundaryIndices.map((index) => (
            <span
              key={`day-${index}`}
              data-testid="scrubber-day-boundary"
              className="absolute top-0 h-full w-px -translate-x-1/2 bg-[color:var(--color-muted-foreground)] opacity-30"
              style={{ left: last > 0 ? `${(index / last) * 100}%` : "0%" }}
            />
          ))}
        </div>
        {/* Event tick marks behind the range track. */}
        <div className="pointer-events-none absolute inset-x-1 top-1/2 h-4 -translate-y-1/2">
          {ticks.map(({ event, index }) => {
            const isCurrent = index === current;
            return (
              <span
                key={event.id}
                data-testid="scrubber-event-tick"
                className={cn(
                  "absolute top-0 h-full w-0.5 -translate-x-1/2 rounded-full transition-transform duration-200 motion-reduce:transition-none",
                  // The active frame's tick is brighter + grows in place (scale,
                  // not a width swap) so the playhead visibly travels even when
                  // stride-thinning hides its neighbours.
                  // Flags active → fade the story arc back so the dots pop.
                  isCurrent
                    ? "scale-x-150 scale-y-125 opacity-100"
                    : flagsActive
                      ? "opacity-25"
                      : "opacity-60",
                )}
                style={{
                  left: last > 0 ? `${(index / last) * 100}%` : "0%",
                  backgroundColor: isCurrent
                    ? "var(--color-primary)"
                    : (tickAccents[index] ?? "var(--color-muted-foreground)"),
                }}
              />
            );
          })}
        </div>
        {/* Flag jump dots — ABOVE the range input (z-2) so they stay
            clickable; each dot seeks straight to its event and feeds the same
            hover bubble the track uses. */}
        {flagDots.length > 0 && (
          <div className="pointer-events-none absolute inset-x-1 -top-0.5 z-[2] h-2.5">
            {flagDots.map((index) => (
              <motion.button
                key={index}
                type="button"
                data-testid="scrubber-flag-dot"
                aria-label={t("timeline.flags.goTo", {
                  caption: events[index]
                    ? deriveCaption(events[index], t as TFunction, columnNames)
                    : String(index + 1),
                })}
                onClick={() => onSeek(index)}
                onPointerEnter={() =>
                  setHover({
                    index,
                    pct: last > 0 ? (index / last) * 100 : 0,
                  })
                }
                onPointerLeave={() => setHover(null)}
                className="pointer-events-auto absolute top-0 size-2 -translate-x-1/2 cursor-pointer rounded-full bg-primary shadow-[0_0_0_2px_var(--color-background)] transition-transform duration-150 hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none"
                onFocus={() => previewAt(index)}
                onBlur={() => setHover(null)}
                style={{
                  left: last > 0 ? `${(index / last) * 100}%` : "0%",
                  backgroundColor: events[index] ? actorAccents[eventActorKey(events[index])] : undefined,
                }}
                {...(reducedMotion
                  ? {}
                  : {
                      initial: { scale: 0.9, opacity: 0 },
                      animate: { scale: 1, opacity: 1 },
                      transition: { duration: 0.18, ease: "easeOut" as const },
                    })}
              />
            ))}
          </div>
        )}
        <input
          type="range"
          min={0}
          max={last}
          disabled={frameCount === 0}
          aria-valuetext={events[current] ? `${current + 1} / ${frameCount}: ${deriveCaption(events[current], t as TFunction, columnNames)}` : undefined}
          step={1}
          value={current}
          onChange={(e) => onSeek(Number(e.target.value))}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHover(null)}
          aria-label={t("timeline.scrubber.label")}
          className="relative z-[1] h-6 w-full cursor-pointer appearance-none bg-transparent accent-[color:var(--color-primary)]"
        />
        {/* Hover preview bubble — the ticks' coordinate space (inset-x-1),
            floated above the track, never trapping the cursor. */}
        {hoverEvent && hover && (
          <div className="pointer-events-none absolute inset-x-1 bottom-full z-10 mb-1.5">
            <motion.div
              ref={hoverBubbleRef}
              data-testid="scrubber-hover-preview"
              className="absolute bottom-0 flex max-w-full -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
              style={{ left: `${hover.pct}%` }}
              // Reduced motion: render in place, content identical, no entrance.
              {...(reducedMotion
                ? {}
                : {
                    initial: { opacity: 0, y: 4, scale: 0.97 },
                    animate: { opacity: 1, y: 0, scale: 1 },
                    transition: { duration: 0.12, ease: "easeOut" as const },
                  })}
            >
              <span
                aria-hidden
                data-testid="scrubber-hover-dot"
                className="size-1.5 shrink-0 rounded-full"
                style={{
                  backgroundColor:
                    tickAccents[hover.index] ?? "var(--color-muted-foreground)",
                }}
              />
              <span className="max-w-[60ch] truncate">
                {deriveCaption(hoverEvent, t as TFunction, columnNames)}
              </span>
              <span
                data-testid="scrubber-hover-time"
                className="shrink-0 tabular-nums text-muted-foreground"
              >
                {hoverTimeFormatter.format(new Date(hoverEvent.created_at))}
              </span>
            </motion.div>
          </div>
        )}
      </div>
      {contextGroups.length > 0 && (
        <div className="relative h-5" role="group" aria-label={t("timeline.scrubber.contextLane")}>
          <div aria-hidden className="absolute inset-x-1 top-1/2 h-px bg-border/70" />
          <div className="absolute inset-x-1 inset-y-0">
            {contextGroups.map(({ indices, position }) => {
              const index = indices.find((candidate) => candidate > current) ?? indices[0]!;
              const event = events[index]!;
              const grouped = indices.length > 1;
              const Icon = event.entity_type === "note" ? StickyNote : Layers;
              const caption = deriveCaption(event, t as TFunction, columnNames);
              const label = grouped
                ? t("timeline.scrubber.contextGroup", { count: indices.length, caption })
                : t("timeline.flags.goTo", { caption });
              return (
                <button key={position} type="button" data-testid="scrubber-context-event"
                  aria-label={label}
                  title={label}
                  aria-current={indices.includes(current) ? "step" : undefined}
                  onClick={() => onSeek(index)}
                  onPointerEnter={() => previewAt(index, position)} onPointerLeave={() => setHover(null)}
                  onFocus={() => previewAt(index, position)} onBlur={() => setHover(null)}
                  className={cn("absolute top-0 flex size-6 -translate-x-1/2 items-center justify-center rounded bg-background transition-colors hover:bg-muted focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", indices.includes(current) && "ring-1 ring-current")}
                  style={{ left: last > 0 ? `${(position / last) * 100}%` : "0%", color: tickAccents[index] }}>
                  <Icon aria-hidden className="size-3" />
                  {grouped && <span aria-hidden className="absolute -right-1 -top-1 rounded bg-background px-0.5 text-[8px] font-medium tabular-nums">{indices.length}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {dateLabels && (
        <div className="flex justify-between text-[0.65rem] tabular-nums text-muted-foreground/80">
          <span data-testid="scrubber-start-date">{dateLabels.start}</span>
          <span data-testid="scrubber-end-date">{dateLabels.end}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="hidden text-[0.7rem] text-muted-foreground/70 sm:block">
          {t("timeline.scrubber.keyboardHint")}
        </p>
        <div
          data-testid="scrubber-legend"
          className="hidden flex-wrap items-center gap-x-2 gap-y-1 text-[0.65rem] text-muted-foreground/70 md:flex"
        >
          <span>{t("timeline.scrubber.legend")}</span>
          {LEGEND_KINDS.map(({ kind, token }) => (
            <span key={kind} className="flex items-center gap-1">
              <span
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ backgroundColor: `var(${token})` }}
              />
              {t(`timeline.step.kind.${kind}`)}
            </span>
          ))}
          {contextGroups.length > 0 && (
            <span className="flex items-center gap-1"><StickyNote aria-hidden className="size-3 text-[color:var(--color-data-5)]" />{t("timeline.scrubber.contextLane")}</span>
          )}
        </div>
        <p className="ml-auto text-xs tabular-nums text-muted-foreground">
          {t("timeline.scrubber.eventOf", {
            index: frameCount > 0 ? current + 1 : 0,
            total: frameCount,
          })}
        </p>
      </div>
    </div>
  );
}
