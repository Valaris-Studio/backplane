// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  useArchiveLoopTemplate,
  useUnarchiveLoopTemplate,
} from "../hooks/useLoopTemplateList";

export interface ArchiveTemplateTarget {
  ref: string;
  name: string;
}

/**
 * Confirm-then-archive with an Undo toast, shared by the library cards and
 * the detail-page header so a stray click near Publish/Duplicate can't
 * silently archive a template (devops UX round 2 #2). Archive is a soft
 * archive server-side, so Undo is a plain POST /unarchive.
 */
export function ArchiveTemplateDialog({
  slug,
  target,
  onClose,
  onArchived,
}: {
  slug: string;
  target: ArchiveTemplateTarget | null;
  onClose: () => void;
  onArchived?: () => void;
}) {
  const { t } = useTranslation();
  const archive = useArchiveLoopTemplate(slug);
  const unarchive = useUnarchiveLoopTemplate(slug);

  function handleConfirm() {
    if (!target) return;
    const { ref } = target;
    archive.mutate(ref, {
      onSuccess: () => {
        onClose();
        onArchived?.();
        toast.success(t("loopTemplates.library.archivedToast"), {
          action: {
            label: t("loopTemplates.library.archiveUndo"),
            onClick: () =>
              unarchive.mutate(ref, {
                onError: () =>
                  toast.error(t("loopTemplates.library.restoreFailed")),
              }),
          },
        });
      },
      onError: () => toast.error(t("loopTemplates.library.archiveFailed")),
    });
  }

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("loopTemplates.library.archiveDialog.title")}
      description={t("loopTemplates.library.archiveDialog.description", {
        name: target?.name ?? "",
      })}
      confirmLabel={t("loopTemplates.library.archiveDialog.confirm")}
      cancelLabel={t("loopTemplates.library.archiveDialog.cancel")}
      pending={archive.isPending}
      onConfirm={handleConfirm}
    />
  );
}
