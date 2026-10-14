// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import { useBoards, useBoard } from "@/features/kanban/api/use-boards";
import { useMembers } from "@/features/members/api/use-members";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { buildNoteLink } from "@/features/notes/utils/note-link";
import { isApiError } from "@/lib/api-error";
import { useSaveExcerptNote, type ExcerptNoteRequest } from "../api/use-save-excerpt-note";
import { compactNoteDocument, EXCERPT_NOTE_MAX_BYTES, EXCERPT_NOTE_MAX_ITEMS, type ExcerptNoteDraft } from "../utils/excerpt-note";
import { utf8Bytes } from "../utils/excerpt";

const selectClass = "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

interface ReviewedDestination {
  workspace: { id: string; slug: string; name: string };
  board: { id: string; name: string };
  card?: { id: string; title: string };
}

function outcomeIsUnknown(error: unknown): boolean {
  return !isApiError(error) || error.status === 0 || error.status === 408 || error.status >= 500;
}

export function ExcerptNoteDialog({ draft, stale, onDiscard }: {
  draft: ExcerptNoteDraft; stale: boolean; onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const label = (key: string, values?: Record<string, unknown>) => t(`sessions.contents.excerpt.note.${key}`, values);
  const id = useId();
  const [open, setOpen] = useState(true);
  const [slug, setSlug] = useState("");
  const [boardId, setBoardId] = useState("");
  const [cardId, setCardId] = useState("");
  const [title, setTitle] = useState((draft.session.title || t("sessions.contents.excerpt.title")).replace(/\s+/gu, " ").trim());
  const [content, setContent] = useState(draft.document);
  const request = useRef<ExcerptNoteRequest | null>(null);
  const reviewedDestination = useRef<ReviewedDestination | null>(null);
  const hadUnknownOutcome = useRef(false);
  const dispatching = useRef(false);
  const save = useSaveExcerptNote();
  const workspaces = useWorkspaces();
  const boards = useBoards(slug, { enabled: !!slug });
  const board = useBoard(slug, boardId);
  const members = useMembers(slug, { enabled: !!slug });
  const me = useCurrentUser();
  const workspace = workspaces.data?.find((item) => item.slug === slug);
  const destination = boards.data?.find((item) => item.id === boardId);
  const role = members.data?.find((item) => item.user_id === me.data?.id)?.role;
  const cards = board.data?.id === boardId ? board.data.columns.flatMap((column) => column.cards) : [];
  const compact = useMemo(() => compactNoteDocument(content), [content]);
  const oversized = compact !== null && utf8Bytes(compact) > EXCERPT_NOTE_MAX_BYTES;
  const frozen = request.current !== null;
  const workspaceOptions = frozen && reviewedDestination.current ? [reviewedDestination.current.workspace] : workspaces.data;
  const boardOptions = frozen && reviewedDestination.current ? [reviewedDestination.current.board] : boards.data;
  const cardOptions = frozen && reviewedDestination.current ? (reviewedDestination.current.card ? [reviewedDestination.current.card] : []) : cards;
  const audienceName = frozen ? reviewedDestination.current?.workspace.name : workspace?.name;

  let problem: string | null = null;
  if (!frozen) {
    if (stale || draft.bodies.some(({ item }) => !item.sha256 || !/^[a-f0-9]{64}$/i.test(item.sha256))) problem = label("sourceChanged");
    else if (draft.bodies.length > EXCERPT_NOTE_MAX_ITEMS) problem = label("tooMany");
    else if (oversized) problem = label("tooLarge");
    else if (compact === null) problem = label("invalidDocument");
    else if (destination?.is_frozen || board.data?.is_frozen) problem = label("boardFrozen");
    else if (slug && members.isSuccess && me.isSuccess && !["member", "admin", "owner"].includes(role ?? "")) problem = label("permission");
    else if (workspaces.isError || boards.isError || members.isError || board.isError || me.isError) problem = label("destinationUnavailable");
    else if (boardId && boards.isSuccess && !destination) problem = label("destinationUnavailable");
    else if (cardId && board.isSuccess && !cards.some((card) => card.id === cardId)) problem = label("destinationUnavailable");
  }
  if (save.error) {
    const error = save.error;
    const code = isApiError(error) ? error.errorCode : undefined;
    const status = isApiError(error) ? error.status : 0;
    if (outcomeIsUnknown(error)) problem = label("unknown");
    else if (status === 413) problem = label("tooLarge");
    else if (status === 410) problem = label("deleted");
    else if (code === "board_frozen") problem = label("boardFrozen");
    else if (code === "client_request_conflict") problem = label("requestConflict");
    else if ((status === 404 && (!code || code === "not_found")) || status === 405) problem = label("serverUnsupported");
    else if (code === "excerpt_source_stale" || code === "content_not_found" || status === 404) problem = label("sourceChanged");
    else if (status === 403 || status === 401) problem = label("permission");
    else problem = label("rejected");
  }
  const canSave = !frozen && !problem && !!title.trim() && !!workspace && !!destination
    && destination.workspace_id === workspace.id && board.isSuccess && !board.isFetching
    && boards.isSuccess && !boards.isFetching && members.isSuccess && !members.isFetching
    && ["member", "admin", "owner"].includes(role ?? "");
  const canRevise = save.isError && !hadUnknownOutcome.current && isApiError(save.error)
    && save.error.status >= 400 && save.error.status < 500;

  function dispatch() {
    if (dispatching.current || save.isSuccess) return;
    if (!request.current) {
      if (!canSave || compact === null || !workspace || !destination) return;
      const card = cards.find((item) => item.id === cardId);
      reviewedDestination.current = {
        workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
        board: { id: destination.id, name: destination.name },
        ...(card ? { card: { id: card.id, title: card.title } } : {}),
      };
      request.current = {
        slug, boardId,
        payload: {
          title, content: compact, card_id: cardId || null, pinned: false,
          client_request_id: crypto.randomUUID(),
          excerpt_source: {
            workspace_id: draft.session.workspace_id, session_id: draft.session.id,
            items: draft.bodies.map(({ item }) => ({ content_id: item.id, sha256: item.sha256! })),
          },
        },
      };
    }
    dispatching.current = true;
    save.mutate(request.current, {
      onError: (error) => { if (outcomeIsUnknown(error)) hadUnknownOutcome.current = true; },
      onSettled: () => { dispatching.current = false; },
    });
  }

  function revise() {
    if (!canRevise || dispatching.current) return;
    request.current = null;
    reviewedDestination.current = null;
    hadUnknownOutcome.current = false;
    save.reset();
  }

  function dismiss() {
    if (save.isSuccess) onDiscard();
    else if (request.current) setOpen(false);
    else onDiscard();
  }

  const noteLink = save.data && request.current ? buildNoteLink({ slug: request.current.slug, boardId: request.current.boardId, noteId: save.data.id }) : null;
  return <>
    {!open ? <div className="flex flex-wrap items-center gap-3 px-[var(--card-padding)] py-3" role="status">
      {noteLink ? <Link className="text-sm text-primary underline underline-offset-4" to={noteLink}>{label("openNote")}</Link> : <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{label("resume")}</Button>}
    </div> : null}
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent className="max-w-4xl" aria-describedby={`${id}-audience`}>
        <DialogHeader><DialogTitle>{label("share")}</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="grid gap-1.5 text-sm" htmlFor={`${id}-workspace`}>{label("workspace")}
            <select id={`${id}-workspace`} className={selectClass} value={slug} disabled={frozen} onChange={(event) => { setSlug(event.target.value); setBoardId(""); setCardId(""); }}>
              <option value="">{label("chooseWorkspace")}</option>
              {workspaceOptions?.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm" htmlFor={`${id}-board`}>{label("board")}
            <select id={`${id}-board`} className={selectClass} value={boardId} disabled={frozen || !slug || boards.isPending} onChange={(event) => { setBoardId(event.target.value); setCardId(""); }}>
              <option value="">{label("chooseBoard")}</option>
              {boardOptions?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm" htmlFor={`${id}-card`}>{label("card")}
            <select id={`${id}-card`} className={selectClass} value={cardId} disabled={frozen || !boardId || board.isPending} onChange={(event) => setCardId(event.target.value)}>
              <option value="">{label("noCard")}</option>
              {cardOptions.map((card) => <option key={card.id} value={card.id}>{card.title}</option>)}
            </select>
          </label>
        </div>
        <div id={`${id}-audience`} className="grid gap-1 text-sm leading-relaxed text-muted-foreground">
          <p>{audienceName ? label("audience", { workspace: audienceName }) : label("chooseAudience")}</p>
          <p>{label("cardVisibility")}</p>
          <p>{label("snapshot")}</p>
        </div>
        <label className="grid gap-1.5 text-sm" htmlFor={`${id}-title`}>{label("title")}
          <Input id={`${id}-title`} value={title} disabled={frozen} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <section role="region" aria-label={label("content")} className="min-w-0">
          <RichTextEditor content={content} onChange={setContent} editable={!frozen} allowMediaUpload={false} workspaceSlug={slug || undefined} className="max-h-[45dvh] min-h-48 overflow-auto" />
        </section>
        {!frozen ? <p className="text-xs text-muted-foreground">{label("review")}</p> : null}
        {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
        {save.isPending ? <p role="status" className="text-sm text-muted-foreground">{label("saving")}</p> : null}
        {noteLink ? <p role="status" className="text-sm">{label("saved")} <Link className="text-primary underline underline-offset-4" to={noteLink}>{label("openNote")}</Link></p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={dismiss}>{frozen ? label("hide") : t("sessions.contents.excerpt.cancel")}</Button>
          {canRevise ? <Button variant="outline" onClick={revise}>{label("revise")}</Button> : null}
          {save.isError ? <Button onClick={dispatch}>{label("retry")}</Button> : !save.isSuccess ? <Button onClick={dispatch} disabled={!canSave || save.isPending}>{label("save")}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
