// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { calculatePosition } from "../utils/position";
import { useCreateColumn } from "../api/use-columns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Column } from "@/types/kanban";

interface Props {
  slug: string;
  boardId: string;
  existingColumns: Column[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateColumnDialog({
  slug,
  boardId,
  existingColumns,
  open,
  onOpenChange,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const createColumn = useCreateColumn(slug, boardId);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    const lastPosition = existingColumns[existingColumns.length - 1]?.position;
    const position = calculatePosition(lastPosition);

    createColumn.mutate(
      { name: name.trim(), position },
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
            <DialogTitle>{t("columns.createTitle")}</DialogTitle>
            <DialogDescription>{t("columns.namePlaceholder")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t("columns.nameLabel")}</label>
            <Input
              placeholder={t("columns.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <DialogFooter className="border-t border-border/70 pt-5">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={createColumn.isPending || !name.trim()}>
              {createColumn.isPending ? t("common.creating") : t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
