// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { NumberTick } from "../../motion/NumberTick";
import { ShellFooter } from "../../shell/ShellFooter";
import { useEndedSessionsToday, useLiveSessions, type TrackedSession } from "../../stores/sessions";
import { COST_BASIS_LABEL, costOf, formatCost, formatTokens, totalTokens, type CostBasis } from "./format";

interface Totals {
  sessions: number;
  tokens: number;
  /** null when no session today has a known cost on that basis. */
  usdByBasis: Record<CostBasis, number | null>;
}

function todaysTotals(sessions: readonly TrackedSession[]): Totals {
  const totals: Totals = { sessions: sessions.length, tokens: 0, usdByBasis: { api_equivalent: null, spend: null } };
  for (const session of sessions) {
    totals.tokens += totalTokens(session.tokens);
    const cost = costOf(session);
    if (cost) totals.usdByBasis[cost.basis] = (totals.usdByBasis[cost.basis] ?? 0) + cost.usd;
  }
  return totals;
}

const formatTotalCost = (usd: number | null) => (usd === null ? "—" : formatCost(usd));

export function TotalsFooter() {
  const live = useLiveSessions();
  const endedToday = useEndedSessionsToday();
  const totals = todaysTotals([...live, ...endedToday]);
  return (
    <ShellFooter>
      <div className="home-totals" role="group" aria-label="Today’s totals">
        <span className="home-t-cell">
          <NumberTick className="home-t-v" value={String(totals.sessions)} />
          <span className="home-t-k">sessions today</span>
        </span>
        <span className="home-t-cell">
          <NumberTick className="home-t-v" value={formatTokens(totals.tokens)} />
          <span className="home-t-k">tokens</span>
        </span>
        <span className="home-t-cell home-t-costs">
          {(["api_equivalent", "spend"] as const).map((basis) => (
            <span key={basis}>
              <NumberTick className="home-t-v" value={formatTotalCost(totals.usdByBasis[basis])} /> <span className="home-t-k">{COST_BASIS_LABEL[basis]}</span>
            </span>
          ))}
        </span>
      </div>
    </ShellFooter>
  );
}
