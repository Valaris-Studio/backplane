// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { buildEntityLink } from "@/lib/entity-link";
import { resourceKeys } from "@/lib/query-keys";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { normalizeResourceId, useResourceDetail } from "../api/use-resources";
import type { Resource, ResourceDetail } from "@/types/resource";

const RESOURCE_PARAM = "resource";
const FOLDER_PARAM = "folder";
const QUERY_PARAM = "q";
const TYPE_PARAM = "resource_type";
const TAG_PARAM = "tag";
const TYPE_FILTERS = new Set(["file", "folder"]);

export type ResourceFilterParam = typeof QUERY_PARAM | typeof TYPE_PARAM | typeof TAG_PARAM;

export interface ResourceView {
  folderId: string | null;
  resourceId: string | null;
  query: string;
  resourceType: string | undefined;
  tag: string | undefined;
}

export type ResourceDestination =
  | { kind: "none" }
  | { kind: "loading" }
  // A folder target, or a board target reached through the workspace alias:
  // its replace is pending and nothing is previewed.
  | { kind: "redirecting" }
  | { kind: "file"; resource: Resource; locationVerified: boolean }
  | { kind: "unavailable" | "failed"; retrying: boolean };

export function resourceItemDomId(resourceId: string) {
  return `resource-item-${resourceId}`;
}

export function verifiedLocation(detail: ResourceDetail): { folderId: string | null; verified: boolean } {
  if (detail.parent_id === null) return { folderId: null, verified: true };
  // A legacy parent can sit outside this scope. Only a parent the server also
  // returned as the nearest authorized ancestor may become the folder beneath.
  if (detail.ancestors?.at(-1)?.id === detail.parent_id) return { folderId: detail.parent_id, verified: true };
  return { folderId: null, verified: false };
}

function readView(searchParams: URLSearchParams): ResourceView {
  const resourceType = searchParams.get(TYPE_PARAM);
  return {
    folderId: normalizeResourceId(searchParams.get(FOLDER_PARAM)),
    resourceId: normalizeResourceId(searchParams.get(RESOURCE_PARAM)),
    query: searchParams.get(QUERY_PARAM) ?? "",
    resourceType: resourceType && TYPE_FILTERS.has(resourceType) ? resourceType : undefined,
    tag: searchParams.get(TAG_PARAM) || undefined,
  };
}

function isListOriginOf(originHref: string, pathname: string) {
  const origin = new URL(originHref, window.location.origin);
  return origin.pathname === pathname && !origin.searchParams.has(RESOURCE_PARAM);
}

/** The collection's own URL is its state: folder, filters and the exact target. */
export function useResourceView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const returnNavigation = useReturnNavigation();
  const view = readView(searchParams);

  // Every replace mints a new history key and A01 restores focus/scroll by
  // key, so a write that would not change the URL must not happen at all.
  function replaceSearch(update: (next: URLSearchParams) => void) {
    const next = new URLSearchParams(searchParams);
    update(next);
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true, state: location.state });
  }

  function fileSearch(resourceId: string) {
    const next = new URLSearchParams(searchParams);
    next.set(RESOURCE_PARAM, resourceId);
    return `?${next}`;
  }

  // Opening a matched folder drops the filters that produced the match; the
  // previous entry keeps them for Back. Breadcrumbs keep folder-scoped filters.
  function folderSearch(folderId: string | null, keepFolderFilters = false) {
    const next = new URLSearchParams();
    if (folderId) next.set(FOLDER_PARAM, folderId);
    if (keepFolderFilters) {
      for (const name of [TYPE_PARAM, TAG_PARAM]) {
        const value = searchParams.get(name);
        if (value) next.set(name, value);
      }
    }
    const search = next.toString();
    return search ? `?${search}` : "";
  }

  // What a row's href carries for new tabs and copied links: the exact
  // identity alone, never this view's private query text.
  function linkSearch(resource: Resource) {
    if (resource.resource_type === "folder") return folderSearch(resource.id);
    return `?${new URLSearchParams({ [RESOURCE_PARAM]: resource.id })}`;
  }

  return {
    view,
    linkSearch,
    replaceSearch,
    openFolder: (folderId: string | null) => {
      void navigate({ search: folderSearch(folderId, true) });
    },
    openFile: (resourceId: string, origin: HTMLElement | null) => {
      const bpReturn = origin ? returnNavigation?.capture(origin) : null;
      void navigate({ search: fileSearch(resourceId) }, bpReturn ? { state: { bpReturn } } : undefined);
    },
    setFilter: (name: ResourceFilterParam, value: string | undefined) => {
      replaceSearch((next) => {
        if (value) next.set(name, value);
        else next.delete(name);
      });
    },
  };
}

export function useResourceDestination({
  slug,
  boardId,
  view,
  selectedFile,
  replaceSearch,
}: {
  slug: string;
  boardId: string | undefined;
  view: ResourceView;
  selectedFile: Resource | null;
  replaceSearch: (update: (next: URLSearchParams) => void) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const returnNavigation = useReturnNavigation();
  const closingKey = useRef<string | null>(null);
  const { resourceId } = view;
  const detailQuery = useResourceDetail(slug, boardId, resourceId);
  const detail = detailQuery.data?.id === resourceId ? detailQuery.data : undefined;
  const isWorkspaceRoute = boardId === undefined;

  let destination: ResourceDestination;
  if (resourceId === null) destination = { kind: "none" };
  // A known denial outranks anything still cached for this identity.
  else if (detailQuery.isUnavailable) destination = { kind: "unavailable", retrying: detailQuery.isFetching };
  else if (detail) {
    destination = (isWorkspaceRoute && detail.board_id) || detail.resource_type === "folder"
      ? { kind: "redirecting" }
      : { kind: "file", resource: detail, locationVerified: verifiedLocation(detail).verified };
  } else if (selectedFile?.id === resourceId && selectedFile.resource_type === "file") {
    // The row the operator chose is already authorized metadata for this scope.
    destination = { kind: "file", resource: selectedFile, locationVerified: true };
  } else if (detailQuery.isError) destination = { kind: "failed", retrying: detailQuery.isFetching };
  else destination = { kind: "loading" };

  // Only a settled, successful answer for the CURRENT identity may move the
  // URL; a refetch in flight or a late answer for an old target never does.
  const settled = detailQuery.isSuccess && !detailQuery.isFetching ? detail : undefined;
  let redirect: string | null = null;
  if (settled && isWorkspaceRoute && settled.board_id) {
    // The workspace alias answers for board resources. Open the target once in
    // its actual board, addressed by UUID, never by comparing a route slug.
    redirect = buildEntityLink({ type: "resource", slug, boardId: settled.board_id, id: settled.id })?.href ?? null;
  } else if (settled) {
    const current = new URLSearchParams(location.search);
    const next = new URLSearchParams(current);
    if (settled.resource_type === "folder") {
      for (const name of [RESOURCE_PARAM, QUERY_PARAM, TYPE_PARAM, TAG_PARAM]) next.delete(name);
      next.set(FOLDER_PARAM, settled.id);
    } else {
      const { folderId } = verifiedLocation(settled);
      if (folderId) next.set(FOLDER_PARAM, folderId);
      else next.delete(FOLDER_PARAM);
    }
    if (next.toString() !== current.toString()) {
      redirect = next.toString() ? `${location.pathname}?${next}` : location.pathname;
    }
  }

  useEffect(() => {
    // Keyed by history entry: a render that still sees the old location cannot
    // repeat the same replace, and the replaced entry resolves to no redirect.
    if (redirect) void navigate(redirect, { replace: true, state: location.state });
  }, [redirect, location.key, location.state, navigate]);

  const deniedResourceId = destination.kind === "unavailable" ? resourceId : null;
  useEffect(() => {
    if (!deniedResourceId) return;
    queryClient.removeQueries({ queryKey: resourceKeys.downloadUrl(slug, boardId, deniedResourceId) });
    // Preview bodies are keyed by signed URL; drop every one for this identity.
    queryClient.removeQueries({ queryKey: resourceKeys.previewText(deniedResourceId, "").slice(0, 2) });
    queryClient.removeQueries({ queryKey: resourceKeys.previewBinary(deniedResourceId, "").slice(0, 2) });
    returnNavigation?.forget();
  }, [deniedResourceId, slug, boardId, queryClient, returnNavigation]);

  // One close per visit to an entry: a second click before the pop lands must
  // not pop again, yet Forward back to the same entry can be closed again.
  useEffect(() => {
    closingKey.current = null;
  }, [location.key]);

  function close() {
    if (closingKey.current === location.key) return;
    closingKey.current = location.key;
    const origin = returnNavigation?.resolve((location.state as { bpReturn?: unknown } | null)?.bpReturn);
    // Pop only into the list entry this preview was opened from: same page, no
    // preview of its own, directly behind this one. A note, a cold link or a
    // reload closes in place, keeping the verified folder and existing state.
    if (origin?.canPop && isListOriginOf(origin.href, location.pathname)) {
      void navigate(-1);
      return;
    }
    replaceSearch((next) => next.delete(RESOURCE_PARAM));
  }

  return {
    destination,
    close,
    retry: () => { void detailQuery.refetch(); },
  };
}
