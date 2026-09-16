// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useWebSocketEvent } from "@/hooks/use-websocket";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { useResumeCostBreaker } from "@/features/workspaces/api/cost-breaker";

interface BreakerEventPayload {
  current_usd?: number;
  threshold_usd?: number;
  action?: string;
  window_seconds?: number;
}

interface BreakerState extends BreakerEventPayload {
  receivedAt: number;
}

// Banner shown to operators when the workspace cost circuit breaker fires.
// Hidden until the first cost.threshold_crossed event arrives (best-effort:
// no historical query yet); cleared by the resume CTA.
export function CostAlertBanner() {
  const { slug } = useParams();
  const { t } = useTranslation();
  const [state, setState] = useState<BreakerState | null>(null);
  const resumeMutation = useResumeCostBreaker(slug);

  useWebSocketEvent("cost.threshold_crossed", (event) => {
    const payload = (event.payload || {}) as BreakerEventPayload;
    // cost.threshold_crossed is dual-emitter: the circuit breaker and the alert
    // thresholds both publish under this name with disjoint payloads. This banner
    // handles only the breaker shape; the alert-threshold shape is handled by
    // useCostAlerts (toast). Ignore anything missing the breaker fields.
    if (typeof payload.current_usd !== "number") return;
    setState({ ...payload, receivedAt: Date.now() });
  });

  if (!state) return null;

  const isPause = state.action === "pause" || state.action === "kill_runner";
  const current =
    typeof state.current_usd === "number"
      ? formatNumber(state.current_usd, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : "?";
  const threshold =
    typeof state.threshold_usd === "number"
      ? formatNumber(state.threshold_usd, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : "?";

  async function handleResume() {
    try {
      await resumeMutation.mutateAsync();
      setState(null);
    } catch {
      // Surface failures via the mutation state; the banner stays visible
      // so the operator can retry.
    }
  }

  return (
    <div
      role="alert"
      className="border-b border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-[var(--page-shell-max)] flex-wrap items-center gap-3 px-4 py-2 text-sm">
        <span className="font-medium">
          {t("workspaces.costBreaker.bannerTitle")}
        </span>
        <span>
          {t("workspaces.costBreaker.currentUsd", { value: current })}
          {" / "}
          {t("workspaces.costBreaker.thresholdUsd", { value: threshold })}
        </span>
        {isPause ? (
          <Button
            size="sm"
            variant="outline"
            onClick={handleResume}
            disabled={resumeMutation.isPending}
          >
            {t("workspaces.costBreaker.resume")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
