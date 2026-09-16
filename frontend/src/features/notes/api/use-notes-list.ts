// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { noteKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { NoteSummary } from "@/types/note";

export const NOTES_PAGE_SIZE = 60;

export type NotesOrderBy = "updated_at" | "created_at" | "title" | "author";
export type NotesDirection = "asc" | "desc";

export interface NotesListParams {
  q?: string;
  orderBy?: NotesOrderBy;
  direction?: NotesDirection;
  pinnedOnly?: boolean;
  authors?: string[];
  kinds?: string[];
}

interface NotesPage {
  items: NoteSummary[];
  /** X-Total-Count — rows matching the filters, not rows loaded so far. */
  total: number;
  offset: number;
}

function getBasePath(slug: string, boardId?: string) {
  return boardId
    ? `/workspaces/${slug}/boards/${boardId}/notes`
    : `/workspaces/${slug}/notes`;
}

/**
 * Normalize the caller's controls into the exact request params.
 *
 * Empty selections are DROPPED rather than sent as `[]`/`false`: the params
 * object doubles as the query key, so an omitted-vs-empty distinction would
 * split the cache between two keys that mean the same thing (and, for
 * `pinned_only=false`, send a filter the backend would have to special-case).
 */
function toRequestParams(params: NotesListParams) {
  const q = params.q?.trim();
  const authors = params.authors?.length ? params.authors : undefined;
  const kinds = params.kinds?.length ? params.kinds : undefined;
  return {
    summary_only: true,
    ...(q ? { q } : {}),
    ...(params.orderBy ? { order_by: params.orderBy } : {}),
    ...(params.direction ? { direction: params.direction } : {}),
    ...(params.pinnedOnly ? { pinned_only: true } : {}),
    ...(authors ? { authors } : {}),
    ...(kinds ? { kinds } : {}),
  };
}

/**
 * The Notes browse list: summary-only rows, paginated, with search/sort/filter
 * resolved by the server.
 *
 * Search must span the whole collection, not the loaded pages — which is why
 * `q` (and every filter and the sort) is a request param rather than a client
 * pass over `items`. Callers debounce `q` before handing it here; each distinct
 * combination gets its own cache entry.
 */
export function useNotesList(
  slug: string,
  boardId?: string,
  params: NotesListParams = {},
) {
  const requestParams = useMemo(
    () => toRequestParams(params),
    // Value-compare the caller's params: the arrays and the object literal are
    // fresh identities on every render, and this feeds the query key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(params)],
  );

  const queryKey = noteKeys.list(slug, boardId, requestParams);

  // Agents write notes constantly; without this an agent-authored note doesn't
  // appear until a manual refresh. Invalidate the whole list prefix — the user
  // may have several filter combinations cached and any of them can be stale.
  useDomainSync("activity.note", noteKeys.listRoot(slug, boardId));

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const response = await api.get<NoteSummary[]>(getBasePath(slug, boardId), {
        params: { ...requestParams, limit: NOTES_PAGE_SIZE, offset: pageParam },
        // `authors`/`kinds` are repeated params (?authors=a&authors=b). Axios
        // defaults to the `authors[]=` bracket form, which FastAPI reads as a
        // differently-named field and silently ignores.
        paramsSerializer: { indexes: null },
      });
      const header = response.headers?.["x-total-count"];
      return {
        items: response.data,
        total: header != null ? Number(header) : response.data.length,
        offset: pageParam,
      } satisfies NotesPage;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.items.length === NOTES_PAGE_SIZE
        ? lastPage.offset + NOTES_PAGE_SIZE
        : undefined,
    // Changing a filter keeps the previous result on screen until the new one
    // lands, so typing in the search box doesn't blank the grid per keystroke.
    placeholderData: keepPreviousData,
    // NO maxPages here (unlike the activity feed): pages are offset-addressed
    // and rendered as one continuous list, so dropping page 0 would both punch
    // a hole in the middle of the grid and leave `offset` pointing past a gap.
  });

  const items = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  return {
    ...query,
    items,
    totalCount: query.data?.pages[0]?.total ?? 0,
  };
}
