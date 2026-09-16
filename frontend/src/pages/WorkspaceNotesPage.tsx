// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { NoteList } from "@/features/notes/components/NoteList";

export function WorkspaceNotesPage() {
  const { slug = "" } = useParams();
  return <NoteList slug={slug} />;
}
