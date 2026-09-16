// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { notificationKeys } from "@/lib/query-keys";
import { useWebSocketEvent } from "@/hooks/use-websocket";
import { showBrowserNotification } from "../utils/show-browser-notification";
import { linkToRoute } from "../utils/link-to-route";
import type { NotificationLink } from "./notifications-api";
import {
  fetchNotificationChannels,
  fetchNotificationPreferences,
  fetchUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  updateNotificationPreferences,
  type NotificationPreferences,
  type NotificationRead,
} from "./notifications-api";
import { useCurrentUser } from "./use-current-user";

const PAGE_SIZE = 50;

type InboxData = InfiniteData<NotificationRead[]>;

export function useNotificationInbox(slug?: string, unreadOnly = false) {
  return useInfiniteQuery({
    queryKey: [...notificationKeys.inbox(slug), unreadOnly ? "unread" : "all"],
    queryFn: ({ pageParam }) =>
      listNotifications({
        slug,
        limit: PAGE_SIZE,
        before: pageParam,
        unread: unreadOnly || undefined,
      }),
    initialPageParam: undefined as string | undefined,
    // Keyset cursor: the `before` of the next page is the oldest row's
    // created_at on this page. A short page means we've reached the tail.
    getNextPageParam: (lastPage) =>
      lastPage.length === PAGE_SIZE
        ? lastPage[lastPage.length - 1]?.created_at
        : undefined,
  });
}

export function useUnreadCount(slug?: string) {
  return useQuery({
    queryKey: notificationKeys.unreadCount(slug),
    queryFn: () => fetchUnreadCount(slug),
  });
}

// Optimistically flip read_at locally + decrement the unread-count cache, then
// invalidate on settle so the server stays authoritative. Snapshots both the
// inbox pages and BOTH unread-count caches (workspace + all-workspaces rollup)
// for rollback — a read in one workspace also drains the global count.
export function useMarkRead(slug?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),

    onMutate: async (id) => {
      const inboxKey = notificationKeys.inbox(slug);
      await queryClient.cancelQueries({ queryKey: inboxKey });

      const inboxSnapshots = queryClient.getQueriesData<InboxData>({
        queryKey: notificationKeys.inbox(slug),
      });
      const readAt = new Date().toISOString();
      let wasUnread = false;

      queryClient.setQueriesData<InboxData>(
        { queryKey: notificationKeys.inbox(slug) },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) =>
              page.map((n) => {
                if (n.id !== id) return n;
                if (n.read_at === null) wasUnread = true;
                return { ...n, read_at: n.read_at ?? readAt };
              }),
            ),
          };
        },
      );

      const countSnapshots = wasUnread
        ? decrementUnreadCaches(queryClient, slug, 1)
        : [];

      return { inboxSnapshots, countSnapshots };
    },

    onError: (_err, _id, context) => {
      restoreSnapshots(queryClient, context?.inboxSnapshots);
      restoreSnapshots(queryClient, context?.countSnapshots);
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.allInboxes() });
      queryClient.invalidateQueries({ queryKey: notificationKeys.allUnreadCounts() });
    },
  });
}

export function useMarkAllRead(slug?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => markAllNotificationsRead(slug),

    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: notificationKeys.inbox(slug) });
      const inboxSnapshots = queryClient.getQueriesData<InboxData>({
        queryKey: notificationKeys.inbox(slug),
      });
      const readAt = new Date().toISOString();

      queryClient.setQueriesData<InboxData>(
        { queryKey: notificationKeys.inbox(slug) },
        (old) =>
          old
            ? {
                ...old,
                pages: old.pages.map((page) =>
                  page.map((n) => ({ ...n, read_at: n.read_at ?? readAt })),
                ),
              }
            : old,
      );

      const countSnapshots = zeroUnreadCaches(queryClient, slug);
      return { inboxSnapshots, countSnapshots };
    },

    onError: (_err, _vars, context) => {
      restoreSnapshots(queryClient, context?.inboxSnapshots);
      restoreSnapshots(queryClient, context?.countSnapshots);
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.allInboxes() });
      queryClient.invalidateQueries({ queryKey: notificationKeys.allUnreadCounts() });
    },
  });
}

// Trailing-edge window for coalescing inbox refetches, matching
// useDomainSync's DEFAULT_DEBOUNCE_MS so live notification traffic behaves like
// every other WS-driven invalidation.
const NOTIFICATION_SYNC_DEBOUNCE_MS = 250;

/**
 * Live push. The recipient-targeted `notification.created` event bumps the
 * unread-count cache optimistically (so the badge spring-counts without an HTTP
 * round-trip) and invalidates the inbox so the new row streams in. We
 * defensively match `recipient_user_id` even though the backend already filters
 * by socket — a shared workspace socket must never bump another user's badge.
 */
export function useNotificationLiveSync(slug?: string) {
  const queryClient = useQueryClient();
  const { data: me } = useCurrentUser();
  const { t } = useTranslation();
  const inboxRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Same trailing window as useDomainSync: a burst of notifications (an agent
  // finishing a run fans out several at once) would otherwise fire two
  // invalidations each and stampede the inbox endpoint. The badge count and the
  // toast stay synchronous — only the refetch coalesces.
  const scheduleInboxRefetch = useCallback(() => {
    if (inboxRefetchTimer.current != null) {
      clearTimeout(inboxRefetchTimer.current);
    }
    inboxRefetchTimer.current = setTimeout(() => {
      inboxRefetchTimer.current = null;
      queryClient.invalidateQueries({ queryKey: notificationKeys.inbox(slug) });
      queryClient.invalidateQueries({
        queryKey: notificationKeys.inbox(undefined),
      });
    }, NOTIFICATION_SYNC_DEBOUNCE_MS);
  }, [queryClient, slug]);

  useEffect(() => {
    return () => {
      if (inboxRefetchTimer.current != null) {
        clearTimeout(inboxRefetchTimer.current);
        inboxRefetchTimer.current = null;
      }
    };
  }, []);

  useWebSocketEvent("notification.created", (event) => {
    const payload = event.payload as {
      recipient_user_id?: string;
      workspace_id?: string;
      unread_delta?: number;
      link?: NotificationLink | null;
    };
    if (me && payload.recipient_user_id && payload.recipient_user_id !== me.id) {
      return;
    }

    const delta = payload.unread_delta ?? 1;
    incrementUnreadCaches(queryClient, slug, delta);
    scheduleInboxRefetch();

    // Sober ephemeral nudge — the durable copy lives in the inbox, so this is a
    // restrained one-liner, not a duplicate of the row's full copy.
    toast(t("notifications.toast.arrived"));

    // OS-level ping (opt-in, this device only; no-op unless granted + the tab is
    // backgrounded). White-label generic copy — the rich per-category sentence
    // stays in the inbox (INV-5). The push carries the resolved deep-link, so
    // clicking the OS toast navigates straight to the card/note (the WS link has
    // no workspace_slug; the bell's current `slug` is the fallback). Falls back
    // to just focusing the app when the link can't be resolved.
    const url = linkToRoute(payload.link, slug) ?? undefined;
    showBrowserNotification({
      title: t("notifications.browser.title"),
      body: t("notifications.browser.body"),
      url,
    });
  });
}

// --- Phase 6 scaffolding (preferences query; the UI is Phase 6) ---

export function useNotificationPreferences(slug: string) {
  return useQuery<NotificationPreferences>({
    queryKey: notificationKeys.preferences(slug),
    queryFn: () => fetchNotificationPreferences(slug),
  });
}

// Optimistically merge the partial PUT into the cached prefs so a toggle flips
// instantly, then trust the server's recomputed `effective` on success (the
// backend folds muted → override → default-by-scope; the FE can't fully derive
// `effective` from a sparse override alone). The caller passes a pre-computed
// `optimistic` snapshot (the predicted whole-prefs shape) since the resolution
// of `effective` lives server-side; we apply that prediction on mutate and
// reconcile to the authoritative response on settle.
interface UpdatePrefsVariables {
  patch: Partial<NotificationPreferences>;
  optimistic: NotificationPreferences;
}

export function useUpdateNotificationPreferences(slug: string) {
  const queryClient = useQueryClient();
  const key = notificationKeys.preferences(slug);

  return useMutation({
    mutationFn: ({ patch }: UpdatePrefsVariables) =>
      updateNotificationPreferences(slug, patch),

    onMutate: async ({ optimistic }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<NotificationPreferences>(key);
      queryClient.setQueryData(key, optimistic);
      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(key, context.previous);
      }
    },

    onSuccess: (data) => {
      // Prefer the authoritative response — it carries the recomputed effective.
      queryClient.setQueryData(key, data);
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.preferences(slug) });
    },
  });
}

export function useNotificationChannels() {
  return useQuery({
    queryKey: notificationKeys.channels(),
    queryFn: fetchNotificationChannels,
    staleTime: 30 * 60 * 1000,
  });
}

// --- cache helpers ---

type QueryClient = ReturnType<typeof useQueryClient>;
type Snapshot = [readonly unknown[], unknown];

// A read/arrival in a specific workspace also moves the all-workspaces rollup
// count, so every count mutation touches both the slug cache and the `undefined`
// rollup cache. Each returns its prior value for rollback.
function adjustUnreadCaches(
  queryClient: QueryClient,
  slug: string | undefined,
  mutate: (prev: number) => number,
): Snapshot[] {
  const keys = [
    notificationKeys.unreadCount(slug),
    notificationKeys.unreadCount(undefined),
  ];
  const snapshots: Snapshot[] = [];
  for (const key of keys) {
    const prev = queryClient.getQueryData<number>(key);
    if (prev === undefined) continue;
    snapshots.push([key, prev]);
    queryClient.setQueryData<number>(key, mutate(prev));
  }
  return snapshots;
}

function decrementUnreadCaches(
  queryClient: QueryClient,
  slug: string | undefined,
  by: number,
): Snapshot[] {
  return adjustUnreadCaches(queryClient, slug, (prev) => Math.max(0, prev - by));
}

function incrementUnreadCaches(
  queryClient: QueryClient,
  slug: string | undefined,
  by: number,
): Snapshot[] {
  return adjustUnreadCaches(queryClient, slug, (prev) => prev + by);
}

function zeroUnreadCaches(
  queryClient: QueryClient,
  slug: string | undefined,
): Snapshot[] {
  return adjustUnreadCaches(queryClient, slug, () => 0);
}

function restoreSnapshots(
  queryClient: QueryClient,
  snapshots: Snapshot[] | undefined,
) {
  if (!snapshots) return;
  for (const [key, value] of snapshots) {
    queryClient.setQueryData(key, value);
  }
}
