// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useCompanionEnabled } from "../api/use-sessions";
import { useCompanionDevices } from "../api/use-linked-sessions";

// Sessions · Devices under the page header, as routes so each is deep-linkable
// (the desktop app's "Manage on the web" opens Devices directly).
export function SessionsTabs() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  const { pathname } = useLocation();
  const enabled = useCompanionEnabled() === true;
  const devices = useCompanionDevices(enabled);
  const activeDevices = devices.data?.filter((device) => !device.revoked_at).length;
  const onDevices = pathname.endsWith("/sessions/devices");

  const tabs = [
    { key: "sessions", href: `/${slug}/sessions`, label: t("sessions.tabs.sessions"), current: !onDevices, count: undefined },
    { key: "devices", href: `/${slug}/sessions/devices`, label: t("sessions.tabs.devices"), current: onDevices, count: activeDevices },
  ];

  return (
    <nav aria-label={t("sessions.tabs.label")} className="flex gap-5 border-b border-border px-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.href}
          aria-current={tab.current ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex items-center gap-2 border-b-2 py-2 text-[0.92rem] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            tab.current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span className="rounded-full bg-secondary px-1.5 text-[0.75rem] font-bold tabular-nums text-muted-foreground">{tab.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
