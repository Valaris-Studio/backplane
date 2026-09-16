// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus, X } from "lucide-react";
import { calculatePosition } from "../utils/position";
import { statusLabel } from "../utils/status-label";
import { priorityLabel } from "../utils/priority-label";
import { useCreateCard, useAddParticipant } from "../api/use-cards";
import { useMembers } from "@/features/members/api/use-members";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import type { Card, CardType, Column, ParticipantRole, Priority } from "@/types/kanban";

const CARD_TYPE_TOOLTIP_KEYS: Record<CardType, string> = {
  task: "cardTypeTask",
  bug: "cardTypeBug",
  feature: "cardTypeFeature",
  issue: "cardTypeIssue",
};

interface PendingParticipant {
  user_id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  role: ParticipantRole;
}

interface Props {
  slug: string;
  boardId: string;
  columnId: string;
  columns: Column[];
  existingCards: Card[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateCardDialog({
  slug,
  boardId,
  columnId: defaultColumnId,
  columns,
  existingCards,
  open,
  onOpenChange,
}: Props) {
  const { t } = useTranslation();
  const rootId = useId();
  const fieldId = (name: string) => `${rootId}-${name}`;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cardType, setCardType] = useState<CardType>("task");
  const [priority, setPriority] = useState<Priority>("medium");
  const [columnId, setColumnId] = useState(defaultColumnId);
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const [participants, setParticipants] = useState<PendingParticipant[]>([]);
  const [newUserId, setNewUserId] = useState("");
  const [newRole, setNewRole] = useState("");
  const createCard = useCreateCard(slug, boardId);
  const addParticipant = useAddParticipant(slug, boardId);
  const { data: members } = useMembers(slug);

  function resetForm() {
    setTitle("");
    setDescription("");
    setCardType("task");
    setPriority("medium");
    setColumnId(defaultColumnId);
    setDueDate("");
    setStatus("");
    setLabelsText("");
    setParticipants([]);
    setNewUserId("");
    setNewRole("");
  }

  function handleAddParticipant() {
    if (!newUserId || !newRole) return;
    const member = members?.find((m) => m.user_id === newUserId);
    if (!member) return;

    const hasHero = participants.some((p) => p.role === "hero");
    if (newRole === "hero" && hasHero) return;

    setParticipants((prev) => [
      ...prev,
      {
        user_id: member.user_id,
        name: member.name,
        email: member.email,
        avatar_url: null,
        role: newRole as ParticipantRole,
      },
    ]);
    setNewUserId("");
    setNewRole("");
  }

  function handleRemoveParticipant(userId: string) {
    setParticipants((prev) => prev.filter((p) => p.user_id !== userId));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    const targetColumn = columns.find((c) => c.id === columnId);
    const cardsInColumn = columnId === defaultColumnId
      ? existingCards
      : targetColumn?.cards ?? [];
    const lastPosition = cardsInColumn[cardsInColumn.length - 1]?.position;
    const position = calculatePosition(lastPosition);
    const parsedLabels = labelsText
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);

    createCard.mutate(
      {
        title: title.trim(),
        description,
        column_id: columnId,
        card_type: cardType,
        priority,
        position,
        due_date: dueDate || undefined,
        status: status || undefined,
        labels: parsedLabels.length > 0 ? parsedLabels : undefined,
      },
      {
        onSuccess: async (card) => {
          for (const p of participants) {
            addParticipant.mutate({ cardId: card.id, user_id: p.user_id, role: p.role });
          }
          resetForm();
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
            <DialogTitle>{t("cards.createTitle")}</DialogTitle>
            <DialogDescription>{t("cards.titlePlaceholder")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <label htmlFor={fieldId("title")} className="text-sm font-medium">
                {t("cards.titleLabel")}
              </label>
              <Input
                id={fieldId("title")}
                placeholder={t("cards.titlePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("cards.descriptionLabel")}</label>
              <RichTextEditor
                content={description}
                onChange={setDescription}
                placeholder={t("common.descriptionOptional")}
                workspaceSlug={slug}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label htmlFor={fieldId("type")} className="text-sm font-medium">
                  <RichTooltip i18nKey={CARD_TYPE_TOOLTIP_KEYS[cardType]} side="top">
                    <span>{t("cards.typeLabel")}</span>
                  </RichTooltip>
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
                  {t("cards.dueDateLabel")}
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
                  {t("cards.statusLabel")}
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

            <div className="space-y-2">
              <label htmlFor={fieldId("column")} className="text-sm font-medium">
                {t("cards.columnLabel")}
              </label>
              <Select value={columnId} onValueChange={setColumnId}>
                <SelectTrigger id={fieldId("column")}>
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

            {/* Participants */}
            <div className="space-y-3">
              <label className="text-sm font-medium">{t("cards.participants")}</label>

              {participants.length > 0 ? (
                <div className="space-y-2">
                  {[...participants]
                    .sort((a, b) => (a.role === "hero" ? -1 : b.role === "hero" ? 1 : 0))
                    .map((p) => (
                      <div key={p.user_id} className="flex items-center justify-between rounded-md border border-border/75 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Avatar className="h-6 w-6">
                            {p.avatar_url ? (
                              <AvatarImage src={p.avatar_url} alt={p.name} />
                            ) : null}
                            <AvatarFallback className="text-[0.6rem]">
                              {p.name.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0, 2)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm">{p.name || p.email}</span>
                          <Badge variant="outline" className="text-[0.65rem]">
                            {t(`cards.roles.${p.role}`)}
                          </Badge>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label={t("a11y.card.removeParticipant")}
                          onClick={() => handleRemoveParticipant(p.user_id)}
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
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder={t("cards.selectMember")}>
                      {members?.find((m) => m.user_id === newUserId)?.name ||
                        members?.find((m) => m.user_id === newUserId)?.email}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {members
                      ?.filter((m) => !participants.some((p) => p.user_id === m.user_id))
                      .map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.name || m.email}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Select value={newRole} onValueChange={setNewRole}>
                  <SelectTrigger className="w-32">
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
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t("a11y.card.addParticipant")}
                  disabled={!newUserId || !newRole}
                  onClick={handleAddParticipant}
                >
                  <UserPlus className="h-4 w-4" />
                </Button>
              </div>
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
            <Button type="submit" disabled={createCard.isPending || !title.trim()}>
              {createCard.isPending ? t("common.creating") : t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
