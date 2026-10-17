// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError, isApiError } from "@/lib/api-error";
import { sessionKeys } from "@/lib/query-keys";
import type { ContentBodyPage, SessionContent, SessionContentPage } from "@/types/agent-session";
import { downloadName } from "../utils/contents";
import { retryServerErrors } from "./use-sessions";
import { useForgetSessionContent } from "./use-session-realtime";

export const CONTENT_PAGE_SIZE = 100;
export const SessionReaderActive = createContext(true);
export const useSessionReaderActive = () => useContext(SessionReaderActive);

function useCancelInactiveReads(queryKey: QueryKey, active: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!active) void queryClient.cancelQueries({ queryKey, predicate: (query) => !query.isActive() });
  }, [active, queryClient, queryKey]);
}

function contentsPath(slug: string, sessionId: string) {
  return `/workspaces/${slug}/sessions/${sessionId}/contents`;
}

export function usePrivateContentRead(slug: string, sessionId: string) {
  const queryClient = useQueryClient();
  const forgetContent = useForgetSessionContent();
  return useCallback(async <T,>(signal: AbortSignal, read: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    // Mounted observers can briefly recreate a removed query before the denied
    // parent commits. A known authority loss must not start another private read.
    if (queryClient.getQueryData(sessionKeys.detail(slug, sessionId)) === null) {
      throw new ApiError("Session unavailable", 403);
    }
    try {
      return await read();
    } catch (error) {
      if (!signal.aborted && isApiError(error) && [401, 403].includes(error.status)) {
        queryClient.setQueryData(sessionKeys.detail(slug, sessionId), null);
        forgetContent(slug, sessionId);
      }
      throw error;
    }
  }, [forgetContent, queryClient, sessionId, slug]);
}

export function useSessionContents(slug: string, sessionId: string, callId?: string, enabled = true) {
  const active = useSessionReaderActive();
  const read = usePrivateContentRead(slug, sessionId);
  const filters = { limit: CONTENT_PAGE_SIZE, ...(callId === undefined ? {} : { call_id: callId }) };
  const query = useInfiniteQuery({
    queryKey: sessionKeys.contents(slug, sessionId, filters),
    queryFn: ({ pageParam, signal }) => read(signal, async () => {
      const { data } = await api.get<SessionContentPage>(contentsPath(slug, sessionId), {
        params: { ...filters, cursor: pageParam ?? undefined },
        signal,
      });
      return data;
    }),
    enabled: enabled && active,
    initialPageParam: null as string | null,
    // Source order: each cursor continues forward.
    getNextPageParam: (page) => page.next_cursor,
    retry: retryServerErrors,
  });
  useCancelInactiveReads(sessionKeys.contents(slug, sessionId, filters), enabled && active);
  return query;
}

/** The body pages asked for so far, in order; each offset is the previous page's end. */
export function useContentBodyPages(slug: string, sessionId: string, content: SessionContent, offsets: readonly number[]) {
  const active = useSessionReaderActive();
  const read = usePrivateContentRead(slug, sessionId);
  const pages = useQueries({
    queries: offsets.map((offset) => ({
      queryKey: sessionKeys.contentBody(slug, sessionId, content.id, content.sha256 ?? "", offset),
      queryFn: ({ signal }: { signal: AbortSignal }) => read(signal, async () => {
        const { data } = await api.get<ContentBodyPage>(`${contentsPath(slug, sessionId)}/${content.id}/body`, {
          params: { offset },
          signal,
        });
        return data;
      }),
      enabled: active,
      gcTime: 0,
      staleTime: Infinity,
      retry: retryServerErrors,
    })),
  });
  useCancelInactiveReads([...sessionKeys.detail(slug, sessionId), "content-body", content.id], active);
  return pages;
}

async function fetchFile(slug: string, sessionId: string, content: SessionContent, signal: AbortSignal) {
  const response = await api.get<ArrayBuffer>(`${contentsPath(slug, sessionId)}/${content.id}/download`, {
    responseType: "arraybuffer",
    signal,
  });
  // Typed from the row, never sniffed from the bytes or the response.
  const blob = new Blob([response.data], { type: content.media_type });
  return { blob, name: downloadName(response.headers["content-disposition"], `content-${content.id}`) };
}

/** A raster image's bytes, fetched with the viewer's credentials; never a remote URL. */
export function useContentImage(slug: string, sessionId: string, content: SessionContent, enabled: boolean) {
  const active = useSessionReaderActive();
  const read = usePrivateContentRead(slug, sessionId);
  const query = useQuery({
    queryKey: sessionKeys.contentFile(slug, sessionId, content.id, content.sha256 ?? ""),
    queryFn: ({ signal }) => read(signal, async () => (await fetchFile(slug, sessionId, content, signal)).blob),
    enabled: enabled && active,
    gcTime: 0,
    staleTime: Infinity,
    retry: retryServerErrors,
  });
  useCancelInactiveReads(sessionKeys.contentFile(slug, sessionId, content.id, content.sha256 ?? ""), active);
  return query;
}

/** Saves the body as a file under the server's (sanitized) name; the bytes are not kept. */
export function useDownloadContent(slug: string, sessionId: string, content: SessionContent) {
  const controller = useRef<AbortController | null>(null);
  const active = useSessionReaderActive();
  const read = usePrivateContentRead(slug, sessionId);
  useEffect(() => { if (!active) controller.current?.abort(); }, [active]);
  useEffect(() => () => controller.current?.abort(), []);
  return useMutation({
    mutationFn: async () => {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      const { blob, name } = await read(request.signal, () => fetchFile(slug, sessionId, content, request.signal));
      request.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Revoked after the click has handed the URL to the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  });
}
