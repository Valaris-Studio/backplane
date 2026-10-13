// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSession } from "@/types/agent-session";
import { isUsageOnly } from "../utils/group-sessions";

function Banner({ tone, title, children }: { tone: "info" | "warning"; title: string; children: ReactNode }) {
  const Icon = tone === "info" ? Info : AlertCircle;
  return (
    <div
      role="note"
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-[var(--radius-cap)] border px-3.5 py-2.5 text-[0.86rem]",
        tone === "info"
          ? "border-info/45 bg-info/10 text-[color:var(--color-info-foreground)]"
          : "border-warning/50 bg-warning/12 text-[color:var(--color-warning-foreground)]",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4" />
      <p className="font-bold">{title}</p>
      <p className="col-start-2 text-foreground/85">{children}</p>
    </div>
  );
}

// Honest about thin coverage before the timeline makes any claim.
export function SessionBanners({ session }: { session: AgentSession }) {
  const { t } = useTranslation();
  const levels = session.capture_levels ?? [];
  const distinctLevels = [...new Set(levels)];
  const banners: ReactNode[] = [];

  if (isUsageOnly(session)) {
    banners.push(
      <Banner key="usage" tone="info" title={t("sessions.banners.usageOnlyTitle")}>
        {t("sessions.banners.usageOnlyBody", { agent: session.harness_display_name })}
      </Banner>,
    );
  }
  if (session.capture_gaps > 0) {
    banners.push(
      <Banner key="gaps" tone="warning" title={t("sessions.banners.incompleteTitle", { count: session.capture_gaps })}>
        {t("sessions.banners.incompleteBody")}
      </Banner>,
    );
  }
  if (distinctLevels.length > 1) {
    banners.push(
      <Banner key="levels" tone="info" title={t("sessions.banners.levelChangedTitle")}>
        {t("sessions.banners.levelChangedBody", {
          first: t(`sessions.rail.captured.levels.${distinctLevels[0]}`),
          second: t(`sessions.rail.captured.levels.${distinctLevels.at(-1)}`),
        })}
      </Banner>,
    );
  }

  return banners.length ? <div className="flex flex-col gap-2">{banners}</div> : null;
}
