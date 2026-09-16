// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useWebSocketEvent } from "@/hooks/use-websocket";

export function useCostAlerts() {
  const { t } = useTranslation();

  useWebSocketEvent("cost.threshold_crossed", (event) => {
    const payload = event.payload;
    // cost.threshold_crossed is dual-emitter: the circuit breaker and the alert
    // thresholds both publish under this name with disjoint payloads. This
    // consumer handles only the alert-threshold shape; the breaker shape is
    // handled by CostAlertBanner. Ignore anything missing the alert fields.
    if (
      typeof payload.current_value !== "number" ||
      typeof payload.metric !== "string"
    ) {
      return;
    }
    toast.warning(
      t("alerts.costThresholdCrossed", {
        metric: t(`alerts.metrics.${payload.metric}`),
        value: payload.current_value,
      }),
    );
  });
}
