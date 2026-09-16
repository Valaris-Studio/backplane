// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { BellRing, MonitorOff } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { useBrowserNotifications } from "../hooks/use-browser-notifications";

/**
 * Device-local "Browser notifications" opt-in. Flipping ON triggers the OS
 * permission prompt (the toggle click is the required user gesture). Surfaces
 * the three states a user can be in: unsupported, blocked (denied — can't be
 * re-prompted, needs site settings), or available. Independent of the
 * server-side per-user prefs below it (those gate which categories generate a
 * notification; this governs OS-level delivery on this machine only).
 */
export function BrowserNotificationToggle() {
  const { t } = useTranslation();
  const { permission, enabled, supported, setEnabled } =
    useBrowserNotifications();

  if (!supported) {
    return (
      <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-border/60 bg-muted/30 p-3">
        <MonitorOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("notifications.browser.unsupported")}
        </p>
      </div>
    );
  }

  const blocked = permission === "denied";

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <span className="text-sm font-medium text-foreground">
          {t("notifications.browser.label")}
        </span>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {blocked
            ? t("notifications.browser.blocked")
            : t("notifications.browser.help")}
        </p>
      </div>
      <Toggle
        variant="outline"
        size="sm"
        pressed={enabled}
        disabled={blocked}
        onPressedChange={(next) => {
          void setEnabled(next);
        }}
        aria-label={t("notifications.browser.label")}
        className="shrink-0 gap-1.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
      >
        <BellRing className="h-4 w-4" />
        {t("notifications.browser.label")}
      </Toggle>
    </div>
  );
}
