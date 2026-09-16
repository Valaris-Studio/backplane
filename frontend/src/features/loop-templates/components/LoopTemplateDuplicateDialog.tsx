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

export interface DuplicateChoice {
  newName?: string;
  newSlug?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The source template's name, used to prefill the suggestion. */
  sourceName: string;
  pending?: boolean;
  onConfirm: (choice: DuplicateChoice) => void;
}

/**
 * Name-the-copy prompt for Duplicate.
 *
 * Both fields start EMPTY on purpose. The server derives the next free
 * `-copy`, `-copy-2`, … slug by probing rows the client cannot see, so
 * prefilling a slug and always posting it would hand that decision back to the
 * client and make a third fork 409 again — the exact bug this feature removes.
 * A blank field therefore means "server picks", and only a slug the operator
 * actually typed travels as `new_slug`.
 */
export function LoopTemplateDuplicateDialog({
  open,
  onOpenChange,
  sourceName,
  pending = false,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const nameId = useId();
  const slugId = useId();

  // A cancelled duplicate must not leave the next one prefilled with a slug
  // the operator already abandoned.
  useEffect(() => {
    if (!open) {
      setName("");
      setSlug("");
    }
  }, [open]);

  function handleConfirm() {
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    onConfirm({
      newName: trimmedName || undefined,
      newSlug: trimmedSlug || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="loop-template-duplicate-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("loopTemplates.library.duplicateDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("loopTemplates.library.duplicateDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={nameId}>
              {t("loopTemplates.library.duplicateDialog.nameLabel")}
            </label>
            <Input
              id={nameId}
              value={name}
              placeholder={t(
                "loopTemplates.library.duplicateDialog.namePlaceholder",
                { name: sourceName },
              )}
              onChange={(event) => setName(event.target.value)}
              data-testid="loop-template-duplicate-name"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={slugId}>
              {t("loopTemplates.library.duplicateDialog.slugLabel")}
            </label>
            <Input
              id={slugId}
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              data-testid="loop-template-duplicate-slug"
            />
            <p className="text-xs text-muted-foreground">
              {t("loopTemplates.library.duplicateDialog.slugHelp")}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("loopTemplates.library.duplicateDialog.cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            data-testid="loop-template-duplicate-confirm"
          >
            {t("loopTemplates.library.duplicateDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
