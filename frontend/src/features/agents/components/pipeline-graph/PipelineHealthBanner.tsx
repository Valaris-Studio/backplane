// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PipelineHealthSummary } from "@/features/agents/utils/lifecycle-graph";

interface PipelineHealthBannerProps {
  health: PipelineHealthSummary;
}

/**
 * The strand-class headline for the graph overview: rolls up dead-ends, broken
 * links, and decision-without-on_failure gaps across all roles into one line so
 * a reader sees pipeline health before drilling in.
 */
export function PipelineHealthBanner({ health }: PipelineHealthBannerProps) {
  const { t } = useTranslation();

  if (health.ok) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-success)]/40 bg-[color:var(--color-success)]/10 px-3 py-2 text-sm text-[color:var(--color-success)]">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>{t("pipelineGraph.healthOk")}</span>
      </div>
    );
  }

  const parts: string[] = [];
  if (health.strandCount > 0) {
    parts.push(t("pipelineGraph.healthStrands", { count: health.strandCount }));
  }
  if (health.danglingCount > 0) {
    parts.push(t("pipelineGraph.healthDangling", { count: health.danglingCount }));
  }
  if (health.missingFailureFallbackCount > 0) {
    parts.push(
      t("pipelineGraph.healthFailureGaps", {
        count: health.missingFailureFallbackCount,
      }),
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-md)] border px-3 py-2 text-sm",
        "border-destructive/50 bg-destructive/10 text-destructive",
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="font-medium">{parts.join(" · ")}</span>
      {health.affectedRoles.length > 0 ? (
        <span className="text-destructive/80">
          {t("pipelineGraph.healthAffected", {
            roles: health.affectedRoles.join(", "),
          })}
        </span>
      ) : null}
    </div>
  );
}
