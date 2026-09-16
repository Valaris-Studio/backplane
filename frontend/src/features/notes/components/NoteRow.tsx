// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Bot, Pin, StickyNote } from "lucide-react";
import { formatAbsolute, formatRelativeShort } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import type { NoteSummary } from "@/types/note";
import { isAgentNote } from "../lib/noteKinds";
import { NoteKindBadge } from "./NoteKindBadge";

interface NoteRowProps {
  note: NoteSummary;
  authorName: string;
  onClick: () => void;
}

export function NoteRow({ note, authorName, onClick }: NoteRowProps) {
  const { t } = useTranslation();
  const agentic = isAgentNote(note.kind);
  const Icon = agentic ? Bot : StickyNote;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
        agentic && "border-l-2 border-l-primary/50 bg-primary/[0.03]",
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          {note.pinned ? (
            <Pin className="h-3.5 w-3.5 shrink-0 text-primary" />
          ) : null}
          <span className="truncate text-sm font-medium text-foreground">
            {note.title}
          </span>
          <NoteKindBadge
            kind={note.kind}
            failureClass={note.failure_class}
            className="shrink-0"
          />
        </div>
        {note.preview ? (
          <span className="truncate text-xs text-muted-foreground">
            {note.preview}
          </span>
        ) : null}
      </div>

      <div className="hidden shrink-0 text-xs text-muted-foreground sm:block">
        {authorName}
      </div>
      <div
        className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground md:block"
        title={formatAbsolute(note.created_at)}
      >
        {t("collection.createdAt", { value: formatRelativeShort(note.created_at) })}
      </div>
      <div
        className="w-20 shrink-0 text-right text-xs text-muted-foreground"
        title={formatAbsolute(note.updated_at)}
      >
        {t("collection.updatedAt", { value: formatRelativeShort(note.updated_at) })}
      </div>
    </button>
  );
}
