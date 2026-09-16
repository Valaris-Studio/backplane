// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CARD_TYPE_TINT, PRIORITY_TINT } from "@/features/kanban/utils/card-visuals";
import type { CardType, Priority } from "@/types/kanban";
import { cn } from "@/lib/utils";
import { initials } from "../utils/humanize";
import { ParticleBurst } from "./ParticleBurst";
import { SpotlightActorBadge, useEmphasis, type SpotlightProps } from "./ReplayCard";
import type { FrameCard } from "../types";

// VERY compact, read-only mirror of a card: a 1-line ellipsis title, a card-type
// tint as a left bar, a priority dot and ONE holder avatar with a +N overflow
// number. Same select + keyboard + data-replay-card + motion glide contract as
// ReplayCard, plus the optional spotlight prop so the spotlight engine works in
// compact mode. ROLE-AGNOSTIC: opaque classifier fields fall back to a neutral
// tint so any user-defined value still renders (never enumerated).

// The shared card-visual token maps are typed to the known classifier values.
// Classifier fields here are OPAQUE — narrow before indexing, else fall back to
// a neutral tint so any user-defined value still renders.
function isKnownCardType(value: string): value is CardType {
  return value in CARD_TYPE_TINT;
}
function isKnownPriority(value: string): value is Priority {
  return value in PRIORITY_TINT;
}

const NEUTRAL_TINT = "var(--color-muted-foreground)";

interface Props {
  card: FrameCard;
  selected: boolean;
  onClick: () => void;
  reducedMotion: boolean;
  // Shared with ReplayCard so both cards spotlight identically (one source of
  // truth for the prop shape). accentToken is a TOKEN NAME wrapped in color-mix,
  // never a literal color.
  spotlight?: SpotlightProps;
}

export function ReplayCardSquare({ card, selected, onClick, reducedMotion, spotlight }: Props) {
  const { t } = useTranslation();
  const { snapshot, legacy } = card;
  const rootRef = useRef<HTMLDivElement>(null);
  useEmphasis(rootRef, selected, spotlight);

  const typeTint = isKnownCardType(snapshot.card_type)
    ? CARD_TYPE_TINT[snapshot.card_type]
    : NEUTRAL_TINT;
  const priorityTint = isKnownPriority(snapshot.priority)
    ? PRIORITY_TINT[snapshot.priority]
    : NEUTRAL_TINT;

  const participants = snapshot.participants ?? [];
  const holder = participants[0];
  const overflow = participants.length - (holder ? 1 : 0);

  const title = snapshot.title || t("timeline.untitledCard");

  // Mirror ReplayCard's motion: a shared `layoutId` glides the tile across
  // columns; AnimatePresence (in the column) drives opacity enter/exit. Reduced-
  // motion renders a plain div so tiles snap. Keeping the SAME layoutId as the
  // rich card means toggling view modes keeps the per-card animation identity.
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

  const active = spotlight?.active ?? false;

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
      title={title}
      // Shared box-shadow emphasis (no border-width/padding change → no reflow),
      // applied imperatively by useEmphasis — the style prop is a dead channel
      // for boxShadow once layoutId is set. Identical model to the rich card.
      className={cn(
        "group relative flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-[calc(var(--radius-md))] border border-border/75 bg-card/92 pr-2 shadow-soft transition-[box-shadow,background-color] duration-200 hover:border-primary/25",
        legacy && "border-dashed",
      )}
    >
      {/* Left bar: card-type tint (the compact analogue of the rich corner tag). */}
      <span
        aria-hidden
        className="h-full w-1 shrink-0"
        style={{ background: `color-mix(in oklab, ${typeTint} 80%, transparent)` }}
      />

      {/* Priority dot. */}
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: priorityTint }}
      />

      {snapshot.title ? (
        <span className="min-w-0 flex-1 truncate text-[0.7rem] font-medium leading-none text-foreground">
          {title}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[0.7rem] font-medium italic leading-none text-muted-foreground">
          {title}
        </span>
      )}

      {holder ? (
        <span className="flex shrink-0 items-center gap-1">
          <Avatar className="h-5 w-5" title={holder.name} aria-label={holder.name}>
            {holder.avatar_url ? (
              <AvatarImage src={holder.avatar_url} alt={holder.name} />
            ) : null}
            <AvatarFallback className="text-[0.5rem]">{initials(holder.name)}</AvatarFallback>
          </Avatar>
          {overflow > 0 ? (
            <span className="text-[0.6rem] tabular-nums text-muted-foreground">+{overflow}</span>
          ) : null}
        </span>
      ) : null}

      {/* Burst overlay during active Play — keyed per step so it remounts (and
          replays) each time this tile is the spotlight target. */}
      {active && spotlight!.burst ? (
        <ParticleBurst
          key={spotlight!.burstKey}
          accentToken={spotlight!.accentToken}
          reducedMotion={reducedMotion}
        />
      ) : null}

      {/* Compact actor chip: avatar only (no room for text); name · role in
          the tooltip. Covers the holder avatar for the one step it's shown —
          "who is acting now" outranks "who holds it" at that moment. */}
      {active && spotlight!.actor ? (
        <SpotlightActorBadge
          actor={spotlight!.actor}
          accentToken={spotlight!.accentToken}
          reducedMotion={reducedMotion}
          compact
        />
      ) : null}
    </MotionDiv>
  );
}
