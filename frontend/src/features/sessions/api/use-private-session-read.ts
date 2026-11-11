// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, isApiError } from "@/lib/api-error";
import { sessionKeys } from "@/lib/query-keys";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { useForgetSessionContent } from "./use-session-realtime";

export function usePrivateContentRead(slug: string, sessionId: string) {
  const queryClient = useQueryClient();
  const forgetContent = useForgetSessionContent();
  const returnNavigation = useReturnNavigation();
  return useCallback(async <T,>(signal: AbortSignal, read: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    // Denial wins over mounted observers briefly recreating a removed query.
    if (queryClient.getQueryData(sessionKeys.detail(slug, sessionId)) === null) throw new ApiError("Session unavailable", 403);
    try {
      const result = await read();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (!signal.aborted && isApiError(error)) {
        if ([401, 403].includes(error.status)) {
          queryClient.setQueryData(sessionKeys.detail(slug, sessionId), null);
          forgetContent(slug, sessionId);
          returnNavigation?.forget(`/${slug}/sessions/${sessionId}`);
        } else if ([404, 410].includes(error.status)) {
          void queryClient.refetchQueries({ queryKey: sessionKeys.detail(slug, sessionId), exact: true });
        }
      }
      throw error;
    }
  }, [forgetContent, queryClient, returnNavigation, sessionId, slug]);
}
