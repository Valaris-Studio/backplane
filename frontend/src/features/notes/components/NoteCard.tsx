// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Bot, Pin, SquarePen, StickyNote } from "lucide-react";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WaveCard } from "@/features/visuals/components/WaveCard";
import { formatRelativeShort } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import type { NoteSummary } from "@/types/note";
import { isAgentNote } from "../lib/noteKinds";
import { NoteKindBadge } from "./NoteKindBadge";

interface NoteCardProps {
  note: NoteSummary;
  authorName: string;
  onClick: () => void;
}

export function NoteCard({ note, authorName, onClick }: NoteCardProps) {
  const { t } = useTranslation();
  const agentic = isAgentNote(note.kind);
  const Icon = agentic ? Bot : StickyNote;

  return (
    <button type="button" onClick={onClick} className="text-left w-full">
      <WaveCard
        className={cn(
          "h-full border-border/75 transition-transform duration-200 hover:-translate-y-1 hover:border-primary/20 hover:shadow-panel",
          // Agentic notes get a tinted left accent so runner output is
          // distinguishable from human notes at a glance.
          agentic && "border-l-2 border-l-primary/50 bg-primary/[0.03]",
        )}
      >
        <CardHeader className="gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-cap)] bg-primary/10 text-primary shadow-soft">
              <Icon className="h-[1.15rem] w-[1.15rem]" />
            </div>
            <CardTitle className="line-clamp-2 min-w-0 flex-1 text-base leading-snug">
              {note.title}
            </CardTitle>
            {note.pinned ? (
              <Pin className="h-4 w-4 shrink-0 text-primary" />
            ) : null}
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card/70 text-muted-foreground opacity-0 transition-all duration-200 group-hover:opacity-100">
              <SquarePen className="h-4 w-4" />
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <NoteKindBadge kind={note.kind} failureClass={note.failure_class} />
          <p className="line-clamp-3 text-sm text-muted-foreground">
            {note.preview || t("notes.contentOptionalPlaceholder")}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{authorName}</span>
            <span aria-hidden="true">·</span>
            <span>{t("collection.updatedAt", { value: formatRelativeShort(note.updated_at) })}</span>
          </div>
        </CardContent>
      </WaveCard>
    </button>
  );
}
