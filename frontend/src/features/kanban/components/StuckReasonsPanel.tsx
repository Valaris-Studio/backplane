// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import type { StuckReason, StuckReasonKey } from "../utils/stuckReasons";

// Maps the StuckReason's internal key to the matching kanban.stuckReasons.*
// tooltip leaf. Keeping the map explicit avoids silently authoring tooltips
// against typos when new reason keys are added. Exported so the i18n contract
// tests can hold every entry to the locale files.
export const REASON_TOOLTIP_KEY: Record<StuckReasonKey, string> = {
  blockedColumn: "kanban.stuckReasons.blockedColumn",
  needsAdvisor: "kanban.stuckReasons.needsAdvisor",
  noHero: "kanban.stuckReasons.noHero",
  awaitingPrompt: "kanban.stuckReasons.awaitingPrompt",
  requestChanges: "kanban.stuckReasons.requestChanges",
  recentFailures: "kanban.stuckReasons.recentFailures",
  stale: "kanban.stuckReasons.stale",
};

interface Props {
  reasons: StuckReason[];
  // Whether the card is in a "terminal" state (Done) where reasons are
  // irrelevant. If true, the panel renders nothing — we don't pretend an
  // unfinished card exists when the user has already shipped.
  suppressed?: boolean;
}

export function StuckReasonsPanel({ reasons, suppressed = false }: Props) {
  const { t } = useTranslation();

  if (suppressed) return null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {t("agentic.card.stuckTitle")}
        </h3>
        {reasons.length > 0 && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("agentic.card.stuckHint")}
          </p>
        )}
      </div>

      {reasons.length === 0 ? (
        <div className="flex items-center gap-2 rounded-[calc(var(--radius-md))] border border-border/60 bg-[color:var(--color-surface-1)] px-3 py-2 text-xs text-muted-foreground">
          <CheckCircle2
            className="h-3.5 w-3.5 text-[color:var(--color-success-foreground)]"
            aria-hidden
          />
          {t("agentic.card.stuckAllClear")}
        </div>
      ) : (
        <ul className="space-y-2">
          {reasons.map((reason) => {
            const titleKey = `agentic.card.reason${toPascal(reason.key)}.title`;
            const bodyKey = `agentic.card.reason${toPascal(reason.key)}.body`;
            return (
              <li
                key={reason.key}
                className="flex gap-2.5 rounded-[calc(var(--radius-md))] border border-warning/30 bg-warning/5 px-3 py-2.5"
              >
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
                  aria-hidden
                />
                <div className="space-y-1">
                  <RichTooltip i18nKey={REASON_TOOLTIP_KEY[reason.key]} side="top">
                    <p className="text-xs font-semibold text-foreground">
                      {t(titleKey, reason.values ?? {})}
                    </p>
                  </RichTooltip>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t(bodyKey, reason.values ?? {})}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// i18n keys live as `reasonBlockedColumn` / `reasonNoHero` etc. StuckReasonKey
// is camelCase already (`blockedColumn`); this just capitalises the first
// letter so we can compose `reason${Key}` without duplicating the literal set.
function toPascal(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}
