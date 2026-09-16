// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Copy,
  DollarSign,
  Coins,
  XCircle,
  AlertCircle,
  Loader2,
  PauseCircle,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/PageHeader";
import { ToolInvocationList } from "@/features/agents/components/ToolInvocationList";
import { ExecutionInsights } from "@/features/agents/components/ExecutionInsights";
import { EntityLink } from "@/components/shared/EntityLink";
import { useExecution, useAgentMetrics } from "@/features/agents/hooks/useAgentMetrics";
import { useRunnerBasePath } from "@/features/agents/hooks/useRunnerBasePath";
import { cn } from "@/lib/utils";
import { formatDuration, formatNumber, formatUsd } from "@/lib/format";
import { formatAbsolute } from "@/lib/date-format";
import { copyTextToClipboard } from "@/lib/clipboard";

type DetailTab = "overview" | "prompt";

const STATUS_CONFIG = {
  completed: { icon: CheckCircle2, variant: "success" as const },
  failed: { icon: XCircle, variant: "destructive" as const },
  running: { icon: Loader2, variant: "info" as const },
  started: { icon: Clock, variant: "default" as const },
  aborted: { icon: AlertCircle, variant: "warning" as const },
  skipped: { icon: PauseCircle, variant: "warning" as const },
} as const;

export function ExecutionDetailPage() {
  const { slug = "", executionId = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activity: activityHome } = useRunnerBasePath();

  const { data: execution, isLoading, isError } = useExecution(slug, executionId);
  const { data: agents } = useAgentMetrics(slug);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

  const agentName =
    agents?.find((a) => a.agent_id === execution?.agent_id)?.name ??
    execution?.agent_id.slice(0, 8) ??
    "";

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-24 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      </div>
    );
  }

  if (isError || !execution) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate(activityHome)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("executions.backToTimeline")}
        </Button>
        <p className="text-sm text-muted-foreground">{t("common.notFound")}</p>
      </div>
    );
  }

  const config = STATUS_CONFIG[execution.status];
  const StatusIcon = config.icon;
  const promptBody = execution.input_prompt ?? "";
  const hasPrompt = promptBody.length > 0;

  async function handleCopyPrompt() {
    const copiedSuccessfully = await copyTextToClipboard(promptBody);
    if (!copiedSuccessfully) return;
    toast.success(t("executions.prompt.copied"));
  }

  const tabs: { id: DetailTab; label: string }[] = [
    { id: "overview", label: t("executions.tabs.overview") },
    { id: "prompt", label: t("executions.tabs.prompt") },
  ];

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title={execution.action}
        description={`${agentName} -- ${formatAbsolute(execution.started_at, "second")}`}
        actions={
          <Button
            variant="ghost"
            onClick={() => navigate(activityHome)}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("executions.backToTimeline")}
          </Button>
        }
      />

      <nav
        role="tablist"
        aria-label={t("executions.detail")}
        className="flex gap-1 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border border-border/70 bg-[color:var(--color-surface-1)] p-1 shadow-soft"
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "relative z-10 flex items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.1rem))] px-4 py-2 text-sm font-medium transition-colors duration-200",
                isActive
                  ? "bg-[color:color-mix(in_oklab,var(--color-primary)_16%,transparent)] text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {activeTab === "overview" && (
        <div
          role="tabpanel"
          aria-label={t("executions.tabs.overview")}
          className="space-y-[var(--page-section-gap)]"
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <StatusIcon className={`h-5 w-5 ${execution.status === "running" ? "animate-spin" : ""}`} />
                <div>
                  <RichTooltip i18nKey="execution.status" side="bottom">
                    <Badge variant={config.variant}>
                      {t(`agents.executionStatus.${execution.status}`)}
                    </Badge>
                  </RichTooltip>
                  <p className="mt-1 text-xs text-muted-foreground">{t("agents.status")}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Clock className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold tabular-nums">
                    {execution.duration_seconds == null
                      ? "-"
                      : formatDuration(execution.duration_seconds)}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("executions.duration")}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Wrench className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold tabular-nums">
                    {execution.tool_calls_count}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("agents.toolCalls")}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Coins className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold tabular-nums">
                    {execution.tokens_used != null
                      ? formatNumber(execution.tokens_used)
                      : "-"}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("agents.tokens")}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <DollarSign className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold tabular-nums">
                    {execution.cost_usd != null
                      ? formatUsd(execution.cost_usd)
                      : "-"}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("agents.costLabel")}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2 p-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("agents.executionPrompt")}
                </span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {execution.prompt_slug ?? "—"}
                </code>
              </div>
              {execution.provider && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {t("agents.executionProvider")}
                  </span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {execution.provider}
                  </code>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("agents.executionModel")}
                </span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {execution.model ?? "—"}
                </code>
              </div>
            </CardContent>
          </Card>

          <ExecutionInsights execution={execution} slug={slug} />

          <Card>
            <CardHeader className="space-y-2">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Wrench className="h-4 w-4" />
                <RichTooltip i18nKey="execution.toolInvocations" side="bottom">
                  <span>{t("executions.toolInvocations")}</span>
                </RichTooltip>
                {execution.tool_invocations.length > 0 && (
                  <Badge variant="secondary">{execution.tool_invocations.length}</Badge>
                )}
              </CardTitle>
              {execution.cards_affected_detail.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {t("agents.workingCard")}
                  </span>
                  {execution.cards_affected_detail.map((ref) => (
                    <EntityLink
                      key={ref.id}
                      type="card"
                      id={ref.id}
                      boardId={ref.board_id ?? undefined}
                      slug={slug}
                      className="font-medium text-primary hover:underline"
                    >
                      {ref.title}
                    </EntityLink>
                  ))}
                  {execution.role ? (
                    <Badge variant="outline" className="text-[0.65rem]">
                      {execution.role}
                    </Badge>
                  ) : null}
                </div>
              )}
            </CardHeader>
            <CardContent>
              <ToolInvocationList invocations={execution.tool_invocations} />
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "prompt" && (
        <div
          role="tabpanel"
          aria-label={t("executions.tabs.prompt")}
          className="space-y-4"
        >
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="flex items-center gap-2 text-lg">
                {t("executions.renderedPrompt")}
                {hasPrompt && (
                  <Badge variant="secondary">
                    {t("executions.prompt.captured")}
                  </Badge>
                )}
              </CardTitle>
              {hasPrompt && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyPrompt}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  {t("executions.prompt.copy")}
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {hasPrompt ? (
                <pre
                  data-testid="execution-prompt-body"
                  className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs"
                >
                  {promptBody}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("executions.prompt.empty")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
