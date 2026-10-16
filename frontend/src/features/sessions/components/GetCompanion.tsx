// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, BookOpen, Download, Laptop } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { COMPANION_RELEASE } from "@/lib/companion-release";
import { useDocsBasePath } from "@/pages/documentation/use-docs-base-path";

const EXTERNAL_LINK = { target: "_blank", rel: "noopener noreferrer" } as const;
const SECONDARY_LINK = "inline-flex items-center gap-1 font-medium text-primary hover:underline";

function browsesFromMac(): boolean {
  return /Macintosh|Mac OS X/.test(window.navigator.userAgent);
}

interface GetCompanionProps {
  // One row (primary action + setup guide) for notices that sit beside content.
  compact?: boolean;
  // Called when the visitor takes any of the ways to get Companion.
  onTake?: () => void;
}

// The packaged app is macOS-only, so a Mac visitor gets the download first and
// everyone else is told so plainly and led to the source build instead.
export function GetCompanion({ compact = false, onTake }: GetCompanionProps) {
  const { t } = useTranslation();
  const setupGuideHref = `${useDocsBasePath()}/${COMPANION_RELEASE.docsSlug}`;
  const onMac = browsesFromMac();
  const primarySize = compact ? "sm" : "default";

  const primary = onMac ? (
    <a href={COMPANION_RELEASE.macDownloadUrl} onClick={onTake} className={buttonVariants({ size: primarySize })}>
      <Download aria-hidden />
      {t("sessions.getCompanion.downloadMac")}
    </a>
  ) : (
    <a href={COMPANION_RELEASE.sourceUrl} {...EXTERNAL_LINK} onClick={onTake} className={buttonVariants({ size: primarySize })}>
      <ArrowUpRight aria-hidden />
      {t("sessions.getCompanion.buildFromSource")}
    </a>
  );
  const setupGuide = (
    <Link to={setupGuideHref} onClick={onTake} className={SECONDARY_LINK}>
      <BookOpen aria-hidden className="size-3" />
      {t("sessions.getCompanion.setupGuide")}
    </Link>
  );

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs" data-testid="get-companion">
        {primary}
        {setupGuide}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2.5" data-testid="get-companion">
      {onMac ? null : <p className="max-w-sm text-sm text-muted-foreground">{t("sessions.getCompanion.macOnly")}</p>}
      {primary}
      <p className="text-xs text-muted-foreground">
        {t("sessions.getCompanion.requirements", { version: COMPANION_RELEASE.version })}
      </p>
      <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs">
        {onMac ? (
          <a href={COMPANION_RELEASE.sourceUrl} {...EXTERNAL_LINK} onClick={onTake} className={SECONDARY_LINK}>
            {t("sessions.getCompanion.otherPlatforms")}
            <ArrowUpRight aria-hidden className="size-3" />
          </a>
        ) : (
          <a href={COMPANION_RELEASE.macDownloadUrl} onClick={onTake} className={SECONDARY_LINK}>
            <Download aria-hidden className="size-3" />
            {t("sessions.getCompanion.macDownload")}
          </a>
        )}
        {setupGuide}
      </p>
    </div>
  );
}

// Above a list whose sessions came from computers no longer paired: new
// sessions need Companion again, the old ones stay.
export function NoActiveComputerNotice() {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <div
      role="status"
      aria-labelledby={titleId}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] px-[var(--card-padding)] py-3 shadow-panel"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Laptop aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm">
          <span id={titleId} className="block font-semibold text-foreground">
            {t("sessions.noComputer.title")}
          </span>
          <span className="block text-muted-foreground">{t("sessions.noComputer.body")}</span>
        </p>
      </div>
      <GetCompanion compact />
    </div>
  );
}

// One line for places that already explain the steps: straight to the guide,
// which carries the download for every platform.
export function GetCompanionLink() {
  const { t } = useTranslation();
  const setupGuideHref = `${useDocsBasePath()}/${COMPANION_RELEASE.docsSlug}`;
  return (
    <Link to={setupGuideHref} className={SECONDARY_LINK}>
      <Download aria-hidden className="size-3.5" />
      {t("sessions.getCompanion.getLink", { version: COMPANION_RELEASE.version })}
    </Link>
  );
}
