// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Bot, Download, Pause, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { EntityLink } from "@/components/shared/EntityLink";
import { EmptyState } from "@/components/layout/EmptyState";
import { AgentLifecycleMenu } from "./AgentLifecycleMenu";
import { formatNumber, formatPercentage } from "@/lib/format";
import { useRunnerBasePath } from "../hooks/useRunnerBasePath";
import { downloadAgentConfigBundle } from "../utils/exportConfig";
import type { AgentMetric } from "../api/agents";

// null last_seen_at = never heartbeated. For freshly-created runners this is
// the "waiting to connect" window — distinguish it from an offline runner,
// which has heartbeated at some point and then went quiet.
//
// Card 7a91173e: online/offline comes from the server's `liveness` column, not
// from a client-side TTL over last_seen_at. The server owns the thresholds AND
// promotes a runner with an in-flight execution to alive, so a client fork
// could only ever disagree with the runner detail page about the same runner.
function agentStatus(agent: AgentMetric) {
  if (agent.last_seen_at === null) {
    return {
      label: "waitingToConnect",
      dot: "bg-[color:var(--color-data-3)]",
      pulse: true,
      detail: null as string | null,
    };
  }
  if (agent.liveness === "offline") {
    return { label: "offline", dot: "bg-muted-foreground/40", pulse: false, detail: null as string | null };
  }
  // Stale (90s–600s silent) renders as its own degraded state instead of
  // falling through to health_status — otherwise a runner quiet for 5 minutes
  // would read "idle"/"working", hiding exactly the degradation the status
  // bar surfaces.
  if (agent.liveness === "stale") {
    return { label: "liveness.stale", dot: "bg-amber-500", pulse: false, detail: null as string | null };
  }
  switch (agent.health_status) {
    case "working":
      return {
        label: "working",
        dot: "bg-emerald-500",
        pulse: true,
        detail: agent.health_current_card_id
          ? agent.health_current_card_id.length > 8
            ? agent.health_current_card_id.slice(0, 8) + "\u2026"
            : agent.health_current_card_id
          : null,
      };
    case "draining":
      return { label: "draining", dot: "bg-amber-500", pulse: false, detail: null };
    case "idle":
    default:
      return { label: "idle", dot: "bg-emerald-500", pulse: false, detail: null };
  }
}

function formatUptime(seconds: number | null): string {
  if (!seconds) return "\u2014";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface AgentTableProps {
  agents: AgentMetric[];
  slug: string;
  onCreate?: () => void;
  // agent_id → the roles it may take, aggregated across team memberships.
  // Optional: when absent (e.g. legacy mounts), the roles summary is hidden.
  rolesByAgent?: Record<string, string[]>;
}

export function AgentTable({ agents, slug, onCreate, rolesByAgent }: AgentTableProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { runnerDetail } = useRunnerBasePath();

  const handleExport = async (agent: AgentMetric) => {
    try {
      await downloadAgentConfigBundle(agent.agent_id, agent.name);
    } catch {
      toast.error(t("agents.configSaveError"));
    }
  };

  if (!agents.length) {
    return (
      <EmptyState
        icon={Bot}
        title={t("agents.title")}
        description={
          <>
            {t("agents.noAgents")}
            <span className="mt-2 block text-sm text-muted-foreground/80">
              {t("agents.emptyStateExplainer")}
            </span>
          </>
        }
        action={
          onCreate ? (
            <Button onClick={onCreate} className="gap-2">
              <Plus className="h-4 w-4" />
              {t("agents.createFirstRunner")}
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))] border border-border/70 bg-[color:var(--color-surface-1)] shadow-panel">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/40 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <th className="px-4 py-3">{t("agents.name")}</th>
              <th className="px-4 py-3">
                <RichTooltip i18nKey="runners.table.status" side="bottom">
                  <span>{t("agents.connection")}</span>
                </RichTooltip>
              </th>
              <th className="px-4 py-3">
                <RichTooltip i18nKey="runners.metrics.successRate" side="bottom">
                  <span>{t("agents.status")}</span>
                </RichTooltip>
              </th>
              <th className="px-4 py-3 text-right">{t("agents.executions")}</th>
              <th className="px-4 py-3 text-right">{t("agents.completed")}</th>
              <th className="px-4 py-3 text-right">{t("agents.failed")}</th>
              <th className="px-4 py-3 text-right">
                <RichTooltip i18nKey="runners.metrics.avgDuration" side="bottom">
                  <span>{t("agents.avgDuration")}</span>
                </RichTooltip>
              </th>
              <th className="px-4 py-3 text-right">{t("agents.totalTokens")}</th>
              <th className="px-4 py-3 text-right">{t("agents.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {agents.map((agent) => {
              const successRateRatio =
                agent.total_executions > 0
                  ? agent.completed_executions / agent.total_executions
                  : 0;
              const successRate = formatPercentage(
                successRateRatio,
                agent.total_executions > 0
                  ? { minimumFractionDigits: 1, maximumFractionDigits: 1 }
                  : undefined,
              );

              const status = agentStatus(agent);
              const hasHealth = agent.health_version || agent.health_uptime_seconds != null || agent.health_cards_processed != null;

              return (
                <tr
                  key={agent.agent_id}
                  className="cursor-pointer transition-colors duration-150 hover:bg-muted/30"
                  onClick={() => navigate(runnerDetail(agent.agent_id))}
                >
                  <td className="px-4 py-3 font-medium">
                    <span className="inline-flex items-center gap-2">
                      {agent.name}
                      {!agent.is_active && (
                        <Badge variant="secondary" className="opacity-80">
                          {t("agents.inactive")}
                        </Badge>
                      )}
                      {agent.is_active && agent.is_paused && (
                        <Badge variant="warning" className="gap-1">
                          <Pause className="h-3 w-3" />
                          {t("agents.paused")}
                        </Badge>
                      )}
                      {(agent.health_config_errors?.length ?? 0) > 0 && (
                        <Badge
                          variant="destructive"
                          className="gap-1 text-[0.6rem]"
                          title={agent.health_config_errors!
                            .map((c) => c.message)
                            .join("; ")}
                        >
                          <AlertTriangle className="h-3 w-3" />
                          {t("runners.table.configErrorBadge")}
                        </Badge>
                      )}
                    </span>
                    {rolesByAgent ? (
                      <RolesSummary roles={rolesByAgent[agent.agent_id]} />
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="relative inline-flex">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${status.dot}`}
                          />
                          {status.pulse && (
                            <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-75" />
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(`agents.${status.label}`)}
                        </span>
                        {status.detail &&
                          (agent.health_current_card_id &&
                          agent.health_current_board_id ? (
                            <span onClick={(e) => e.stopPropagation()}>
                              <EntityLink
                                type="card"
                                id={agent.health_current_card_id}
                                boardId={agent.health_current_board_id}
                                slug={slug}
                                className="text-[10px] font-mono text-primary hover:underline"
                              >
                                {status.detail}
                              </EntityLink>
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/70 font-mono">
                              {status.detail}
                            </span>
                          ))}
                        {agent.health_last_error && (
                          <span
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <RichTooltip
                              i18nKey="runners.table.healthLastError"
                              summary={agent.health_last_error}
                              side="top"
                            >
                              <AlertTriangle
                                className="h-3 w-3 text-amber-500"
                                aria-label={agent.health_last_error}
                              />
                            </RichTooltip>
                          </span>
                        )}
                      </span>
                      {hasHealth && (
                        <span className="text-[10px] text-muted-foreground/60 leading-tight">
                          {agent.health_version && <span>v{agent.health_version}</span>}
                          {agent.health_uptime_seconds != null && (
                            <span>{agent.health_version ? " \u00b7 " : ""}{formatUptime(agent.health_uptime_seconds)}</span>
                          )}
                          {agent.health_cards_processed != null && (
                            <span>
                              {" \u00b7 "}
                              {agent.health_cards_processed}ok
                              {agent.health_cards_failed ? `/${agent.health_cards_failed}err` : ""}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={
                        successRateRatio >= 0.9
                          ? "success"
                          : successRateRatio >= 0.5
                            ? "warning"
                            : "destructive"
                      }
                    >
                      {successRate}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatNumber(agent.total_executions)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatNumber(agent.completed_executions)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatNumber(agent.failed_executions)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatNumber(agent.avg_duration_seconds ?? 0, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    })}
                    s
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatNumber(agent.total_tokens_used)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleExport(agent);
                      }}
                      title={t("agents.exportConfig")}
                      aria-label={t("a11y.agents.exportConfig")}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                    <AgentLifecycleMenu
                      slug={slug}
                      agentId={agent.agent_id}
                      name={agent.name}
                      isActive={agent.is_active}
                      isPaused={agent.is_paused ?? false}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Compact "roles this runner may take" chips under the runner name. Two
// distinct empty-ish states, per the scheduler's semantics: `undefined` = no
// team membership at all — the runner has no pipeline and exits fatal on
// launch — while `[]` = bound with empty roles = role-agnostic (claims every
// pipeline role). Collapsing them showed "Any role" for runners that won't
// start (audit r2 finding 1).
function RolesSummary({ roles }: { roles: string[] | undefined }) {
  const { t } = useTranslation();
  if (roles === undefined) {
    return (
      <span className="mt-1 block text-[10px] text-[color:var(--color-warning)]">
        {t("runners.table.unbound")}
      </span>
    );
  }
  if (roles.length === 0) {
    return (
      <span className="mt-1 block text-[10px] text-muted-foreground/70">
        {t("runners.table.anyRole")}
      </span>
    );
  }
  const shown = roles.slice(0, 3);
  const extra = roles.length - shown.length;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
      {shown.map((role) => (
        <Badge key={role} variant="outline" className="text-[0.55rem] font-mono">
          {role}
        </Badge>
      ))}
      {extra > 0 && (
        <span className="text-[10px] text-muted-foreground/70">
          {t("runners.table.moreRoles", { count: extra })}
        </span>
      )}
    </span>
  );
}
