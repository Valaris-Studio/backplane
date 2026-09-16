// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  DollarSign,
  ExternalLink,
  Loader2,
  PauseCircle,
  RefreshCw,
  SquareStack,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { cn } from "@/lib/utils";
import { formatDuration, formatNumber, formatUsd } from "@/lib/format";
import { formatAbsolute } from "@/lib/date-format";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/EmptyState";
import { EntityLink } from "@/components/shared/EntityLink";
import { CardRefs } from "./ExecutionInsights";
import { useExecutions } from "../hooks/useAgentMetrics";
import { usePipelineConfig } from "../hooks/usePipelineConfig";
import { useRunnerBasePath } from "../hooks/useRunnerBasePath";
import type { AgentMetric, ExecutionSummary } from "../api/agents";

interface ExecutionTimelineProps {
  slug: string;
  agents: AgentMetric[];
  defaultAgentId?: string;
}

const STATUS_CONFIG = {
  completed: { icon: CheckCircle2, variant: "success" as const, color: "text-[color:var(--color-success-foreground)]" },
  failed: { icon: XCircle, variant: "destructive" as const, color: "text-destructive" },
  running: { icon: Loader2, variant: "info" as const, color: "text-[color:var(--color-info-foreground)]" },
  started: { icon: Clock, variant: "default" as const, color: "text-primary" },
  aborted: { icon: AlertCircle, variant: "warning" as const, color: "text-[color:var(--color-warning-foreground)]" },
  skipped: { icon: PauseCircle, variant: "warning" as const, color: "text-[color:var(--color-warning-foreground)]" },
} as const;


function formatCost(usd: number): string {
  return formatUsd(usd);
}

function agentNameById(agents: AgentMetric[], agentId: string): string {
  return agents.find((a) => a.agent_id === agentId)?.name ?? agentId.slice(0, 8);
}

function hasExpandableContent(execution: ExecutionSummary): boolean {
  return !!(
    execution.output_summary ||
    execution.cards_affected?.length ||
    execution.error_message ||
    execution.cost_usd != null ||
    execution.ship_warnings?.length
  );
}

function ExecutionRow({
  execution,
  agents,
  roleColors,
  slug,
}: {
  execution: ExecutionSummary;
  agents: AgentMetric[];
  roleColors: Record<string, string>;
  slug: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { executionDetail } = useRunnerBasePath();
  const [expanded, setExpanded] = useState(false);
  const config = STATUS_CONFIG[execution.status];
  const StatusIcon = config.icon;
  const expandable = hasExpandableContent(execution);

  return (
    <div className="rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.15rem))] border border-border/50 bg-[color:var(--color-surface-1)]/60 transition-colors duration-150 hover:border-border/80 hover:bg-muted/30">
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
        onClick={() => expandable && setExpanded(!expanded)}
        aria-expanded={expandable ? expanded : undefined}
        aria-label={expandable ? t(expanded ? "agents.collapseDetails" : "agents.expandDetails") : undefined}
      >
        <div className={`mt-0.5 flex-shrink-0 ${config.color}`}>
          <StatusIcon className={`h-4 w-4 ${execution.status === "running" ? "animate-spin" : ""}`} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {execution.action}
            </span>
            <RichTooltip i18nKey="execution.status" side="top">
              <Badge variant={config.variant}>
                {t(`agents.executionStatus.${execution.status}`)}
              </Badge>
            </RichTooltip>
            {execution.role && (
              <RichTooltip i18nKey="execution.role" side="top">
                <Badge
                  variant="outline"
                  className={cn("text-[0.6rem]", roleColors[execution.role])}
                >
                  {t(`teams.roles.${execution.role}`, { defaultValue: execution.role })}
                </Badge>
              </RichTooltip>
            )}
            {execution.parent_execution_id && (
              <RichTooltip i18nKey="execution.parentExecution" side="top">
                <span className="flex items-center gap-1 text-[0.65rem] text-muted-foreground/80">
                  <RefreshCw className="h-3 w-3" />
                  {t("agents.retryOf")}{" "}
                  <EntityLink
                    type="execution"
                    id={execution.parent_execution_id}
                    slug={slug}
                    className="text-primary hover:underline"
                  >
                    {execution.parent_execution_id.slice(0, 8)}
                  </EntityLink>
                </span>
              </RichTooltip>
            )}
            {execution.ship_warnings?.length ? (
              <RichTooltip i18nKey="execution.shipWarnings" side="top">
                <Badge
                  variant="outline"
                  className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                >
                  <AlertTriangle className="h-3 w-3" />
                  {t("agents.shipWarningsCount", { count: execution.ship_warnings.length })}
                </Badge>
              </RichTooltip>
            ) : null}
            {execution.cost_usd != null && (
              <span className="ml-auto flex items-center gap-1 text-[0.65rem] text-muted-foreground/80">
                <DollarSign className="h-3 w-3" />
                {formatCost(execution.cost_usd)}
              </span>
            )}
          </div>

          <p className="mt-0.5 text-xs text-muted-foreground">
            {agentNameById(agents, execution.agent_id)}
            {" \u2014 "}
            {execution.input_summary}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[0.65rem] text-muted-foreground/80">
            <span>{formatAbsolute(execution.started_at)}</span>
            {execution.duration_seconds != null && (
              <span>{formatDuration(execution.duration_seconds)}</span>
            )}
            {execution.tool_calls_count > 0 && (
              <span>
                {execution.tool_calls_count} {t("agents.toolCalls")}
              </span>
            )}
            {execution.tokens_used != null && (
              <span>
                {formatNumber(execution.tokens_used)} {t("agents.tokens")}
              </span>
            )}
            {execution.prompt_slug && (
              <span data-testid="execution-prompt-slot">
                {t("agents.executionPrompt")}:{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  {execution.prompt_slug}
                </code>
              </span>
            )}
            {execution.provider && (
              <span data-testid="execution-provider-slot">
                {t("agents.executionProvider")}:{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  {execution.provider}
                </code>
              </span>
            )}
            {execution.model && (
              <span data-testid="execution-model-slot">
                {t("agents.executionModel")}:{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  {execution.model}
                </code>
              </span>
            )}
            {execution.cards_affected?.length ? (
              <RichTooltip i18nKey="execution.cardsAffected" side="top">
                <span className="flex items-center gap-1">
                  <SquareStack className="h-3 w-3" />
                  {execution.cards_affected.length}
                </span>
              </RichTooltip>
            ) : null}
          </div>
        </div>

        {expandable && (
          <ChevronDown
            className={`mt-1 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`}
          />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/40 px-4 py-3 space-y-3">
          {execution.error_message && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wider text-destructive">
                {t("agents.errorDetails")}
              </p>
              <p className="whitespace-pre-wrap text-xs text-destructive/90">
                {execution.error_message}
              </p>
            </div>
          )}

          {execution.output_summary && (
            <div>
              <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("agents.outputSummary")}
              </p>
              <p className="whitespace-pre-wrap text-xs text-muted-foreground/90 leading-relaxed">
                {execution.output_summary}
              </p>
            </div>
          )}

          {execution.ship_warnings?.length ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <p className="mb-1 flex items-center gap-1 text-[0.65rem] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {t("agents.shipWarnings")}
              </p>
              <ul className="list-disc space-y-1 pl-4 text-xs text-amber-700/90 dark:text-amber-300/90">
                {execution.ship_warnings.map((warning, idx) => (
                  <li key={idx} className="whitespace-pre-wrap">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {execution.cards_affected?.length ? (
            <div>
              <p className="mb-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("agents.cardsAffected")}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <CardRefs
                  cardIds={execution.cards_affected}
                  detail={execution.cards_affected_detail}
                  slug={slug}
                />
              </div>
            </div>
          ) : null}

          {execution.cost_usd != null && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5" />
              <span className="font-semibold uppercase tracking-wider text-[0.65rem]">
                {t("agents.costLabel")}:
              </span>
              <span>{formatCost(execution.cost_usd)}</span>
            </div>
          )}

          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
            onClick={() => navigate(executionDetail(execution.id))}
          >
            <ExternalLink className="h-3 w-3" />
            {t("executions.viewDetails")}
          </button>
        </div>
      )}
    </div>
  );
}

export function ExecutionTimeline({ slug, agents, defaultAgentId }: ExecutionTimelineProps) {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState(defaultAgentId ?? "all");
  const [roleFilter, setRoleFilter] = useState("all");
  const { roles: FILTERABLE_ROLES, roleColorMap: ROLE_COLORS } = usePipelineConfig(slug);

  const filters = {
    ...(statusFilter !== "all" && { status: statusFilter }),
    ...(agentFilter !== "all" && { agent_id: agentFilter }),
  };

  const { data: executions, isLoading } = useExecutions(
    slug,
    Object.keys(filters).length > 0 ? filters : undefined,
  );

  const filteredExecutions = roleFilter === "all"
    ? executions
    : executions?.filter((e) => e.role === roleFilter);

  if (isLoading) {
    return <Skeleton className="h-64 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-lg">
            {t("agents.executionTimeline")}
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue placeholder={t("agents.allStatuses")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("agents.allStatuses")}</SelectItem>
                <SelectItem value="completed">{t("agents.executionStatus.completed")}</SelectItem>
                <SelectItem value="failed">{t("agents.executionStatus.failed")}</SelectItem>
                <SelectItem value="running">{t("agents.executionStatus.running")}</SelectItem>
                <SelectItem value="started">{t("agents.executionStatus.started")}</SelectItem>
                <SelectItem value="aborted">{t("agents.executionStatus.aborted")}</SelectItem>
              </SelectContent>
            </Select>

            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue placeholder={t("agents.allAgents")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("agents.allAgents")}</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.agent_id} value={a.agent_id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue placeholder={t("agents.allRoles")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("agents.allRoles")}</SelectItem>
                {FILTERABLE_ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {t(`teams.roles.${role}`, { defaultValue: role })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!filteredExecutions?.length ? (
          <EmptyState
            icon={Activity}
            title={t("agents.executionTimeline")}
            description={t("agents.noExecutions")}
          />
        ) : (
          <div className="space-y-2">
            {filteredExecutions.map((execution) => (
              <ExecutionRow
                key={execution.id}
                execution={execution}
                agents={agents}
                roleColors={ROLE_COLORS}
                slug={slug}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
