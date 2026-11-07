// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError, isApiError } from "@/lib/api-error";
import { resourceKeys } from "@/lib/query-keys";
import { shouldRetry } from "@/lib/should-retry";
import { useDomainSync } from "@/hooks/useDomainSync";
import type {
  Resource,
  ResourceCreate,
  ResourceDetail,
  ResourceUpdate,
  ResourceSearchParams,
  UploadUrlRequest,
  UploadUrlResponse,
  DownloadUrlResponse,
} from "@/types/resource";

/** A 4xx the server will repeat on retry: deleted, denied or malformed target.
 *  408/429 are pressure, not an answer about the resource. */
export function isDefinitiveResourceError(error: unknown): boolean {
  return isApiError(error) && error.status >= 400 && error.status < 500 &&
    error.status !== 408 && error.status !== 429;
}

function retryTransientResourceErrors(failureCount: number, error: unknown): boolean {
  return !isDefinitiveResourceError(error) && shouldRetry(failureCount, error);
}

export function normalizeResourceId(id: string | null): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return id && uuid.test(id) ? id.toLowerCase() : id;
}

function resourcePathSegment(id: string) {
  // Proxies and the API router decode path separators again. Encoding alone
  // cannot confine an identity to this endpoint; opaque unreserved IDs can.
  if (!/^[A-Za-z0-9._~-]+$/.test(id) || id === "." || id === "..") {
    throw new ApiError("Invalid resource identity", 422);
  }
  return id;
}

function getBasePath(slug: string, boardId?: string) {
  return boardId
    ? `/workspaces/${slug}/boards/${boardId}/resources`
    : `/workspaces/${slug}/resources`;
}

function getQueryKey(slug: string, boardId?: string) {
  return boardId
    ? resourceKeys.byBoard(slug, boardId)
    : resourceKeys.byWorkspace(slug);
}

export function useResources(
  slug: string,
  boardId?: string,
  parentId?: string | null,
  searchParams?: ResourceSearchParams,
) {
  // Invalidate the base scope rather than the fully-parameterised key so all
  // search/filter variants refresh on activity.resource.* events.
  useDomainSync("activity.resource", getQueryKey(slug, boardId));

  const queryClient = useQueryClient();
  const normalizedParentId = normalizeResourceId(parentId ?? null);
  const scopeKey = getQueryKey(slug, boardId);
  const queryKey = [
    ...scopeKey,
    normalizedParentId ?? "root",
    searchParams?.q ?? "",
    searchParams?.resource_type ?? "",
    searchParams?.tag ?? "",
  ];
  const query = useQuery<Resource[] | null>({
    queryKey,
    queryFn: async ({ signal }) => {
      try {
        // The server applies parent_id to type/tag filters and ignores it for a
        // text search, which spans the whole scope.
        const params: Record<string, string> = {};
        if (normalizedParentId !== null) {
          resourcePathSegment(normalizedParentId);
          params.parent_id = normalizedParentId;
        }
        if (searchParams?.q) params.q = searchParams.q;
        if (searchParams?.resource_type) params.resource_type = searchParams.resource_type;
        if (searchParams?.tag) params.tag = searchParams.tag;
        const { data } = await api.get<Resource[]>(getBasePath(slug, boardId), { params, signal });
        return data;
      } catch (error) {
        // null removes denied metadata and survives retry's error reset and
        // remounts. Only a successful response replaces it with authorized data.
        if (!signal.aborted && isDefinitiveResourceError(error)) {
          queryClient.setQueryData<Resource[] | null>(queryKey, null);
        }
        throw error;
      }
    },
    placeholderData: (previous, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      // A warm route change can reuse this observer. Only folder/filter
      // transitions within the same collection may retain authorized rows.
      const sameScope = previousKey?.length === queryKey.length
        && scopeKey.every((part, index) => previousKey[index] === part);
      return sameScope ? previous ?? undefined : undefined;
    },
    retry: retryTransientResourceErrors,
  });
  return {
    ...query,
    data: query.data ?? undefined,
    isUnavailable: query.data === null || isDefinitiveResourceError(query.error),
  };
}

/** Exact authorized metadata for one resource, independent of any listing.
 *  Never seeded from another identity: a late or mismatched answer is dropped. */
export function useResourceDetail(slug: string, boardId: string | undefined, resourceId: string | null) {
  const queryClient = useQueryClient();
  const id = normalizeResourceId(resourceId);
  const queryKey = resourceKeys.detail(slug, boardId, id ?? "");
  const query = useQuery<ResourceDetail | null>({
    queryKey,
    queryFn: async ({ signal }) => {
      try {
        const segment = resourcePathSegment(id ?? "");
        const { data } = await api.get<ResourceDetail>(`${getBasePath(slug, boardId)}/${segment}`, { signal });
        if (data.id !== id) throw new Error("Resource detail answered for another identity");
        return data;
      } catch (error) {
        if (!signal.aborted && isDefinitiveResourceError(error)) {
          queryClient.setQueryData<ResourceDetail | null>(queryKey, null);
        }
        throw error;
      }
    },
    enabled: id !== null,
    retry: retryTransientResourceErrors,
  });
  return {
    ...query,
    data: query.data ?? undefined,
    isUnavailable: query.data === null || isDefinitiveResourceError(query.error),
  };
}

export function useTags(slug: string, boardId?: string) {
  useDomainSync("activity.resource", resourceKeys.tags(slug, boardId));

  return useQuery({
    queryKey: resourceKeys.tags(slug, boardId),
    queryFn: async () => {
      const { data } = await api.get<string[]>(`${getBasePath(slug, boardId)}/tags`);
      return data;
    },
  });
}

export function useCreateResource(slug: string, boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ResourceCreate) => {
      const { data } = await api.post<Resource>(getBasePath(slug, boardId), payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getQueryKey(slug, boardId) });
      queryClient.invalidateQueries({ queryKey: resourceKeys.tags(slug, boardId) });
    },
  });
}

export function useUpdateResource(slug: string, boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ resourceId, ...payload }: ResourceUpdate & { resourceId: string }) => {
      const { data } = await api.put<Resource>(
        `${getBasePath(slug, boardId)}/${resourceId}`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getQueryKey(slug, boardId) });
      queryClient.invalidateQueries({ queryKey: resourceKeys.tags(slug, boardId) });
    },
  });
}

export function useDeleteResource(slug: string, boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (resourceId: string) => {
      await api.delete(`${getBasePath(slug, boardId)}/${resourceId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getQueryKey(slug, boardId) });
      queryClient.invalidateQueries({ queryKey: resourceKeys.tags(slug, boardId) });
    },
  });
}

export function useUploadUrl(slug: string, boardId?: string) {
  return useMutation({
    mutationFn: async (payload: UploadUrlRequest) => {
      const { data } = await api.post<UploadUrlResponse>(
        `${getBasePath(slug, boardId)}/upload-url`,
        payload,
      );
      return data;
    },
  });
}

export function useDownloadUrl(slug: string, boardId?: string) {
  return useMutation({
    mutationFn: async (resourceId: string) => {
      const { data } = await api.get<DownloadUrlResponse>(
        `${getBasePath(slug, boardId)}/${resourceId}/download-url`,
      );
      return data;
    },
  });
}

export function usePreviewDownloadUrl(
  slug: string,
  boardId: string | undefined,
  resource: Resource,
) {
  return useQuery({
    queryKey: resourceKeys.downloadUrl(slug, boardId, resource.id),
    queryFn: async () => {
      const { data } = await api.get<DownloadUrlResponse>(
        `${getBasePath(slug, boardId)}/${resource.id}/download-url`,
      );
      if (!data.download_url) throw new Error("Missing download URL");
      return data.download_url;
    },
    enabled: Boolean(resource.gcs_path),
    retry: false,
    gcTime: 0,
  });
}
