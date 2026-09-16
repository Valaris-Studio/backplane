// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { BADGE_SIZE_MD } from "@/components/ui/badge";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import type { BoardStats } from "@/types/dashboard";
import { BUCKETS, buildDistributionGradient } from "../utils/board-buckets";

// Ambient drift, matching the --animate-rainbow-drift token in index.css. Slow
// on purpose: this is "the board is alive" texture in a dashboard panel, not a
// progress cue asking to be watched.
const SHEEN_DURATION_SECONDS = 18;

export function BoardActivityPill({
  slug,
  board,
}: {
  slug: string;
  board: BoardStats;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);

  // The route accepts a slug or an id; boards created before slug-identity
  // still have a null slug and must stay reachable.
  const boardPath = `/${slug}/boards/${board.slug ?? board.board_id}`;
  const gradient = buildDistributionGradient(
    board.distribution,
    board.card_count,
  );

  const bucketReadout = BUCKETS.filter(({ key }) => board.distribution[key] > 0)
    .map(({ key, label }) => `${t(label)}: ${board.distribution[key]}`)
    .join(", ");

  // The visible label is opacity-0 on hover, so the accessible name has to
  // carry everything the colors alone encode — name, count, and the breakdown
  // the rainbow shows sighted users.
  const accessibleName = [
    t("dashboard.boardStats.pillLabel", {
      name: board.name,
      count: board.card_count,
    }),
    bucketReadout,
  ]
    .filter(Boolean)
    .join(" — ");

  // Hovering doubles the drift: same distance in half the time. Written through
  // the same inline animationDuration the layer already owns, so changing it
  // mid-run rescales the running animation in place instead of restarting it.
  // Skipped entirely under reduced motion, where the layer does not render —
  // the second belt behind the index.css media query.
  const hoverHandlers = reducedMotion
    ? undefined
    : {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
      };

  return (
    <Link
      to={boardPath}
      data-testid="board-activity-pill"
      title={board.name}
      aria-label={accessibleName}
      // Fixed width is the point of the pill: every board's rainbow starts and
      // ends at the same x, so two distributions can be compared by eye.
      className={cn(
        "group relative inline-flex h-7 w-[13.5rem] shrink-0 items-center gap-2 overflow-hidden rounded-full px-2.5",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
        !gradient && "bg-muted",
      )}
      style={gradient ? { backgroundImage: gradient } : undefined}
      {...hoverHandlers}
    >
      {/* Ambient layer, deliberately separate from the data gradient: stop
          percentages are relative to the background IMAGE, so drifting the
          rainbow itself at background-size 200% would paint its 40%/70%
          boundaries at 80%/140% of the pill and stop reporting the real
          distribution. This sheen carries no information, so it is free to
          move. */}
      {gradient && !reducedMotion && (
        <span
          aria-hidden
          data-testid="board-activity-pill-sheen"
          className="pointer-events-none absolute inset-0 animate-rainbow-drift"
          style={{
            backgroundImage:
              "linear-gradient(90deg, transparent, color-mix(in oklab, white 18%, transparent), transparent)",
            backgroundSize: "200% 100%",
            animationDuration: `${hovered ? SHEEN_DURATION_SECONDS / 2 : SHEEN_DURATION_SECONDS}s`,
          }}
        />
      )}

      {/* One wrapper for name + count so a single opacity transition reveals
          the colors underneath. Only opacity — never display:none — so the
          text stays in the accessibility tree while it is invisible. */}
      {/* The scrim hugs the text rather than filling the pill: the rainbow IS
          the content here, so a full-width panel would leave only its edges
          visible. min-w-0 lets a long name truncate instead of pushing the
          count out of the fixed width. */}
      <span
        data-testid="board-activity-pill-label"
        className={cn(
          "relative flex min-w-0 items-baseline gap-1.5 rounded-full px-1.5 py-0.5",
          "bg-[color:color-mix(in_oklab,var(--color-card)_82%,transparent)]",
          "transition-opacity duration-200",
          "group-hover:opacity-0 group-focus-visible:opacity-0",
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate font-medium text-foreground",
            BADGE_SIZE_MD,
          )}
        >
          {board.name}
        </span>
        <span className="shrink-0 text-[0.7rem] tabular-nums text-muted-foreground">
          {board.card_count}
        </span>
      </span>

      {board.overdue_count > 0 && (
        <span
          data-testid="overdue-badge"
          title={t("dashboard.boardStats.overdue", {
            count: board.overdue_count,
          })}
          // ml-auto parks the dot against the pill's right edge whatever the
          // name's width, so overdue always reads from the same spot.
          className="relative ml-auto flex size-3.5 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--color-data-4)_88%,var(--color-card))] text-[color:var(--color-card)]"
        >
          <AlertTriangle className="size-2.5" aria-hidden="true" />
          <span className="sr-only">
            {board.overdue_count}{" "}
            {t("dashboard.boardStats.overdue", {
              count: board.overdue_count,
            })}
          </span>
        </span>
      )}
    </Link>
  );
}
