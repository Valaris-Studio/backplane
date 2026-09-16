// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, Check, Hash, Link2, MoreVertical, Trash2, Unlink, X, UserPlus } from "lucide-react";
import {
  useUpdateCard,
  useAddParticipant,
  useDeleteCard,
  useRemoveParticipant,
} from "../api/use-cards";
import { useOptimisticCardMove } from "../hooks/use-optimistic-card-move";
import { useMembers } from "@/features/members/api/use-members";
import { useCardExecutions } from "@/features/agents/hooks/useAgentMetrics";
import { usePipelineConfig } from "@/features/agents/hooks/usePipelineConfig";
import { useNotes, useUpdateNote } from "@/features/notes/api/use-notes";
import { AgentInfoSubtab } from "@/components/agentic/agent-info-section";
import { EntityLink } from "@/components/shared/EntityLink";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { UnsavedChangesPrompt } from "@/components/ui/unsaved-changes-prompt";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import { FrozenActionTooltip } from "./FrozenActionTooltip";
import { CardCompletionSection } from "./CardCompletionSection";
import { DependenciesSection } from "./DependenciesSection";
import { StuckReasonsPanel } from "./StuckReasonsPanel";
import { computeStuckReasons } from "../utils/stuckReasons";
import { buildCardLink, parseCardLink } from "../utils/card-link";
import { statusLabel } from "../utils/status-label";
import { priorityLabel } from "../utils/priority-label";
import { isImmutableNoteKind } from "@/features/notes/lib/noteKinds";
import { copyTextToClipboard } from "@/lib/clipboard";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Card, CardType, Column, Priority } from "@/types/kanban";
import type { Note } from "@/types/note";

interface Props {
  card: Card | null;
  columns: Column[];
  slug: string;
  boardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Swap the sheet to another card on this board (card-reference links). */
  onOpenCard?: (cardId: string) => void;
  /** Frozen boards reject card mutations — gate the affordances up front. */
  isFrozen?: boolean;
  /**
   * False while `card.description` may still be the board's summary EXCERPT.
   * Saving then would persist the excerpt over the stored body, so writes stay
   * shut until the full card read lands. Defaults true for callers that pass a
   * card they already hold in full.
   */
  isDetailLoaded?: boolean;
}

export function CardDetailSheet({
  card,
  columns,
  slug,
  boardId,
  open,
  onOpenChange,
  onOpenCard,
  isFrozen = false,
  isDetailLoaded = true,
}: Props) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const rootId = useId();
  const fieldId = (name: string) => `${rootId}-${name}`;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cardType, setCardType] = useState<CardType>("task");
  const [priority, setPriority] = useState<Priority>("medium");
  const [columnId, setColumnId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const [newUserId, setNewUserId] = useState("");
  const [newRole, setNewRole] = useState("");
  // The add-participant button is an ephemeral commit trigger. After a
  // successful add we clear the two Selects; without this ref the browser
  // would drop focus to <body> on disable, breaking keyboard flow.
  const addParticipantButtonRef = useRef<HTMLButtonElement>(null);
  const updateCard = useUpdateCard(slug, boardId);
  const moveCard = useOptimisticCardMove(slug, boardId);
  const addParticipant = useAddParticipant(slug, boardId);
  const removeParticipant = useRemoveParticipant(slug, boardId);
  const deleteCard = useDeleteCard(slug, boardId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [idCopied, setIdCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const { data: members } = useMembers(slug);
  // Card-scoped: the backend filters by this card, so a done card's full
  // pipeline history is returned regardless of how old it is (was empty before —
  // the workspace-wide newest-50 fetch never contained an old card's rows).
  const { data: executions } = useCardExecutions(slug, card?.id);
  const { data: cardNotes } = useNotes(slug, boardId, { cardId: card?.id });
  const [linkNoteOpen, setLinkNoteOpen] = useState(false);
  // The board-wide list feeds the link-note picker only, and it is the
  // UNPAGINATED endpoint — full ProseMirror bodies for every note on the
  // board — so it stays disabled until the picker opens. Its cache entry
  // (noteKeys.byBoard) is NOT shared with the notes page, whose browse list
  // lives under noteKeys.list.
  const { data: boardNotes } = useNotes(slug, boardId, { enabled: linkNoteOpen });
  const updateNote = useUpdateNote(slug, boardId);
  const [noteLinkError, setNoteLinkError] = useState<unknown>(null);
  // preferDetail: the backend writes the user-actionable copy into `detail`
  // for link validation (wrong board, workspace-level note, immutable kind).
  const noteLinkErrorMessage =
    noteLinkError === null
      ? null
      : resolveApiErrorMessage(noteLinkError, t, i18n, {
          preferDetail: true,
          fallbackKey: "agentic.card.noteLinkError",
        });
  const { pipelineConfig } = usePipelineConfig(slug);

  // Shared by the picker save and the per-row unlink; closing the (possibly
  // already-closed) picker on success keeps one code path.
  function setNoteCardLink(noteId: string, targetCardId: string | null) {
    setNoteLinkError(null);
    updateNote.mutate(
      { noteId, card_id: targetCardId },
      {
        onSuccess: () => setLinkNoteOpen(false),
        onError: setNoteLinkError,
      },
    );
  }

  const agentParticipants = useMemo(
    () => card?.participants?.filter((p) => p.agent_id != null) ?? [],
    [card?.participants],
  );

  // UX-3: prefer the first-class `pr_url` column. Fall back to parsing the
  // legacy "PR: <url>" footer for historical cards where the column is null.
  const prUrl = useMemo(() => {
    if (card?.pr_url) return card.pr_url;
    if (!card?.description) return null;
    const match = card.description.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    return match ? match[0] : null;
  }, [card?.pr_url, card?.description]);

  const latestReview = useMemo<"approve" | "request_changes" | null>(() => {
    if (!cardNotes?.length) return null;
    const newest = [...cardNotes].sort((a, b) =>
      b.created_at < a.created_at ? -1 : 1,
    );
    for (const n of newest) {
      const match = n.title.match(/^Review:\s+\S+\s+[—-]\s+(approve|request_changes)\s*$/);
      if (match) return match[1] as "approve" | "request_changes";
    }
    return null;
  }, [cardNotes]);

  const cardExecutions = useMemo(() => {
    if (!card || !executions) return [];
    return executions
      .filter((e) => e.cards_affected?.includes(card.id))
      .sort((a, b) => (b.started_at < a.started_at ? -1 : 1))
      .slice(0, 5);
  }, [card, executions]);

  const awaitingPromptStages = useMemo(() => {
    if (!card || !executions) return [];
    const seen = new Set<string>();
    const rows: { role: string; stage: string }[] = [];
    for (const e of executions) {
      if (e.status !== "skipped") continue;
      if (!e.cards_affected?.includes(card.id)) continue;
      if (!e.role || !e.action) continue;
      const key = `${e.role}\u0000${e.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ role: e.role, stage: e.action });
    }
    return rows;
  }, [card, executions]);

  const sortedCardNotes = useMemo(() => {
    if (!cardNotes) return [];
    return [...cardNotes]
      .sort((a, b) => (b.created_at < a.created_at ? -1 : 1))
      .slice(0, 10);
  }, [cardNotes]);

  const currentColumn = useMemo(
    () => columns.find((c) => c.id === card?.column_id) ?? null,
    [columns, card?.column_id],
  );

  const stuckReasons = useMemo(() => {
    if (!card) return [];
    return computeStuckReasons({
      card,
      column: currentColumn,
      cardExecutions,
      awaitingPromptCount: awaitingPromptStages.length,
      latestReview,
      pipelineStages: pipelineConfig?.stages,
    });
  }, [
    card,
    currentColumn,
    cardExecutions,
    awaitingPromptStages.length,
    latestReview,
    pipelineConfig?.stages,
  ]);

  const isDoneColumn = currentColumn?.column_type === "done";

  const resetDraft = useCallback(() => {
    if (!card) return;
    setTitle(card.title);
    setDescription(card.description);
    setCardType(card.card_type);
    setPriority(card.priority);
    setColumnId(card.column_id);
    setDueDate(card.due_date ?? "");
    setStatus(card.status ?? "");
    setLabelsText(card.labels?.join(", ") ?? "");
  }, [card]);

  // Keyed on `open` as well as the card: BoardView mounts this sheet
  // unconditionally and never clears selectedCardId, and useCardDetail hands
  // back the same cached object on reopen, so a card-only key would never
  // refire and the sheet would reopen on a stale draft. Deliberately one-way —
  // resetting as `open` flips false would snap the still-visible sheet back to
  // pre-save values during the exit tween (useUpdateCard's optimistic patch
  // hits the board query, not cardKeys.detail).
  useEffect(() => {
    if (!open) return;
    resetDraft();
  }, [resetDraft, open]);

  function copyCardId() {
    if (!card) return;
    void copyTextToClipboard(card.id).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setIdCopied(true);
      window.setTimeout(() => setIdCopied(false), 1500);
    });
  }

  function copyCardLinkToClipboard() {
    if (!card) return;
    const url = `${window.location.origin}${buildCardLink({ slug, boardId, cardId: card.id })}`;
    void copyTextToClipboard(url).then((copiedSuccessfully) => {
      if (!copiedSuccessfully) return;
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    });
  }

  function handleDelete() {
    if (!card) return;
    setDeleteError(null);
    deleteCard.mutate(card.id, {
      onSuccess: () => {
        setConfirmDelete(false);
        // Deleting the card is not discarding unsaved edits — bypass the
        // guard rather than prompting to save a card that no longer exists.
        guard.closeAnyway();
      },
      onError: () => {
        setDeleteError(t("cards.delete.error"));
      },
    });
  }

  function handleSave() {
    if (!card || !title.trim()) return;
    const parsedLabels = labelsText
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);

    // A column change is NOT a plain field PATCH — update_card has no
    // column_id field and now rejects it outright; only /move does. Moving
    // owns the fractional position, the Done-merge gate, and the column-change
    // activity, so route it through the move endpoint. Append to the end of
    // the target column following the max_position + 1024 convention.
    const columnChanged = columnId !== card.column_id;
    if (columnChanged) {
      const target = columns.find((c) => c.id === columnId);
      const maxPosition = target?.cards.reduce(
        (max, c) => (c.position > max ? c.position : max),
        0,
      ) ?? 0;
      moveCard.mutate({
        cardId: card.id,
        column_id: columnId,
        position: maxPosition + 1024,
      });
    }

    updateCard.mutate(
      {
        cardId: card.id,
        title: title.trim(),
        description,
        card_type: cardType,
        priority,
        due_date: dueDate || null,
        status: status || null,
        labels: parsedLabels.length > 0 ? parsedLabels : null,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  // Save only activates when an editable field actually diverges from the
  // card's persisted value. Participants/dependencies save through their own
  // immediate mutations, so they're intentionally excluded here. Normalize the
  // same way handleSave does (trim title, comma-split labels) so cosmetic
  // whitespace doesn't read as a change.
  const isDirty = useMemo(() => {
    if (!card) return false;
    const normalizedLabels = labelsText
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(", ");
    const originalLabels = card.labels?.join(", ") ?? "";
    return (
      title.trim() !== card.title ||
      description !== card.description ||
      cardType !== card.card_type ||
      priority !== card.priority ||
      columnId !== card.column_id ||
      dueDate !== (card.due_date ?? "") ||
      status !== (card.status ?? "") ||
      normalizedLabels !== originalLabels
    );
  }, [card, title, description, cardType, priority, columnId, dueDate, status, labelsText]);

  const saveDisabled =
    updateCard.isPending ||
    !title.trim() ||
    !isDirty ||
    isFrozen ||
    !isDetailLoaded;
  const saveLabel = updateCard.isPending ? t("common.saving") : t("common.save");

  const guard = useUnsavedChangesGuard({
    isDirty,
    onClose: () => onOpenChange(false),
    onSave: handleSave,
    canSave: !saveDisabled,
    onDiscard: resetDraft,
  });

  // Capture-phase so card-reference anchors anywhere in the sheet body
  // (description rich text, dependency chips) are intercepted before tiptap's
  // own link handling or the browser's full navigation. Modifier/middle
  // clicks keep their native open-in-new-tab behavior.
  function handleCardLinkCapture(event: React.MouseEvent<HTMLDivElement>) {
    if (!onOpenCard || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement).closest?.("a[href]");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const reference = parseCardLink(anchor.getAttribute("href") ?? "");
    if (!reference) return;
    event.preventDefault();
    event.stopPropagation();
    if (reference.slug === slug && reference.boardId === boardId) {
      onOpenCard(reference.cardId);
    } else {
      navigate(buildCardLink(reference));
    }
  }

  return (
    <Sheet open={open} onOpenChange={guard.handleOpenChange}>
      {/* overflow-hidden + p-0 hand scroll ownership to the inner body so the
          header and footer stay pinned regardless of how tall the form gets
          (the board behind can be scrolled arbitrarily far). */}
      <SheetContent
        side="right"
        className="gap-0 overflow-hidden p-0"
        // Headerless: the compact close (X) row IS the whole header.
        closeClassName="right-3 top-3 z-20 h-8 w-8"
        // Structured metadata rows (status, priority, participants) stop being
        // readable below ~576px, so the floor sits above the note editor's.
        // 896px (56rem) matches the note editor — the two edit panels read as
        // one surface, and it is the sole width source now that the `!w-*`
        // pin is gone (it outranked the inline resize width and froze drag).
        resizable
        resizeStorageKey="card-detail"
        defaultWidth={896}
        minWidth={576}
        maxWidth={1440}
        resizeHandleLabel={t("common.resizePanel")}
      >
        {/* No visible heading — a card editor is self-explanatory. The sheet
            still needs an accessible name; an sr-only title supplies it. Save
            lives only in the pinned footer, which floats above the content, so
            a header copy would be pure duplication. */}
        <SheetTitle className="sr-only">{t("cards.editTitle")}</SheetTitle>

        {/* Kebab menu — left of the built-in close (X) so the two never
            overlap. Absolute like the close button; the title row's pr-16
            (below) reserves room for both. */}
        <div className="absolute right-12 top-3 z-20">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("cards.actions.more")}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={copyCardLinkToClipboard} closeOnClick={false}>
                {linkCopied ? (
                  <Check className="mr-2 h-4 w-4 text-[color:var(--color-success)]" />
                ) : (
                  <Link2 className="mr-2 h-4 w-4" />
                )}
                {linkCopied ? t("cards.actions.linkCopied") : t("cards.actions.copyLink")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={copyCardId} closeOnClick={false}>
                {idCopied ? (
                  <Check className="mr-2 h-4 w-4 text-[color:var(--color-success)]" />
                ) : (
                  <Hash className="mr-2 h-4 w-4" />
                )}
                {idCopied ? t("cards.actions.idCopied") : t("cards.actions.copyId")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          // The body starts nearly at the sheet top (pt-3): the title row
          // clears the close (X) horizontally via pr-9 instead of reserving a
          // whole strip above. When the approval alert renders first (full
          // width), fall back to clearing the X vertically (pt-11).
          className={cn(
            "flex-1 space-y-5 overflow-y-auto px-6 pb-5",
            card?.has_pending_approval ? "pt-11" : "pt-3",
          )}
          onClickCapture={handleCardLinkCapture}
        >
          {card?.has_pending_approval ? (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-md border border-[color:var(--color-warning)]/40 bg-warning/15 px-4 py-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]" />
              <div className="flex-1 space-y-1">
                <p className="font-semibold text-[color:var(--color-warning-foreground)]">
                  {t("cards.awaitingApproval")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("cards.awaitingApprovalDetail")}
                </p>
                <Link
                  to={`/${slug}/approvals`}
                  className="inline-block text-xs font-medium text-primary hover:underline"
                >
                  {t("cards.viewApproval")}
                </Link>
              </div>
            </div>
          ) : null}
          {/* No field labels: title and description are self-explanatory —
              placeholders carry the hint, aria-label keeps the input named.
              pr-16 keeps the title row clear of BOTH the kebab and the close
              (X) when it's the topmost element (no approval alert above
              pushing it down). */}
          <div className={cn(!card?.has_pending_approval && "pr-16")}>
            <Input
              id={fieldId("title")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("cards.titleLabel")}
              aria-label={t("cards.titleLabel")}
            />
          </div>
          <RichTextEditor
            content={description}
            onChange={setDescription}
            placeholder={t("cards.descriptionLabel")}
            workspaceSlug={slug}
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor={fieldId("type")} className="text-sm font-medium">
                {t("cards.typeLabel")}
              </label>
              <Select value={cardType} onValueChange={(v) => setCardType(v as CardType)}>
                <SelectTrigger id={fieldId("type")}>
                  <SelectValue>{t(`cards.types.${cardType}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="task">{t("cards.types.task")}</SelectItem>
                  <SelectItem value="bug">{t("cards.types.bug")}</SelectItem>
                  <SelectItem value="feature">{t("cards.types.feature")}</SelectItem>
                  <SelectItem value="issue">{t("cards.types.issue")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor={fieldId("priority")} className="text-sm font-medium">
                {t("cards.priorityLabel")}
              </label>
              <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
                <SelectTrigger id={fieldId("priority")}>
                  <SelectValue>{priorityLabel(t, priority)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">{t("cards.priorities.low")}</SelectItem>
                  <SelectItem value="medium">{t("cards.priorities.medium")}</SelectItem>
                  <SelectItem value="high">{t("cards.priorities.high")}</SelectItem>
                  <SelectItem value="urgent">{t("cards.priorities.urgent")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor={fieldId("dueDate")} className="text-sm font-medium">
                <RichTooltip i18nKey="kanban.dueDate" side="top">
                  <span>{t("cards.dueDateLabel")}</span>
                </RichTooltip>
              </label>
              <Input
                id={fieldId("dueDate")}
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor={fieldId("status")} className="text-sm font-medium">
                <RichTooltip i18nKey="kanban.status" side="top">
                  <span>{t("cards.statusLabel")}</span>
                </RichTooltip>
              </label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id={fieldId("status")}>
                  <SelectValue placeholder={t("common.none")}>
                    {statusLabel(t, status)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todo">{t("cards.statuses.todo")}</SelectItem>
                  <SelectItem value="in_progress">{t("cards.statuses.in_progress")}</SelectItem>
                  <SelectItem value="in_review">{t("cards.statuses.in_review")}</SelectItem>
                  <SelectItem value="done">{t("cards.statuses.done")}</SelectItem>
                  <SelectItem value="blocked">{t("cards.statuses.blocked")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor={fieldId("labels")} className="text-sm font-medium">
              {t("cards.labelsLabel")}
            </label>
            <Input
              id={fieldId("labels")}
              placeholder={t("cards.labelsPlaceholder")}
              value={labelsText}
              onChange={(e) => setLabelsText(e.target.value)}
            />
          </div>

          {/* Dependencies — full bidirectional view; counts on the card chip
              come from the inline CardRead fields populated by the backend
              annotator. */}
          {open && card && <CardCompletionSection slug={slug} boardId={boardId} cardId={card.id} isFrozen={isFrozen} />}
          {card ? (
            <DependenciesSection
              card={card}
              slug={slug}
              boardId={boardId}
              columns={columns}
            />
          ) : null}

          {/* Participants */}
          <div className="space-y-3" role="group" aria-labelledby={fieldId("participants-label")}>
            <label id={fieldId("participants-label")} className="text-sm font-medium">
              <RichTooltip i18nKey="kanban.participantRole" side="top">
                <span>{t("cards.participants")}</span>
              </RichTooltip>
            </label>

            {card?.participants && card.participants.length > 0 ? (
              <div className="space-y-2">
                {[...card.participants]
                  .sort((a, b) => (a.role === "hero" ? -1 : b.role === "hero" ? 1 : 0))
                  .map((p) => (
                    <div key={p.user_id} className="flex items-center justify-between rounded-md border border-border/75 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Avatar className="h-6 w-6">
                          {p.user.avatar_url ? (
                            <AvatarImage src={p.user.avatar_url} alt={p.user.name} />
                          ) : null}
                          <AvatarFallback className="text-[0.6rem]">
                            {p.user.name.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm">{p.user.name || p.user.email}</span>
                        <Badge variant="outline" className="text-[0.65rem]">
                          {t(`cards.roles.${p.role}`)}
                        </Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label={t("a11y.card.removeParticipant")}
                        disabled={isFrozen}
                        onClick={() => {
                          if (!card) return;
                          removeParticipant.mutate({ cardId: card.id, userId: p.user_id });
                        }}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("cards.noParticipants")}</p>
            )}

            <div className="flex gap-2">
              <Select value={newUserId} onValueChange={setNewUserId}>
                <SelectTrigger
                  id={fieldId("participant-member")}
                  aria-label={t("cards.selectMember")}
                  className="flex-1"
                >
                  <SelectValue placeholder={t("cards.selectMember")}>
                    {members?.find((m) => m.user_id === newUserId)?.name ||
                      members?.find((m) => m.user_id === newUserId)?.email}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {members
                    ?.filter((m) => !card?.participants?.some((p) => p.user_id === m.user_id))
                    .map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.name || m.email}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Select value={newRole} onValueChange={setNewRole}>
                <SelectTrigger
                  id={fieldId("participant-role")}
                  aria-label={t("cards.rolePlaceholder")}
                  className="w-32"
                >
                  <SelectValue placeholder={t("cards.rolePlaceholder")}>
                    {t(`cards.roles.${newRole}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hero">{t("cards.roles.hero")}</SelectItem>
                  <SelectItem value="viewer">{t("cards.roles.viewer")}</SelectItem>
                  <SelectItem value="stakeholder">{t("cards.roles.stakeholder")}</SelectItem>
                  <SelectItem value="helper">{t("cards.roles.helper")}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                ref={addParticipantButtonRef}
                variant="outline"
                size="icon"
                aria-label={t("a11y.card.addParticipant")}
                disabled={
                  !newUserId || !newRole || addParticipant.isPending || isFrozen
                }
                onClick={() => {
                  if (!card || !newUserId || !newRole) return;
                  addParticipant.mutate(
                    { cardId: card.id, user_id: newUserId, role: newRole },
                    {
                      onSuccess: () => {
                        setNewUserId("");
                        setNewRole("");
                        // Refocus the trigger so keyboard users stay anchored
                        // — disabling the button would otherwise drop focus
                        // to <body>.
                        addParticipantButtonRef.current?.focus();
                      },
                    },
                  );
                }}
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <AgentInfoSubtab title={t("agentic.card.subtabTitle")}>
            <div className="space-y-5">
              {/* Agent participants */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("agentic.card.participantsTitle")}
                </h4>
                {agentParticipants.length > 0 ? (
                  <div className="space-y-2">
                    {agentParticipants.map((p) => (
                      <div
                        key={p.user_id}
                        className="flex items-center gap-2 rounded-md border border-border/75 px-3 py-2"
                      >
                        <span className="text-sm">{p.agent?.name ?? p.user.name}</span>
                        <Badge variant="outline" className="text-[0.65rem]">
                          {t(`cards.roles.${p.role}`)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("agentic.card.participantsEmpty")}
                  </p>
                )}
              </div>

              {/* Pull request */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("agentic.card.prTitle")}
                </h4>
                {prUrl ? (
                  // TODO UX-B.1: surface PR state (open/merged/closed). Blocked on backend
                  // PR status endpoint; today only the URL is available from card description.
                  <EntityLink
                    type="pr"
                    slug={slug}
                    externalUrl={prUrl}
                    className="text-sm text-primary hover:underline break-all"
                  >
                    {prUrl}
                  </EntityLink>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("agentic.card.prNone")}</p>
                )}
              </div>

              <StuckReasonsPanel reasons={stuckReasons} suppressed={isDoneColumn} />

              {awaitingPromptStages.length > 0 ? (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("agentic.card.awaitingPromptsTitle")}
                  </h4>
                  <ul className="space-y-1">
                    {awaitingPromptStages.map(({ role, stage }) => (
                      <li
                        key={`${role}\u0000${stage}`}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge variant="outline" className="text-[0.6rem]">
                            {role}
                          </Badge>
                          <span className="truncate">{stage}</span>
                        </div>
                        <Link
                          to={`/${slug}/runner/pipeline?role=${encodeURIComponent(role)}&stage=${encodeURIComponent(stage)}`}
                          className="shrink-0 text-primary hover:underline"
                        >
                          {t("agentic.card.awaitingPromptsAuthor")}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Execution history */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("agentic.card.executionsTitle")}
                </h4>
                {cardExecutions.length > 0 ? (
                  <ul className="space-y-1">
                    {cardExecutions.map((exec) => (
                      <li
                        key={exec.id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate">{exec.action}</span>
                          {exec.role ? (
                            <Badge variant="outline" className="text-[0.6rem]">
                              {exec.role}
                            </Badge>
                          ) : null}
                          <span className="text-muted-foreground shrink-0">
                            {formatDate(exec.started_at)}
                          </span>
                        </div>
                        <EntityLink
                          type="execution"
                          id={exec.id}
                          slug={slug}
                          className="shrink-0 text-primary hover:underline"
                        >
                          {t("agentic.card.executionLink")}
                        </EntityLink>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("agentic.card.executionsEmpty")}
                  </p>
                )}
              </div>

              {/* Latest review decision */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("agentic.card.latestReviewTitle")}
                </h4>
                {latestReview === "approve" ? (
                  <Badge variant="outline" className="text-xs">
                    {t("agentic.card.latestReviewApprove")}
                  </Badge>
                ) : latestReview === "request_changes" ? (
                  <Badge variant="outline" className="text-xs">
                    {t("agentic.card.latestReviewRequestChanges")}
                  </Badge>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("agentic.card.latestReviewNone")}
                  </p>
                )}
              </div>

              {/* Review & platform notes */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("agentic.card.notesTitle")}
                  </h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={updateNote.isPending}
                    onClick={() => {
                      setNoteLinkError(null);
                      setLinkNoteOpen(true);
                    }}
                  >
                    {t("agentic.card.linkNote")}
                  </Button>
                </div>
                {/* Row-unlink failures happen with the picker closed — the
                    picker renders its own copy of this message while open. */}
                {noteLinkErrorMessage && !linkNoteOpen ? (
                  <p role="alert" className="text-xs text-destructive">
                    {noteLinkErrorMessage}
                  </p>
                ) : null}
                {sortedCardNotes.length > 0 ? (
                  <>
                    <ul className="space-y-1">
                      {sortedCardNotes.map((note) => (
                        <li
                          key={note.id}
                          className="flex items-center justify-between gap-2 text-xs"
                        >
                          {/* House rule: link the note to its element. A note
                              that records a pipeline verdict links to the
                              execution that produced it; otherwise to the board
                              notes page. */}
                          <EntityLink
                            {...(note.source_execution_id
                              ? { type: "execution", id: note.source_execution_id, slug }
                              : { type: "note", id: note.id, slug, boardId })}
                            className="truncate text-primary hover:underline"
                          >
                            {note.title}
                          </EntityLink>
                          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                            {formatDate(note.created_at)}
                            {/* Immutable kinds (review_verdict): the backend
                                403s any update, unlink included — offer no
                                affordance. */}
                            {isImmutableNoteKind(note.kind) ? null : (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5"
                                aria-label={t("agentic.card.unlinkNote")}
                                disabled={updateNote.isPending}
                                onClick={() => setNoteCardLink(note.id, null)}
                              >
                                <Unlink className="h-3 w-3" />
                              </Button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {(cardNotes?.length ?? 0) > sortedCardNotes.length ? (
                      <Link
                        to={`/${slug}/boards/${boardId}/notes`}
                        className="text-xs text-primary hover:underline"
                      >
                        {t("cards.viewAllNotes")}
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("agentic.card.notesEmpty")}
                  </p>
                )}
              </div>
            </div>
          </AgentInfoSubtab>

          <div className="space-y-2">
            <label htmlFor={fieldId("column")} className="text-sm font-medium">
              {t("cards.columnLabel")}
            </label>
            <Select value={columnId} onValueChange={setColumnId}>
              <SelectTrigger id={fieldId("column")} disabled={isFrozen}>
                <SelectValue>
                  {columns.find((c) => c.id === columnId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {columns.map((column) => (
                  <SelectItem key={column.id} value={column.id}>
                    {column.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <SheetFooter className="shrink-0 border-t border-border/60 px-6 pb-6 pt-4">
          <FrozenActionTooltip frozen={isFrozen} className="mr-auto">
            <Button
              variant="ghost"
              className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
              disabled={!card || deleteCard.isPending || isFrozen}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              {t("cards.actions.delete")}
            </Button>
          </FrozenActionTooltip>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <FrozenActionTooltip frozen={isFrozen}>
            <Button onClick={handleSave} disabled={saveDisabled}>
              {saveLabel}
            </Button>
          </FrozenActionTooltip>
        </SheetFooter>
      </SheetContent>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cards.delete.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("cards.delete.confirmBody", { title: card?.title ?? "" })}
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteCard.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteCard.isPending}
            >
              {deleteCard.isPending ? t("common.saving") : t("cards.delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {card ? (
        <CardNoteLinkPicker
          open={linkNoteOpen}
          onOpenChange={setLinkNoteOpen}
          notes={boardNotes ?? []}
          cardId={card.id}
          onSave={(noteId) => setNoteCardLink(noteId, card.id)}
          pending={updateNote.isPending}
          errorMessage={noteLinkErrorMessage}
        />
      ) : null}

      <UnsavedChangesPrompt
        open={guard.guardOpen}
        canSave={guard.canSave}
        onSave={guard.saveAndClose}
        onDiscard={guard.closeAnyway}
        onKeepEditing={guard.dismissGuard}
      />
    </Sheet>
  );
}

/** Single-select picker over the board's notes; notes already linked to THIS
 *  card are excluded, notes linked elsewhere stay offered (relink allowed).
 *  Immutable kinds are excluded too — the backend 403s linking them. */
function CardNoteLinkPicker({
  open,
  onOpenChange,
  notes,
  cardId,
  onSave,
  pending,
  errorMessage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notes: Note[];
  cardId: string;
  onSave: (noteId: string) => void;
  pending: boolean;
  errorMessage: string | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    return notes
      .filter((n) => n.card_id !== cardId)
      .filter((n) => !isImmutableNoteKind(n.kind))
      .filter((n) => !lowerQuery || n.title.toLowerCase().includes(lowerQuery))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [notes, cardId, query]);

  function handleOpenChange(next: boolean) {
    if (next) {
      setQuery("");
      setSelectedNoteId(null);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("agentic.card.linkNote")}</DialogTitle>
          <DialogDescription>
            {t("agentic.card.notePickerDescription")}
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder={t("agentic.card.notePickerSearchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="max-h-72 overflow-y-auto">
          {candidates.length === 0 ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">
              {t("agentic.card.notePickerEmpty")}
            </p>
          ) : (
            <ul className="space-y-1">
              {candidates.map((note) => {
                const selected = selectedNoteId === note.id;
                return (
                  <li key={note.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedNoteId(note.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left hover:border-border/75 hover:bg-muted/30",
                        selected && "border-primary/30 bg-primary/5",
                      )}
                      aria-pressed={selected}
                    >
                      <span className="truncate text-sm">{note.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter>
          {/* Cancel stays enabled while pending — a slow request must not
              trap the user in the dialog. */}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => selectedNoteId && onSave(selectedNoteId)}
            disabled={pending || !selectedNoteId}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
