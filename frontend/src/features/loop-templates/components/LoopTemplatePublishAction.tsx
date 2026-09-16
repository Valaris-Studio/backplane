// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { isApiError } from "@/lib/api-error";
import { loopTemplateKeys } from "@/lib/query-keys";
import {
  publishLoopTemplate,
  type LoopTemplateFinding,
} from "../api/loop-templates";
import type { LoopTemplateTab } from "./LoopTemplateDetailPage";
import { findingTab, findingsFrom } from "../lib/publish-findings";

interface LoopTemplatePublishActionProps {
  slug: string;
  templateRef: string;
  /** The published version this publish locks against (`expected_version`). */
  version: number | null;
  /** Admin AND a workspace template — system templates have no row to publish. */
  canPublish: boolean;
  /**
   * Persist the debounced draft before freezing it into a version.
   *
   * Same contract as the preview panel's `onBeforePreview`, and for a sharper
   * reason: a preview that renders stale text is visibly wrong and re-runnable,
   * whereas a publish inside the 800 ms autosave window freezes a version
   * WITHOUT the operator's last keystrokes and reports success either way.
   */
  onBeforePublish?: () => Promise<unknown>;
  onNavigateToTab: (tab: LoopTemplateTab) => void;
  onPublished?: () => void;
}

/**
 * The header Publish action: the only path that bumps a version (spec §5.1).
 *
 * A 422 is not an error state to retry blindly — it is a work list, so the
 * findings stay on screen with a link to the tab that owns each field.
 */
export function LoopTemplatePublishAction({
  slug,
  templateRef,
  version,
  canPublish,
  onBeforePublish,
  onNavigateToTab,
  onPublished,
}: LoopTemplatePublishActionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [findings, setFindings] = useState<LoopTemplateFinding[]>([]);
  const [conflict, setConflict] = useState(false);

  const publish = useMutation({
    mutationFn: async () => {
      // Autosave is debounced, and publish SNAPSHOTS the stored draft — not
      // what is on screen. Without this, confirming inside the debounce window
      // freezes a version missing the last keystrokes, and nothing in the UI
      // says so: the dialog closes, the version bumps, and the loss only shows
      // up in the published copy.
      await onBeforePublish?.();
      return publishLoopTemplate(slug, templateRef, {
        expected_version: version,
        note: note.trim() || null,
      });
    },
    onMutate: () => {
      // Findings describe the draft as it was LAST submitted; carrying them
      // into a retry would report a template still broken after it was fixed.
      setFindings([]);
      setConflict(false);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: loopTemplateKeys.all(slug) });
      setOpen(false);
      setNote("");
      onPublished?.();
    },
    onError: (error) => {
      if (!isApiError(error)) return;
      if (error.status === 409) {
        setConflict(true);
        return;
      }
      if (error.status === 422) {
        setFindings(findingsFrom(error.detail ?? error.message));
      }
    },
  });

  if (!canPublish) return null;

  function goToFinding(finding: LoopTemplateFinding) {
    onNavigateToTab(findingTab(finding.field));
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="loop-template-publish-open"
      >
        <Upload className="mr-1.5 h-4 w-4" />
        {t("loopTemplates.draft.publish")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("loopTemplates.draft.publishTitle")}</DialogTitle>
            <DialogDescription>
              {t("loopTemplates.draft.publishDescription")}
            </DialogDescription>
          </DialogHeader>

          <label
            className="text-sm font-medium"
            htmlFor="loop-template-publish-note"
          >
            {t("loopTemplates.draft.note")}
          </label>
          <Textarea
            id="loop-template-publish-note"
            data-testid="loop-template-publish-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("loopTemplates.draft.notePlaceholder")}
            rows={3}
          />

          {conflict && (
            <p
              role="alert"
              data-testid="loop-template-publish-conflict"
              className="flex items-center gap-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t("loopTemplates.draft.conflict")}
            </p>
          )}

          {findings.length > 0 && (
            <div data-testid="loop-template-findings" role="alert">
              <p className="mb-1 text-sm font-medium">
                {t("loopTemplates.draft.findingsTitle", {
                  count: findings.length,
                })}
              </p>
              <ul className="space-y-1">
                {findings.map((finding, index) => (
                  <li key={`${finding.field}-${finding.code}-${index}`}>
                    <button
                      type="button"
                      data-testid={`loop-template-finding-${index}`}
                      onClick={() => goToFinding(finding)}
                      className="w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {finding.field}
                      </span>{" "}
                      {finding.message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              onClick={() => publish.mutate()}
              disabled={publish.isPending}
              data-testid="loop-template-publish-confirm"
            >
              {t("loopTemplates.draft.publish")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
