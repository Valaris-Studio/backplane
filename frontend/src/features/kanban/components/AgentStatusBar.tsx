// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Bot, AlertTriangle, PowerOff, CircleHelp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  useAgentMetrics,
  useInFlightExecutions,
} from "@/features/agents/hooks/useAgentMetrics";
import { useBoardLoopStatus } from "@/features/kanban/api/use-board-loop-status";
import type { AgentLiveness } from "@/features/agents/api/agents";

interface AgentStatusBarProps {
  slug: string;
  boardId: string;
  // Agent ids relevant to THIS board. The workspace metrics list has no board
  // axis, so board membership has to come in from the parent — without it the
  // bar shows every workspace runner on every board (three badges for a board
  // with one bound runner). Omitted = no scoping (workspace-wide), preserving
  // the pre-scoping behavior for any legacy mount.
  boardAgentIds?: string[];
}

const LIVENESS_STYLES: Record<
  AgentLiveness,
  { className: string; Icon: typeof Bot }
> = {
  alive: {
    className: "border-emerald-400/40 bg-emerald-400/10 text-emerald-700 dark:text-emerald-400",
    Icon: Bot,
  },
  stale: {
    className: "border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-400",
    Icon: AlertTriangle,
  },
  offline: {
    className: "border-red-400/40 bg-red-400/10 text-red-700 dark:text-red-400",
    Icon: PowerOff,
  },
  unknown: {
    className: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
    Icon: CircleHelp,
  },
};

export function AgentStatusBar({
  slug,
  boardId,
  boardAgentIds,
}: AgentStatusBarProps) {
  const { t } = useTranslation();
  // Card 40424fb3 — the bar consumes the agent metrics list (which carries the
  // backend-derived liveness column) instead of executions, so a runner that
  // crashed mid-card still surfaces as offline.
  const { data: agents } = useAgentMetrics(slug);
  const { data: inflight } = useInFlightExecutions(slug);
  // Bound-vs-alive is a board fact, not a workspace one: it answers "does this
  // board actually have a runner that will serve it", which the per-agent
  // badges can't, since a badge only exists for an agent the metrics list
  // returned.
  // boardId here is always the canonical UUID (BoardView passes board.id), so
  // it doubles as the WS-filter UUID — keeping this subscription exactly as
  // wide as the header chip's.
  const { data: loopStatus } = useBoardLoopStatus(slug, boardId, boardId);

  const allAgents = agents ?? [];
  const visibleAgents = boardAgentIds
    ? allAgents.filter((a) => boardAgentIds.includes(a.agent_id))
    : allAgents;

  // Card db510916 — board attribution has exactly one signal (an OPEN
  // execution row on this board), and a loop runner between iterations has
  // none: alive, bound, about to claim, attributed to nothing. Unmounting on
  // an empty set therefore hid the bar precisely when an operator was watching
  // for it, and took the bound-vs-alive split — which comes from /loop/status
  // and is team-binding derived, independent of any execution row — with it.
  // Render whenever EITHER signal has something to say; stay silent only when
  // attribution is still unknown (boardAgentIds undefined) or the board has
  // genuinely nothing to report.
  const hasPresenceToReport =
    !!loopStatus && (loopStatus.bound_agent_count > 0 || visibleAgents.length > 0);
  if (boardAgentIds === undefined && visibleAgents.length === 0) return null;
  if (visibleAgents.length === 0 && !hasPresenceToReport) return null;

  // Drives the "N working" headline only. Card 7a91173e removed the badge-level
  // override this used to feed: liveness is server-authoritative and the
  // backend already PROMOTES a genuinely-working runner to "alive", so a row
  // still reading "stale" next to an in-flight execution means the heartbeat
  // truly lapsed — masking that with a "working" badge hid real staleness from
  // operators.
  // Board-attributed only: the metrics `working` flag is workspace-wide and a
  // board-less execution belongs to no board — both counted phantom runners
  // onto every board (field lesson 2026-08-09). The flag still contributes for
  // agents already board-scoped by the caller via boardAgentIds.
  const workingAgentIds = new Set<string>([
    ...(boardAgentIds
      ? visibleAgents.filter((a) => a.working).map((a) => a.agent_id)
      : []),
    ...(inflight ?? [])
      .filter((e) => e.board_id === boardId)
      .map((e) => e.agent_id),
  ]);

  return (
    <RichTooltip i18nKey="kanban.agentStatusBar" side="bottom">
      <div className="flex items-center gap-2 rounded-lg border border-primary/10 bg-primary/5 px-3 py-1.5">
        <Bot className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-primary">
          {t("agents.agentsWorking", { count: workingAgentIds.size })}
        </span>
        {loopStatus ? (
          <span
            data-testid="agent-bar-presence"
            title={t("agents.presence.tooltip", {
              alive: loopStatus.alive_agent_count,
              bound: loopStatus.bound_agent_count,
            })}
            className="text-xs tabular-nums text-muted-foreground"
          >
            {t("agents.presence.aliveOfBound", {
              alive: loopStatus.alive_agent_count,
              bound: loopStatus.bound_agent_count,
            })}
          </span>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {visibleAgents.map((agent) => {
            const state = (agent.liveness ?? "unknown") as AgentLiveness;
            const { className, Icon } = LIVENESS_STYLES[state];
            return (
              <Badge
                key={agent.agent_id}
                variant="outline"
                data-liveness={state}
                className={`text-[0.6rem] ${className}`}
              >
                <Icon className="mr-1 h-3 w-3" />
                {agent.name}
                <span className="ml-1 opacity-80">
                  {t(`agents.liveness.${state}`)}
                </span>
              </Badge>
            );
          })}
        </div>
      </div>
    </RichTooltip>
  );
}
