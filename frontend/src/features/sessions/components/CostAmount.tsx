// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { CostBasis, CostSource } from "@/types/agent-session";
import { formatUsd } from "../utils/format";

interface CostAmountProps {
  amount: number | null;
  basis: CostBasis | null;
  source: CostSource | null;
  complete: boolean;
  className?: string;
}

// A cost is never shown without its basis: API-equivalent is what a
// subscription's tokens would cost at list price, spend is money billed.
export function CostAmount({ amount, basis, source, complete, className }: CostAmountProps) {
  const { t } = useTranslation();

  if (amount === null) {
    return <span className={cn("text-sm text-muted-foreground", className)}>{t("sessions.cost.none")}</span>;
  }

  return (
    <span className={cn("inline-flex flex-col items-end leading-tight", className)}>
      <span className="inline-flex items-baseline gap-1 text-[0.95rem] font-bold tabular-nums text-foreground">
        {formatUsd(amount)}
        {!complete ? (
          <span title={t("sessions.cost.incompleteHint")} className="cursor-help text-muted-foreground">
            +
          </span>
        ) : null}
      </span>
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-[0.78rem] font-medium text-muted-foreground">
        {basis ? t(basis === "spend" ? "sessions.cost.spend" : "sessions.cost.apiEquivalent") : null}
        {source === "estimated" ? (
          <span
            title={t("sessions.cost.estimatedHint")}
            className="rounded-[var(--radius-cap)] border border-border px-1 text-[0.75rem] font-bold"
          >
            {t("sessions.cost.estimated")}
          </span>
        ) : null}
      </span>
    </span>
  );
}
