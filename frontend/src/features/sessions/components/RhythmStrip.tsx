// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { GitFork } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { AgentSession, RhythmBucket, SessionRhythm } from "@/types/agent-session";
import { useSessionRhythm } from "../api/use-sessions";
import { usePromptsHidden } from "../hooks/use-hide-prompts";
import { useNow } from "../hooks/use-now";
import { formatClock, formatWallTime, sessionWallSeconds } from "../utils/format";
import { AgentMark, agentFamily } from "./AgentMark";
import { PromptText } from "./PromptText";
import { COMPACT_LIST_QUERY } from "./SessionsTable";

type TickKind = "prompt" | "error" | "work" | "file" | "tool";

// The server counts each entry once, in this order of precedence; a tick
// takes the colour of the most telling kind in its bucket.
const KIND_PRECEDENCE: TickKind[] = ["prompt", "error", "work", "file", "tool"];
const KIND_COLOR: Record<TickKind, string> = {
  prompt: "var(--color-kind-prompt)",
  error: "var(--color-kind-error)",
  work: "var(--color-kind-work)",
  file: "var(--color-kind-file)",
  tool: "var(--color-kind-tool)",
};
const LEGEND: TickKind[] = ["prompt", "tool", "file", "work", "error"];
const LANE_HUE: Record<ReturnType<typeof agentFamily>, string> = {
  claude: "var(--color-agent-claude)",
  codex: "var(--color-agent-codex)",
  pi: "var(--color-agent-pi)",
  other: "var(--color-agent-other)",
};
const DESKTOP_BUCKETS = 120;
const PHONE_BUCKETS = 60;
// A silence narrower than this share of the strip gets a line but no label.
const IDLE_LABEL_MIN_SHARE = 0.08;

function callsIn(bucket: RhythmBucket): number {
  return bucket.tool + bucket.file + bucket.work + bucket.error;
}

function tickKind(bucket: RhythmBucket): TickKind | null {
  return KIND_PRECEDENCE.find((kind) => bucket[kind] > 0) ?? null;
}

interface RhythmStripProps {
  slug: string;
  session: AgentSession;
}

export function RhythmStrip({ slug, session }: RhythmStripProps) {
  const { t } = useTranslation();
  const compact = useMediaQuery(COMPACT_LIST_QUERY);
  const rhythm = useSessionRhythm(slug, session.id, compact ? PHONE_BUCKETS : DESKTOP_BUCKETS, true);

  if (rhythm.isPending) return <Skeleton className="h-36 w-full" aria-hidden />;
  if (rhythm.isError) return <p className="text-sm text-muted-foreground">{t("sessions.rhythm.loadError")}</p>;
  return <RhythmView slug={slug} session={session} rhythm={rhythm.data} onJump={jumpToTurnAt} />;
}

// Focus the turn that was under way at `iso`, if it is on a loaded page.
function jumpToTurnAt(iso: string) {
  const target = Date.parse(iso);
  const turns = [...document.querySelectorAll<HTMLElement>("[data-turn][data-started]")];
  const turn = turns.filter((node) => Date.parse(node.dataset.started ?? "") <= target).at(-1) ?? turns[0];
  turn?.focus();
  turn?.scrollIntoView({ block: "start", behavior: "smooth" });
}

interface RhythmViewProps {
  slug: string;
  session: AgentSession;
  rhythm: SessionRhythm;
  onJump: (iso: string) => void;
}

export function RhythmView({ slug, session, rhythm, onJump }: RhythmViewProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const now = useNow();
  const compact = useMediaQuery(COMPACT_LIST_QUERY);
  const start = Date.parse(rhythm.start);
  const end = Date.parse(rhythm.end);
  const span = Math.max(end - start, 1);
  const position = (iso: string) => Math.min(Math.max((Date.parse(iso) - start) / span, 0), 1);
  const bucketShare = 1 / Math.max(rhythm.buckets.length, 1);
  const maxCalls = Math.max(1, ...rhythm.buckets.map(callsIn));

  const totals = useMemo(
    () =>
      rhythm.buckets.reduce(
        (sum, bucket) => ({ prompts: sum.prompts + bucket.prompt, calls: sum.calls + callsIn(bucket), failures: sum.failures + bucket.error }),
        { prompts: 0, calls: 0, failures: 0 },
      ),
    [rhythm.buckets],
  );
  const endLabel = rhythm.live ? t("sessions.rhythm.now") : formatClock(rhythm.end);
  const summary = t("sessions.rhythm.summary", {
    start: formatClock(rhythm.start),
    end: endLabel,
    counts: [
      t("sessions.rhythm.prompts", { count: totals.prompts }),
      t("sessions.rhythm.calls", { count: totals.calls }),
      ...(totals.failures ? [t("sessions.rhythm.failures", { count: totals.failures })] : []),
      ...(rhythm.children.length ? [t("sessions.rhythm.subagents", { count: rhythm.children.length })] : []),
    ].join(", "),
  });
  const axisTicks = compact ? 3 : 5;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] px-[var(--card-padding)] py-3.5 shadow-panel"
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
        <h2 id={headingId} className="text-base font-bold">
          {t("sessions.rhythm.title")}
        </h2>
        <p className="text-[0.8rem] text-muted-foreground">
          <b className="font-bold tabular-nums text-foreground">{formatWallTime(sessionWallSeconds(session, now))}</b>{" "}
          {t("sessions.rhythm.wallTime")}
          {rhythm.children.length ? <> · {t("sessions.rhythm.overlapNote")}</> : null}
        </p>
        {rhythm.capture_gaps ? (
          <p className="text-[0.8rem] font-medium text-[color:var(--color-warning-foreground)]">
            {t("sessions.rhythm.gaps", { count: rhythm.capture_gaps })}
          </p>
        ) : null}
        <ul aria-label={t("sessions.rhythm.legend.label")} className="flex flex-wrap gap-x-3.5 gap-y-1 text-[0.78rem] text-muted-foreground sm:ml-auto">
          {LEGEND.map((kind) => (
            <li key={kind} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-[1px]" style={{ backgroundColor: KIND_COLOR[kind] }} />
              {t(`sessions.rhythm.legend.${kind}`)}
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-y-1.5 relative sm:grid-cols-[11rem_minmax(0,1fr)]">
        <p className="hidden h-9 items-center gap-2 text-[0.8rem] font-semibold text-muted-foreground sm:flex">
          <AgentMark harness={session.harness} displayName={session.harness_display_name} size="sm" decorative />
          {t("sessions.rhythm.mainLane")}
        </p>
        <MainLane
          rhythm={rhythm}
          summary={summary}
          bucketShare={bucketShare}
          maxCalls={maxCalls}
          position={position}
          onJump={onJump}
        />

        {rhythm.children.map((lane) => (
          <ChildLane key={lane.session_id} slug={slug} lane={lane} position={position} />
        ))}

        {/* "Now" runs down every lane, so a running subagent reads as open. */}
        {rhythm.live ? (
          <span aria-hidden className="pointer-events-none absolute bottom-5 right-0 top-0 border-l-[1.5px] border-[color:var(--color-success)]" />
        ) : null}

        <div aria-hidden className="relative h-4 text-[0.72rem] tabular-nums text-muted-foreground sm:col-start-2">
          {Array.from({ length: axisTicks }, (_, index) => {
            const share = index / (axisTicks - 1);
            const label = rhythm.live && index === axisTicks - 1 ? t("sessions.rhythm.now") : formatClock(new Date(start + share * span).toISOString());
            return (
              <span
                key={index}
                className={cn("absolute", index === 0 ? "left-0" : index === axisTicks - 1 ? "right-0" : "-translate-x-1/2", rhythm.live && index === axisTicks - 1 && "font-bold text-[color:var(--color-success-foreground)]")}
                style={index > 0 && index < axisTicks - 1 ? { left: `${share * 100}%` } : undefined}
              >
                {label}
              </span>
            );
          })}
        </div>
      </div>

      <RhythmTable rhythm={rhythm} />
    </section>
  );
}

interface MainLaneProps {
  rhythm: SessionRhythm;
  summary: string;
  bucketShare: number;
  maxCalls: number;
  position: (iso: string) => number;
  onJump: (iso: string) => void;
}

function bucketEnd(rhythm: SessionRhythm, bucket: RhythmBucket): string {
  return new Date(Date.parse(bucket.t) + rhythm.bucket_seconds * 1000).toISOString();
}

function MainLane({ rhythm, summary, bucketShare, maxCalls, position, onJump }: MainLaneProps) {
  const { t } = useTranslation();
  const active = useMemo(
    () => rhythm.buckets.map((bucket, index) => ({ bucket, index })).filter(({ bucket }) => tickKind(bucket) !== null),
    [rhythm.buckets],
  );
  const [focusIndex, setFocusIndex] = useState(0);
  const [readout, setReadout] = useState<{ label: string; share: number } | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const readoutFor = (bucket: RhythmBucket) =>
    [
      `${formatClock(bucket.t)}–${formatClock(bucketEnd(rhythm, bucket))}`,
      ...(bucket.prompt ? [t("sessions.rhythm.prompts", { count: bucket.prompt })] : []),
      t("sessions.rhythm.calls", { count: callsIn(bucket) }),
      ...(bucket.error ? [t("sessions.rhythm.failures", { count: bucket.error })] : []),
    ].join(" · ");

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
    const step = steps[event.key];
    if (step === undefined || !active.length) return;
    event.preventDefault();
    const next = step === -Infinity ? 0 : step === Infinity ? active.length - 1 : Math.min(Math.max(focusIndex + step, 0), active.length - 1);
    setFocusIndex(next);
    buttons.current[next]?.focus();
  }

  return (
    <div className="relative">
      <div
        role="img"
        aria-label={summary}
        className="relative h-9 overflow-hidden rounded-[var(--radius-cap)] bg-[color:var(--color-surface-2)]"
      >
        {active.map(({ bucket, index }) => {
          const kind = tickKind(bucket) as TickKind;
          const height = kind === "prompt" ? 100 : 30 + 60 * (callsIn(bucket) / maxCalls);
          return (
            <span
              key={bucket.t}
              aria-hidden
              className="absolute bottom-1 rounded-[1px]"
              // Thin ticks centred in their bucket read as moments, not bars.
              style={{
                left: `calc(${(index + 0.5) * bucketShare * 100}% - ${kind === "prompt" ? 1.5 : 1}px)`,
                width: kind === "prompt" ? "3px" : "2px",
                height: kind === "prompt" ? "calc(100% - 0.5rem)" : `calc((100% - 0.5rem) * ${height / 100})`,
                backgroundColor: KIND_COLOR[kind],
              }}
            />
          );
        })}
        {rhythm.idle_spans.map((idle) => {
          const left = position(idle.start);
          const width = position(idle.end) - left;
          return (
            <span key={idle.start} aria-hidden className="absolute inset-y-0" style={{ left: `${left * 100}%`, width: `${width * 100}%` }}>
              <span className="absolute inset-x-0 top-1/2 border-t-[1.5px] border-dashed border-muted-foreground/55" />
              {width >= IDLE_LABEL_MIN_SHARE ? (
                <span className="absolute left-1/2 top-0.5 -translate-x-1/2 whitespace-nowrap bg-[color:var(--color-surface-2)] px-1 text-[0.7rem] font-semibold text-muted-foreground">
                  {t("sessions.rhythm.idle", { duration: formatWallTime((Date.parse(idle.end) - Date.parse(idle.start)) / 1000) })}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>

      {/* Hit areas over the ticks: one button per active bucket, roving focus. */}
      <div role="group" aria-label={t("sessions.rhythm.stripLabel")} onKeyDown={moveFocus} className="absolute inset-0">
        {active.map(({ bucket, index }, order) => {
          const label = readoutFor(bucket);
          return (
            <button
              key={bucket.t}
              ref={(node) => {
                buttons.current[order] = node;
              }}
              type="button"
              tabIndex={order === focusIndex ? 0 : -1}
              aria-label={label}
              onFocus={() => {
                setFocusIndex(order);
                setReadout({ label, share: (index + 0.5) * bucketShare });
              }}
              onBlur={() => setReadout(null)}
              onMouseEnter={() => setReadout({ label, share: (index + 0.5) * bucketShare })}
              onMouseLeave={() => setReadout(null)}
              onClick={() => onJump(bucketEnd(rhythm, bucket))}
              className="absolute inset-y-0 min-w-[6px] rounded-[var(--radius-cap)] hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ left: `${index * bucketShare * 100}%`, width: `${bucketShare * 100}%` }}
            />
          );
        })}
      </div>

      {/* Above the bucket it describes, kept inside the strip at the edges. */}
      <p
        aria-hidden
        data-testid="rhythm-readout"
        className={cn(
          "pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-cap)] border border-border bg-popover px-2 py-0.5 text-[0.75rem] font-semibold tabular-nums text-foreground shadow-soft transition-opacity duration-150",
          readout ? "opacity-100" : "opacity-0",
        )}
        style={{ left: `clamp(7rem, ${(readout?.share ?? 0.5) * 100}%, calc(100% - 7rem))` }}
      >
        {readout?.label}
      </p>
    </div>
  );
}

interface ChildLaneProps {
  slug: string;
  lane: SessionRhythm["children"][number];
  position: (iso: string) => number;
}

function ChildLane({ slug, lane, position }: ChildLaneProps) {
  const { t } = useTranslation();
  const promptsHidden = usePromptsHidden();
  const title = lane.title ?? t("sessions.timeline.subagent.untitled");
  const spokenTitle = promptsHidden && lane.title ? t("sessions.hidePrompts.hidden") : title;
  const left = position(lane.start);
  const width = Math.max(position(lane.end) - left, 0.006);
  const running = lane.display_state === "active";
  const hue = LANE_HUE[agentFamily(lane.harness)];

  return (
    <>
      <p className="hidden h-5 min-w-0 items-center gap-1.5 pl-3.5 text-[0.78rem] font-medium text-muted-foreground sm:flex">
        <GitFork aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{lane.title ? <PromptText text={title} /> : title}</span>
      </p>
      <div className="relative h-5">
        <Link
          to={`/${slug}/sessions/${lane.session_id}`}
          aria-label={t("sessions.timeline.subagent.openLabel", { title: spokenTitle })}
          className="absolute inset-y-0.5 rounded-[var(--radius-cap)] border transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{
            left: `${left * 100}%`,
            width: `${width * 100}%`,
            borderColor: `color-mix(in oklab, ${hue} 55%, transparent)`,
            background: running
              ? `linear-gradient(90deg, color-mix(in oklab, ${hue} 30%, var(--color-surface-2)) 70%, transparent)`
              : `color-mix(in oklab, ${hue} 30%, var(--color-surface-2))`,
            borderRightColor: running ? "transparent" : undefined,
          }}
        />
      </div>
    </>
  );
}

function RhythmTable({ rhythm }: { rhythm: SessionRhythm }) {
  const { t } = useTranslation();
  const rows = rhythm.buckets.filter((bucket) => tickKind(bucket) !== null);
  return (
    // A table keeps its full layout width even when sr-only; the wrapper clips it.
    <div className="sr-only">
    <table>
      <caption>{t("sessions.rhythm.tableCaption")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("sessions.rhythm.time")}</th>
          {LEGEND.map((kind) => (
            <th key={kind} scope="col">
              {t(`sessions.rhythm.legend.${kind}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((bucket) => (
          <tr key={bucket.t}>
            <th scope="row">{formatClock(bucket.t)}</th>
            {LEGEND.map((kind) => (
              <td key={kind}>{bucket[kind]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
