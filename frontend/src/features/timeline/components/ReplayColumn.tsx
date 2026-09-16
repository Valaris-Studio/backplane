// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { ReplayCard, type SpotlightProps } from "./ReplayCard";
import { ReplayCardSquare } from "./ReplayCardSquare";
import { ReplayCardDense } from "./ReplayCardDense";
import type { ViewMode } from "../hooks/use-view-mode";
import type { Spotlight } from "../hooks/use-spotlight";
import { UNKNOWN_COLUMN_ID, type FrameColumn } from "../types";

interface Props {
  column: FrameColumn;
  selectedCardId: string | null;
  onSelectCard: (id: string) => void;
  reducedMotion: boolean;
  viewMode?: ViewMode;
  // The current-step spotlight (one card across the whole board). Each card
  // derives its own active/burst from it; absent ⇒ no card lights up.
  spotlight?: Spotlight;
  // Changes per step (the current event id) so a repeat-target card's burst
  // remounts and replays each step.
  burstKey?: string;
}

// Per-card spotlight props: only the spotlight's target card is active.
function spotlightFor(
  spotlight: Spotlight | undefined,
  cardId: string,
  burstKey: string | undefined,
): SpotlightProps | undefined {
  if (!spotlight || spotlight.cardId !== cardId) return undefined;
  return {
    active: true,
    accentToken: spotlight.accentToken,
    burst: spotlight.burst,
    burstKey,
    actor: spotlight.actor,
  };
}

export function ReplayColumn({
  column,
  selectedCardId,
  onSelectCard,
  reducedMotion,
  viewMode = "rich",
  spotlight,
  burstKey,
}: Props) {
  const { t } = useTranslation();
  const cardCount = column.cards.length;
  // Previous render's count — seeded with the CURRENT count so the badge never
  // pops on initial mount, only when a card actually arrives/leaves later.
  const previousCountRef = useRef(cardCount);
  const countDelta = cardCount - previousCountRef.current;
  useEffect(() => {
    previousCountRef.current = cardCount;
  }, [cardCount]);
  const isUnknown = column.snapshot.id === UNKNOWN_COLUMN_ID;
  const name = isUnknown ? t("timeline.unknownColumn") : column.snapshot.name;
  const compact = viewMode === "compact";
  const dense = viewMode === "dense";
  const Card = dense ? ReplayCardDense : compact ? ReplayCardSquare : ReplayCard;
  // An empty lane collapses to a thin rail (vertical label only) so empty
  // columns don't eat horizontal space — common early in a replay when most
  // columns have no cards yet. It still shows its name + 0 count so the board
  // structure stays legible.
  const empty = column.cards.length === 0;
  // Clip overflow ONLY while the lane-width tween runs (see the container).
  const [clipping, setClipping] = useState(false);

  const cards = column.cards.map((card) => {
    const cardSpotlight = spotlightFor(spotlight, card.snapshot.id, burstKey);
    return (
      <Card
        key={card.snapshot.id}
        card={card}
        selected={card.snapshot.id === selectedCardId}
        onClick={() => onSelectCard(card.snapshot.id)}
        reducedMotion={reducedMotion}
        spotlight={cardSpotlight}
      />
    );
  });

  const surface = isUnknown
    ? "border-dashed border-border/50 bg-[color:var(--color-surface-1)]/50"
    : "border-border/60 bg-[color:var(--color-surface-1)]";

  const railBody = (
    <>
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.6rem] font-medium tabular-nums text-muted-foreground">
        0
      </span>
      {/* Vertical name so a thin rail stays identifiable without eating width. */}
      <span
        className={cn(
          "max-h-56 truncate text-xs font-semibold [writing-mode:vertical-rl]",
          isUnknown ? "italic text-muted-foreground/70" : "text-muted-foreground",
        )}
      >
        {name}
      </span>
    </>
  );

  const laneHeader = (
    <div className="flex items-center justify-between px-1">
      <h3
        className={cn(
          "text-sm font-semibold",
          isUnknown ? "italic text-muted-foreground" : "text-foreground",
        )}
      >
        {name}
      </h3>
      {reducedMotion ? (
        <span
          data-testid="replay-count-badge"
          className="rounded-full bg-muted px-2 py-0.5 text-[0.65rem] font-medium tabular-nums text-muted-foreground"
        >
          {cardCount}
        </span>
      ) : (
        // Keyed on the count so each arrival remounts the span and replays the
        // pop — consecutive arrivals each get acknowledged. Scale/background
        // only (no size change), honoring "emphasis never resizes".
        <motion.span
          key={cardCount}
          data-testid="replay-count-badge"
          data-count-change={countDelta > 0 ? "increased" : countDelta < 0 ? "decreased" : "none"}
          initial={{ scale: countDelta > 0 ? 1.35 : countDelta < 0 ? 1.15 : 1 }}
          animate={{ scale: 1 }}
          transition={{ scale: { type: "spring", stiffness: 520, damping: 22 } }}
          className="relative rounded-full bg-muted px-2 py-0.5 text-[0.65rem] font-medium tabular-nums text-muted-foreground"
        >
          {countDelta > 0 ? (
            // One-beat accent tint confirming the lane GAINED a card: a STATIC
            // color-mix backdrop fading via numeric opacity — motion can't
            // interpolate color-mix() strings (the tint would snap, not fade).
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                backgroundColor:
                  "color-mix(in oklab, var(--color-primary) 28%, transparent)",
              }}
              initial={{ opacity: 1 }}
              animate={{ opacity: 0 }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
          ) : null}
          {cardCount}
        </motion.span>
      )}
    </div>
  );

  const laneCardBody = (
    <div
      data-replay-card-body={viewMode}
      className={dense ? "grid grid-cols-8 justify-items-start gap-2" : compact ? "grid grid-cols-2 gap-2" : "flex flex-col gap-3"}
    >
      {reducedMotion ? cards : <AnimatePresence initial={false}>{cards}</AnimatePresence>}
    </div>
  );

  // Reduced motion keeps the original two static trees verbatim: the lane
  // snaps between rail and full width with no tween, no cross-fade.
  if (reducedMotion) {
    if (empty) {
      return (
        <div
          data-testid={`replay-column-${column.snapshot.id}`}
          data-collapsed="true"
          title={name}
          className={cn(
            "flex w-12 shrink-0 flex-col items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border py-3",
            surface,
          )}
        >
          {railBody}
        </div>
      );
    }
    return (
      <div
        data-testid={`replay-column-${column.snapshot.id}`}
        className={cn(
          "flex shrink-0 flex-col gap-3 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border p-3",
          // Compact mode widens the lane so several tiles share a row; rich mode
          // keeps the original single-column width byte-for-byte.
          compact || dense ? "w-[22rem]" : "w-72",
          // The synthetic holding bucket is NOT a real board column — de-emphasize
          // it (dashed border, dimmer surface, muted heading) so the eye reads it
          // as "uncategorized / partial history" rather than a first-class lane.
          surface,
        )}
      >
        {laneHeader}
        {laneCardBody}
      </div>
    );
  }

  // ONE container for both states so the lane WIDTH animates instead of the
  // rail/full trees teleport-swapping (which shoved siblings sideways in one
  // frame). Same spring family as the card glide — the lane visibly breathes
  // open just before the card lands in it. Clipping applies ONLY while the
  // width tween runs (mid-tween the content is wider than the container and
  // would spill); at rest the lane is overflow-visible so the spotlight's
  // box-shadow glow (~25px past the card, > the lane's 12px padding) is never
  // hard-cropped.
  return (
    <motion.div
      data-testid={`replay-column-${column.snapshot.id}`}
      data-collapsed={empty ? "true" : undefined}
      title={empty ? name : undefined}
      initial={false}
      animate={{ width: empty ? "3rem" : compact || dense ? "22rem" : "18rem" }}
      transition={{ type: "spring", stiffness: 420, damping: 40, mass: 0.9 }}
      onAnimationStart={() => setClipping(true)}
      onAnimationComplete={() => setClipping(false)}
      className={cn(
        "flex shrink-0 flex-col rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border",
        clipping ? "overflow-hidden" : "overflow-visible",
        surface,
      )}
    >
      {/* mode="popLayout" mounts the new state IMMEDIATELY (a card landing in a
          just-opened lane must be visible the same frame, not after the rail's
          exit fade) while the outgoing state is popped out of flow to fade.
          Entrance via plain opacity — content never leaves the a11y tree. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {empty ? (
          <motion.div
            key="rail"
            className="flex flex-col items-center gap-2 py-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {railBody}
          </motion.div>
        ) : (
          <motion.div
            key="lane"
            className="flex min-h-0 flex-col gap-3 p-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {laneHeader}
            {laneCardBody}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
