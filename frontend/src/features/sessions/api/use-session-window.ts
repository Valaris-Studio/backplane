// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { sessionKeys } from "@/lib/query-keys";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { AgentSession, SessionContentPage, SessionContentWindow, SessionContentWindowMode } from "@/types/agent-session";
import { useForgetSessionContent } from "./use-session-realtime";
import { retryServerErrors } from "./use-sessions";

export interface ContentWindowRequest {
  mode: Exclude<SessionContentWindowMode, "refresh">;
  cursor?: string;
  anchor_id?: string;
}

interface RetainedWindow {
  cursor?: string;
  legacy: boolean;
}

export function useSessionWindow(slug: string, sessionId: string, active: boolean, initialAnchor?: string) {
  const queryClient = useQueryClient();
  const forgetContent = useForgetSessionContent();
  const returnNavigation = useReturnNavigation();
  const viewKey = `session-reader-window:${slug}/${sessionId}`;
  const [retainedWindow] = useState(() => returnNavigation?.readView<RetainedWindow>(viewKey));
  const [navigation, setNavigation] = useState<Omit<ContentWindowRequest, "mode"> & { mode: SessionContentWindowMode; request: number }>(() => retainedWindow ? {
    mode: retainedWindow.legacy ? "beginning" : "refresh", cursor: retainedWindow.cursor, request: 0,
  } : {
    mode: initialAnchor ? "anchor" : "latest", anchor_id: initialAnchor, request: 0,
  });
  const [changed, setChanged] = useState(false);
  const parked = useRef(false);
  const [unsupported, setUnsupported] = useState(false);
  const [legacy, setLegacy] = useState(retainedWindow?.legacy ?? false);
  const key = sessionKeys.contentWindow(slug, sessionId, navigation);
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<SessionContentWindow> => {
      const retained = queryClient.getQueryData<SessionContentWindow>(key);
      if (parked.current && retained) return retained;
      try {
        if (legacy) {
          const { data } = await api.get<SessionContentPage>(`/workspaces/${slug}/sessions/${sessionId}/contents`, {
            params: { limit: 100, cursor: navigation.cursor }, signal,
          });
          return { capability: "content-window-v1", mode: "beginning", items: data.items,
            earlier_cursor: null, later_cursor: data.next_cursor, window_cursor: "", anchor_id: null };
        }
        const { data } = await api.get<SessionContentWindow>(`/workspaces/${slug}/sessions/${sessionId}/contents/window`, {
          params: retained ? { mode: "refresh", cursor: retained.window_cursor } : {
            mode: navigation.mode, cursor: navigation.cursor, anchor_id: navigation.anchor_id,
          }, signal,
        });
        return data;
      } catch (error) {
        if (!signal.aborted && isApiError(error)) {
          if ([401, 403].includes(error.status)) {
            returnNavigation?.forget();
            queryClient.setQueryData(sessionKeys.detail(slug, sessionId), null);
            forgetContent(slug, sessionId);
          }
          if (error.status === 409 && error.errorCode === "content_window_changed") {
            parked.current = true;
            setChanged(true);
          }
          if (error.status === 405 || (error.status === 404 && error.errorCode === "not_found")) {
            const authorityKey = sessionKeys.detail(slug, sessionId);
            await queryClient.refetchQueries({ queryKey: authorityKey, exact: true });
            const authority = queryClient.getQueryState<AgentSession | null>(authorityKey);
            if (!signal.aborted && authority?.status === "success" && authority.data) setUnsupported(true);
          }
        }
        throw error;
      }
    },
    enabled: active && (!unsupported || legacy),
    gcTime: 0,
    staleTime: Infinity,
    retry: retryServerErrors,
    placeholderData: (previous) => previous,
    meta: { explicitSessionRefresh: () => { parked.current = false; setChanged(false); } },
  });

  useEffect(() => {
    if (!query.data || query.isPlaceholderData || query.isError) return;
    // Keep only the server's bounded-window identity. Return reauthorizes and
    // reloads that exact window; private record bodies never enter view memory.
    returnNavigation?.writeView(viewKey, {
      cursor: legacy ? navigation.cursor : query.data.window_cursor,
      legacy,
    });
  }, [query.data, query.isPlaceholderData, query.isError, returnNavigation, viewKey, legacy, navigation.cursor]);

  useEffect(() => {
    if (!active) void queryClient.cancelQueries({ queryKey: key, exact: true, predicate: (candidate) => !candidate.isActive() });
  }, [active, queryClient, key]);

  function navigate(request: ContentWindowRequest) {
    parked.current = false;
    setChanged(false);
    setNavigation((current) => ({ ...request, request: current.request + 1 }));
  }

  function readBeginningFallback() {
    setLegacy(true);
    navigate({ mode: "beginning" });
  }

  return { ...query, changed, unsupported, legacy, navigation, navigate, readBeginningFallback };
}
