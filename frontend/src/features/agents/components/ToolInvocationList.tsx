// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  ChevronDown,
  Clock,
  AlertCircle,
  Loader2,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/layout/EmptyState";
import { formatDuration } from "@/lib/format";
import type { ToolInvocation } from "../api/agents";

interface ToolInvocationListProps {
  invocations: ToolInvocation[];
}

const TOOL_STATUS_CONFIG = {
  completed: { icon: CheckCircle2, variant: "success" as const, color: "text-[color:var(--color-success-foreground)]" },
  failed: { icon: AlertCircle, variant: "destructive" as const, color: "text-destructive" },
  started: { icon: Loader2, variant: "info" as const, color: "text-[color:var(--color-info-foreground)]" },
} as const;

function formatToolDuration(seconds: number | null): string {
  if (seconds == null) return "-";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return formatDuration(seconds);
}

function InvocationRow({ invocation }: { invocation: ToolInvocation }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const config = TOOL_STATUS_CONFIG[invocation.status] ?? TOOL_STATUS_CONFIG.started;
  const StatusIcon = config.icon;

  const expandable = !!(invocation.arguments_summary || invocation.result_summary || invocation.error_message);

  return (
    <div className="rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.15rem))] border border-border/50 bg-[color:var(--color-surface-1)]/60 transition-colors duration-150 hover:border-border/80 hover:bg-muted/30">
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
        onClick={() => expandable && setExpanded(!expanded)}
        aria-expanded={expandable ? expanded : undefined}
      >
        <div className={`mt-0.5 flex-shrink-0 ${config.color}`}>
          <StatusIcon className={`h-4 w-4 ${invocation.status === "started" ? "animate-spin" : ""}`} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-foreground">
              {invocation.tool_name}
            </span>
            <Badge variant={config.variant}>
              {t(`executions.status.${invocation.status}`)}
            </Badge>
          </div>

          <div className="mt-1 flex items-center gap-3 text-[0.65rem] text-muted-foreground/80">
            {invocation.duration_seconds != null && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatToolDuration(invocation.duration_seconds)}
              </span>
            )}
            <span className="tabular-nums">#{invocation.position + 1}</span>
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
          {invocation.error_message && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wider text-destructive">
                {t("agents.errorDetails")}
              </p>
              <p className="whitespace-pre-wrap text-xs text-destructive/90">
                {invocation.error_message}
              </p>
            </div>
          )}

          {invocation.arguments_summary && (
            <div>
              <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("executions.arguments")}
              </p>
              <pre className="whitespace-pre-wrap text-xs text-muted-foreground/90 leading-relaxed font-mono bg-muted/30 rounded-lg px-3 py-2">
                {invocation.arguments_summary}
              </pre>
            </div>
          )}

          {invocation.result_summary && (
            <div>
              <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("executions.result")}
              </p>
              <pre className="whitespace-pre-wrap text-xs text-muted-foreground/90 leading-relaxed font-mono bg-muted/30 rounded-lg px-3 py-2">
                {invocation.result_summary}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolInvocationList({ invocations }: ToolInvocationListProps) {
  const { t } = useTranslation();

  if (!invocations.length) {
    return (
      <EmptyState
        icon={Wrench}
        title={t("executions.toolInvocations")}
        description={t("executions.noInvocations")}
      />
    );
  }

  const sorted = [...invocations].sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-2">
      {sorted.map((invocation) => (
        <InvocationRow key={invocation.id} invocation={invocation} />
      ))}
    </div>
  );
}
