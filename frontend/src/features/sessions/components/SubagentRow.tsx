// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSession } from "@/types/agent-session";
import { usePromptsHidden } from "../hooks/use-hide-prompts";
import { formatClock, formatTokens, isLive, sessionTotalTokens } from "../utils/format";
import { AgentMark } from "./AgentMark";
import { PromptText } from "./PromptText";
import { SessionStateBadge } from "./SessionStateBadge";

// A child session sits where it started. Backplane does not claim which call
// spawned it (no reliable link exists), only when it ran.
export function SubagentRow({ slug, session }: { slug: string; session: AgentSession }) {
  const { t } = useTranslation();
  const promptsHidden = usePromptsHidden();
  const live = isLive(session);
  const title = session.title ?? t("sessions.timeline.subagent.untitled");
  const spokenTitle = promptsHidden && session.title ? t("sessions.hidePrompts.hidden") : title;
  const span = live
    ? t("sessions.facts.since", { time: formatClock(session.started_at) })
    : `${formatClock(session.started_at)} – ${formatClock(session.last_event_at)}`;

  return (
    <li
      data-subagent-row=""
      className={cn(
        "my-1 ml-[2.1rem] grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[var(--radius-cap)] border bg-card px-3 py-2 text-[0.86rem]",
        live ? "border-[color:color-mix(in_oklab,var(--color-success)_45%,var(--color-border))]" : "border-border",
      )}
    >
      <AgentMark harness={session.harness} displayName={session.harness_display_name} size="sm" />
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 font-bold text-foreground max-sm:line-clamp-2 sm:truncate">
          {session.title ? <PromptText text={title} /> : title}
        </span>
        <span className="flex flex-wrap gap-x-1.5 text-[0.8rem] tabular-nums text-muted-foreground [&>span+span]:before:mr-1.5 [&>span+span]:before:opacity-60 [&>span+span]:before:content-['·']">
          <span>{span}</span>
          <span>
            {live
              ? t("sessions.timeline.subagent.callsSoFar", { count: session.tool_call_count })
              : t("sessions.timeline.subagent.calls", { count: session.tool_call_count })}
          </span>
          <span>{t("sessions.timeline.subagent.tokens", { value: formatTokens(sessionTotalTokens(session)) })}</span>
        </span>
      </p>
      <span className="flex items-center gap-2">
        {live ? <SessionStateBadge session={session} /> : null}
        <Link
          to={`/${slug}/sessions/${session.id}`}
          aria-label={t("sessions.timeline.subagent.openLabel", { title: spokenTitle })}
          className="inline-flex items-center gap-1 rounded-[var(--radius-cap)] px-1.5 py-1 text-[0.82rem] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("sessions.timeline.subagent.open")}
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </span>
    </li>
  );
}
