// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CompletionContextWarning } from "@/features/kanban/components/CompletionContextWarning";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Hash, Info, Link2, Pin, PinOff, Trash2 } from "lucide-react";
import { useDeleteNote, useUpdateNote } from "../api/use-notes";
import { downloadNoteMarkdown } from "../utils/noteToMarkdown";
import { buildNoteLink } from "../utils/note-link";
import { NoteEditorMeta } from "./NoteEditorMeta";
import { EditorSheet } from "@/components/ui/editor-sheet";
import { Button } from "@/components/ui/button";
import { TitleInput } from "@/components/ui/title-input";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { UnsavedChangesPrompt } from "@/components/ui/unsaved-changes-prompt";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { copyTextToClipboard } from "@/lib/clipboard";
import type { Note } from "@/types/note";

interface NoteEditorProps {
  /** Must carry the note's FULL body — see `isBodyAuthoritative`. */
  note: Note;
  slug: string;
  boardId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * False while `note.content` may be a trimmed browse payload rather than the
   * stored body. Saving then would write the trimmed copy over the real note,
   * so writes stay shut until the caller supplies the fetched note. Defaults
   * true for callers that already hold the note in full.
   */
  isBodyAuthoritative?: boolean;
}

export function NoteEditor({
  note,
  slug,
  boardId,
  open,
  onOpenChange,
  isBodyAuthoritative = true,
}: NoteEditorProps) {
  const { t } = useTranslation();
  // `note` is the LIST object — fine for the metadata strip, but its `content`
  // is a browse payload we must not edit or save back. The body comes from the
  // single-note GET; while that is in flight the draft is provisional, so every
  // write stays shut (a save then would persist the list copy over the real
  // body). A FAILED fetch is not gated the same way: the query is disabled
  // after it settles, and trapping the sheet on a transient 500 would be worse
  // than the stale-copy risk it guards.
  const source = note;
  const [title, setTitle] = useState(source.title);
  const [content, setContent] = useState(source.content);
  const [pinned, setPinned] = useState(source.pinned);
  const [idCopied, setIdCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const updateNote = useUpdateNote(slug, boardId);
  const deleteNote = useDeleteNote(slug, boardId);

  const resetDraft = useCallback(() => {
    setTitle(source.title);
    setContent(source.content);
    setPinned(source.pinned);
  }, [source]);

  // Keyed on `open` as well as the note: NoteList keeps this component mounted
  // across a close and hands back the same react-query object on reopen, so a
  // note-only key would never refire and the sheet would reopen on a stale
  // draft. Deliberately one-way — resetting as `open` flips false would snap
  // the still-visible sheet back to pre-save values during the exit tween.
  useEffect(() => {
    if (!open) return;
    resetDraft();
  }, [resetDraft, open]);

  // Save only activates when title/content diverge from the persisted note —
  // pin saves through its own immediate mutation, so it's excluded (mirrors
  // CardDetailSheet's dirty gate). The content compare is safe because the
  // editor's onChange only fires on real edits, never on mount.
  const isDirty = title.trim() !== source.title || content !== source.content;
  const saveDisabled =
    updateNote.isPending || !title.trim() || !isDirty || !isBodyAuthoritative;

  function handleSave() {
    updateNote.mutate(
      { noteId: note.id, title: title.trim(), content },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  const guard = useUnsavedChangesGuard({
    isDirty,
    onClose: () => onOpenChange(false),
    onSave: handleSave,
    canSave: !saveDisabled,
    onDiscard: resetDraft,
  });

  // `source` does NOT refresh while the sheet stays open. Track pin locally so
  // a second toggle sends the opposite value instead of re-sending the first.
  function handleTogglePin() {
    const next = !pinned;
    updateNote.mutate(
      { noteId: note.id, pinned: next },
      { onSuccess: () => setPinned(next) },
    );
  }

  function handleDelete() {
    deleteNote.mutate(note.id, {
      onSuccess: () => onOpenChange(false),
    });
  }

  // Export the in-progress edits, not the last-saved server copy, so the .md
  // reflects exactly what the operator sees in the sheet. Gated on the body
  // having actually arrived — see the button's `disabled`.
  function handleExport() {
    downloadNoteMarkdown({ ...source, title, content });
  }

  function copyNoteId() {
    void copyTextToClipboard(note.id).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setIdCopied(true);
      window.setTimeout(() => setIdCopied(false), 1500);
    });
  }

  // note.board_id null means workspace-scoped — never hardcode one home.
  function copyNoteLink() {
    const url = `${window.location.origin}${buildNoteLink({
      slug,
      boardId: note.board_id ?? undefined,
      noteId: note.id,
    })}`;
    void copyTextToClipboard(url).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    });
  }

  return (
    <>
    <EditorSheet
      open={open}
      onOpenChange={guard.handleOpenChange}
      a11yTitle={t("notes.editTitle")}
      bodyClassName="pt-3"
      // Long-form prose: the widest ceiling of any panel, and a floor that
      // still fits the toolbar without wrapping. 896px (56rem) is the sole
      // width source now — the old `!w-*` widthClassName outranked the inline
      // resize width in the cascade and froze the panel at that exact size.
      resizable
      resizeStorageKey="note-editor"
      defaultWidth={896}
      minWidth={512}
      maxWidth={1440}
      resizeHandleLabel={t("common.resizePanel")}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleTogglePin}>
              {pinned ? (
                <PinOff className="h-4 w-4" />
              ) : (
                <Pin className="h-4 w-4" />
              )}
              {pinned ? t("notes.unpin") : t("notes.pin")}
            </Button>
            <RichTooltip i18nKey="workspace.notes.pin" side="top">
              <span
                aria-label={t("notes.pinHelp")}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3.5 w-3.5" />
              </span>
            </RichTooltip>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              {t("common.delete")}
            </Button>
            <Button variant="outline" size="sm" onClick={copyNoteId}>
              {idCopied ? (
                <Check className="h-4 w-4 text-[color:var(--color-success)]" />
              ) : (
                <Hash className="h-4 w-4" />
              )}
              {idCopied ? t("notes.actions.idCopied") : t("notes.actions.copyId")}
            </Button>
            <Button variant="outline" size="sm" onClick={copyNoteLink}>
              {linkCopied ? (
                <Check className="h-4 w-4 text-[color:var(--color-success)]" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              {linkCopied ? t("notes.actions.linkCopied") : t("notes.actions.copyLink")}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              // Same gate as Save: the list carries no body, so exporting
              // before the fetch lands would write an empty .md.
              disabled={!isBodyAuthoritative}
              data-testid="export-note-md"
            >
              <Download className="h-4 w-4" />
              {t("common.export")}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saveDisabled}>
              {updateNote.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      }
    >
      {/* No field labels: title and content are self-explanatory — the
          placeholders carry the hint, aria-label keeps the input named. pr-9
          keeps the title row clear of the close (X) so the body can start
          nearly at the sheet top (bodyClassName pt-3). */}
      <div className="space-y-2 pr-9">
        <TitleInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("notes.titlePlaceholder")}
          aria-label={t("cards.titleLabel")}
        />
        <NoteEditorMeta note={note} slug={slug} />
      </div>
      {/* Mounts on the provisional body and re-seeds when the fetched one
          lands — RichTextEditor syncs external `content` changes. Save stays
          shut until then, so the provisional copy can never be written back. */}
      <CompletionContextWarning slug={slug} sourceKind="note" sourceId={note.id} enabled={open} />
      <RichTextEditor
        content={content}
        onChange={setContent}
        placeholder={t("notes.contentPlaceholder")}
        workspaceSlug={slug}
        className="min-h-[240px]"
      />
    </EditorSheet>
    <UnsavedChangesPrompt
      open={guard.guardOpen}
      canSave={guard.canSave}
      onSave={guard.saveAndClose}
      onDiscard={guard.closeAnyway}
      onKeepEditing={guard.dismissGuard}
    />
    </>
  );
}
