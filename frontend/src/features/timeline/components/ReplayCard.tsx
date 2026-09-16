// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  CARD_TYPE_TEXT,
  CARD_TYPE_TINT,
  PRIORITY_TEXT,
  PRIORITY_TINT,
} from "@/features/kanban/utils/card-visuals";
import type { CardType, Priority } from "@/types/kanban";
import { cn } from "@/lib/utils";
import { humanizeCardType, humanizePriority, humanizeRole, initials } from "../utils/humanize";
import { ParticleBurst } from "./ParticleBurst";
import type { StepActor } from "../utils/step-role";
import type { FrameCard } from "../types";

// Read-only, ROLE-AGNOSTIC mirror of KanbanCard's VISUAL structure. Stripped of
// ALL live behavior: no useSortable/dnd, no mutation hooks, no kebab menu, no
// dependency-highlight or agent-presence. Clicking only selects.

const MAX_AVATARS = 4;

// The shared card-visual token maps are typed to the 4 known classifier values.
// Classifier fields here are OPAQUE — narrow before indexing, else fall back to
// a neutral tint so any user-defined value still renders (never enumerated).
function isKnownCardType(value: string): value is CardType {
  return value in CARD_TYPE_TINT;
}
function isKnownPriority(value: string): value is Priority {
  return value in PRIORITY_TINT;
}

const NEUTRAL_TINT = "var(--color-muted-foreground)";

// V2 spotlight: the active step lights up the card it acts on/references.
// `active` draws the accent glow + ring; `burst` adds the particle flourish
// (suppressed under reduced motion by the caller). Absent ⇒ unchanged v1 card.
export interface SpotlightProps {
  active: boolean;
  accentToken: string;
  burst: boolean;
  // A value that changes per spotlighting step (the current event id). The burst
  // overlay is keyed on it so a NEW ParticleBurst mounts each step — otherwise a
  // card that stays the burst target across consecutive steps would replay the
  // burst only once (the overlay self-latches after its first play).
  burstKey?: string;
  // WHO performed this step (runner identity + acting role when the summary
  // names one, or a human's name) — rendered as a badge ON the spotlighted
  // card so the actor is visible at the point of action, not only in the
  // step panel. null/absent ⇒ no badge (never a guess).
  actor?: StepActor | null;
}

// The actor badge overlaid on the spotlighted card: avatar + "name · role".
// Absolutely positioned (never reflows the card), pointer-events-none, and
// accent-tinted over an opaque card mix so it stays readable above content.
export function SpotlightActorBadge({
  actor,
  accentToken,
  reducedMotion,
  compact = false,
}: {
  actor: StepActor;
  accentToken: string;
  reducedMotion: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const roleLabel = actor.role ? humanizeRole(actor.role, t) : "";
  const label =
    actor.name && roleLabel
      ? `${actor.name} · ${roleLabel}`
      : actor.name || roleLabel;
  if (!label) return null;

  const MotionSpan = reducedMotion ? "span" : motion.span;
  const entrance = reducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 4 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.18, ease: "easeOut" as const },
      };

  if (compact) {
    // Tile variant: an avatar-only chip (the tile has no room for text); the
    // full "name · role" lives in the tooltip.
    return (
      <MotionSpan
        {...entrance}
        data-testid="spotlight-actor"
        title={label}
        className="pointer-events-none absolute right-1 top-1/2 z-[2] -translate-y-1/2"
      >
        <Avatar
          className="h-5 w-5 ring-2"
          style={{ "--tw-ring-color": `var(${accentToken})` } as React.CSSProperties}
        >
          {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt={label} /> : null}
          <AvatarFallback className="text-[0.5rem]">
            {initials(actor.name || roleLabel)}
          </AvatarFallback>
        </Avatar>
      </MotionSpan>
    );
  }

  return (
    <MotionSpan
      {...entrance}
      data-testid="spotlight-actor"
      title={label}
      className="pointer-events-none absolute bottom-1.5 left-1.5 z-[2] flex max-w-[85%] items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-[0.62rem] font-semibold shadow-soft"
      style={{
        background: `color-mix(in oklab, var(${accentToken}) 22%, var(--color-card))`,
        color: `var(${accentToken})`,
      }}
    >
      <Avatar className="h-4 w-4">
        {actor.avatarUrl ? <AvatarImage src={actor.avatarUrl} alt={label} /> : null}
        <AvatarFallback className="text-[0.5rem]">
          {initials(actor.name || roleLabel)}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{label}</span>
    </MotionSpan>
  );
}

// Card emphasis is expressed ENTIRELY via box-shadow (never border-width/padding)
// so toggling it NEVER reflows the card or shifts its neighbours.
//
// Two distinct, non-competing cues:
//  - spotlight (the CURRENT step's card): a bright accent ring + soft glow,
//    keyed on the accent TOKEN. This is the single "being worked on now" marker.
//  - selected (a card the user clicked to inspect): a quiet neutral inset ring —
//    deliberately understated so it never reads as the step indicator and so a
//    lingering selection can't masquerade as "this card is active".
// When a card is both, the spotlight wins (it's the louder, transient cue).
export function emphasisBoxShadow(
  selected: boolean,
  spotlight: SpotlightProps | undefined,
): string {
  if (spotlight?.active) {
    const ring = `color-mix(in oklab, var(${spotlight.accentToken}) 75%, transparent)`;
    const glow = `color-mix(in oklab, var(${spotlight.accentToken}) 30%, transparent)`;
    return `0 0 0 2px ${ring}, 0 0 22px 3px ${glow}`;
  }
  if (selected) {
    return "inset 0 0 0 1.5px color-mix(in oklab, var(--color-foreground) 35%, transparent)";
  }
  return "none";
}

// Applies the emphasis IMPERATIVELY to the card root. It can NOT go through the
// motion.div's `style` prop: with `layoutId` set, motion takes ownership of
// boxShadow at mount and silently ignores every later style-prop update — which
// left each previously-spotlighted card ringed forever as the playhead moved on.
// Writing el.style directly (a property motion was never told about) is the only
// channel that stays live; the card's transition-[box-shadow] class fades it.
export function useEmphasis(
  ref: React.RefObject<HTMLDivElement | null>,
  selected: boolean,
  spotlight: SpotlightProps | undefined,
): void {
  const active = spotlight?.active ?? false;
  const accentToken = spotlight?.accentToken;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.boxShadow = emphasisBoxShadow(selected, active && accentToken ? { active, accentToken, burst: false } : undefined);
  }, [ref, selected, active, accentToken]);
}

interface Props {
  card: FrameCard;
  selected: boolean;
  onClick: () => void;
  reducedMotion: boolean;
  spotlight?: SpotlightProps;
}

export function ReplayCard({ card, selected, onClick, reducedMotion, spotlight }: Props) {
  const { t } = useTranslation();
  const { snapshot, legacy } = card;
  const rootRef = useRef<HTMLDivElement>(null);
  useEmphasis(rootRef, selected, spotlight);

  const typeTint = isKnownCardType(snapshot.card_type)
    ? CARD_TYPE_TINT[snapshot.card_type]
    : NEUTRAL_TINT;
  const typeText = isKnownCardType(snapshot.card_type)
    ? CARD_TYPE_TEXT[snapshot.card_type]
    : "text-muted-foreground";
  const priorityTint = isKnownPriority(snapshot.priority)
    ? PRIORITY_TINT[snapshot.priority]
    : NEUTRAL_TINT;
  const priorityText = isKnownPriority(snapshot.priority)
    ? PRIORITY_TEXT[snapshot.priority]
    : "text-muted-foreground";

  const typeLabel = humanizeCardType(snapshot.card_type, t);
  const priorityLabel = humanizePriority(snapshot.priority, t);
  const participants = snapshot.participants ?? [];
  const shown = participants.slice(0, MAX_AVATARS);
  const overflow = participants.length - shown.length;

  // motion's `layout`/`layoutId` glides a card to its new column box when the
  // frame changes; AnimatePresence (in the column) drives the enter/exit fade.
  // Reduced-motion renders a plain div so cards snap instantly.
  //
  // GLIDE TUNING: a card that MOVES columns exists transiently in both lanes
  // (exiting the old, entering the new) under one shared `layoutId`. To keep the
  // cross-column move reading as a single smooth glide (not a fade-shrink ghost
  // fighting an enter-pop), enters/exits are opacity-only — the spring `layout`
  // transition owns the positional motion. A genuinely new/removed card simply
  // fades. Spring (not a fixed easeOut duration) gives the premium, weighty
  // "settling into place" feel of a real player.
  const MotionDiv = reducedMotion ? "div" : motion.div;
  const motionProps = reducedMotion
    ? {}
    : {
        layout: true,
        layoutId: snapshot.id,
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: {
          layout: { type: "spring" as const, stiffness: 420, damping: 38, mass: 0.9 },
          opacity: { duration: 0.18, ease: "easeOut" as const },
        },
      };

  return (
    <MotionDiv
      {...motionProps}
      ref={rootRef}
      data-replay-card={snapshot.id}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-lg)+0.05rem))] border border-border/75 bg-card/92 px-4 pt-7 pb-4 shadow-soft transition-[box-shadow,background-color] duration-200 hover:border-primary/25",
        legacy && "border-dashed",
      )}
      // Emphasis (accent ring when this is the current step's card, quiet ring
      // when selected) is applied imperatively by useEmphasis — see its comment;
      // routing it through the style prop is a no-op once layoutId is set.
    >
      {spotlight?.active && !reducedMotion ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[1] rounded-[min(var(--radius-cap),calc(var(--radius-lg)+0.05rem))]"
          style={{
            boxShadow: `0 0 0 2px color-mix(in oklab, var(${spotlight.accentToken}) 80%, transparent)`,
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0, 1, 0] }}
          transition={{ duration: 1.8, ease: "easeInOut", times: [0, 0.25, 0.5, 0.75, 1] }}
        />
      ) : null}

      {spotlight?.active && spotlight.burst ? (
        <ParticleBurst
          key={spotlight.burstKey}
          accentToken={spotlight.accentToken}
          reducedMotion={reducedMotion}
        />
      ) : null}

      {spotlight?.active && spotlight.actor ? (
        <SpotlightActorBadge
          actor={spotlight.actor}
          accentToken={spotlight.accentToken}
          reducedMotion={reducedMotion}
        />
      ) : null}

      {/* Top-left: card type tag. */}
      <span
        aria-label={typeLabel}
        title={typeLabel}
        className={cn(
          "pointer-events-none absolute left-0 top-0 z-[1] select-none rounded-tl-[min(var(--radius-cap),calc(var(--radius-lg)+0.05rem))] px-2.5 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.16em]",
          typeText,
        )}
        style={{
          background: `linear-gradient(135deg, color-mix(in oklab, ${typeTint} 22%, transparent) 0%, color-mix(in oklab, ${typeTint} 14%, transparent) 55%, transparent 100%)`,
        }}
      >
        {typeLabel}
      </span>

      {/* Top-right: priority tag. */}
      <span
        aria-label={priorityLabel}
        title={priorityLabel}
        className={cn(
          "pointer-events-none absolute right-0 top-0 z-[1] select-none rounded-tr-[min(var(--radius-cap),calc(var(--radius-lg)+0.05rem))] px-2.5 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.16em]",
          priorityText,
        )}
        style={{
          background: `linear-gradient(225deg, color-mix(in oklab, ${priorityTint} 22%, transparent) 0%, color-mix(in oklab, ${priorityTint} 14%, transparent) 55%, transparent 100%)`,
        }}
      >
        {priorityLabel}
      </span>

      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            {snapshot.title ? (
              <p className="text-sm font-semibold leading-6 text-foreground [overflow-wrap:anywhere]">
                {snapshot.title}
              </p>
            ) : (
              <p className="text-sm font-medium italic leading-6 text-muted-foreground">
                {t("timeline.untitledCard")}
              </p>
            )}

            {snapshot.labels && snapshot.labels.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {snapshot.labels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full bg-muted px-2 py-0.5 text-[0.65rem] text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {shown.length > 0 ? (
            <div className="flex items-center gap-1.5">
              {shown.map((participant) => {
                const roleLabel = humanizeRole(participant.role, t);
                return (
                  <Avatar
                    key={participant.agent_id ?? participant.user_id}
                    className="h-8 w-8"
                    title={`${participant.name} · ${roleLabel}`}
                    aria-label={`${participant.name} · ${roleLabel}`}
                  >
                    {participant.avatar_url ? (
                      <AvatarImage src={participant.avatar_url} alt={participant.name} />
                    ) : null}
                    <AvatarFallback>{initials(participant.name)}</AvatarFallback>
                  </Avatar>
                );
              })}
              {overflow > 0 ? (
                <span className="text-xs text-muted-foreground">+{overflow}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </MotionDiv>
  );
}
