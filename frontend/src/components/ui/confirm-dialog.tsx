// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Defaults to true — a destructive (red) confirm button. */
  destructive?: boolean;
  /** Disables the confirm button (e.g. while the mutation is pending). */
  pending?: boolean;
  /**
   * When set, the operator must reproduce this exact string before confirm
   * unlocks. Reserve it for the unrecoverable — the friction is the feature.
   */
  requirePhrase?: string;
  /** Accessible label for the phrase input. Required alongside requirePhrase. */
  requirePhraseLabel?: string;
  onConfirm: () => void;
}

/**
 * Declarative confirmation modal built on the shared Dialog primitive.
 * Mirrors the established Dialog-confirm idiom (KanbanCard, CardDetailSheet,
 * DangerZoneSection): outline Cancel + variant-driven Confirm in a DialogFooter.
 * Replaces window.confirm() — which breaks inside the IAP iframe.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = true,
  pending = false,
  requirePhrase,
  requirePhraseLabel,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [typedPhrase, setTypedPhrase] = useState("");
  const inputId = useId();

  // Clearing on close means a reopened dialog asks again. Without it, a
  // cancelled delete leaves the gate already unlocked for the next one.
  useEffect(() => {
    if (!open) setTypedPhrase("");
  }, [open]);

  const phraseSatisfied = !requirePhrase || typedPhrase === requirePhrase;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {requirePhrase ? (
          <div className="space-y-2">
            <label
              htmlFor={inputId}
              className="text-sm font-medium text-muted-foreground"
            >
              {requirePhraseLabel}
            </label>
            <Input
              id={inputId}
              value={typedPhrase}
              onChange={(e) => setTypedPhrase(e.target.value)}
              autoComplete="off"
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {/* An omitted cancelLabel once rendered an EMPTY button — the
                shared default guarantees every consumer gets a labeled one. */}
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending || !phraseSatisfied}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
