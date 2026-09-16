// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { GitPullRequestArrow, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DraftConflict } from "../../hooks/useLifecycleDraft";

interface ConflictBannerProps {
  conflict: DraftConflict | null;
  onReload: () => void;
  onOverwrite: () => void;
  onDismiss: () => void;
}

// Surfaced when a save returns 409 (the pipeline changed elsewhere since load).
// The user's in-progress draft is preserved; they choose to reload-and-review
// (take theirs) or overwrite (keep mine, re-PATCH against the fresh version).
export function ConflictBanner({
  conflict,
  onReload,
  onOverwrite,
  onDismiss,
}: ConflictBannerProps) {
  const { t } = useTranslation();
  if (!conflict) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-md)] border border-[color:var(--color-warning)]/50 bg-[color:var(--color-warning)]/10 px-3 py-2 text-sm"
      role="alert"
      data-testid="conflict-banner"
    >
      <GitPullRequestArrow className="h-4 w-4 shrink-0 text-[color:var(--color-warning)]" />
      <span className="font-medium text-foreground">
        {t("pipelineGraph.canvas.conflict.title")}
      </span>
      {conflict.currentVersion != null ? (
        <span className="text-muted-foreground">
          {t("pipelineGraph.canvas.conflict.versions", {
            current: conflict.currentVersion,
            expected: conflict.expectedVersion ?? "—",
          })}
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onReload} data-testid="conflict-reload">
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t("pipelineGraph.canvas.conflict.reload")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={onOverwrite}
          data-testid="conflict-overwrite"
        >
          {t("pipelineGraph.canvas.conflict.overwrite")}
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground"
          aria-label={t("pipelineGraph.canvas.conflict.dismiss")}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
