// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useCompanionEnabled, useSessionSummary } from "../api/use-sessions";
import { useNow } from "../hooks/use-now";
import { periodStart } from "../hooks/use-session-filters";

// A session goes from live to idle by silence (15 minutes), which sends no
// event; poll at this pace so the count drops without one.
const LIVE_POLL_MS = 60_000;

// Beside "My sessions" in the sidebar, only while something is live. Motion
// is reserved for the live state, and reduced motion keeps the dot still.
export function SessionsLiveCount({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const enabled = useCompanionEnabled() === true;
  const now = useNow();
  const query = useMemo(() => ({ since: new Date(periodStart("today", now)).toISOString(), root_only: true }), [now]);
  const summary = useSessionSummary(slug, query, enabled, LIVE_POLL_MS);
  const live = summary.data?.live_count ?? 0;
  if (!live) return null;

  return (
    <span className="ml-auto inline-flex items-center gap-1.5 text-[0.75rem] font-bold text-sidebar-primary">
      <span aria-hidden className="relative inline-flex size-1.5">
        <span className="absolute inset-0 rounded-full bg-current opacity-60 motion-safe:animate-ping" />
        <span className="relative size-1.5 rounded-full bg-current" />
      </span>
      <span aria-hidden className="tabular-nums">
        {live}
      </span>
      <span className="sr-only">{t("sessions.liveCount", { count: live })}</span>
    </span>
  );
}
