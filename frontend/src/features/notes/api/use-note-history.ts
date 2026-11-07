// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDomainSync } from "@/hooks/useDomainSync";
import { useWebSocket } from "@/hooks/use-websocket";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { noteHistoryKeys } from "@/lib/query-keys";
import type { Note } from "@/types/note";
import type { NoteRevisionComparison, NoteRevisionDetail, NoteRevisionPage, NoteRevisionSummary } from "./note-history-types";

interface RevisionSelection {
  selected: number;
  from: number | null;
  to: number;
  mode: "previous" | "current";
}

const HISTORY_PAGE_SIZE = 50;

export function useNoteHistory(slug: string, boardId: string | null, noteId: string, viewerId: string) {
  const client = useQueryClient();
  const family = useMemo(() => noteHistoryKeys.root(slug, boardId, noteId, viewerId), [slug, boardId, noteId, viewerId]);
  const currentKey = useMemo(() => noteHistoryKeys.current(slug, boardId, noteId, viewerId), [slug, boardId, noteId, viewerId]);
  const base = `/workspaces/${slug}${boardId ? `/boards/${boardId}` : ""}/notes/${noteId}`;
  const epoch = useRef(0);
  const denied = useRef(false);
  const activityVersion = useRef(0);
  const [accessLost, setAccessLost] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const { status, onAccessRevoked } = useWebSocket();
  const previousStatus = useRef(status);

  const revoke = useCallback(() => {
    if (denied.current) return;
    denied.current = true;
    epoch.current++;
    setAccessLost(true);
    void client.cancelQueries({ queryKey: family });
    client.removeQueries({ queryKey: family });
  }, [client, family]);

  const read = useCallback(async <T,>(path: string, signal: AbortSignal): Promise<T> => {
    const requestEpoch = epoch.current;
    if (denied.current) throw new DOMException("Access lost", "AbortError");
    try {
      const { data } = await api.get<T>(path, { signal });
      if (signal.aborted || denied.current || epoch.current !== requestEpoch) throw new DOMException("Obsolete history read", "AbortError");
      return data;
    } catch (error) {
      if (!signal.aborted && epoch.current === requestEpoch && isApiError(error) && [401, 403, 404].includes(error.status)) revoke();
      throw error;
    }
  }, [revoke]);

  useEffect(() => () => {
    epoch.current++;
    void client.cancelQueries({ queryKey: family });
    client.removeQueries({ queryKey: family });
  }, [client, family]);

  const options = { gcTime: 0, retry: false as const, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, enabled: !accessLost };
  const list = useInfiniteQuery({
    ...options,
    queryKey: noteHistoryKeys.list(slug, boardId, noteId, viewerId),
    initialPageParam: null as number | null,
    queryFn: ({ signal, pageParam }) => read<NoteRevisionPage>(`${base}/revisions?limit=${HISTORY_PAGE_SIZE}${pageParam === null ? "" : `&before_revision=${pageParam}`}`, signal),
    getNextPageParam: (page) => page.next_before_revision ?? undefined,
  });
  const current = useQuery({
    ...options,
    queryKey: currentKey,
    queryFn: async ({ signal }) => {
      const note = await read<Note>(base, signal);
      return { history_revision: note.history_revision, revision_digest: note.revision_digest };
    },
  });
  const snapshot = useQuery({
    ...options,
    enabled: !accessLost && selection !== null,
    queryKey: selection?.from !== null && selection?.from !== undefined
      ? noteHistoryKeys.compare(slug, boardId, noteId, viewerId, selection.from, selection.to)
      : noteHistoryKeys.revision(slug, boardId, noteId, viewerId, selection?.to ?? 0),
    queryFn: ({ signal }): Promise<NoteRevisionDetail | NoteRevisionComparison> => {
      const path = selection!.from === null ? `/revisions/${selection!.to}`
        : `/revisions/compare?from_revision=${selection!.from}&to_revision=${selection!.to}`;
      return read(`${base}${path}`, signal);
    },
  });

  const revalidateCurrent = useCallback(() => {
    if (denied.current) return;
    void client.cancelQueries({ queryKey: currentKey, exact: true }).then(() => {
      if (!denied.current) void client.invalidateQueries({ queryKey: currentKey, exact: true });
    });
  }, [client, currentKey]);

  useEffect(() => {
    if (status === "connected" && previousStatus.current !== "connected") revalidateCurrent();
    previousStatus.current = status;
  }, [status, revalidateCurrent]);
  useEffect(() => onAccessRevoked?.(revoke), [onAccessRevoked, revoke]);
  useEffect(() => {
    window.addEventListener("focus", revalidateCurrent);
    return () => window.removeEventListener("focus", revalidateCurrent);
  }, [revalidateCurrent]);

  useDomainSync("activity.note", family, {
    filter: (event) => event.payload.entity_id === noteId && (event.payload.board_id ?? null) === boardId,
    patch: (event) => {
      if (event.event.endsWith(".deleted")) revoke();
      else {
        activityVersion.current++;
        setHasChanges(true);
        void client.cancelQueries({ queryKey: currentKey, exact: true });
      }
      return true;
    },
  });
  useDomainSync("activity.member", family, {
    filter: (event) => {
      const changes = event.payload.changes as Record<string, unknown> | undefined;
      return event.payload.entity_id === viewerId || changes?.affected_user_id === viewerId;
    },
    patch: (event) => {
      if (/removed|deleted|revoked/.test(event.event)) revoke();
      else revalidateCurrent();
      return true;
    },
  });
  useDomainSync("activity.board", family, {
    filter: (event) => !!boardId && event.payload.entity_id === boardId && event.event.endsWith(".deleted"),
    patch: () => { revoke(); return true; },
  });

  const revisions = list.data?.pages.flatMap((page) => page.items) ?? [];
  const latest = list.data?.pages[0]?.items[0];
  const currentVerified = !accessLost && !hasChanges && !current.isFetching && !current.isError && !!latest
    && current.data?.history_revision === latest.revision && !!current.data?.revision_digest
    && current.data.revision_digest === latest.revision_digest;

  async function refresh() {
    const version = activityVersion.current;
    await client.cancelQueries({ queryKey: currentKey, exact: true });
    await Promise.all([list.refetch(), current.refetch()]);
    if (!denied.current && version === activityVersion.current) setHasChanges(false);
  }

  function selectRevision(revision: NoteRevisionSummary) {
    setSelection({ selected: revision.revision, to: revision.revision,
      from: revision.revision === 1 ? null : revision.revision - 1,
      mode: "previous" });
  }

  function compareWithCurrent() {
    if (selection && currentVerified && latest) setSelection({ ...selection, from: selection.selected, to: latest.revision, mode: "current" });
  }

  return { accessLost, hasChanges, revisions, list, current, currentVerified, snapshot, selection,
    currentRevision: currentVerified && latest ? latest.revision : null,
    refresh, selectRevision, compareWithCurrent,
    compareWithPrevious: () => {
      const selected = revisions.find((revision) => revision.revision === selection?.selected);
      if (selected) selectRevision(selected);
    } };
}
