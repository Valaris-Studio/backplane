// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UnsavedChangesPrompt } from "@/components/ui/unsaved-changes-prompt";
import { useNavigationGuard } from "@/providers/NavigationGuardProvider";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import { useBoards, useBoard } from "@/features/kanban/api/use-boards";
import { useMembers } from "@/features/members/api/use-members";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { buildCardLink } from "@/features/kanban/utils/card-link";
import { buildNoteLink } from "@/features/notes/utils/note-link";
import { ApiError, isApiError } from "@/lib/api-error";
import { useSaveExcerptNote } from "../api/use-save-excerpt-note";
import type { HandoffDraftController, HandoffForm } from "../hooks/use-handoff-drafts";
import { compactNoteDocument, EXCERPT_NOTE_MAX_BYTES, EXCERPT_NOTE_MAX_ITEMS, type ExcerptNoteDraft } from "../utils/excerpt-note";
import { utf8Bytes } from "../utils/excerpt";

const selectClass = "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px] max-sm:min-w-[44px]";

function outcomeIsUnknown(error: unknown): boolean {
  return !isApiError(error) || error.status === 0 || error.status === 408 || error.status >= 500;
}

export function ExcerptNoteDialog({ draft, stale, onDiscard, beforeFirstSave, sourceCheckFailed = false, onRecheckSources, handoff, onComplete }: {
  draft: ExcerptNoteDraft; stale: boolean; onDiscard: () => void;
  beforeFirstSave?: () => Promise<boolean>;
  sourceCheckFailed?: boolean; onRecheckSources?: () => Promise<unknown>;
  handoff: HandoffDraftController; onComplete: () => void;
}) {
  const { t } = useTranslation();
  const label = (key: string, values?: Record<string, unknown>) => t(`sessions.contents.excerpt.note.${key}`, values);
  const id = useId();
  const initialTitle = (draft.session.title || t("sessions.contents.excerpt.title")).replace(/\s+/gu, " ").trim();
  const [form, setForm] = useState<HandoffForm>(() => handoff.state.form ?? {
    open: true, slug: "", boardId: "", cardId: "", title: initialTitle, content: draft.document,
    request: null, reviewedDestination: null, hadUnknownOutcome: false, hasSentRequest: false, pending: false, error: null,
  });
  const formRef = useRef(form);
  const { open, slug, boardId, cardId, title, content } = form;
  const [saved, setSaved] = useState<{ id: string; slug: string; boardId: string; cardId: string | null } | null>(null);
  const [showClosePrompt, setShowClosePrompt] = useState(false);
  const [capacityReached, setCapacityReached] = useState(false);
  const dispatching = useRef(false);
  const mounted = useRef(true);
  const [validating, setValidating] = useState(false);
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
  const frozen = form.request !== null || saved !== null;
  const reviewedDestination = form.reviewedDestination;
  const workspaceOptions = frozen && reviewedDestination ? [reviewedDestination.workspace] : workspaces.data;
  const boardOptions = frozen && reviewedDestination ? [reviewedDestination.board] : boards.data;
  const cardOptions = frozen && reviewedDestination ? (reviewedDestination.card ? [reviewedDestination.card] : []) : cards;
  const audienceName = frozen ? reviewedDestination?.workspace.name : workspace?.name;
  const destinationBoard = frozen ? reviewedDestination?.board : destination;
  const destinationCard = frozen ? reviewedDestination?.card : cards.find((card) => card.id === cardId);

  let problem: string | null = null;
  if (!frozen) {
    if (sourceCheckFailed) problem = label("sourceCheckFailed");
    else if (stale || draft.bodies.some(({ item }) => !item.sha256 || !/^[a-f0-9]{64}$/i.test(item.sha256))) problem = label("sourceChanged");
    else if (draft.bodies.length > EXCERPT_NOTE_MAX_ITEMS) problem = label("tooMany");
    else if (oversized) problem = label("tooLarge");
    else if (compact === null) problem = label("invalidDocument");
    else if (destination?.is_frozen || board.data?.is_frozen) problem = label("boardFrozen");
    else if (slug && members.isSuccess && me.isSuccess && !["member", "admin", "owner"].includes(role ?? "")) problem = label("permission");
    else if (workspaces.isError || boards.isError || members.isError || board.isError || me.isError) problem = label("destinationUnavailable");
    else if (boardId && boards.isSuccess && !destination) problem = label("destinationUnavailable");
    else if (cardId && board.isSuccess && !cards.some((card) => card.id === cardId)) problem = label("destinationUnavailable");
  }
  if (form.error) {
    const error = form.error;
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
  const canRevise = form.error !== null && !form.hadUnknownOutcome
    && form.error.status >= 400 && form.error.status < 500;
  const formIdentity = JSON.stringify([slug, boardId, cardId, title, content, draft.fingerprint, stale, canSave]);
  const currentForm = useRef(formIdentity);
  currentForm.current = formIdentity;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    // A request started by the previous route instance can settle after this
    // dialog remounts. Adopt its result without losing the current open state.
    const retained = handoff.state.form;
    if (retained && retained !== formRef.current) {
      formRef.current = retained;
      setForm(retained);
    }
  }, [handoff.state.form]);

  function updateForm(patch: Partial<HandoffForm>): boolean {
    const next = { ...(handoff.getForm(draft) ?? formRef.current), ...patch };
    if (!saved && !handoff.setForm(draft, next)) {
      if (mounted.current) setCapacityReached(true);
      return false;
    }
    // Persist in the interaction, not a cleanup effect: a route can unmount
    // this component before React commits the next render.
    formRef.current = next;
    if (mounted.current) { setForm(next); setCapacityReached(false); }
    return true;
  }

  const edited = !!slug || !!boardId || !!cardId || title !== initialTitle || content !== draft.document;
  useNavigationGuard({
    isDirty: open && !saved && (edited || form.request !== null),
    canSave: !form.pending && !validating && (canSave || form.request !== null),
    save: dispatch,
    discard: onDiscard,
  });

  async function dispatch(): Promise<boolean> {
    if (dispatching.current || formRef.current.pending || saved) return false;
    if (!formRef.current.request) {
      if (!canSave || compact === null || !workspace || !destination) return false;
      dispatching.current = true;
      if (beforeFirstSave) {
        setValidating(true);
        let valid = false;
        try { valid = await beforeFirstSave(); } catch { /* A failed check never freezes a request. */ }
        if (!mounted.current || !handoff.isCurrent(draft)) return false;
        setValidating(false);
        if (!valid || currentForm.current !== formIdentity) {
          dispatching.current = false;
          return false;
        }
      }
      const card = cards.find((item) => item.id === cardId);
      const reviewed = {
        workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
        board: { id: destination.id, name: destination.name },
        ...(card ? { card: { id: card.id, title: card.title } } : {}),
      };
      const request = {
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
      if (!updateForm({ reviewedDestination: reviewed, request })) {
        dispatching.current = false;
        return false;
      }
    }
    dispatching.current = true;
    const request = formRef.current.request!;
    if (!handoff.isCurrent(draft) || !updateForm({ pending: true, hasSentRequest: true, error: null })) {
      dispatching.current = false;
      return false;
    }
    try {
      // mutateAsync settles even after the observer unmounts. The owner/draft
      // identity check prevents a late response from resurrecting revoked data.
      const note = await save.mutateAsync(request);
      if (!handoff.isCurrent(draft)) return false;
      if (mounted.current) {
        const completed = { ...formRef.current, content: "", request: null, pending: false, error: null };
        formRef.current = completed;
        setForm(completed);
        setSaved({ id: note.id, slug: request.slug, boardId: request.boardId, cardId: request.payload.card_id ?? null });
        setShowClosePrompt(false);
        onComplete();
      } else handoff.setDraft(null);
      return true;
    } catch (error) {
      if (!handoff.isCurrent(draft)) return false;
      const retainedError = new ApiError("Publication failed", isApiError(error) ? error.status : 0,
        undefined, { errorCode: isApiError(error) ? error.errorCode : undefined });
      updateForm({ pending: false, error: retainedError,
        hadUnknownOutcome: formRef.current.hadUnknownOutcome || outcomeIsUnknown(error) });
      return false;
    } finally {
      dispatching.current = false;
      // The retained draft owns retries. Release mutation-cache request/body
      // copies as soon as this attempt settles, including after route unmount.
      save.reset();
    }
  }

  function revise() {
    if (!canRevise || dispatching.current) return;
    updateForm({ request: null, reviewedDestination: null, hadUnknownOutcome: false, error: null });
    save.reset();
  }

  function dismiss() {
    if (saved) onDiscard();
    else if (formRef.current.request || stale || sourceCheckFailed) updateForm({ open: false });
    else if (edited) setShowClosePrompt(true);
    else onDiscard();
  }

  async function recheckSources() {
    if (!onRecheckSources || dispatching.current) return;
    dispatching.current = true;
    setValidating(true);
    try { await onRecheckSources(); } finally {
      dispatching.current = false;
      if (mounted.current) setValidating(false);
    }
  }

  const noteLink = saved ? buildNoteLink({ slug: saved.slug, boardId: saved.boardId, noteId: saved.id }) : null;
  const cardLink = saved?.cardId ? buildCardLink({ slug: saved.slug, boardId: saved.boardId, cardId: saved.cardId }) : null;
  return <>
    {!open ? <div className="flex basis-full flex-wrap items-center gap-3" role="status">
      {noteLink ? <Link className="inline-flex items-center text-sm text-primary underline underline-offset-4 max-sm:min-h-[44px] max-sm:min-w-[44px]" to={noteLink}>{label("openNote")}</Link> : <Button variant="outline" size="sm" className="max-sm:min-h-[44px] max-sm:min-w-[44px]" onClick={() => updateForm({ open: true })}>{label(frozen ? "resume" : "resumeDraft")}</Button>}
      {cardLink ? <Link className="inline-flex items-center text-sm text-primary underline underline-offset-4 max-sm:min-h-[44px] max-sm:min-w-[44px]" to={cardLink}>{label("openCard")}</Link> : null}
      {noteLink ? <Button variant="ghost" size="sm" className="max-sm:min-h-[44px] max-sm:min-w-[44px]" onClick={onDiscard}>{t("common.done")}</Button> : null}
    </div> : null}
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent className="max-w-4xl max-sm:[&>button]:min-h-[44px] max-sm:[&>button]:min-w-[44px]" aria-describedby={`${id}-audience`}>
        <DialogHeader className="max-sm:min-h-[44px] max-sm:pr-[44px]"><DialogTitle>{label("share")}</DialogTitle></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="grid gap-1.5 text-sm" htmlFor={`${id}-workspace`}>{label("workspace")}
            <select id={`${id}-workspace`} className={selectClass} value={slug} disabled={frozen || validating} onChange={(event) => updateForm({ slug: event.target.value, boardId: "", cardId: "" })}>
              <option value="">{label("chooseWorkspace")}</option>
              {workspaceOptions?.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm" htmlFor={`${id}-board`}>{label("board")}
            <select id={`${id}-board`} className={selectClass} value={boardId} disabled={frozen || validating || !slug || boards.isPending} onChange={(event) => updateForm({ boardId: event.target.value, cardId: "" })}>
              <option value="">{label("chooseBoard")}</option>
              {boardOptions?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm" htmlFor={`${id}-card`}>{label("card")}
            <select id={`${id}-card`} className={selectClass} value={cardId} disabled={frozen || validating || !boardId || board.isPending} onChange={(event) => updateForm({ cardId: event.target.value })}>
              <option value="">{label("noCard")}</option>
              {cardOptions.map((card) => <option key={card.id} value={card.id}>{card.title}</option>)}
            </select>
          </label>
        </div>
        <label className="grid gap-1.5 text-sm" htmlFor={`${id}-title`}>{label("title")}
          <Input className="max-sm:min-h-[44px] max-sm:min-w-[44px]" id={`${id}-title`} value={title} disabled={frozen || validating} onChange={(event) => updateForm({ title: event.target.value })} />
        </label>
        <section role="region" aria-label={label("content")} className="min-w-0">
          <RichTextEditor content={content} onChange={(value) => updateForm({ content: value })} editable={!frozen && !validating} allowMediaUpload={false} workspaceSlug={slug || undefined} className="max-h-[45dvh] min-h-48 overflow-auto" />
        </section>
        {!frozen ? <p className="text-xs text-muted-foreground">{label("review")}</p> : null}
        <div className="grid gap-3 border-t pt-4">
          {audienceName && destinationBoard ? <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label("workspace")}</dt><dd className="break-words font-medium">{audienceName}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label("board")}</dt><dd className="break-words font-medium">{destinationBoard.name}</dd></div>
            {!cardId || destinationCard ? <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label("card")}</dt><dd className="break-words font-medium">{destinationCard?.title ?? label("noCard")}</dd></div> : null}
          </dl> : null}
          <div id={`${id}-audience`} className="grid gap-1 text-sm leading-relaxed text-muted-foreground">
            <p>{audienceName ? label("audience", { workspace: audienceName }) : label("chooseAudience")}</p>
            <p>{label("cardVisibility")}</p>
            <p>{label("snapshot")}</p>
          </div>
          {!form.hasSentRequest ? <p className="text-sm text-muted-foreground">{label("unsent")}</p> : null}
          {!saved ? <p className="text-xs text-muted-foreground">{label("memoryOnly")}</p> : null}
          {capacityReached ? <p role="alert" className="text-sm text-destructive">{label("capacity")}</p> : null}
          {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
          {validating ? <p role="status" className="text-sm text-muted-foreground">{t("sessions.contents.excerpt.validating")}</p> : null}
          {form.pending ? <p role="status" className="text-sm text-muted-foreground">{label("saving")}</p> : null}
          {noteLink ? <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span>{label("saved")}</span>
            <Link className="text-primary underline underline-offset-4 max-sm:inline-flex max-sm:items-center max-sm:min-h-[44px] max-sm:min-w-[44px]" to={noteLink}>{label("openNote")}</Link>
            {cardLink ? <Link className="text-primary underline underline-offset-4 max-sm:inline-flex max-sm:items-center max-sm:min-h-[44px] max-sm:min-w-[44px]" to={cardLink}>{label("openCard")}</Link> : null}
          </div> : null}
          <DialogFooter className="max-sm:[&>button]:min-h-[44px] max-sm:[&>button]:min-w-[44px]">
            <Button variant="ghost" onClick={dismiss}>{frozen || stale || sourceCheckFailed ? label("hide") : t("sessions.contents.excerpt.cancel")}</Button>
            {!frozen && (stale || sourceCheckFailed) ? <>
              <Button variant="ghost" disabled={validating} onClick={onDiscard}>{label("discard")}</Button>
              {onRecheckSources ? <Button variant="outline" disabled={validating} onClick={() => void recheckSources()}>{label("recheck")}</Button> : null}
            </> : null}
            {canRevise ? <Button variant="outline" onClick={revise}>{label("revise")}</Button> : null}
            {form.error ? <Button onClick={() => void dispatch()} disabled={validating || form.pending}>{label("retry")}</Button> : !saved ? <Button onClick={() => void dispatch()} disabled={!canSave || validating || form.pending}>{label("save")}</Button> : null}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
    <UnsavedChangesPrompt open={showClosePrompt} canSave={canSave} pending={validating || form.pending}
      onSave={() => { void dispatch().then((success) => { if (success && mounted.current) setShowClosePrompt(false); }); }}
      onDiscard={onDiscard} onKeepEditing={() => setShowClosePrompt(false)} />
  </>;
}
