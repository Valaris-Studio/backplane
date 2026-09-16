// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { LayoutGroup, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { ReplayColumn } from "./ReplayColumn";
import type { ViewMode } from "../hooks/use-view-mode";
import type { Spotlight } from "../hooks/use-spotlight";
import type { BoardFrame } from "../types";

interface Props {
  frame: BoardFrame;
  selectedCardId: string | null;
  onSelectCard: (id: string) => void;
  reducedMotion: boolean;
  viewMode?: ViewMode;
  spotlight?: Spotlight;
  burstKey?: string;
}

type OffscreenEdge = "left" | "right";

// Which board edge hides the spotlit card, or null when it's visible (or
// unknowable: jsdom / pre-layout containers report zero-width rects, and a
// zero-width viewport can't claim anything is off-screen).
function offscreenEdgeFor(container: HTMLElement, cardId: string): OffscreenEdge | null {
  const viewport = container.getBoundingClientRect();
  if (viewport.width === 0) return null;
  const card = container.querySelector(`[data-replay-card="${CSS.escape(cardId)}"]`);
  if (!card) return null;
  const cardRect = card.getBoundingClientRect();
  const cardCenter = (cardRect.left + cardRect.right) / 2;
  if (cardCenter < viewport.left) return "left";
  if (cardCenter > viewport.right) return "right";
  return null;
}

// The spotlight deliberately never auto-scrolls (auto-scroll fights the user);
// this chip surfaces what that policy hides: when the StepPanel narrates a step
// whose glowing card sits outside the scrolled viewport, a small edge-pinned
// chip points at it and click-scrolls it into view. The user stays in control;
// the system stops silently acting off-stage. Rendered under reduced motion too
// (static, no entrance/nudge) — it carries information, not decoration.
function OffscreenSpotlightChip({
  edge,
  cardId,
  accentToken,
  reducedMotion,
  onJump,
}: {
  edge: OffscreenEdge;
  cardId: string;
  accentToken: string;
  reducedMotion: boolean;
  onJump: () => void;
}) {
  const { t } = useTranslation();
  const label = t("timeline.board.offscreen");
  const Arrow = edge === "left" ? ChevronLeft : ChevronRight;
  const arrowIcon = <Arrow aria-hidden className="h-3.5 w-3.5" />;
  // Entrance slides IN from the edge it points at; the nudge keeps poking
  // toward it (2 cycles, then rest).
  const towardEdge = edge === "left" ? -1 : 1;

  const chipClass =
    "pointer-events-auto flex items-center gap-0.5 rounded-full px-2 py-1.5 text-[0.65rem] font-semibold shadow-soft";
  const chipStyle = {
    background: `color-mix(in oklab, var(${accentToken}) 22%, var(--color-card))`,
    color: `var(${accentToken})`,
    border: `1px solid color-mix(in oklab, var(${accentToken}) 45%, transparent)`,
  };

  return (
    // Non-animated wrapper owns the edge pin + vertical centering so the
    // button's motion `x` transform can't clobber the centering translate.
    <span
      className={cn(
        "pointer-events-none absolute top-1/2 z-20 -translate-y-1/2",
        edge === "left" ? "left-1.5" : "right-1.5",
      )}
    >
      {reducedMotion ? (
        <button
          type="button"
          data-testid="offscreen-spotlight-chip"
          data-edge={edge}
          aria-label={label}
          title={label}
          onClick={onJump}
          className={chipClass}
          style={chipStyle}
        >
          {arrowIcon}
        </button>
      ) : (
        <motion.button
          key={cardId}
          type="button"
          data-testid="offscreen-spotlight-chip"
          data-edge={edge}
          aria-label={label}
          title={label}
          onClick={onJump}
          className={chipClass}
          style={chipStyle}
          initial={{ opacity: 0, x: 8 * towardEdge }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          <motion.span
            aria-hidden
            className="flex"
            animate={{ x: [0, 3 * towardEdge, 0, 3 * towardEdge, 0] }}
            transition={{ duration: 1.2 }}
          >
            {arrowIcon}
          </motion.span>
        </motion.button>
      )}
    </span>
  );
}

export function ReplayBoard({
  frame,
  selectedCardId,
  onSelectCard,
  reducedMotion,
  viewMode = "rich",
  spotlight,
  burstKey,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const spotlightCardId = spotlight?.cardId ?? null;
  const [offscreenEdge, setOffscreenEdge] = useState<OffscreenEdge | null>(null);

  // Re-measure when the spotlight retargets or the frame relays cards out
  // (a step can move the spotlit card itself). `frame` is a fresh object per
  // simulator render, so this also covers column/card layout churn; the
  // measurement is two rect reads — cheap enough to run unconditionally.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !spotlightCardId) {
      setOffscreenEdge(null);
      return;
    }
    setOffscreenEdge(offscreenEdgeFor(container, spotlightCardId));
  }, [spotlightCardId, frame, viewMode]);

  // The user scrolling is what brings the card on/off screen — track it with a
  // passive, rAF-throttled listener so the chip clears the moment the card is
  // actually visible (and re-appears if they scroll away again).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !spotlightCardId) return;
    let rafId = 0;
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        setOffscreenEdge(offscreenEdgeFor(container, spotlightCardId));
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [spotlightCardId]);

  const jumpToSpotlitCard = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !spotlightCardId) return;
    const card = container.querySelector(`[data-replay-card="${CSS.escape(spotlightCardId)}"]`);
    card?.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [spotlightCardId, reducedMotion]);

  const columns = frame.columns.map((column) => (
    <ReplayColumn
      key={column.snapshot.id}
      column={column}
      selectedCardId={selectedCardId}
      onSelectCard={onSelectCard}
      reducedMotion={reducedMotion}
      viewMode={viewMode}
      spotlight={spotlight}
      burstKey={burstKey}
    />
  ));

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        data-testid="replay-board"
        className="flex h-full gap-4 overflow-x-auto pb-2"
      >
        {/* A single LayoutGroup lets a card's `layoutId` glide it across columns
            with a FLIP transition when the frame changes. Reduced-motion skips it
            entirely (cards are plain divs that snap into place). */}
        {reducedMotion ? columns : <LayoutGroup>{columns}</LayoutGroup>}
      </div>
      {offscreenEdge && spotlightCardId ? (
        <OffscreenSpotlightChip
          edge={offscreenEdge}
          cardId={spotlightCardId}
          accentToken={spotlight?.accentToken ?? "--color-muted-foreground"}
          reducedMotion={reducedMotion}
          onJump={jumpToSpotlitCard}
        />
      ) : null}
    </div>
  );
}
