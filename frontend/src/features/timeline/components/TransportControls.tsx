// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { formatDateTime } from "@/lib/format";

interface Props {
  playing: boolean;
  speed: number;
  atStart: boolean;
  atEnd: boolean;
  currentTimestamp: string | null;
  caption: string;
  onToggle: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onSpeedCycle: () => void;
}

export function TransportControls({
  playing,
  speed,
  atStart,
  atEnd,
  currentTimestamp,
  caption,
  onToggle,
  onStepBack,
  onStepForward,
  onSpeedCycle,
}: Props) {
  const { t } = useTranslation();
  // Read the preference here — the simulator doesn't thread it down.
  const reducedMotion = useReducedMotion();

  const formattedTime = currentTimestamp ? formatDateTime(currentTimestamp) : "";

  // Stopped at the end = pressing play replays from the start (the playback
  // reducer already resets frameIndex); surface that with the video-player idiom.
  const showReplay = atEnd && !playing;
  const toggleIconKey = playing ? "pause" : showReplay ? "replay" : "play";
  const toggleIcon = playing ? (
    <Pause className="h-4 w-4" />
  ) : showReplay ? (
    <RotateCcw className="h-4 w-4" />
  ) : (
    <Play className="h-4 w-4" />
  );
  const toggleLabel = playing
    ? t("timeline.transport.pause")
    : showReplay
      ? t("timeline.transport.replay")
      : t("timeline.transport.play");

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={onStepBack}
          disabled={atStart}
          aria-label={t("timeline.transport.stepBack")}
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        {/* Play/pause is the primary control — give it the filled accent
            treatment of a real player's transport button. The wrapper is
            relative so the halo never affects flex layout. */}
        <span className="relative inline-flex">
          {playing && !reducedMotion ? (
            <motion.span
              data-testid="playing-halo"
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                boxShadow:
                  "0 0 0 2px color-mix(in oklab, var(--color-primary) 60%, transparent)",
              }}
              animate={{ scale: [1, 1.45], opacity: [0.7, 0] }}
              transition={{ duration: 1.6, ease: "easeOut", repeat: Infinity }}
            />
          ) : null}
          <Button
            variant={playing ? "secondary" : "default"}
            size="icon"
            onClick={onToggle}
            aria-label={toggleLabel}
            title={toggleLabel}
            className="rounded-full"
          >
            {reducedMotion ? (
              toggleIcon
            ) : (
              /* mode="wait" is fine: 120ms total, a transport icon may briefly be empty */
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={toggleIconKey}
                  className="inline-flex"
                  initial={{ scale: 0.5, rotate: -45, opacity: 0 }}
                  animate={{ scale: 1, rotate: 0, opacity: 1 }}
                  exit={{ scale: 0.5, rotate: 45, opacity: 0 }}
                  transition={{ duration: 0.12, ease: "easeOut" }}
                >
                  {toggleIcon}
                </motion.span>
              </AnimatePresence>
            )}
          </Button>
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onStepForward}
          disabled={atEnd}
          aria-label={t("timeline.transport.stepForward")}
        >
          <SkipForward className="h-4 w-4" />
        </Button>
        <span aria-hidden className="mx-1 h-5 w-px bg-border/70" />
        <Button
          variant="ghost"
          size="sm"
          onClick={onSpeedCycle}
          aria-label={t("timeline.transport.speed")}
          className="min-w-12 font-semibold tabular-nums"
        >
          {t("timeline.transport.speedValue", { speed })}
        </Button>
      </div>

      {caption || formattedTime ? (
        <div className="flex min-w-0 flex-col items-end text-right">
          {caption ? (
            <p className="truncate text-sm text-foreground" title={caption}>
              {caption}
            </p>
          ) : null}
          {formattedTime ? (
            <p className="text-xs tabular-nums text-muted-foreground">{formattedTime}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
