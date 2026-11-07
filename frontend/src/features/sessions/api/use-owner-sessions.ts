// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { notifyManager, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError, isApiError } from "@/lib/api-error";
import { meKeys, ownerSessionKeys, workspaceKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { WebSocketEvent } from "@/lib/websocket";
import type { CurrentUser } from "@/features/notifications/api/use-current-user";
import type { WorkspaceInventoryFreshness } from "@/features/workspaces/api/use-workspaces";
import type { OwnerSessionListQuery, OwnerSessionOverviewData, OwnerSessionPage } from "@/types/owner-session";
import type { Workspace } from "@/types/workspace";
import type { OwnerSessionReadingOrder } from "../hooks/use-owner-session-snapshot";
import { isOwnerSessionHarnessValid } from "../hooks/use-owner-session-filters";
import { retryServerErrors } from "./use-sessions";
import { SESSION_EVENT_DEBOUNCE_MS } from "./use-session-realtime";

export type { OwnerSessionListQuery } from "@/types/owner-session";

const STALE_TIME = 15_000;
const OVERVIEW_REFRESH_MS = 30_000;
const LIST_REFRESH_MS = 60_000;
const PAGE_SIZE = 40;

// A filter REPLACE keeps one browser entry. Only its current reading order
// belongs in return state; scope still distinguishes the server queries.
export const OWNER_SESSION_LIST_READING_SLOT = "owner-session-list";

// Membership decides which retained rows may still be shown. Home and Global
// have no workspace socket, so the one shared inventory follows their polls.
export const overviewInventoryFreshness: WorkspaceInventoryFreshness = { refetchInterval: OVERVIEW_REFRESH_MS, staleTime: STALE_TIME };
export const listInventoryFreshness: WorkspaceInventoryFreshness = { refetchInterval: LIST_REFRESH_MS, staleTime: STALE_TIME };
type RequestedSessionPage = OwnerSessionPage & { authorizationRequestedAt: number };
type RequestedSessionOverview = OwnerSessionOverviewData & { authorizationRequestedAt: number };
type SessionPages = InfiniteData<RequestedSessionPage, string | null>;

export function ownerSessionAccessLost(error: unknown): boolean {
  return isApiError(error) && [401, 403, 404].includes(error.status);
}

export function ownerSessionListScope(params: OwnerSessionListQuery, owner: string) {
  return `owner-sessions:${owner}:${JSON.stringify(params)}`;
}

export function useOwnerSessionWorkspaceInventory() {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey.length === 1 && event.query.queryKey[0] === workspaceKeys.all[0]) changed();
  }), [client]);
  const readInventory = useCallback(() => client.getQueryState<Workspace[]>(workspaceKeys.all), [client]);
  // Dashboard consumes the same inventory authority as Home without starting
  // another request or replacing the shared query's fetch configuration.
  return useSyncExternalStore(subscribe, readInventory, readInventory);
}

function useOwnerScope() {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === meKeys.me()[0]) changed();
  }), [client]);
  const readOwner = useCallback(() => {
    const me = client.getQueryState<CurrentUser>(meKeys.me());
    return ownerSessionAccessLost(me?.error) ? "denied" : me?.data?.id ?? "pending";
  }, [client]);
  const owner = useSyncExternalStore(subscribe, readOwner, readOwner);
  const previousOwner = useRef(owner);
  useEffect(() => {
    if (previousOwner.current === owner) return;
    const previous = previousOwner.current;
    previousOwner.current = owner;
    const scope = { queryKey: ownerSessionKeys.all, predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey.at(-1) === previous };
    void client.cancelQueries(scope);
    client.removeQueries(scope);
  }, [client, owner]);
  return owner;
}

// The same owner check and capture-burst window as the workspace session views.
function ownerSessionEvents(owner: string) {
  return {
    debounceMs: SESSION_EVENT_DEBOUNCE_MS,
    filter: (event: WebSocketEvent) => event.payload.owner_id === owner,
  };
}

function clearOwnerDiscovery(
  client: ReturnType<typeof useQueryClient>, owner: string, failedKey: readonly unknown[],
) {
  const belongsToOwner = (query: { queryKey: readonly unknown[] }) => query.queryKey.at(-1) === owner;
  const scope = { queryKey: ownerSessionKeys.all, predicate: belongsToOwner };
  const failedQuery = client.getQueryCache().find({ queryKey: failedKey, exact: true });
  const kind = (name: string) => ({
    queryKey: ownerSessionKeys.all,
    predicate: (query: { queryKey: readonly unknown[] }) => belongsToOwner(query) && query.queryKey[1] === name,
  });
  notifyManager.batch(() => {
    // Cancellation restores a sibling's pre-fetch data synchronously. Clear
    // afterward, and leave this failing request alive to publish its error.
    void client.cancelQueries({ ...scope, predicate: (query) => belongsToOwner(query) && query !== failedQuery });
    // Updating existing queries also notifies mounted observers; removing an
    // active query alone could leave its observer holding the denied metadata.
    client.setQueriesData(kind("list"), { pages: [], pageParams: [] });
    client.setQueriesData(kind("overview"), null);
    client.setQueriesData(kind("reading"), []);
    // Reusing another filter or Home must reauthorize, even inside staleTime.
    // Do not start a fan-out of retries from the denial handler itself.
    void client.invalidateQueries({ ...scope, refetchType: "none" });
  });
}

export function useOwnerSessionOverview(enabled: boolean) {
  const client = useQueryClient();
  const ownerScope = useOwnerScope();
  const queryKey = [...ownerSessionKeys.overview(), ownerScope];
  useDomainSync("agent_session", queryKey, ownerSessionEvents(ownerScope));
  const query = useQuery<RequestedSessionOverview | null>({
    queryKey,
    queryFn: async ({ signal }) => {
      const authorizationRequestedAt = Date.now();
      try {
        const { data } = await api.get<OwnerSessionOverviewData>("/me/sessions/overview", {
          params: { active_limit: 6, recent_limit: 6 }, signal,
        });
        return { ...data, authorizationRequestedAt };
      } catch (error) {
        if (!signal.aborted && ownerSessionAccessLost(error)) {
          clearOwnerDiscovery(client, ownerScope, queryKey);
        }
        throw error;
      }
    },
    enabled: enabled && ownerScope !== "denied",
    staleTime: STALE_TIME,
    refetchInterval: OVERVIEW_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: retryServerErrors,
  });
  return { ...query, ownerScope };
}

interface ReturnWindow {
  key: string;
  pageCount: number;
  status: "pending" | "failed" | "complete";
}

export function useOwnerSessionList(params: OwnerSessionListQuery, enabled: boolean, returnKey?: string) {
  const client = useQueryClient();
  const navigation = useReturnNavigation();
  const ownerScope = useOwnerScope();
  const encodedParams = JSON.stringify(params);
  const options = useMemo(() => {
    const filters = JSON.parse(encodedParams) as OwnerSessionListQuery;
    const queryKey = [...ownerSessionKeys.list(filters), ownerScope];
    return {
      queryKey,
      queryFn: async ({ pageParam, signal }: { pageParam: string | null; signal: AbortSignal }) => {
        // Manual refetch bypasses `enabled`; validate here as well as in the UI.
        if (!isOwnerSessionHarnessValid(filters.harness)) {
          throw new ApiError("Invalid session agent identifier", 422);
        }
        if (!pageParam && (filters.q || filters.harness)) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 250);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        }
        const search = new URLSearchParams({ root_only: String(filters.root_only), limit: String(PAGE_SIZE) });
        for (const [key, value] of Object.entries(filters)) {
          if (value === undefined || key === "root_only") continue;
          if (Array.isArray(value)) value.forEach((state) => search.append(key, state));
          else search.set(key, String(value));
        }
        if (pageParam) search.set("cursor", pageParam);
        const authorizationRequestedAt = Date.now();
        try {
          const { data } = await api.get<OwnerSessionPage>("/me/sessions", { params: search, signal });
          // Infinite Query publishes a whole page chain together. Retain the
          // individual request boundary: loading page two must not renew page one.
          return { ...data, authorizationRequestedAt };
        } catch (error) {
          if (!signal.aborted && ownerSessionAccessLost(error)) {
            clearOwnerDiscovery(client, ownerScope, queryKey);
          }
          throw error;
        }
      },
      initialPageParam: null as string | null,
      getNextPageParam: (page: RequestedSessionPage) => page.next_cursor,
      retry: retryServerErrors,
    };
  }, [client, encodedParams, ownerScope]);
  const scope = ownerSessionListScope(params, ownerScope);
  const restorationKey = `${returnKey ?? "live"}:${scope}`;
  function initialReturnWindow(): ReturnWindow {
    const saved = returnKey ? navigation?.readView<OwnerSessionReadingOrder>(OWNER_SESSION_LIST_READING_SLOT) : undefined;
    const pageCount = saved?.scope === scope ? saved.pageCount : 0;
    const cachedPages = client.getQueryData<SessionPages>(options.queryKey)?.pages.length ?? 0;
    return { key: restorationKey, pageCount, status: pageCount > cachedPages ? "pending" : "complete" };
  }
  const [retainedWindow, setRetainedWindow] = useState(initialReturnWindow);
  const window = retainedWindow.key === restorationKey ? retainedWindow : initialReturnWindow();
  if (window !== retainedWindow) setRetainedWindow(window);
  const restorePending = window.status !== "complete";
  const canRead = enabled && ownerScope !== "denied" && isOwnerSessionHarnessValid(params.harness);
  useDomainSync("agent_session", options.queryKey, {
    ...ownerSessionEvents(ownerScope),
    predicate: (query) => ((query.state.data as { pages?: unknown[] } | undefined)?.pages?.length ?? 0) <= 1,
  });
  const query = useInfiniteQuery({
    ...options,
    enabled: canRead && !restorePending,
    staleTime: STALE_TIME,
    refetchInterval: (query) => !restorePending && (query.state.data?.pages.length ?? 0) <= 1 ? LIST_REFRESH_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: (query) => !restorePending && (query.state.data?.pages.length ?? 0) <= 1,
    refetchOnReconnect: (query) => !restorePending && (query.state.data?.pages.length ?? 0) <= 1,
    refetchOnMount: (query) => !restorePending && (query.state.data?.pages.length ?? 0) <= 1,
  });

  useEffect(() => {
    if (!canRead || window.status !== "pending") return;
    let disposed = false;
    let finished = false;
    // A return is bounded by the earlier reading window, not an old cursor.
    // Infinite Query begins at null and derives every later cursor from the
    // fresh preceding response. No automatic refresh adopts this page bound.
    void client.fetchInfiniteQuery({ ...options, pages: window.pageCount, staleTime: 0 }).then(() => {
      finished = true;
      if (!disposed) setRetainedWindow({ ...window, status: "complete" });
    }, () => {
      finished = true;
      if (!disposed) setRetainedWindow({ ...window, status: "failed" });
    });
    return () => {
      disposed = true;
      if (!finished) void client.cancelQueries({ queryKey: options.queryKey, exact: true });
    };
  }, [client, canRead, options, window]);

  function retryRestoration() { setRetainedWindow({ ...window, status: "pending" }); }
  return {
    ...query, ownerScope, restorePending, retryRestoration,
    restoredWindow: !!returnKey && window.pageCount > 0 && !restorePending,
  };
}
