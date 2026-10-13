// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentSession, DisplayState } from "@/types/agent-session";

const VARIANT_BY_STATE: Record<DisplayState, BadgeProps["variant"]> = {
  active: "success",
  idle: "secondary",
  ended: "outline",
  incomplete: "warning",
  paused: "secondary",
  disconnected: "secondary",
};

// State words sit in dense rows next to 11px+ meta text; the app badge's
// 0.67rem renders under 10px here, so session badges step up to ~11px.
const SESSION_BADGE_SIZING = "px-2 py-0.5 text-[0.75rem] tracking-[0.1em]";

type BadgeSession = Pick<AgentSession, "display_state" | "capture_gaps" | "ended_reason" | "coverage">;

export function SessionStateBadge({ session }: { session: BadgeSession }) {
  const { t } = useTranslation();

  if (session.coverage === "usage_only") {
    return (
      <Badge variant="info" className={SESSION_BADGE_SIZING}>
        {t("sessions.states.usageOnly")}
      </Badge>
    );
  }

  const state = session.display_state;
  const hint =
    state === "incomplete"
      ? session.capture_gaps > 0
        ? t("sessions.stateHints.gaps", { count: session.capture_gaps })
        : session.ended_reason === "abandoned"
          ? t("sessions.stateHints.abandoned")
          : undefined
      : state === "paused" || state === "disconnected"
        ? t(`sessions.stateHints.${state}`)
        : undefined;

  return (
    <Badge
      variant={VARIANT_BY_STATE[state]}
      title={hint}
      className={cn(SESSION_BADGE_SIZING, state === "ended" && "text-muted-foreground")}
    >
      {state === "active" ? <LiveDot /> : null}
      {t(`sessions.states.${state}`)}
    </Badge>
  );
}

// Motion is reserved for the live state; reduced motion keeps the dot, drops the ping.
export function LiveDot() {
  return (
    <span aria-hidden className="relative inline-flex size-1.5 shrink-0">
      <span className="absolute inset-0 rounded-full bg-current opacity-60 motion-safe:animate-ping" />
      <span className="relative size-1.5 rounded-full bg-current" />
    </span>
  );
}
