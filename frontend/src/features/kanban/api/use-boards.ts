// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys, dashboardKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import { reconcileBoardEvent } from "@/features/kanban/utils/board-event-reconciler";
import { mergeCardIntoBoard } from "@/features/kanban/utils/card-cache-patcher";
import { patchExecutionPresence } from "@/features/kanban/utils/execution-presence-patcher";
import { eventTargetsBoard } from "@/features/kanban/utils/board-event-scope";
import { isDependencyEvent } from "@/features/kanban/utils/dependency-events";
import type { WebSocketEvent } from "@/lib/websocket";
import type { Board, BoardDetail, Card } from "@/types/kanban";

// card.created / card.updated carry only a partial snapshot, so the cache can't
// be patched from the event itself — but re-reading the ONE card that changed
// is O(1) where a board refetch is O(board): 0.5-3 MB of JSON and a heavy
// multi-join at 1000 cards, per event. Every other action keeps its existing
// path (moved/deleted merge from the event; dependency edits refetch).
const SINGLE_CARD_FETCH_ACTIONS = new Set(["created", "updated"]);

// The board structure is kept live by WS patching (card mutations merge from
// the event or a single-card GET; execution presence patches in place), so the
// query itself no longer needs to poll for freshness. Holding it well past the
// 30 s global default stops navigation churn — open a card, go to /agents, come
// back — from refetching the whole board. A WS disconnect still converges:
// reconnect triggers its own invalidation, and refetchOnMount/onReconnect are
// untouched.
export const BOARD_DETAIL_STALE_TIME_MS = 5 * 60_000;

function actionOf(event: WebSocketEvent): string | null {
  const fromPayload = event.payload?.action;
  if (typeof fromPayload === "string") return fromPayload;
  const parts = event.event.split(".");
  return parts[parts.length - 1] ?? null;
}

export function useBoards(slug: string) {
  useDomainSync("activity.board", boardKeys.byWorkspace(slug));

  return useQuery({
    queryKey: boardKeys.byWorkspace(slug),
    queryFn: async () => {
      const { data } = await api.get<Board[]>(
        `/workspaces/${slug}/boards`,
      );
      return data;
    },
  });
}

export function useBoard(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  const queryKey = boardKeys.detail(slug, boardId);

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      // summary=true: cards arrive with a short plain-text description excerpt
      // instead of the full ProseMirror body. The card face renders only that
      // excerpt and the filter bar searches it, so nothing on the board loses
      // information — but the payload sheds its dominant term at 1000 cards.
      // CardDetailSheet re-reads the full card on open.
      const { data } = await api.get<BoardDetail>(
        `/workspaces/${slug}/boards/${boardId}`,
        { params: { summary: true } },
      );
      return data;
    },
    enabled: !!boardId,
    staleTime: BOARD_DETAIL_STALE_TIME_MS,
  });

  // Scope WS handling to events for THIS board. The backend fans events for
  // every board in the workspace into one socket; without scoping, activity
  // on board B invalidates board A's detail query and refetches it for nothing.
  //
  // CRUCIAL: the route param `boardId` is often a board SLUG, but every WS
  // event's `payload.board_id` is the board's UUID. Match against the fetched
  // board's real id (query.data.id) — falling back to the param before the
  // board has loaded. Comparing param-only dropped every cross-tab card event.
  const boardUuid = query.data?.id;
  const isThisBoard = (evt: { payload: Record<string, unknown> }) =>
    eventTargetsBoard(evt, { routeParam: boardId, boardUuid });

  // In-flight single-card GETs, keyed by card id. The backend dual-publishes
  // every card mutation on the bridge AND activity channels, so the same
  // mutation arrives twice; without this the board would issue two identical
  // GETs for it. Cleared when the fetch settles — a LATER event for the same
  // card must fetch again, since it reflects a newer state.
  const inFlightCardFetches = useRef(new Map<string, Promise<void>>()).current;

  // Re-read the single changed card and merge it into the cached board. Returns
  // true to suppress the debounced full-board refetch — the merge (or, on
  // failure, an explicit invalidation) is now responsible for converging.
  const patchOneCard = (evt: WebSocketEvent): boolean => {
    const action = actionOf(evt);
    if (!action || !SINGLE_CARD_FETCH_ACTIONS.has(action)) return false;
    const cardId = evt.payload?.entity_id;
    if (typeof cardId !== "string") return false;
    if (inFlightCardFetches.has(cardId)) return true; // twin event, already fetching

    const fetch = api
      .get<Card>(`/workspaces/${slug}/boards/${boardId}/cards/${cardId}`)
      .then(({ data }) => {
        const board = queryClient.getQueryData<BoardDetail>(queryKey);
        // The board may have been refetched or evicted while we were in flight;
        // either way it is at least as fresh as this card, so drop the merge.
        if (!board) return;
        const merged = mergeCardIntoBoard(board, data);
        if (merged) {
          queryClient.setQueryData<BoardDetail>(queryKey, merged);
        } else {
          queryClient.invalidateQueries({ queryKey });
        }
      })
      .catch(() => {
        // 404 from a delete race, a network blip, or a card that moved boards —
        // the full board GET is authoritative for all of them.
        queryClient.invalidateQueries({ queryKey });
      })
      .finally(() => {
        inFlightCardFetches.delete(cardId);
      });

    inFlightCardFetches.set(cardId, fetch);
    return true;
  };

  // Fast-path patcher that keeps every card mutation off the full-board GET.
  // The reconciler merges moves/deletes straight from the event (the cached
  // card already holds the full data, so relocating it is lossless and
  // instant). created/updated carry only a partial snapshot, so they take the
  // single-card GET instead. GET /boards/{id} stays the fallback for anything
  // neither path can converge: an empty cache, dependency edits, an unknown
  // destination column, or a failed single-card read.
  const patchBoardCache = (evt: WebSocketEvent) => {
    const current = queryClient.getQueryData<BoardDetail>(queryKey);
    if (!current) return false; // nothing cached yet — let the query load it
    const result = reconcileBoardEvent(current, evt);
    if (result === "consistent") return true; // cache already correct, suppress
    if (result !== "refetch") {
      queryClient.setQueryData<BoardDetail>(queryKey, result);
      return true;
    }
    return patchOneCard(evt); // created/updated → single-card GET, else refetch
  };

  // The board listens on BOTH the legacy bridge channel (`card.*`) and the
  // primary `activity.card.*` channel. The backend dual-publishes every card
  // mutation on both, so either alone would suffice today — but the bridge is
  // deprecated (sunset planned), and subscribing to both means the board keeps
  // working through that sunset with no code change. Double delivery is benign:
  // the reconciler's no-op guard returns null on the duplicate (cache already
  // reflects it) and the debounce coalesces refetches across both channels into
  // one (same query key).
  useDomainSync("card", queryKey, { filter: isThisBoard, patch: patchBoardCache });
  useDomainSync("activity.card", queryKey, {
    // Dependency edits (activity.card.dependency_added / _removed /
    // dependencies_replaced — note the 'ies') have no bridge twin, so they
    // arrive ONLY here. They change the inline depends_on / dependency_status
    // fields that drive the board chip, which the move reconciler can't merge,
    // so let them fall through to the debounced refetch. The reconciler still
    // fast-paths moves/deletes that arrive on this channel (e.g. once the
    // bridge sunsets); created/updated return null → refetch.
    filter: isThisBoard,
    patch: patchBoardCache,
  });
  useDomainSync("column", queryKey, { filter: isThisBoard });
  useDomainSync("completion", queryKey, { filter: isThisBoard });
  // Board metadata changes (name/description/tags) come through activity.board
  // events; without this the detail header shows stale name after a rename.
  useDomainSync("activity.board", queryKey, { filter: isThisBoard });
  // Dependency edits emit activity.card.dependency_added / _removed /
  // dependencies_replaced (note the 'ies') with no bridge twin, so the legacy
  // `card.*` channel above never sees them. The inline depends_on /
  // dependency_status fields on CardRead drive the board chip — without this
  // subscription the chip stays stale until a page reload after another tab or
  // the runner adds a dep. An exact-name match (not a prefix) so the bulk
  // dependencies_replaced event isn't silently dropped.
  useDomainSync("activity.card", queryKey, {
    filter: (evt) => isDependencyEvent(evt.event) && isThisBoard(evt),
  });
  // Runner pickup/finish: the filter keys on payload.board_id. The backend
  // guarantees it on execution.started and — as of today's backend fix — on the
  // terminal execution.completed/.warning events too (they previously omitted
  // it, so a finished run only cleared the robot indicator when an unrelated
  // card.*/activity.* event happened to fire — the "runner working but board
  // says idle" gap).
  //
  // These events exist to flip ONE card's robot indicator, so they patch
  // `agent_presence` / `active_execution_id` straight into the cached card
  // rather than refetching the whole board to have attach_agent_presence
  // recompute it server-side. On an active runner board that refetch cost two
  // full board GETs (0.5-3 MB each at 1000 cards) per tick. The board GET stays
  // the fallback for anything the patch can't express: an event with no
  // card_id, a card missing from the cache, or an empty cache.
  //
  // An execution with board_id=null (a non-board stage like planning/triage)
  // must NOT refetch this board. That once required a hand-rolled filter,
  // because the shared isThisBoard waved null-board_id events through; since
  // card 77c8fc90 tightened it to reject them, isThisBoard has exactly the
  // semantics this subscription needs.
  const patchPresence = (evt: WebSocketEvent) => {
    const current = queryClient.getQueryData<BoardDetail>(queryKey);
    if (!current) return false; // nothing cached yet — let the query load it
    const next = patchExecutionPresence(current, evt);
    if (!next) return false;
    if (next !== current) queryClient.setQueryData<BoardDetail>(queryKey, next);
    return true;
  };
  useDomainSync("execution", queryKey, {
    filter: isThisBoard,
    patch: patchPresence,
  });

  return query;
}

export function useFreezeBoard(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<Board>(
        `/workspaces/${slug}/boards/${boardId}/freeze`,
      );
      return data;
    },
    // Settled, not success: a 409 means the server state diverged from the
    // cache (someone else froze/unfroze first) — refetch to converge.
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: boardKeys.detail(slug, boardId),
      });
      // The grid's BoardCard reads is_frozen off the LIST query, which nothing
      // else refreshes — without this the snowflake stays stale until reload.
      // `exact` because the list key is a PREFIX of every detail key (same
      // hazard as useDeleteBoard): a prefix invalidation would churn every
      // mounted board detail query in the workspace.
      queryClient.invalidateQueries({
        queryKey: boardKeys.byWorkspace(slug),
        exact: true,
      });
    },
  });
}

export function useUnfreezeBoard(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<Board>(
        `/workspaces/${slug}/boards/${boardId}/unfreeze`,
      );
      return data;
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: boardKeys.detail(slug, boardId),
      });
      // See useFreezeBoard: refresh the grid's frozen state, `exact` so the
      // list key doesn't prefix-match (and refetch) every board detail query.
      queryClient.invalidateQueries({
        queryKey: boardKeys.byWorkspace(slug),
        exact: true,
      });
    },
  });
}

export function useCreateBoard(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { name: string; description: string }) => {
      // The backend responds with BoardDetailRead: the board PLUS its
      // auto-seeded typed columns (To Do/In Progress/Blocked/Done), so callers
      // like the onboarding checklist can target a column without a re-fetch.
      const { data } = await api.post<BoardDetail>(
        `/workspaces/${slug}/boards`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: boardKeys.byWorkspace(slug) });
      // Invalidate from the MUTATION side: the dashboard summary's board count
      // is kept live by useDomainSync, which only subscribes while the
      // dashboard is mounted. Creating a board from the boards page and then
      // navigating back within the global 30 s staleTime would otherwise serve
      // the pre-create count from cache.
      queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(slug) });
    },
  });
}

export function useUpdateBoard(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      boardId,
      ...payload
    }: {
      boardId: string;
      name?: string;
      description?: string;
      tags?: string[];
      // Tri-state, and the null is LOAD-BEARING: an explicit null clears the
      // board's override back to inheriting the workspace flag, while an
      // omitted key means "no change". Passed straight through — axios
      // JSON-encodes null as null and only drops `undefined`.
      enforce_done_merge_gate?: boolean | null;
    }) => {
      const { data } = await api.patch<Board>(
        `/workspaces/${slug}/boards/${boardId}`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      // Deliberately NOT `exact`: the list key ["boards", slug] prefixes every
      // detail key, so this one call also refreshes the board detail that
      // ColumnHeader and BoardLoopDialog read the done-gate override from.
      // (Unlike freeze/delete, churning sibling detail queries is harmless
      // here — an edit can change any of them.)
      queryClient.invalidateQueries({ queryKey: boardKeys.byWorkspace(slug) });
    },
  });
}

export function useDeleteBoard(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (boardId: string) => {
      await api.delete(`/workspaces/${slug}/boards/${boardId}`);
    },
    onSuccess: (_data, boardId) => {
      // Tear the dead board's subtree out, then refresh ONLY the list.
      //
      // Two separate hazards, both ending in a guaranteed 404 on the happy path
      // (the board's detail query stays mounted until navigation completes):
      //
      // 1. The teardown is matched by predicate rather than
      //    `detail(slug, boardId)`, because callers delete by board.id (a UUID)
      //    while the mounted detail query is keyed by the :boardId ROUTE PARAM,
      //    which is normally the board's SLUG. A UUID-only key misses the live
      //    query entirely. Slug-keyed entries are recognised by the board id in
      //    their cached data.
      // 2. `exact: true` on the list invalidation, because the list key
      //    ["boards", slug] is a PREFIX of the detail key ["boards", slug, id]:
      //    a prefix invalidation re-marks the just-removed detail query stale
      //    and its still-mounted observer refetches the deleted board.
      const slugAliases = queryClient
        .getQueriesData<BoardDetail>({ queryKey: boardKeys.byWorkspace(slug) })
        .filter(([, data]) => data?.id === boardId)
        .map(([queryKey]) => queryKey[2]);

      const isDeadBoardDetail = (queryKey: readonly unknown[]) =>
        queryKey[0] === "boards" &&
        queryKey[1] === slug &&
        queryKey.length > 2 &&
        (queryKey[2] === boardId || slugAliases.includes(queryKey[2] as string));

      queryClient.cancelQueries({
        predicate: (q) => isDeadBoardDetail(q.queryKey),
      });
      queryClient.removeQueries({
        predicate: (q) => isDeadBoardDetail(q.queryKey),
      });
      queryClient.invalidateQueries({
        queryKey: boardKeys.byWorkspace(slug),
        exact: true,
      });
      // Same mutation-side reasoning as useCreateBoard: the dashboard's WS sync
      // only runs while the dashboard is mounted, so a delete made from the
      // board page leaves a stale board count behind the 30 s staleTime.
      queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(slug) });
    },
  });
}
