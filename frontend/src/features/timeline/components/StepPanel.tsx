// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  ChevronDown,
  Columns3,
  FilePenLine,
  FilePlus2,
  FileX2,
  LayoutGrid,
  Link2,
  ListPlus,
  MoveRight,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { resolveActivityMessage } from "@/features/activity/utils/resolve-activity-message";
import { deriveCaption } from "../utils/caption";
import { formatDuration } from "../utils/format-duration";
import { humanizeRole, initials } from "../utils/humanize";
import type { StepDescriptor } from "../utils/event-descriptor";
import { resolveStepRole, type AgentRoleIndex } from "../utils/step-role";
import type { CardSnapshot, TimelineEvent } from "../types";

// The fixed overview keeps replay geometry steady; full event evidence is an
// explicit disclosure whose state belongs to the viewer, not the playhead.

// describeEvent emits lucide icon NAMES (strings); map them to components here.
// Role-agnostic: an unknown name falls back to the neutral Activity icon.
const ICONS: Record<string, LucideIcon> = {
  Plus,
  MoveRight,
  Pencil,
  Trash2,
  Link2,
  StickyNote,
  LayoutGrid,
  Columns3,
  Activity,
  FilePlus2,
  FilePenLine,
  FileX2,
  ListPlus,
};

function humanizeField(field: string): string {
  return field.replace(/[_-]+/g, " ").trim();
}

const DAY_MS = 86_400_000;
// Playback compresses real time uniformly, so a gap shorter than this reads as
// normal rhythm; only a jump of ≥1h earns the "+{{duration}} later" chip.
const GAP_CHIP_MIN_MS = 3_600_000;

function cardTitle(
  event: TimelineEvent,
  cardTitles: Record<string, string>,
  id: string | null,
): string {
  if (!id) return "";
  if (cardTitles[id]) return cardTitles[id];
  // Fall back to the event's own snapshot title for the anchored card.
  const snapshot = (event.after_state ?? event.before_state) as
    | Partial<CardSnapshot>
    | null;
  if (id === event.entity_id && snapshot && typeof snapshot.title === "string") {
    return snapshot.title;
  }
  return id;
}

interface Props {
  event: TimelineEvent;
  descriptor: StepDescriptor;
  columnNames: Record<string, string>;
  // card_id → title, resolved across the whole log for relational (dependency)
  // events; the panel falls back to the raw id when a title is unknown.
  cardTitles?: Record<string, string>;
  // board-wide agent_id → role index, so an agent-driven step shows its role even
  // when the acting agent isn't a participant on THIS card's current snapshot.
  agentRoleIndex?: AgentRoleIndex;
  // created_at of the log's FIRST event — anchors the "Day N" position-in-story
  // chip. Absent (legacy caller) → no chip.
  firstEventAt?: string;
  // created_at of the PREVIOUS event — drives the time-jump "+6d later" chip.
  // null/absent for the first frame.
  prevEventAt?: string | null;
  // Test/caller override; when absent the system preference applies, so a
  // caller that forgets the prop can never animate for reduced-motion users.
  reducedMotion?: boolean;
  onInspect?: () => void;
}

export function StepPanel({
  event,
  descriptor,
  columnNames,
  cardTitles = {},
  agentRoleIndex,
  firstEventAt,
  prevEventAt,
  reducedMotion: reducedMotionOverride,
  onInspect,
}: Props) {
  const { t } = useTranslation();
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const systemReducedMotion = useReducedMotion();
  const reducedMotion = reducedMotionOverride ?? systemReducedMotion;
  const Icon = ICONS[descriptor.iconName] ?? Activity;

  // The kind always resolves to a known i18n key; the humanized raw action is a
  // safety-net defaultValue for an unknown card action surfaced as card-update.
  const kindLabel = t(descriptor.kind === "note" && descriptor.detail.noteAction
    ? `timeline.step.note.${descriptor.detail.noteAction}`
    : `timeline.step.kind.${descriptor.kind}`, {
    defaultValue: humanizeField(event.action),
  });

  const snapshot = (event.after_state ?? event.before_state) as
    | Partial<CardSnapshot>
    | null;
  const noteTitle = event.entity_type === "note" && typeof event.message_params?.note_title === "string"
    ? event.message_params.note_title
    : "";
  const entityTitle =
    snapshot && typeof snapshot.title === "string" && snapshot.title
      ? snapshot.title
      : noteTitle || event.entity_title || "";

  const timestamp = formatDateTime(event.created_at);
  const displaySummary = resolveActivityMessage(event, t);
  const caption = deriveCaption(event, t, columnNames);

  // Board-time context: position-in-story day number + the real-time gap the
  // uniform playback cadence hides. Both derive from raw ISO timestamps the
  // caller supplies, keeping this component pure.
  const eventAtMs = new Date(event.created_at).getTime();
  const dayNumber = firstEventAt
    ? Math.floor((eventAtMs - new Date(firstEventAt).getTime()) / DAY_MS) + 1
    : null;
  const gapMs = prevEventAt ? eventAtMs - new Date(prevEventAt).getTime() : 0;
  const showGapChip = gapMs >= GAP_CHIP_MIN_MS;

  const accent = `var(${descriptor.accentToken})`;
  const actorName = event.actor_name?.trim() || event.actor_email || event.actor_id;
  const attribution = [
    actorName,
    event.via_api_key ? t("activity.viaApiKey", { apiKey: event.via_api_key }) : "",
  ].filter(Boolean).join(" · ");

  // The runner role behind this step, ONLY when an agent acted on a card and
  // matches a participant on it. Role string is verbatim (any user-defined
  // config), humanized for display — never enumerated.
  const stepRole = resolveStepRole(event, agentRoleIndex);

  // Cross-fade scaffolding: the icon chip pops on each new step; the gap chip
  // slides in exactly when board time jumped. Both render as plain spans under
  // reduced motion (static, never broken) — mirroring ReplayCard's MotionDiv.
  const MotionIconChip = reducedMotion ? "span" : motion.span;
  const iconChipMotion = reducedMotion
    ? {}
    : {
        initial: { scale: 0.7 },
        animate: { scale: 1 },
        transition: { type: "spring" as const, stiffness: 500, damping: 30 },
      };
  const MotionGapChip = reducedMotion ? "span" : motion.span;
  const gapChipMotion = reducedMotion
    ? {}
    : {
        initial: { opacity: 0, x: -4 },
        animate: { opacity: 1, x: 0 },
        transition: { duration: 0.2, ease: "easeOut" as const },
      };

  const content = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <MotionIconChip
          {...iconChipMotion}
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
          style={{ background: `color-mix(in oklab, ${accent} 18%, transparent)`, color: accent }}
        >
          <Icon className="h-3 w-3" />
        </MotionIconChip>
        <p className="flex min-w-0 flex-1 items-baseline gap-x-1 text-sm leading-5">
          {attribution ? (
            <>
              <span data-testid="step-actor" className="max-w-[40%] min-w-[5ch] shrink-0 truncate font-medium text-foreground" title={attribution}>
                {attribution}
              </span>
              <span aria-hidden className="shrink-0 text-muted-foreground">·</span>
            </>
          ) : null}
          <span className="shrink-0 font-semibold text-foreground">{kindLabel}</span>
          {entityTitle ? (
            <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={entityTitle}>{entityTitle}</span>
          ) : null}
        </p>
      </div>

      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <div className="min-w-0 flex-1">
          <StepDetail descriptor={descriptor} event={event} columnNames={columnNames} cardTitles={cardTitles} accent={accent} displaySummary={displaySummary} />
        </div>
        {stepRole ? (
          <span
            data-testid="step-role"
            title={stepRole.name ? `${stepRole.name} · ${humanizeRole(stepRole.role, t)}` : humanizeRole(stepRole.role, t)}
            className="flex max-w-[35%] min-w-0 shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[0.65rem] font-medium text-foreground"
            style={{ background: `color-mix(in oklab, ${accent} 16%, transparent)` }}
          >
            {stepRole.name ? (
              <Avatar className="h-3.5 w-3.5 shrink-0">
                {stepRole.avatarUrl ? <AvatarImage src={stepRole.avatarUrl} alt={stepRole.name} /> : null}
                <AvatarFallback className="text-[0.45rem]">{initials(stepRole.name)}</AvatarFallback>
              </Avatar>
            ) : null}
            <span className="truncate">{humanizeRole(stepRole.role, t)}</span>
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden pr-18">
        <time dateTime={event.created_at} title={timestamp} className="min-w-0 truncate text-[0.7rem] leading-4 tabular-nums text-muted-foreground">
          {timestamp}
        </time>
        {dayNumber !== null ? (
          <span data-testid="step-day-chip" className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[0.65rem] leading-4 font-medium tabular-nums text-muted-foreground">
            {t("timeline.step.dayChip", { n: dayNumber })}
          </span>
        ) : null}
        {showGapChip ? (
          <MotionGapChip
            {...gapChipMotion}
            data-testid="step-gap-chip"
            className="shrink-0 rounded-full px-1.5 py-px text-[0.65rem] leading-4 font-medium tabular-nums text-foreground"
            style={{ background: `color-mix(in oklab, ${accent} 16%, transparent)` }}
          >
            {t("timeline.step.gapLater", { duration: formatDuration(gapMs, t as TFunction) })}
          </MotionGapChip>
        ) : null}
      </div>
    </>
  );

  const frameClass = "flex h-full min-w-0 flex-col justify-between";

  return (
    <div data-testid="step-panel" className="overflow-hidden rounded-[calc(var(--radius-lg))] border border-border/70 bg-[color:var(--color-surface-1)]">
      <div data-testid="step-panel-overview" className="relative h-[4.5rem] overflow-hidden px-3 py-1">
        {reducedMotion ? (
          <div key={event.id} data-testid="step-panel-frame" className={frameClass}>{content}</div>
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={event.id}
              data-testid="step-panel-frame"
              className={frameClass}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        )}
        <button
          type="button"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => {
            if (!detailsOpen) onInspect?.();
            setDetailsOpen(!detailsOpen);
          }}
          className="absolute right-2 bottom-1 flex h-5 items-center gap-1 rounded px-1.5 text-[0.7rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("timeline.step.details")}
          <ChevronDown aria-hidden className={cn("h-3 w-3 transition-transform motion-reduce:transition-none", detailsOpen && "rotate-180")} />
        </button>
      </div>
      {detailsOpen ? (
        <section id={detailsId} role="region" aria-label={t("timeline.step.eventDetails")} className="space-y-2 border-t border-border/70 px-3 py-3 text-sm [overflow-wrap:anywhere]">
          <p className="font-medium text-foreground">{attribution}</p>
          {entityTitle ? <h3 className="font-semibold text-foreground">{entityTitle}</h3> : null}
          <p className="whitespace-pre-wrap text-muted-foreground">{caption}</p>
          <StepDetail descriptor={descriptor} event={event} columnNames={columnNames} cardTitles={cardTitles} accent={accent} displaySummary="" expanded />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <time dateTime={event.created_at}>{timestamp}</time>
            {stepRole ? <span>{t("timeline.step.role")}: <span className="text-foreground">{stepRole.role}</span></span> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

interface DetailProps {
  descriptor: StepDescriptor;
  event: TimelineEvent;
  columnNames: Record<string, string>;
  cardTitles: Record<string, string>;
  accent: string;
  displaySummary: string;
  expanded?: boolean;
}

function StepDetail({
  descriptor,
  event,
  columnNames,
  cardTitles,
  accent,
  displaySummary,
  expanded = false,
}: DetailProps) {
  const { t } = useTranslation();
  const detailClass = cn("text-xs leading-4 text-muted-foreground", expanded ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "truncate");

  if (descriptor.kind === "card-move") {
    const { fromColumnId, toColumnId } = descriptor.detail;
    if (!fromColumnId && !toColumnId) return null;
    const from = fromColumnId ? (columnNames[fromColumnId] ?? fromColumnId) : "";
    const to = toColumnId ? (columnNames[toColumnId] ?? toColumnId) : "";
    const text = t("timeline.step.moveEdge", { from, to, defaultValue: "{{from}} → {{to}}" });
    return (
      <p className={detailClass} title={text}>
        {text}
      </p>
    );
  }

  if (descriptor.kind === "dependency") {
    const from = cardTitle(event, cardTitles, descriptor.targetCardId);
    const to = descriptor.detail.toCardIds
      ? descriptor.detail.toCardIds.map((id) => cardTitle(event, cardTitles, id)).join(", ")
      : cardTitle(event, cardTitles, descriptor.relatedCardId);
    if (!from || !to) return null;
    const text = t("timeline.step.dependencyEdge", {
      from,
      to,
      defaultValue: "{{from}} ↔ {{to}}",
    });
    return (
      <p className={detailClass} title={text}>
        {text}
      </p>
    );
  }

  if (descriptor.kind === "note") {
    const { sectionHeading, changedFields: fields = [] } = descriptor.detail;
    const card = descriptor.targetCardId
      ? cardTitle(event, cardTitles, descriptor.targetCardId)
      : "";
    const parts = [
      sectionHeading ? t("timeline.step.noteSection", { heading: sectionHeading }) : "",
      card ? t("timeline.step.noteCard", { card }) : "",
    ].filter(Boolean);
    if (parts.length > 0) {
      const text = parts.join(" · ");
      return (
        <div className={expanded ? "space-y-2" : undefined}>
          <p className={detailClass} title={text}>{text}</p>
          {expanded && fields.length > 0 ? <ChangedFields fields={fields} accent={accent} expanded /> : null}
        </div>
      );
    }
    if (fields.length > 0) return <ChangedFields fields={fields} accent={accent} expanded={expanded} />;
  }

  if (descriptor.kind === "card-update") {
    const fields = descriptor.detail.changedFields ?? [];
    if (fields.length === 0) return null;
    return <ChangedFields fields={fields} accent={accent} event={event} expanded={expanded} />;
  }

  if (displaySummary.trim().length > 0) {
    return (
      <p className={detailClass} title={displaySummary}>
        {displaySummary}
      </p>
    );
  }

  return null;
}

const PREVIEW_FIELDS = new Set(["priority", "status", "title", "labels"]);

function fieldDelta(event: TimelineEvent | undefined, field: string, t: TFunction): string | null {
  if (!event || !PREVIEW_FIELDS.has(field)) return null;
  const change = event.changes?.[field];
  const pair = change && typeof change === "object" && "old" in change && "new" in change
    ? change as { old: unknown; new: unknown }
    : {
        old: (event.before_state as Record<string, unknown> | null)?.[field],
        new: (event.after_state as Record<string, unknown> | null)?.[field],
      };
  const formatValue = (value: unknown): string | null => {
    if (value === null || value === "") return "—";
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value.join(", ") || "—";
    }
    if (typeof value !== "string") return null;
    return field === "priority"
      ? t(`cards.priorities.${value}`, { defaultValue: value })
      : value;
  };
  const before = formatValue(pair.old);
  const after = formatValue(pair.new);
  return before !== null && after !== null && before !== after ? `${before} → ${after}` : null;
}

function ChangedFields({ fields, accent, event, expanded = false }: { fields: string[]; accent: string; event?: TimelineEvent; expanded?: boolean }) {
  const { t } = useTranslation();
  const changes = fields.map((field) => {
    const label = t(`timeline.step.fields.${field}`, { defaultValue: humanizeField(field) });
    const delta = fieldDelta(event, field, t);
    return { field, label, delta, title: delta ? `${label}: ${delta}` : label };
  });
  return (
    <div className={cn("flex items-center gap-1", expanded ? "flex-wrap" : "flex-nowrap overflow-hidden")}>
      <span className="shrink-0 text-[0.7rem] uppercase tracking-wide text-muted-foreground">
        {t("timeline.step.changedFields")}
      </span>
      {(expanded ? changes : changes.slice(0, 3)).map(({ field, label, delta, title }) => (
        <span
          key={field}
          title={title}
          className={cn("rounded-full px-2 py-px text-[0.7rem] leading-4 font-medium text-foreground", expanded ? "min-w-0 [overflow-wrap:anywhere]" : "max-w-72 shrink-0 truncate")}
          style={{
            background: `color-mix(in oklab, ${accent} 14%, transparent)`,
          }}
        >
          <span className={delta ? "mr-1" : undefined}>{label}</span>
          {delta ? <span>{delta}</span> : null}
        </span>
      ))}
      {!expanded && changes.length > 3 ? (
        <span className="shrink-0 text-[0.7rem] text-muted-foreground" title={changes.slice(3).map((change) => change.title).join(" · ")}>
          +{changes.length - 3}
        </span>
      ) : null}
    </div>
  );
}
