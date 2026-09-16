// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderClosed } from "lucide-react";
import { useResources, useUpdateResource } from "../api/use-resources";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Resource } from "@/types/resource";

interface MoveDialogProps {
  resource: Resource | null;
  slug: string;
  boardId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MoveDialog({
  resource,
  slug,
  boardId,
  open,
  onOpenChange,
}: MoveDialogProps) {
  const { t } = useTranslation();
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const { data: resources } = useResources(slug, boardId);
  const updateResource = useUpdateResource(slug, boardId);

  const folders = (resources ?? []).filter(
    (r) => r.resource_type === "folder" && r.id !== resource?.id,
  );

  function handleMove() {
    if (!resource) return;
    updateResource.mutate(
      { resourceId: resource.id, parent_id: selectedFolderId },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("resources.moveToTitle")}</DialogTitle>
          <DialogDescription>{t("resources.selectFolder")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-60 space-y-1 overflow-y-auto">
          <button
            type="button"
            onClick={() => setSelectedFolderId(null)}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
              selectedFolderId === null
                ? "bg-primary/10 text-primary"
                : "hover:bg-accent",
            )}
          >
            <FolderClosed className="h-4 w-4" />
            {t("resources.home")}
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              onClick={() => setSelectedFolderId(folder.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                selectedFolderId === folder.id
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-accent",
              )}
            >
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <FolderClosed className="h-4 w-4" />
              {folder.name}
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t border-border/70 pt-4">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={handleMove} disabled={updateResource.isPending}>
            {t("resources.moveTo")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
