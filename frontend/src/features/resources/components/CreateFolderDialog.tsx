// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateResource } from "../api/use-resources";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface CreateFolderDialogProps {
  slug: string;
  boardId?: string;
  parentId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateFolderDialog({
  slug,
  boardId,
  parentId,
  open,
  onOpenChange,
}: CreateFolderDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const createResource = useCreateResource(slug, boardId);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    createResource.mutate(
      {
        name: name.trim(),
        resource_type: "folder",
        parent_id: parentId ?? undefined,
      },
      {
        onSuccess: () => {
          setName("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{t("resources.createFolderTitle")}</DialogTitle>
            <DialogDescription>{t("resources.subtitle")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t("resources.folderNamePlaceholder")}</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("resources.folderNamePlaceholder")}
              autoFocus
            />
          </div>

          <div className="flex justify-end border-t border-border/70 pt-5">
            <Button type="submit" disabled={!name.trim()}>
              {t("common.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
