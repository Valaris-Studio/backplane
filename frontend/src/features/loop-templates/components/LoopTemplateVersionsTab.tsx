// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LineDiff } from "@/components/shared/LineDiff";
import { formatAbsolute } from "@/lib/date-format";
import { loopTemplateKeys } from "@/lib/query-keys";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import {
  useLoopTemplateDraftHalf,
  useLoopTemplatePublished,
  useLoopTemplateVersions,
} from "../hooks/useLoopTemplateDetail";
import { restoreLoopTemplateVersion } from "../api/loop-templates";
import { readPrompt } from "../lib/draft-content";

/**
 * Structural counts a prose line diff cannot show: adding a slot changes one
 * JSON line, which reads as a trivial edit next to a reworded paragraph even
 * though it is the change that breaks a bound board.
 */
function countOf(content: Record<string, unknown> | undefined, key: string): number {
  const value = content?.[key];
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

export function LoopTemplateVersionsTab({
  slug,
  templateRef,
}: {
  slug: string;
  templateRef: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { isAdmin } = useWorkspaceAdmin(slug);

  const versionsQuery = useLoopTemplateVersions(slug, templateRef);
  const draftQuery = useLoopTemplateDraftHalf(slug, templateRef);
  const publishedQuery = useLoopTemplatePublished(slug, templateRef);

  const [pendingVersion, setPendingVersion] = useState<number | null>(null);

  const draftDetail = draftQuery.data;
  const publishedDetail = publishedQuery.data;
  const isSystem = !!draftDetail?.is_system;
  // System templates are code-defined: there is no row to stage a draft into,
  // so restore is not merely hidden by role — it does not apply at all.
  const canRestore = isAdmin && !isSystem;

  const restore = useMutation({
    mutationFn: (version: number) =>
      restoreLoopTemplateVersion(slug, templateRef, version),
    onSuccess: () => {
      // The restore replaced the draft server-side; every cached view of this
      // template is now stale, including the published half's sibling entry.
      queryClient.invalidateQueries({ queryKey: loopTemplateKeys.all(slug) });
      setPendingVersion(null);
    },
  });

  const draftContent = draftDetail?.content as Record<string, unknown> | undefined;
  const publishedContent = publishedDetail?.content as
    | Record<string, unknown>
    | undefined;

  const summary = useMemo(
    () =>
      (["slots", "rails_defaults", "tools"] as const).map((key) => ({
        key,
        before: countOf(publishedContent, key),
        after: countOf(draftContent, key),
      })),
    [publishedContent, draftContent],
  );

  const versions = versionsQuery.data ?? [];
  const loading =
    versionsQuery.isLoading || draftQuery.isLoading || publishedQuery.isLoading;

  if (loading) {
    return (
      <div className="space-y-2" data-testid="loop-template-versions-loading">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (versionsQuery.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t("loopTemplates.versions.loadFailed")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <History className="h-4 w-4" />
          {t("loopTemplates.versions.title")}
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("loopTemplates.versions.description")}
        </p>
      </header>

      {versions.length === 0 ? (
        isSystem ? (
          <p
            data-testid="loop-template-versions-system"
            className="text-muted-foreground rounded-md border border-dashed p-3 text-xs"
          >
            {t("loopTemplates.versions.systemEmpty")}
          </p>
        ) : (
          <p
            data-testid="loop-template-versions-empty"
            className="text-muted-foreground rounded-md border border-dashed p-3 text-xs"
          >
            {t("loopTemplates.versions.empty")}
          </p>
        )
      ) : (
        <ul className="space-y-2">
          {versions.map((entry) => (
            <li
              key={entry.version}
              data-testid={`loop-template-version-${entry.version}`}
              className="flex items-start justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">
                    {t("loopTemplates.versions.versionLabel", {
                      version: entry.version,
                    })}
                  </span>
                  {entry.version === draftDetail?.version && (
                    <Badge
                      variant="secondary"
                      data-testid={`loop-template-version-current-${entry.version}`}
                    >
                      {t("loopTemplates.versions.current")}
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t("loopTemplates.versions.publishedAt", {
                    when: formatAbsolute(entry.published_at),
                  })}
                </p>
                <p className="mt-1 text-xs break-words">
                  {entry.note || (
                    <span className="text-muted-foreground italic">
                      {t("loopTemplates.versions.noteEmpty")}
                    </span>
                  )}
                </p>
              </div>

              {canRestore && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`loop-template-version-restore-${entry.version}`}
                  onClick={() => setPendingVersion(entry.version)}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  {t("loopTemplates.versions.restore")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">
            {t("loopTemplates.versions.compareTitle")}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("loopTemplates.versions.compareDescription")}
          </p>
        </div>

        <div data-testid="loop-template-version-summary" className="flex flex-wrap gap-2">
          {summary.map(({ key, before, after }) => (
            <Badge key={key} variant={before === after ? "outline" : "secondary"}>
              {t(
                key === "slots"
                  ? "loopTemplates.versions.summarySlots"
                  : key === "rails_defaults"
                    ? "loopTemplates.versions.summaryRails"
                    : "loopTemplates.versions.summaryTools",
                { before, after },
              )}
            </Badge>
          ))}
        </div>

        {(["system_prompt", "loop_prompt"] as const).map((key) => (
          <div key={key} className="space-y-1">
            <h4 className="text-xs font-medium">
              {t(
                key === "system_prompt"
                  ? "loopTemplates.versions.systemPrompt"
                  : "loopTemplates.versions.loopPrompt",
              )}
            </h4>
            <LineDiff
              before={readPrompt(publishedContent, key)}
              after={readPrompt(draftContent, key)}
            />
          </div>
        ))}
      </section>

      <Dialog
        open={pendingVersion !== null}
        onOpenChange={(open) => {
          if (!open) setPendingVersion(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("loopTemplates.versions.restoreTitle", {
                version: pendingVersion ?? 0,
              })}
            </DialogTitle>
            <DialogDescription>
              {t("loopTemplates.versions.restoreDescription", {
                version: pendingVersion ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>

          {draftDetail?.has_unpublished_changes && (
            <p
              data-testid="loop-template-version-restore-warning"
              className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-md p-2 text-sm"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t("loopTemplates.versions.restoreDiscardWarning")}
            </p>
          )}

          {restore.isError && (
            <p
              role="alert"
              data-testid="loop-template-version-restore-error"
              className="text-destructive text-sm"
            >
              {t("loopTemplates.versions.restoreFailed")}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingVersion(null)}
            >
              {t("loopTemplates.versions.cancel")}
            </Button>
            <Button
              type="button"
              data-testid="loop-template-version-restore-confirm"
              disabled={restore.isPending}
              onClick={() => {
                if (pendingVersion !== null) restore.mutate(pendingVersion);
              }}
            >
              {t("loopTemplates.versions.restoreConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
