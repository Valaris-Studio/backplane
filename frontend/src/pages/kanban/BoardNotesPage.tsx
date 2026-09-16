// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { NoteList } from "@/features/notes/components/NoteList";
import { useBoard } from "@/features/kanban/api/use-boards";

export function BoardNotesPage() {
  const { slug = "", boardId = "" } = useParams();
  // Cache hit — BoardLayout already holds this query.
  const { data: board } = useBoard(slug, boardId);
  return (
    <NoteList
      slug={slug}
      boardId={boardId}
      isFrozen={board?.is_frozen === true}
    />
  );
}
