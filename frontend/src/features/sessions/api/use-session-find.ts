// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { sessionKeys } from "@/lib/query-keys";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { SessionSearchHit, SessionSearchPage, SessionSearchRequest } from "@/types/agent-session";
import { usePrivateContentRead } from "./use-session-contents";
import { useForgetSessionContent } from "./use-session-realtime";

const MAX_RETAINED_PAGES = 10;
export type FindScope = "all" | "conversation" | "tools" | "mcp";
export interface FindControls {
  open: boolean;
  draft: string;
  scope: FindScope;
  failures: boolean;
  work: boolean;
  run: number;
  selected: number;
}
interface PageReference { cursor: string | null; count: number; scanned: number }
interface SearchRun {
  pages: SessionSearchPage[];
  pageNumbers: number[];
  trail: PageReference[];
  nextCursor: string | null;
  complete: boolean;
  stale: boolean;
}

export function validFindQuery(value: string) {
  return value.length > 0 && [...value].length <= 256 && !value.includes("\u0000") && !value.includes("\uffff");
}

function requestFor(controls: FindControls): SessionSearchRequest {
  return {
    q: controls.draft,
    ...(controls.scope === "all" ? {} : { types: controls.scope === "conversation"
      ? ["prompt", "reply", "reasoning", "summary", "instruction"] : [controls.scope === "tools" ? "tool" : "mcp"] }),
    failures_only: controls.failures, work_only: controls.work, limit: 20,
  };
}

export function useSessionFind(slug: string, sessionId: string, onNavigate: (hit: SessionSearchHit) => void) {
  const queryClient = useQueryClient();
  const returnNavigation = useReturnNavigation();
  const read = usePrivateContentRead(slug, sessionId);
  const forgetContent = useForgetSessionContent();
  const memoryKey = `session-reader-find:${slug}/${sessionId}`;
  const [controls, setControls] = useState<FindControls>(() => returnNavigation?.readView<FindControls>(memoryKey)
    ?? { open: false, draft: "", scope: "all", failures: false, work: false, run: Date.now(), selected: -1 });
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const action = useRef<{ page: number; restart: boolean }>({ page: 0, restart: true });
  const generation = useRef(0);
  const running = useRef(false);
  const edited = useRef(false);
  const freshness = useRef(0);
  const [staleError, setStaleError] = useState(false);
  const key = sessionKeys.search(slug, sessionId, controls.run);
  const query = useQuery<SearchRun>({
    queryKey: key,
    queryFn: ({ signal }) => read(signal, async () => {
      const current = queryClient.getQueryData<SearchRun>(key);
      const { page, restart } = action.current;
      const beganAt = freshness.current;
      const reference = current?.trail[page];
      const cursor = restart ? null : reference ? reference.cursor : current?.nextCursor ?? null;
      try {
        const { data } = await api.post<SessionSearchPage>(`/workspaces/${slug}/sessions/${sessionId}/search`, {
          ...requestFor(controlsRef.current), cursor,
        }, { signal });
        signal.throwIfAborted();
        const previous = restart ? undefined : current;
        const trail = [...previous?.trail ?? []];
        trail[page] = { cursor, count: data.items.length, scanned: data.scanned_bytes };
        const retained = new Map(previous?.pageNumbers.map((number, index) => [number, previous.pages[index]!]));
        retained.set(page, data);
        const pageNumbers = [...retained.keys()].sort((left, right) => left - right);
        while (pageNumbers.length > MAX_RETAINED_PAGES) {
          const remove = page < pageNumbers[0]! + MAX_RETAINED_PAGES ? pageNumbers.pop()! : pageNumbers.shift()!;
          retained.delete(remove);
        }
        const atEnd = page === trail.length - 1;
        return { pages: pageNumbers.map((number) => retained.get(number)!), pageNumbers, trail,
          nextCursor: atEnd ? data.next_cursor : previous!.nextCursor,
          complete: atEnd ? data.complete : previous!.complete, stale: (previous?.stale ?? false) || freshness.current !== beganAt };
      } catch (error) {
        if (!signal.aborted && isApiError(error)) {
          if ([401, 403, 404].includes(error.status)) {
            queryClient.setQueryData(sessionKeys.detail(slug, sessionId), null);
            returnNavigation?.forget(`/${slug}/sessions/${sessionId}`);
            forgetContent(slug, sessionId);
          } else if (error.status === 409) {
            setStaleError(true);
            queryClient.setQueryData<SearchRun>(key, (run) => run ? { ...run, stale: true } : run);
          }
        }
        throw error;
      }
    }),
    enabled: false,
    retry: false,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    meta: { markSessionSearchStale: () => {
      freshness.current++;
      queryClient.setQueryData<SearchRun>(key, (current) => current ? { ...current, stale: true } : current);
    } },
  });

  useEffect(() => { returnNavigation?.writeView(memoryKey, controls); }, [controls, memoryKey, returnNavigation]);
  useEffect(() => () => { generation.current++; void queryClient.cancelQueries({ queryKey: sessionKeys.searchRoot(slug, sessionId) }); }, [queryClient, slug, sessionId]);

  const { refetch } = query;
  const perform = useCallback(async (page: number, restart = false) => {
    if (running.current || !validFindQuery(controlsRef.current.draft)) return undefined;
    const expectedGeneration = generation.current;
    running.current = true;
    edited.current = false;
    action.current = { page, restart };
    if (restart) setStaleError(false);
    try {
      const result = await refetch();
      if (expectedGeneration !== generation.current || result.isError) return undefined;
      if (restart) { setStaleError(false); setControls((current) => ({ ...current, selected: -1 })); }
      return result.data;
    } finally { if (expectedGeneration === generation.current) running.current = false; }
  }, [refetch]);

  useEffect(() => {
    if (!edited.current || !validFindQuery(controls.draft)) return;
    const timeout = window.setTimeout(() => { if (edited.current) void perform(0, true); }, 300);
    return () => window.clearTimeout(timeout);
  }, [controls.run, controls.draft, perform]);

  function change(update: Partial<FindControls>, searchChanged = false) {
    if (searchChanged) {
      generation.current++;
      running.current = false;
      void queryClient.cancelQueries({ queryKey: sessionKeys.searchRoot(slug, sessionId) });
      queryClient.removeQueries({ queryKey: sessionKeys.searchRoot(slug, sessionId) });
      edited.current = true;
      setStaleError(false);
    }
    setControls((current) => ({ ...current, ...update, ...(searchChanged ? { run: current.run + 1, selected: -1 } : {}) }));
  }

  const data = query.data;
  const total = data?.trail.reduce((sum, page) => sum + page.count, 0) ?? 0;
  const scanned = data?.trail.reduce((sum, page) => sum + page.scanned, 0) ?? 0;
  const results = data?.pages.flatMap((page, index) => {
    const start = data.trail.slice(0, data.pageNumbers[index]).reduce((sum, previous) => sum + previous.count, 0);
    return page.items.map((hit, local) => ({ hit, ordinal: start + local }));
  }) ?? [];

  function select(hit: SessionSearchHit, ordinal: number) {
    change({ selected: ordinal });
    onNavigate(hit);
  }

  async function move(direction: 1 | -1) {
    if (running.current) return;
    const ordinal = Math.max(0, controlsRef.current.selected + direction);
    const loaded = results.find((result) => result.ordinal === ordinal);
    if (loaded) { select(loaded.hit, ordinal); return; }
    if (!data) {
      const first = await perform(0, true);
      const hit = first?.pages[0]?.items[0];
      if (hit) select(hit, 0);
      return;
    }
    let page = data.trail.length;
    let start = 0;
    for (let index = 0; index < data.trail.length; index++) {
      if (ordinal < start + data.trail[index]!.count) { page = index; break; }
      start += data.trail[index]!.count;
    }
    if (page === data.trail.length && (!data.nextCursor || staleError)) return;
    const fetched = await perform(page);
    const hit = fetched?.pages[fetched.pageNumbers.indexOf(page)]?.items[ordinal - start];
    if (hit) select(hit, ordinal);
  }

  return { controls, change, query, data, results, total, scanned, stale: !!data?.stale || staleError, staleError,
    select, move, continueSearch: () => perform(data?.trail.length ?? 0),
    restart: () => perform(0, true), retry: () => perform(action.current.page, action.current.restart) };
}
