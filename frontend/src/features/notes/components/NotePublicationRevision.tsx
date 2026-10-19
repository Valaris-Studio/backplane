// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { isApiError } from "@/lib/api-error";
import { formatAbsolute } from "@/lib/date-format";
import type { Note } from "@/types/note";
import { useNotePublicationPresence, useNotePublicationRevision, type NotePublicationRevision } from "../api/use-note-publication-revision";

function comparisonMessage(revision: NotePublicationRevision) {
  if (revision.status === "no_record") return "noRecord";
  if (revision.status === "revision_not_recorded") return "revisionNotRecorded";
  if (revision.status === "unsupported_version") return "unsupportedVersion";
  if (revision.comparison === "matches") return "matches";
  if (revision.comparison === "differs") return "differs";
  if (revision.comparison_reason === "current_note_too_large") return "currentNoteTooLarge";
  return "loadError";
}

function PublicationRevisionResult({ slug, boardId, noteId, ownerId }: {
  slug: string; boardId: string; noteId: string; ownerId: string;
}) {
  const { t } = useTranslation();
  const revision = useNotePublicationRevision(slug, boardId, noteId, ownerId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const data = !revision.isError && revision.data?.status !== "access_lost" ? revision.data : undefined;
  const message = revision.isFetching ? "loading"
    : revision.isError ? "loadError"
    : revision.data?.status === "access_lost" ? "accessLost"
    : data ? comparisonMessage(data) : "loading";

  return (
    <div className="min-w-0 space-y-2 pt-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p role="status" className="font-medium">{t(`notes.publicationRevision.${message}`)}</p>
        <Button variant="ghost" size="sm" disabled={revision.isFetching} onClick={() => void revision.refetch()}>
          {t(revision.isError ? "notes.publicationRevision.retry" : "notes.publicationRevision.checkAgain")}
        </Button>
      </div>
      <p className="text-muted-foreground">{t("notes.publicationRevision.savedNoteScope")}</p>
      {data?.recorded_at && (
        <p className="text-muted-foreground">
          <span>{t("notes.publicationRevision.recordedAt")}</span>{" "}
          <time dateTime={data.recorded_at}>{formatAbsolute(data.recorded_at)}</time>
        </p>
      )}
      {data && data.status !== "no_record" && (
        <>
          <button type="button" aria-expanded={detailsOpen} aria-controls={detailsId}
            className="inline-flex items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setDetailsOpen((open) => !open)}>
            {t("notes.publicationRevision.details")}
            <ChevronDown aria-hidden="true" className={`size-3 ${detailsOpen ? "rotate-180" : ""}`} />
          </button>
          {detailsOpen && (
            <div id={detailsId} className="min-w-0 space-y-2 text-muted-foreground">
              <p>{t("notes.publicationRevision.fieldScope")}</p>
              <dl className="space-y-2">
                {data.published_revision_sha256 && <div>
                  <dt>{t("notes.publicationRevision.publishedDigest")}</dt>
                  <dd className="break-all font-mono text-foreground">{data.published_revision_sha256}</dd>
                </div>}
                {data.current_revision_sha256 && <div>
                  <dt>{t("notes.publicationRevision.currentDigest")}</dt>
                  <dd className="break-all font-mono text-foreground">{data.current_revision_sha256}</dd>
                </div>}
              </dl>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PublicationRevisionDisclosure({ slug, boardId, noteId, ownerId }: {
  slug: string; boardId: string; noteId: string; ownerId: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="min-w-0">
      <button type="button" aria-expanded={open} aria-controls={panelId}
        className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((expanded) => !expanded)}>
        {t("notes.publicationRevision.action")}
        <ChevronDown aria-hidden="true" className={`size-3 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div id={panelId}>
        <PublicationRevisionResult slug={slug} boardId={boardId} noteId={noteId} ownerId={ownerId} />
      </div>}
    </div>
  );
}

function PublicationPresence({ slug, boardId, noteId, ownerId }: {
  slug: string; boardId: string; noteId: string; ownerId: string;
}) {
  const { t } = useTranslation();
  const presence = useNotePublicationPresence(slug, boardId, noteId, ownerId);
  if (presence.isError) return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <p role="status" className="text-muted-foreground">{t("notes.publicationRevision.loadError")}</p>
      <Button variant="ghost" size="sm" disabled={presence.isFetching} onClick={() => void presence.refetch()}>
        {t("notes.publicationRevision.retry")}
      </Button>
    </div>
  );
  if (presence.data && "status" in presence.data) return (
    <p role="status" className="text-xs text-muted-foreground">{t("notes.publicationRevision.accessLost")}</p>
  );
  if (!presence.data?.has_record) return null;
  return <PublicationRevisionDisclosure slug={slug} boardId={boardId} noteId={noteId} ownerId={ownerId} />;
}

export function NotePublicationRevision({ note, slug }: { note: Note; slug: string }) {
  const { data: me, error } = useCurrentUser();
  // React Query retains cached identity after a failed refresh. An explicit
  // denial must unmount the private queries, aborting and discarding their proof.
  const identityLost = isApiError(error) && [401, 403, 404].includes(error.status);
  if (identityLost || !note.board_id || !me || me.id !== note.created_by) return null;
  return <PublicationPresence key={`${slug}/${note.board_id}/${note.id}/${me.id}`}
    slug={slug} boardId={note.board_id} noteId={note.id} ownerId={me.id} />;
}
