// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  useAlertThresholds,
  useDeleteAlert,
  useUpdateAlert,
} from "../hooks/useAlerts";
import { CreateAlertDialog } from "./CreateAlertDialog";
import type { AlertThreshold } from "../api/alerts";

const OPERATOR_LABELS: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "=",
};

interface AlertThresholdListProps {
  slug: string;
  boardId?: string;
  // True when the caller is board-scoped by design (e.g. BoardAlertsPage)
  // but the board hasn't resolved to its canonical id yet — holds the fetch
  // instead of falling through to `useAlertThresholds`'s no-boardId branch,
  // which means "workspace-wide" and would flash the wrong list.
  boardPending?: boolean;
}

function AlertRow({
  threshold,
  slug,
  boardId,
}: {
  threshold: AlertThreshold;
  slug: string;
  boardId?: string;
}) {
  const { t } = useTranslation();
  const updateAlert = useUpdateAlert(slug, boardId);
  const deleteAlert = useDeleteAlert(slug, boardId);

  return (
    <div className="flex items-center justify-between gap-3 rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.15rem))] border border-border/50 bg-[color:var(--color-surface-1)]/60 px-4 py-3 transition-colors duration-150 hover:border-border/80 hover:bg-muted/30">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {threshold.name}
          </span>
          <Badge variant={threshold.is_active ? "success" : "secondary"}>
            {threshold.is_active ? t("alerts.active") : t("alerts.inactive")}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(`alerts.metrics.${threshold.metric}`)}{" "}
          {OPERATOR_LABELS[threshold.operator] ?? threshold.operator}{" "}
          {threshold.value}
        </p>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            updateAlert.mutate({
              thresholdId: threshold.id,
              data: { is_active: !threshold.is_active },
            })
          }
        >
          {threshold.is_active ? t("alerts.disable") : t("alerts.enable")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={() => deleteAlert.mutate(threshold.id)}
          aria-label={t("a11y.alerts.deleteThreshold")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function AlertThresholdList({
  slug,
  boardId,
  boardPending,
}: AlertThresholdListProps) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const { data: thresholds, isLoading } = useAlertThresholds(slug, boardId, {
    enabled: !boardPending,
  });

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-20 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
        <Skeleton className="h-48 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      </div>
    );
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        slim
        title={t("alerts.title")}
        actions={
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            {t("alerts.create")}
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            <RichTooltip i18nKey="budget.alerts" side="bottom">
              <span>{t("alerts.thresholds")}</span>
            </RichTooltip>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!thresholds?.length ? (
            <EmptyState
              icon={Bell}
              title={t("alerts.title")}
              description={t("alerts.noThresholds")}
              action={
                <Button
                  variant="outline"
                  onClick={() => setCreateOpen(true)}
                  className="mt-3 gap-2"
                >
                  <Plus className="h-4 w-4" />
                  {t("alerts.create")}
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {thresholds.map((threshold) => (
                <AlertRow
                  key={threshold.id}
                  threshold={threshold}
                  slug={slug}
                  boardId={boardId}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateAlertDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        slug={slug}
        boardId={boardId}
      />
    </div>
  );
}
