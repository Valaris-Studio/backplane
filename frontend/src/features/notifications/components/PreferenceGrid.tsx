// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Check, Minus } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { cn } from "@/lib/utils";
import type {
  CategoryChannelMap,
  NotificationCategory,
} from "../api/notifications-api";
import {
  CATEGORY_ORDER,
  RESERVED_CATEGORIES,
  channelLabel,
} from "../utils/prefs-taxonomy";

interface PreferenceGridProps {
  /** Backend-resolved on/off per (category, channel) — already folds muted. */
  effective: CategoryChannelMap;
  /** Channel keys from the capability endpoint (one column each). */
  channels: string[];
  /** Toggling writes a sparse override: category_overrides[cat][channel]=value. */
  onToggle: (
    category: NotificationCategory,
    channel: string,
    value: boolean,
  ) => void;
  /** Muted/saving — the whole grid dims and stops accepting input. */
  disabled?: boolean;
}

export function PreferenceGrid({
  effective,
  channels,
  onToggle,
  disabled,
}: PreferenceGridProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-md)] border border-border/60",
        disabled && "pointer-events-none opacity-50",
      )}
      aria-disabled={disabled || undefined}
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border/60 bg-[color:var(--color-surface-1)]">
            <th
              scope="col"
              className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground"
            >
              {t("notifications.prefs.grid.categoryHeader")}
            </th>
            {channels.map((channel) => (
              <th
                key={channel}
                scope="col"
                className="w-24 px-3 py-2.5 text-center text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground"
              >
                {channelLabel(channel, t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CATEGORY_ORDER.map((category) => {
            const reserved = RESERVED_CATEGORIES.has(category);
            const row = effective[category] ?? {};
            return (
              <tr
                key={category}
                className="border-b border-border/40 last:border-b-0 hover:bg-muted/30"
              >
                <th
                  scope="row"
                  className="px-4 py-2.5 text-left align-middle font-normal text-foreground"
                >
                  <span className="flex items-center gap-2">
                    {t(`notifications.prefs.category.${category}`)}
                    {reserved ? (
                      <RichTooltip
                        summary={t("notifications.prefs.comingSoon.help")}
                        side="right"
                      >
                        <span className="rounded-full border border-border/60 px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                          {t("notifications.prefs.comingSoon.label")}
                        </span>
                      </RichTooltip>
                    ) : null}
                  </span>
                </th>
                {channels.map((channel) => {
                  const on = row[channel] ?? false;
                  return (
                    <td key={channel} className="px-3 py-2 text-center align-middle">
                      <Toggle
                        size="sm"
                        variant="outline"
                        pressed={on}
                        disabled={disabled}
                        onPressedChange={(next) =>
                          onToggle(category, channel, next)
                        }
                        aria-label={`${t(`notifications.prefs.category.${category}`)} — ${channelLabel(channel, t)}`}
                        className="mx-auto h-8 w-10 px-0 text-muted-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                      >
                        {on ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Minus className="h-4 w-4 opacity-50" />
                        )}
                      </Toggle>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
