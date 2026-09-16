// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { fadeInUp } from "@/lib/animations";

type Props = {
  open: boolean;
  /** false ⇒ Save is withheld; the draft cannot be persisted as it stands. */
  canSave: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onKeepEditing: () => void;
};

/**
 * The close-guard shown when a modal surface holds unsaved edits.
 *
 * Rendered as its own `Dialog` rather than inline so it layers correctly over
 * both `Sheet` and `Dialog` hosts — the `McpConnectionWizard` guard it is
 * modeled on can sit inline only because it lives inside its own dialog body.
 */
export function UnsavedChangesPrompt({
  open,
  canSave,
  onSave,
  onDiscard,
  onKeepEditing,
}: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  // A warning that pops into an otherwise-settled surface is exactly the
  // jarring appearance the entrance presets exist for.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    fadeInUp(panelRef.current, { offset: 6, duration: 0.2 });
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onKeepEditing())}>
      <DialogContent className="sm:max-w-md">
        <div
          ref={panelRef}
          data-testid="unsaved-changes-prompt"
          role="alertdialog"
          aria-label={t("unsavedChanges.title")}
          className="rounded-[var(--radius-md)] border border-[color:var(--color-warning)]/40 bg-[color:color-mix(in_oklab,var(--color-warning)_8%,var(--color-card))] p-3.5"
        >
          <p className="flex items-start gap-2 text-sm font-medium leading-relaxed text-foreground">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]"
              aria-hidden
            />
            {t("unsavedChanges.body")}
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onKeepEditing}
              data-testid="unsaved-changes-keep-editing"
            >
              {t("unsavedChanges.keepEditing")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={onDiscard}
              data-testid="unsaved-changes-discard"
            >
              {t("unsavedChanges.discard")}
            </Button>
            {canSave && (
              <Button
                size="sm"
                onClick={onSave}
                data-testid="unsaved-changes-save"
              >
                {t("unsavedChanges.save")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
