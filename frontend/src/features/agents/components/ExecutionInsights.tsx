// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Lightbulb,
  MessageSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Stat } from "@/components/ui/stat";
import { EntityLink } from "@/components/shared/EntityLink";
import { formatDuration, formatNumber, formatUsd } from "@/lib/format";
import type { Execution } from "../api/agents";

interface ExecutionInsightsProps {
  execution: Execution;
  slug: string;
}

/**
 * tool_calls_count and tool_invocations are NOT two views of one number.
 * The MCP tracker reports the count on the execution PATCH and posts the
 * itemized rows to a separate endpoint; both are fire-and-forget, and non-MCP
 * runners report neither. So an execution can legitimately carry a reported
 * total with no rows behind it. Rendering that as "0" next to the header
 * tile's "3" reads as a contradiction rather than as missing detail — the
 * em-dash says "not captured", which is what actually happened.
 */
function itemizedToolCalls(execution: Execution): string {
  const itemized = execution.tool_invocations?.length ?? 0;
  if (itemized === 0 && execution.tool_calls_count > 0) return "—";
  return formatNumber(itemized);
}

export function ExecutionInsights({ execution, slug }: ExecutionInsightsProps) {
  const { t } = useTranslation();
  const isReview = execution.action?.includes("review");

  return (
    <div className="space-y-4">
      {execution.input_summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              {t("analytics.inputSummary")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {execution.input_summary}
            </p>
          </CardContent>
        </Card>
      )}

      {execution.output_summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Lightbulb className="h-4 w-4" />
              {isReview
                ? t("analytics.reviewDecision")
                : t("analytics.outputSummary")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap leading-relaxed">
              {execution.output_summary}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="flex items-center justify-between p-4">
          <Stat
            label={t("analytics.cost")}
            value={formatUsd(execution.cost_usd ?? 0, {
              minimumFractionDigits: 4,
              maximumFractionDigits: 4,
            })}
          />
          <Stat
            label={t("analytics.tokens")}
            value={formatNumber(execution.tokens_used ?? 0)}
          />
          <Stat
            data-testid="stat-itemized-tool-calls"
            label={t("analytics.itemizedToolCalls")}
            value={itemizedToolCalls(execution)}
          />
          {execution.duration_seconds != null && (
            <Stat
              label={t("analytics.duration")}
              value={formatDuration(execution.duration_seconds)}
            />
          )}
        </CardContent>
      </Card>

      {execution.error_message && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {t("analytics.errorDetails")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-muted p-3 rounded overflow-x-auto">
              {execution.error_message}
            </pre>
          </CardContent>
        </Card>
      )}

      {execution.cards_affected && execution.cards_affected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <RichTooltip i18nKey="execution.cardsAffected" side="top">
            <span className="text-xs text-muted-foreground">
              {t("analytics.cardsAffected")}:
            </span>
          </RichTooltip>
          <CardRefs
            cardIds={execution.cards_affected}
            detail={execution.cards_affected_detail}
            slug={slug}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Renders each affected card id as a titled deep-link when the backend resolved
 * it (cards_affected_detail), else a short-id badge. Deleted cards stay in the
 * raw id list but drop out of detail — those keep the truncated-id fallback so
 * the reference is still visible even when it can't be linked.
 */
export function CardRefs({
  cardIds,
  detail,
  slug,
}: {
  cardIds: string[];
  detail: Execution["cards_affected_detail"];
  slug: string;
}) {
  const byId = new Map(detail.map((ref) => [ref.id, ref]));
  return (
    <>
      {cardIds.map((id) => {
        const ref = byId.get(id);
        if (ref) {
          return (
            <EntityLink
              key={id}
              type="card"
              id={ref.id}
              boardId={ref.board_id ?? undefined}
              slug={slug}
              className="text-xs font-medium text-primary hover:underline"
            >
              {ref.title}
            </EntityLink>
          );
        }
        return (
          <Badge
            key={id}
            variant="outline"
            className="text-[0.6rem] font-mono"
            title={id}
          >
            {id.slice(0, 8)}
          </Badge>
        );
      })}
    </>
  );
}
