// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePauseAgent, useResumeAgent } from "../hooks/useAgentMetrics";

interface PauseToggleProps {
  slug: string;
  agentId: string;
  isPaused: boolean;
  size?: "sm" | "default";
  className?: string;
}

/**
 * Single Pause/Resume button. Label and icon flip on `isPaused` (which is read
 * from the agent's server state — never local). Mutation is disabled while in
 * flight; WS event `agent.paused` / `agent.resumed` drives the subsequent
 * refetch via `useDomainSync("agent", …)`, so the toggle settles even if
 * another client triggered the transition.
 */
export function PauseToggle({
  slug,
  agentId,
  isPaused,
  size = "sm",
  className,
}: PauseToggleProps) {
  const { t } = useTranslation();
  const pause = usePauseAgent(slug);
  const resume = useResumeAgent(slug);

  const isPending = pause.isPending || resume.isPending;

  const handleClick = () => {
    if (isPaused) {
      resume.mutate(agentId);
    } else {
      pause.mutate(agentId);
    }
  };

  const label = isPending
    ? isPaused
      ? t("agents.resuming")
      : t("agents.pausing")
    : isPaused
      ? t("agents.resume")
      : t("agents.pause");

  const Icon = isPaused ? Play : Pause;

  return (
    <Button
      variant="outline"
      size={size}
      onClick={handleClick}
      disabled={isPending}
      aria-label={label}
      aria-pressed={isPaused}
      className={className}
    >
      <Icon className="mr-1.5 h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
