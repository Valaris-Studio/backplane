// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle,
  Clock,
  Coins,
  Download,
  Heart,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/PageHeader";
import { AgentConfigPanel } from "./AgentConfigPanel";
import { BudgetPanel } from "./BudgetPanel";
import { DangerZoneCard } from "./DangerZoneCard";
import { RunnerRoleBindingCard } from "./RunnerRoleBindingCard";
import { RunnerLaunchPanel } from "./onboarding/RunnerLaunchPanel";
import { AdvancedSection } from "./AdvancedSection";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { PausedBadge } from "./PausedBadge";
import { PauseToggle } from "./PauseToggle";
import {
  useAgentDetail,
  useAgentMetrics,
  usePollAgent,
  useUpdateAgent,
} from "../hooks/useAgentMetrics";
import { useRunnerBasePath } from "../hooks/useRunnerBasePath";
import { downloadAgentConfigBundle } from "../utils/exportConfig";
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercentage,
} from "@/lib/format";
import { resolvePipelineValidationMessage } from "@/lib/localized-errors";
import type { AgentMetric } from "../api/agents";

interface AgentDetailProps {
  slug: string;
  agentId: string;
}

export function AgentDetail({ slug, agentId }: AgentDetailProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { runnersList: runnersHome } = useRunnerBasePath();
  const { data: agents, isLoading, isError } = useAgentMetrics(slug);
  // Pause state lives on AgentRead (full agent row), not on the metrics
  // projection — fetch the detail to read is_paused. The hook is already
  // wired to invalidate on `agent.*` WS events.
  const { data: agentDetail } = useAgentDetail(agentId);
  const isPaused = agentDetail?.is_paused ?? false;

  const agent = agents?.find((a) => a.agent_id === agentId);

  if (isLoading) {
    return <AgentDetailSkeleton />;
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate(runnersHome)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("agents.title")}
        </Button>
        <p className="text-sm text-destructive">{t("common.loadError")}</p>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate(runnersHome)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("agents.title")}
        </Button>
        <p className="text-sm text-muted-foreground">{t("agents.notFound")}</p>
      </div>
    );
  }

  const successRate =
    agent.total_executions > 0
      ? formatPercentage(
          agent.completed_executions / agent.total_executions,
          { minimumFractionDigits: 1, maximumFractionDigits: 1 },
        )
      : formatPercentage(0);

  const handleExportConfig = async () => {
    try {
      await downloadAgentConfigBundle(agentId, agent.name);
    } catch {
      toast.error(t("agents.configSaveError"));
    }
  };

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            {agent.name}
            {isPaused && <PausedBadge />}
          </span>
        }
        description={t("agents.runnerDescription", {
          type: t(`agents.types.${agent.agent_type}`),
        })}
        actions={
          <div className="flex items-center gap-2">
            <PauseToggle slug={slug} agentId={agentId} isPaused={isPaused} />
            <Button variant="outline" size="sm" onClick={handleExportConfig}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t("agents.exportConfig")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => navigate(runnersHome)}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("agents.title")}
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("agents.executions")}
          value={agent.total_executions}
          icon={Bot}
        />
        <StatCard
          label={t("agents.successRate")}
          value={successRate}
          icon={CheckCircle}
        />
        <StatCard
          label={t("agents.avgDuration")}
          value={formatDuration(agent.avg_duration_seconds ?? 0)}
          icon={Clock}
        />
        <StatCard
          label={t("agents.totalTokens")}
          value={formatNumber(agent.total_tokens_used)}
          icon={Coins}
        />
      </div>

      <ScopeMismatchBanner agentId={agentId} slug={slug} />

      <HealthCard agent={agent} agentId={agentId} slug={slug} />

      <RunnerRoleBindingCard slug={slug} agentId={agentId} agentName={agent.name} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Rocket className="h-4 w-4" />
            {t("runner.launchPanel.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RunnerLaunchPanel slug={slug} agentId={agentId} agentName={agent.name} />
        </CardContent>
      </Card>

      <ExecutionTimeline
        slug={slug}
        agents={agents ?? []}
        defaultAgentId={agentId}
      />

      {/* Progressive disclosure: rate limits, budget, scope, and key rotation
          are power-user knobs touched rarely — collapsed by default so the
          operational view (health, roles, activity) stays focused. */}
      <AdvancedSection
        title={t("agents.advancedSettings")}
        hint={t("agents.advancedSettingsHint")}
      >
        <AgentConfigPanel agent={agent} agentId={agentId} slug={slug} />
        <BudgetPanel agentId={agentId} slug={slug} />
        <DangerZoneCard
          slug={slug}
          agentId={agentId}
          agentName={agent.name}
          lastKeyRotatedAt={agent.last_key_rotated_at}
        />
      </AdvancedSection>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <Icon className="h-5 w-5 text-muted-foreground" />
        <div>
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function ScopeMismatchBanner({
  agentId,
  slug,
}: {
  agentId: string;
  slug: string;
}) {
  const { t } = useTranslation();
  const { data: detail } = useAgentDetail(agentId);
  const updateAgent = useUpdateAgent(slug);

  // Null allowed_workspaces = unrestricted → no mismatch.
  const allowed = detail?.allowed_workspaces;
  if (!detail || allowed == null) return null;
  if (allowed.includes(slug)) return null;

  const handleAdd = () => {
    updateAgent.mutate({
      agentId,
      data: { allowed_workspaces: [...allowed, slug] },
    });
  };

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            {t("agents.scopeMismatchTitle")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("agents.scopeMismatchDescription", { workspace: slug })}
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={handleAdd}
        disabled={updateAgent.isPending}
      >
        {t("agents.addToWorkspace")}
      </Button>
    </div>
  );
}

function HealthCard({
  agent,
  agentId,
  slug,
}: {
  agent: AgentMetric;
  agentId: string;
  slug: string;
}) {
  const { t, i18n } = useTranslation();
  const pollMutation = usePollAgent(slug);

  // Card 7a91173e — server `liveness` is the single source of truth for
  // online/offline (it owns the heartbeat thresholds and promotes a runner
  // with an in-flight execution to alive). The old client-side 5-minute TTL
  // over last_seen_at could disagree with the runners table about the same
  // runner, in both directions.
  const online = agent.liveness !== "offline";
  // Stale (silent 90s–600s) keeps the page usable (poll still allowed) but
  // must not wear the green health badge — same degraded treatment as the
  // runners table and the board status bar.
  const stale = agent.liveness === "stale";
  const waitingToConnect = agent.last_seen_at === null;

  const handlePollNow = () => {
    pollMutation.mutate(agentId, {
      onSuccess: () => toast.success(t("agents.pollTriggered")),
      onError: () => toast.error(t("agents.pollFailed")),
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Heart className="h-4 w-4" />
          {t("agents.health")}
          <Badge
            variant={
              stale
                ? "warning"
                : online
                  ? "success"
                  : waitingToConnect
                    ? "outline"
                    : "secondary"
            }
          >
            {stale
              ? t("agents.liveness.stale")
              : online
                ? t(`agents.${agent.health_status ?? "idle"}`)
                : waitingToConnect
                  ? t("agents.waitingToConnect")
                  : t("agents.offline")}
          </Badge>
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={handlePollNow}
          disabled={!online || pollMutation.isPending}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${pollMutation.isPending ? "animate-spin" : ""}`} />
          {t("agents.pollNow")}
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <HealthField label={t("agents.version")} value={agent.health_version} />
          <HealthField
            label={t("agents.uptime")}
            value={
              agent.health_uptime_seconds != null
                ? formatUptime(agent.health_uptime_seconds)
                : null
            }
          />
          <HealthField
            label={t("agents.cardsProcessed")}
            value={agent.health_cards_processed?.toString()}
          />
          <HealthField
            label={t("agents.cardsFailed")}
            value={agent.health_cards_failed?.toString()}
          />
          <HealthField label={t("agents.lastError")} value={agent.health_last_error} />
          <HealthField
            label={t("agents.lastErrorAt")}
            value={
              agent.health_last_error_at
                ? formatDateTime(agent.health_last_error_at)
                : null
            }
          />
        </div>
        {agent.health_config_errors && agent.health_config_errors.length > 0 && (
          <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              {t("agents.configErrors")}
            </div>
            <ul className="space-y-1">
              {agent.health_config_errors.map((err, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0">
                    {err.code}
                  </Badge>
                  <span>
                    {resolvePipelineValidationMessage(
                      {
                        code: err.code,
                        field: err.stage ?? "",
                        params: err.params,
                      },
                      t,
                      i18n,
                    )}
                    {err.stage && (
                      <code className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px]">{err.stage}</code>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HealthField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium truncate">{value ?? "\u2014"}</p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function AgentDetailSkeleton() {
  return (
    <div className="space-y-[var(--page-section-gap)]">
      <Skeleton className="h-24 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
        ))}
      </div>
      <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      <Skeleton className="h-64 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
    </div>
  );
}
