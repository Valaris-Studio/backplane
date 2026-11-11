// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NoteRevisionActor, NoteRevisionSummary } from "../api/note-history-types";

const MAX_EDIT_GROUP_SPAN_MS = 5 * 60 * 1000;

function principalIdentity(actor: NoteRevisionActor | null) {
  return actor && JSON.stringify([
    actor.user_id, actor.principal_kind, actor.authentication_method,
    actor.agent_id, actor.api_key_id, actor.installation_id,
  ]);
}

export function groupNoteRevisions(revisions: NoteRevisionSummary[]) {
  const groups: [NoteRevisionSummary, ...NoteRevisionSummary[]][] = [];
  for (const revision of revisions) {
    const group = groups.at(-1);
    const newest = group?.[0];
    const previous = group?.at(-1);
    const span = newest ? Date.parse(newest.recorded_at) - Date.parse(revision.recorded_at) : Infinity;
    if (newest && previous && revision.capture_kind === "edit" && newest.capture_kind === "edit"
      && previous.revision === revision.revision + 1
      && principalIdentity(revision.actor) !== null
      && principalIdentity(revision.actor) === principalIdentity(newest.actor)
      && revision.channel === newest.channel && revision.operation === newest.operation
      && span >= 0 && span <= MAX_EDIT_GROUP_SPAN_MS) {
      group!.push(revision);
    } else groups.push([revision]);
  }
  return groups;
}
