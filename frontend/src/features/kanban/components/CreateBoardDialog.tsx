// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useCreateBoard } from "../api/use-boards";
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
import { Textarea } from "@/components/ui/textarea";

interface Props {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateBoardDialog({ slug, open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const navigate = useNavigate();
  const createBoard = useCreateBoard(slug);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    const board = await createBoard.mutateAsync({
      name: name.trim(),
      description: description.trim(),
    });

    setName("");
    setDescription("");
    onOpenChange(false);
    navigate(`/${slug}/boards/${board.slug ?? board.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{t("createBoard.title")}</DialogTitle>
            <DialogDescription>{t("boards.subtitle")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("createBoard.namePlaceholder")}</label>
              <Input
                placeholder={t("createBoard.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("common.descriptionOptional")}</label>
              <Textarea
                placeholder={t("createBoard.descriptionPlaceholder")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter className="border-t border-border/70 pt-5">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={createBoard.isPending || !name.trim()}>
              {createBoard.isPending ? t("common.creating") : t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
