// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useInfiniteQuery, useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { sessionKeys } from "@/lib/query-keys";
import type { ContentBodyPage, SessionContent, SessionContentPage } from "@/types/agent-session";
import { downloadName } from "../utils/contents";
import { retryServerErrors } from "./use-sessions";

export const CONTENT_PAGE_SIZE = 100;

function contentsPath(slug: string, sessionId: string) {
  return `/workspaces/${slug}/sessions/${sessionId}/contents`;
}

export function useSessionContents(slug: string, sessionId: string, callId?: string) {
  const filters = { limit: CONTENT_PAGE_SIZE, ...(callId === undefined ? {} : { call_id: callId }) };
  return useInfiniteQuery({
    queryKey: sessionKeys.contents(slug, sessionId, filters),
    queryFn: async ({ pageParam, signal }) => {
      const { data } = await api.get<SessionContentPage>(contentsPath(slug, sessionId), {
        params: { ...filters, cursor: pageParam ?? undefined },
        signal,
      });
      return data;
    },
    initialPageParam: null as string | null,
    // Source order: each cursor continues forward.
    getNextPageParam: (page) => page.next_cursor,
    retry: retryServerErrors,
  });
}

/** The body pages asked for so far, in order; each offset is the previous page's end. */
export function useContentBodyPages(slug: string, sessionId: string, content: SessionContent, offsets: readonly number[]) {
  return useQueries({
    queries: offsets.map((offset) => ({
      queryKey: sessionKeys.contentBody(slug, sessionId, content.id, content.sha256 ?? "", offset),
      queryFn: async () => {
        const { data } = await api.get<ContentBodyPage>(`${contentsPath(slug, sessionId)}/${content.id}/body`, {
          params: { offset },
        });
        return data;
      },
      staleTime: Infinity,
      retry: retryServerErrors,
    })),
  });
}

async function fetchFile(slug: string, sessionId: string, content: SessionContent) {
  const response = await api.get<ArrayBuffer>(`${contentsPath(slug, sessionId)}/${content.id}/download`, {
    responseType: "arraybuffer",
  });
  // Typed from the row, never sniffed from the bytes or the response.
  const blob = new Blob([response.data], { type: content.media_type });
  return { blob, name: downloadName(response.headers["content-disposition"], `content-${content.id}`) };
}

/** A raster image's bytes, fetched with the viewer's credentials; never a remote URL. */
export function useContentImage(slug: string, sessionId: string, content: SessionContent, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.contentFile(slug, sessionId, content.id, content.sha256 ?? ""),
    queryFn: async () => (await fetchFile(slug, sessionId, content)).blob,
    enabled,
    staleTime: Infinity,
    retry: retryServerErrors,
  });
}

/** Saves the body as a file under the server's (sanitized) name; the bytes are not kept. */
export function useDownloadContent(slug: string, sessionId: string, content: SessionContent) {
  return useMutation({
    mutationFn: async () => {
      const { blob, name } = await fetchFile(slug, sessionId, content);
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
