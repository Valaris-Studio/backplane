// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { AlertTriangle, PauseCircle, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { BADGE_SIZE_SM } from "@/components/ui/badge";
import type {
  BoardLoopState,
  BoardLoopStatus,
} from "@/features/kanban/api/use-board-loop-status";

// One chip replacing the old badge + ghost Repeat button. It is always
// rendered — even for a never-configured board — because "the loop is off" is
// information an operator needs at a glance, and an absent badge is
// indistinguishable from a badge that failed to load.
//
// Every visual decision below is a read of server state; nothing is derived
// from timers on the client. The treatments are chosen so the states rank by
// urgency at a glance: off is quiet, parked is calm, waiting is attentive,
// running is alive, unattended is the only one that asks for a human.
const STATE_STYLES: Record<
  BoardLoopState,
  { className: string; Icon: typeof Repeat; spin: boolean }
> = {
  // No data yet (loading or fetch error). Quietest treatment of all and a
  // distinct label — never claim a real state before the server has answered.
  unknown: {
    className:
      "border-border/50 bg-muted/25 text-muted-foreground/70 hover:bg-muted/50",
    Icon: Repeat,
    spin: false,
  },
  // Visible but recessive — present in the header without competing with it.
  off: {
    className:
      "border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/70",
    Icon: Repeat,
    spin: false,
  },
  // Loop on, work available, between iterations. Amber-static: attentive, not
  // alarming.
  waiting: {
    className:
      "border-transparent bg-warning/22 text-[color:var(--color-warning-foreground)] hover:bg-warning/30",
    Icon: Repeat,
    spin: false,
  },
  // Loop on but the board has nothing actionable — the starvation-policy
  // "park" resting state. Same amber family as waiting (it IS the same server
  // state) but a pause glyph, because parked is a healthy idle, not a fault.
  parked: {
    className:
      "border-transparent bg-warning/16 text-[color:var(--color-warning-foreground)] hover:bg-warning/24",
    Icon: PauseCircle,
    spin: false,
  },
  // An iteration is in flight. The only state carrying motion — motion here
  // means "the loop is turning right now", so it must never appear on a state
  // where nothing is happening.
  running: {
    className:
      "border-transparent bg-success/16 text-[color:var(--color-success-foreground)] hover:bg-success/24",
    Icon: Repeat,
    spin: true,
  },
  // Loop enabled, no runner alive to serve it. Deliberately NOT green: the
  // loop looks on but nothing will happen until someone launches or binds a
  // runner.
  unattended: {
    className:
      "border-transparent bg-destructive/14 text-[color:var(--color-error-foreground)] hover:bg-destructive/22",
    Icon: AlertTriangle,
    spin: false,
  },
};

interface BoardLoopStatusChipProps {
  state: BoardLoopState;
  status: BoardLoopStatus | undefined;
  onClick: () => void;
}

export function BoardLoopStatusChip({
  state,
  status,
  onClick,
}: BoardLoopStatusChipProps) {
  const { t } = useTranslation();
  const { className, Icon, spin } = STATE_STYLES[state];

  const label = t(`boardLoop.chip.state.${state}`);
  // The reason a self-stopped loop gives for stopping is the single most
  // useful thing on this chip, so it rides on the element itself (title +
  // aria-label) rather than in a hover-only panel.
  // While the loop is OFF, disabled_reason is the live account. Once someone
  // restarts it that field goes null — and the story of how the previous run
  // ended is exactly what an operator opens this chip to read. last_stop_reason
  // survives the re-enable, so it is the fallback, not a second line: when both
  // hold the same stop, showing it twice would be noise.
  const reason = status?.disabled_reason ?? status?.last_stop_reason ?? null;
  // Unattended has no disabled_reason to explain itself — the cause is
  // structural (nothing bound or nothing alive), so name it explicitly.
  const detail =
    state === "unattended"
      ? t("boardLoop.chip.unattendedHint", {
          bound: status?.bound_agent_count ?? 0,
        })
      : null;
  const description = [label, reason, detail].filter(Boolean).join(" — ");

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="loop-status-chip"
      data-state={state}
      title={description}
      aria-label={t("boardLoop.chip.aria", { description })}
      className={cn(
        // This chip hand-rolls the <Badge> pill geometry (it is a button with
        // its own focus ring), so the primitive's nowrap/shrink-0 fix does not
        // reach it — it carries its own copy for the same reason. The SIZE is
        // the one thing it imports rather than copies: the column-type label
        // matching this pill is a structural guarantee, not two files agreeing
        // by luck.
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-semibold uppercase tracking-[0.16em]",
        BADGE_SIZE_SM,
        "transition-[background-color,border-color,color] duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      {/* animate-loop-turn is the --animate-loop-turn theme token (index.css);
          the reduced-motion block there stops it. */}
      <Icon aria-hidden className={cn("h-3 w-3", spin && "animate-loop-turn")} />
      {label}
      {reason ? <span className="sr-only">{reason}</span> : null}
    </button>
  );
}
