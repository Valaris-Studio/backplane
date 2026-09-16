// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DollarSign, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { formatNumber, formatUsd } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { useBudgetStatus, useUpdateAgent } from "../hooks/useAgentMetrics";

interface BudgetPanelProps {
  agentId: string;
  slug: string;
}

export function BudgetPanel({ agentId, slug }: BudgetPanelProps) {
  const { t } = useTranslation();
  const { data: status, isLoading } = useBudgetStatus(agentId);
  const updateAgent = useUpdateAgent(slug);
  const [budgetInput, setBudgetInput] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (status && !editing) {
      setBudgetInput(status.budget_usd?.toString() ?? "");
    }
  }, [status, editing]);

  function handleSave() {
    const value = budgetInput.trim() === "" ? null : parseFloat(budgetInput);
    updateAgent.mutate(
      { agentId, data: { budget_usd: value } },
      { onSuccess: () => setEditing(false) },
    );
  }

  if (isLoading) {
    return <Skeleton className="h-40 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />;
  }

  const progressValue =
    status?.percentage_used != null
      ? Math.min(status.percentage_used, 100)
      : 0;

  const progressVariant =
    status?.is_exceeded
      ? "text-destructive"
      : (status?.percentage_used ?? 0) > 80
        ? "text-warning"
        : "text-primary";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <DollarSign className="h-4 w-4" />
          <RichTooltip i18nKey="budget.usage">
            <span>{t("agents.budgetStatus")}</span>
          </RichTooltip>
          {status?.is_exceeded && (
            <RichTooltip i18nKey="budget.exceeded" side="bottom">
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                {t("agents.budgetExceeded")}
              </Badge>
            </RichTooltip>
          )}
          {status?.budget_usd == null && !status?.is_exceeded && (
            <Badge variant="secondary">{t("agents.noBudget")}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status?.budget_usd != null && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className={progressVariant}>
                {t("agents.budgetUsed", {
                  percentage:
                    status.percentage_used != null
                      ? formatNumber(status.percentage_used, {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1,
                        })
                      : formatNumber(0),
                })}
              </span>
              <span className="text-muted-foreground">
                {formatUsd(status.spent_usd)} / {formatUsd(status.budget_usd)}
              </span>
            </div>
            <Progress value={progressValue} className="h-2" />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">
              {t("agents.budgetUsd")}
            </p>
            <p className="text-sm font-medium">
              {status?.budget_usd != null
                ? formatUsd(status.budget_usd)
                : "\u2014"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {t("agents.spent")}
            </p>
            <p className="text-sm font-medium">
              {formatUsd(status?.spent_usd ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              <RichTooltip i18nKey="budget.periodReset" side="top">
                <span>{t("agents.remaining")}</span>
              </RichTooltip>
            </p>
            <p className="text-sm font-medium">
              {status?.remaining_usd != null
                ? formatUsd(status.remaining_usd)
                : "\u2014"}
            </p>
          </div>
        </div>

        <div className="flex items-end gap-2 pt-2">
          <div className="flex-1">
            <label htmlFor="budget-input" className="text-xs text-muted-foreground">
              {t("agents.budgetUsd")}
            </label>
            <Input
              id="budget-input"
              type="number"
              min="0"
              step="0.01"
              placeholder={t("agents.noBudget")}
              value={budgetInput}
              onChange={(e) => {
                setEditing(true);
                setBudgetInput(e.target.value);
              }}
            />
          </div>
          {editing && (
            <Button
              size="sm"
              onClick={handleSave}
              disabled={updateAgent.isPending}
            >
              {t("agents.saveBudget")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
