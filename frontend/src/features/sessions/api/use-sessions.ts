// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { sessionKeys } from "@/lib/query-keys";
import { shouldRetry } from "@/lib/should-retry";
import { useAuthModes } from "@/features/auth/api/use-auth-modes";
import type {
  AgentSession,
  AgentSessionList,
  AgentSessionPage,
  CallFilter,
  DisplayState,
  SessionPeriodSummary,
  SessionRhythm,
  SessionSort,
  SessionCallDetail,
  SessionCallPage,
  SessionStatus,
  SessionUsageList,
  SessionWorkLinkList,
} from "@/types/agent-session";

export const SESSION_PAGE_SIZE = 50;
export const CALL_PAGE_SIZE = 100;

// The flag is deployment config; while /auth/modes is in flight it is
// `undefined`, which every gate treats as "not yet", never as "off".
export function useCompanionEnabled(): boolean | undefined {
  const { data } = useAuthModes();
  return data?.companion_enabled;
}

// false: this server refuses the rich level. undefined (loading, or a server
// that predates rich capture) offers it, and the server's 409 explains a refusal.
export function useRichCaptureEnabled(): boolean | undefined {
  const { data } = useAuthModes();
  return data?.rich_capture_enabled;
}

export interface SessionListQuery {
  harness?: string;
  status?: SessionStatus;
  // One display state; the server also accepts the parameter repeated.
  state?: DisplayState;
  board_id?: string;
  q?: string;
  linked_only?: boolean;
  since?: string;
  sort?: SessionSort;
  root_only: boolean;
}

export interface SessionSummaryQuery {
  since?: string;
  board_id?: string;
  harness?: string;
  root_only: boolean;
}

// Totals for the period line and the sidebar's live count: one aggregate
// request, costs per basis kept apart by the server.
export function useSessionSummary(slug: string, query: SessionSummaryQuery, enabled: boolean, refetchInterval?: number) {
  return useQuery({
    queryKey: sessionKeys.summary(slug, query),
    queryFn: async () => {
      const { data } = await api.get<SessionPeriodSummary>(`/workspaces/${slug}/sessions/summary`, { params: query });
      return data;
    },
    enabled: enabled && !!slug,
    retry: retryServerErrors,
    placeholderData: (previous) => previous,
    refetchInterval,
  });
}

export function useSessionRhythm(slug: string, sessionId: string, buckets: number, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.rhythm(slug, sessionId, buckets),
    queryFn: async () => {
      const { data } = await api.get<SessionRhythm>(`/workspaces/${slug}/sessions/${sessionId}/rhythm`, {
        params: { buckets },
      });
      return data;
    },
    enabled,
    retry: retryServerErrors,
    placeholderData: (previous) => previous,
  });
}

// 4xx answers are definitive (not found, agent key, capture off); retrying
// them only delays the explanation. 5xx follows the house outage policy.
export function retryServerErrors(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return shouldRetry(failureCount, error);
}

export function useSessionList(slug: string, query: SessionListQuery, enabled: boolean, pageSize = SESSION_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: sessionKeys.list(slug, { ...query, pageSize }),
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<AgentSessionPage>(`/workspaces/${slug}/sessions`, {
        params: { ...query, limit: pageSize, cursor: pageParam ?? undefined },
      });
      return data;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: enabled && !!slug,
    retry: retryServerErrors,
    placeholderData: (previous) => previous,
  });
}

export function useSession(slug: string, sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.detail(slug, sessionId),
    queryFn: async () => {
      const { data } = await api.get<AgentSession>(`/workspaces/${slug}/sessions/${sessionId}`);
      return data;
    },
    enabled: enabled && !!sessionId,
    retry: retryServerErrors,
  });
}

export function useSessionCalls(slug: string, sessionId: string, filter: CallFilter, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: sessionKeys.calls(slug, sessionId, filter),
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<SessionCallPage>(`/workspaces/${slug}/sessions/${sessionId}/calls`, {
        params: { filter, limit: CALL_PAGE_SIZE, cursor: pageParam ?? undefined },
      });
      return data;
    },
    initialPageParam: null as string | null,
    // The first page is the newest; the cursor walks back in time.
    getNextPageParam: (page) => page.next_cursor,
    enabled,
    retry: retryServerErrors,
    placeholderData: (previous) => previous,
  });
}

export function useSessionCall(slug: string, sessionId: string, callKey: string, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.call(slug, sessionId, callKey),
    queryFn: async () => {
      const { data } = await api.get<SessionCallDetail>(
        `/workspaces/${slug}/sessions/${sessionId}/calls/${encodeURIComponent(callKey)}`,
      );
      return data;
    },
    enabled,
    retry: retryServerErrors,
    staleTime: 60_000,
  });
}

export function useSessionUsage(slug: string, sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.usage(slug, sessionId),
    queryFn: async () => {
      const { data } = await api.get<SessionUsageList>(`/workspaces/${slug}/sessions/${sessionId}/usage`);
      return data;
    },
    enabled,
    retry: retryServerErrors,
  });
}

export function useSessionLinks(slug: string, sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.links(slug, sessionId),
    queryFn: async () => {
      const { data } = await api.get<SessionWorkLinkList>(`/workspaces/${slug}/sessions/${sessionId}/links`);
      return data;
    },
    enabled,
    retry: retryServerErrors,
    staleTime: 30_000,
  });
}

export function useSessionChildren(slug: string, sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.children(slug, sessionId),
    queryFn: async () => {
      const { data } = await api.get<AgentSessionList>(`/workspaces/${slug}/sessions/${sessionId}/children`);
      return data;
    },
    enabled,
    retry: retryServerErrors,
  });
}

export function useDeleteSession(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      await api.delete(`/workspaces/${slug}/sessions/${sessionId}`);
    },
    onSuccess: (_, sessionId) => {
      queryClient.removeQueries({ queryKey: sessionKeys.detail(slug, sessionId) });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all(slug) });
    },
  });
}
