// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBoard } from "@/features/kanban/api/use-boards";
import { useUpdateNote } from "../api/use-notes";
import { isImmutableNoteKind } from "../lib/noteKinds";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import { cn } from "@/lib/utils";
import type { Note } from "@/types/note";

interface NoteCardLinkControlProps {
  note: Note;
  slug: string;
}

/**
 * Link/unlink a board-scoped note to a card: single-select picker over the
 * board's cards (columns → cards from the cached board detail). Renders
 * nothing for workspace notes — card links only exist within a board.
 */
export function NoteCardLinkControl({ note, slug }: NoteCardLinkControlProps) {
  const { t, i18n } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<unknown>(null);
  const updateNote = useUpdateNote(slug, note.board_id ?? undefined);
  // "" disables the query while keeping hook order stable (NoteEditorMeta idiom).
  const { data: board } = useBoard(slug, note.board_id ?? "");

  // preferDetail: the backend puts the user-actionable copy in `detail` for
  // link validation failures (wrong board, immutable kind).
  const linkErrorMessage =
    linkError === null
      ? null
      : resolveApiErrorMessage(linkError, t, i18n, {
          preferDetail: true,
          fallbackKey: "notes.cardLink.error",
        });

  const candidates = useMemo(() => {
    const cards = board?.columns.flatMap((column) => column.cards) ?? [];
    const lowerQuery = query.trim().toLowerCase();
    return cards
      .filter((card) => !lowerQuery || card.title.toLowerCase().includes(lowerQuery))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [board, query]);

  if (!note.board_id) return null;
  // Immutable kinds (review_verdict): the backend 403s any update, card
  // link/unlink included — render no affordance at all.
  if (isImmutableNoteKind(note.kind)) return null;

  function saveLink(cardId: string | null) {
    setLinkError(null);
    updateNote.mutate(
      { noteId: note.id, card_id: cardId },
      {
        onSuccess: () => setPickerOpen(false),
        onError: setLinkError,
      },
    );
  }

  function handleOpenChange(open: boolean) {
    if (open) {
      setQuery("");
      setSelectedCardId(note.card_id);
      setLinkError(null);
    }
    setPickerOpen(open);
  }

  return (
    <span className="flex items-center gap-1.5">
      {note.card_id ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={updateNote.isPending}
            onClick={() => handleOpenChange(true)}
          >
            {t("notes.cardLink.change")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={updateNote.isPending}
            onClick={() => saveLink(null)}
          >
            {t("notes.cardLink.unlink")}
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={updateNote.isPending}
          onClick={() => handleOpenChange(true)}
        >
          {t("notes.cardLink.link")}
        </Button>
      )}

      {/* Unlink failures happen with the picker closed — the dialog renders
          its own copy of this message while open. */}
      {linkErrorMessage && !pickerOpen ? (
        <span role="alert" className="text-xs text-destructive">
          {linkErrorMessage}
        </span>
      ) : null}

      <Dialog open={pickerOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("notes.cardLink.link")}</DialogTitle>
            <DialogDescription>
              {t("notes.cardLink.pickerDescription")}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={t("notes.cardLink.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="max-h-72 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="px-1 py-4 text-sm text-muted-foreground">
                {t("notes.cardLink.pickerEmpty")}
              </p>
            ) : (
              <ul className="space-y-1">
                {candidates.map((card) => {
                  const selected = selectedCardId === card.id;
                  return (
                    <li key={card.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedCardId(card.id)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left hover:border-border/75 hover:bg-muted/30",
                          selected && "border-primary/30 bg-primary/5",
                        )}
                        aria-pressed={selected}
                      >
                        <span className="truncate text-sm">{card.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {linkErrorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {linkErrorMessage}
            </p>
          ) : null}
          <DialogFooter>
            {/* Cancel stays enabled while pending — a slow request must not
                trap the user in the dialog. */}
            <Button variant="outline" onClick={() => setPickerOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => selectedCardId && saveLink(selectedCardId)}
              disabled={updateNote.isPending || !selectedCardId}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}
