// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle } from "lucide-react";
import { useCreateNote } from "../api/use-notes";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import { RichTooltip } from "@/components/ui/rich-tooltip";

interface CreateNoteDialogProps {
  slug: string;
  boardId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateNoteDialog({
  slug,
  boardId,
  open,
  onOpenChange,
}: CreateNoteDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const createNote = useCreateNote(slug, boardId);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    createNote.mutate(
      { title: title.trim(), content },
      {
        onSuccess: () => {
          setTitle("");
          setContent("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              {t("notes.newNote")}
              <RichTooltip i18nKey="workspace.notes.scope" side="right">
                <HelpCircle
                  aria-label={t("notes.newNote")}
                  className="h-3.5 w-3.5 text-muted-foreground"
                />
              </RichTooltip>
            </DialogTitle>
            <DialogDescription>{t("notes.subtitle")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("cards.titleLabel")}</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("notes.titlePlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("cards.descriptionLabel")}</label>
              <RichTextEditor
                content={content}
                onChange={setContent}
                placeholder={t("notes.contentOptionalPlaceholder")}
                workspaceSlug={slug}
              />
            </div>
          </div>

          <div className="flex justify-end border-t border-border/70 pt-5">
            <Button type="submit" disabled={!title.trim()}>
              {t("common.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
