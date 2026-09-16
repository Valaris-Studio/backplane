// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { EntityLink } from "@/components/shared/EntityLink";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { useBoard } from "@/features/kanban/api/use-boards";
import { useMembers } from "@/features/members/api/use-members";
import { formatAbsolute, formatRelativeShort } from "@/lib/date-format";
import type { Note, NoteFinding } from "@/types/note";
import { NoteCardLinkControl } from "./NoteCardLinkControl";
import { NoteKindBadge } from "./NoteKindBadge";

const FINDING_SEVERITY_VARIANT: Record<
  NoteFinding["severity"],
  NonNullable<BadgeProps["variant"]>
> = {
  BLOCKING: "destructive",
  SHOULD_FIX: "warning",
  SUGGESTION: "secondary",
};

interface NoteEditorMetaProps {
  note: Note;
  slug: string;
}

/**
 * Read-only context strip under the note title: what kind of note this is,
 * the card it's attached to, the execution that produced it, who wrote it and
 * when — plus a reviewer verdict's structured findings, which are stored on
 * the note but were previously invisible in the UI.
 */
export function NoteEditorMeta({ note, slug }: NoteEditorMetaProps) {
  const { t } = useTranslation();
  const { data: members } = useMembers(slug);
  // The note stores only card_id; the board detail (columns → cards, one
  // cached fetch) resolves it to a human title. Disabled when there's no card
  // link — passing "" keeps the hook order stable while skipping the query.
  const { data: board } = useBoard(slug, note.card_id ? (note.board_id ?? "") : "");
  const linkedCard = note.card_id
    ? board?.columns.flatMap((c) => c.cards).find((c) => c.id === note.card_id)
    : undefined;
  const author = members?.find((m) => m.user_id === note.created_by);
  const authorName = author
    ? author.name || author.email
    : t("collection.unknownAuthor");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <NoteKindBadge kind={note.kind} failureClass={note.failure_class} />
        {note.card_id ? (
          <EntityLink
            type="card"
            id={note.card_id}
            boardId={note.board_id ?? undefined}
            slug={slug}
            className="font-medium text-primary hover:underline"
          >
            {linkedCard?.title ?? note.card_id.slice(0, 8)}
          </EntityLink>
        ) : null}
        <NoteCardLinkControl note={note} slug={slug} />
        {note.source_execution_id ? (
          <EntityLink
            type="execution"
            id={note.source_execution_id}
            slug={slug}
            className="font-medium text-primary hover:underline"
          >
            {t("notes.meta.sourceExecution")}
          </EntityLink>
        ) : null}
        <span>{t("notes.meta.author", { name: authorName })}</span>
        <span title={formatAbsolute(note.created_at)}>
          {t("collection.createdAt", { value: formatRelativeShort(note.created_at) })}
        </span>
        <span title={formatAbsolute(note.updated_at)}>
          {t("collection.updatedAt", { value: formatRelativeShort(note.updated_at) })}
        </span>
      </div>

      {note.findings?.length ? (
        <div className="rounded-[var(--radius-md)] border border-border/60 bg-muted/20 p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("notes.findings.title")}
          </p>
          <ul className="space-y-1.5">
            {note.findings.map((finding, index) => (
              <li key={index} className="flex items-start gap-2 text-xs">
                <Badge
                  variant={FINDING_SEVERITY_VARIANT[finding.severity] ?? "secondary"}
                  className="shrink-0"
                >
                  {t(`notes.findings.severity.${finding.severity}`)}
                </Badge>
                <span className="min-w-0 pt-0.5 text-foreground">
                  {finding.message}
                  {finding.file ? (
                    <span className="text-muted-foreground">
                      {" — "}
                      {finding.file}
                      {finding.function ? ` · ${finding.function}` : ""}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
