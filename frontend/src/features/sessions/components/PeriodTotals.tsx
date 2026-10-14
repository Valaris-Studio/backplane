// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { SessionPeriodSummary } from "@/types/agent-session";
import { formatTokens, formatUsd, formatWallTime } from "../utils/format";
import { COMPACT_LIST_QUERY } from "./SessionsTable";

interface PeriodTotalsProps {
  summary: SessionPeriodSummary;
  periodPhrase: string;
  partial: { filters: boolean; agent: boolean };
}

function summaryTokens(summary: SessionPeriodSummary): number {
  return summary.input_tokens + summary.output_tokens + summary.cache_read_tokens + summary.cache_creation_tokens;
}

// Plain text, not hero tiles: the period's totals, each cost under its own
// basis. API-equivalent is not money spent, so the two are never added.
export function PeriodTotals({ summary, periodPhrase, partial }: PeriodTotalsProps) {
  const { t } = useTranslation();
  const compact = useMediaQuery(COMPACT_LIST_QUERY);
  const unpriced = !summary.cost_complete ? (
    <span title={t("sessions.totals.unpriced")} className="cursor-help">
      <span aria-hidden>+</span>
      <span className="sr-only">{t("sessions.totals.unpricedLabel")}</span>
    </span>
  ) : null;
  const notes = [
    ...(partial.filters ? [t("sessions.totals.partial")] : []),
    ...(partial.agent ? [t("sessions.totals.partialAgent")] : []),
  ];
  const costs: { key: string; value: ReactNode; label: string }[] = [
    ...(summary.cost_api_equivalent_usd !== null
      ? [{ key: "api", value: <>{formatUsd(summary.cost_api_equivalent_usd)}{unpriced}</>, label: t("sessions.cost.apiEquivalent") }]
      : []),
    ...(summary.cost_spend_usd !== null
      ? [{ key: "spend", value: <>{formatUsd(summary.cost_spend_usd)}{unpriced}</>, label: t("sessions.cost.spend") }]
      : []),
  ];
  const facts = [
    { key: "sessions", value: summary.session_count, label: t("sessions.totals.sessions", { count: summary.session_count }) },
    { key: "wall", value: formatWallTime(summary.wall_duration_seconds), label: t("sessions.facts.wallTime") },
    { key: "tokens", value: formatTokens(summaryTokens(summary)), label: t("sessions.facts.tokens") },
    ...costs,
  ];
  const label = t("sessions.totals.label", { period: periodPhrase });

  if (compact) {
    // Three cells on a phone: count, wall time and the first cost basis.
    const cells = [facts[0], facts[1], costs[0] ?? facts[2]].filter((cell) => cell !== undefined);
    return (
      <div role="group" aria-label={label} className="flex w-full basis-full flex-col gap-1.5">
        <dl className="grid w-full grid-cols-3 divide-x divide-border overflow-hidden rounded-[var(--radius-cap)] border border-border bg-[color:var(--color-surface-1)]">
          {cells.map((cell) => (
            <div key={cell.key} className="flex flex-col-reverse px-3 py-2">
              <dt className="text-[0.75rem] text-muted-foreground">{cell.label}</dt>
              <dd className="font-display text-lg font-bold tabular-nums tracking-[-0.03em]">{cell.value}</dd>
            </div>
          ))}
        </dl>
        {notes.length ? <p className="text-[0.75rem] text-muted-foreground">{notes.join(" ")}</p> : null}
      </div>
    );
  }

  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[0.88rem] text-muted-foreground">
      {facts.map((fact) => (
        <span key={fact.key}>
          <b className="text-[1.02rem] font-bold tabular-nums text-foreground">{fact.value}</b> {fact.label}
        </span>
      ))}
      {notes.length ? <span className="text-[0.78rem]">{notes.join(" ")}</span> : null}
    </div>
  );
}
