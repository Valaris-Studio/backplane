// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/EmptyState";
import { extractPlainText } from "@/lib/text-utils";
import { useApprovals } from "@/features/approvals/hooks/useApprovals";
import { cn } from "@/lib/utils";

interface PendingApprovalsPanelProps {
  slug: string;
}

function RiskLabel({ score }: { score: number }) {
  const { t } = useTranslation();

  if (score < 40) {
    return (
      <span className="text-[color:var(--color-success-foreground)]">
        {score} ({t("approvals.risk.low")})
      </span>
    );
  }
  if (score <= 70) {
    return (
      <span className="text-[color:var(--color-warning-foreground)]">
        {score} ({t("approvals.risk.medium")})
      </span>
    );
  }
  return (
    <span className="text-destructive">
      {score} ({t("approvals.risk.high")})
    </span>
  );
}

export function PendingApprovalsPanel({ slug }: PendingApprovalsPanelProps) {
  const { t } = useTranslation();
  const { data: approvals, isLoading } = useApprovals(slug, "pending");

  if (isLoading) {
    return <Skeleton className="h-52 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />;
  }

  const pending = approvals ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg">
              {t("agents.pendingApprovals")}
            </CardTitle>
            {pending.length > 0 && (
              <Badge variant="warning">{pending.length}</Badge>
            )}
          </div>
          {pending.length > 0 && (
            <Link
              to={`/${slug}/approvals`}
              className="text-sm text-primary hover:underline"
            >
              {t("agents.viewAllApprovals")}
            </Link>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {pending.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title={t("agents.pendingApprovals")}
            description={t("agents.noPendingApprovals")}
          />
        ) : (
          <div className="space-y-2">
            {pending.map((approval) => (
              <div
                key={approval.id}
                className={cn(
                  "flex items-start justify-between gap-3 rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.15rem))]",
                  "border border-border/50 bg-[color:var(--color-surface-1)]/60 px-4 py-3",
                  "transition-colors duration-150 hover:border-border/80 hover:bg-muted/30",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">
                    {extractPlainText(approval.action_description)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {approval.agent_name ?? approval.agent_id.slice(0, 8)}
                    {" — "}
                    {t(`approvals.category.${approval.category}`)}
                  </p>
                </div>
                <div className="flex-shrink-0 text-right text-xs tabular-nums font-semibold">
                  <RiskLabel score={approval.risk_score} />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
