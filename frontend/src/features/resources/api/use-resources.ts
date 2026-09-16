// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { resourceKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type {
  Resource,
  ResourceCreate,
  ResourceUpdate,
  ResourceSearchParams,
  UploadUrlRequest,
  UploadUrlResponse,
  DownloadUrlResponse,
} from "@/types/resource";

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

  return useQuery({
    queryKey: [
      ...getQueryKey(slug, boardId),
      parentId ?? "root",
      searchParams?.q ?? "",
      searchParams?.resource_type ?? "",
      searchParams?.tag ?? "",
    ],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (parentId) params.parent_id = parentId;
      if (searchParams?.q) params.q = searchParams.q;
      if (searchParams?.resource_type) params.resource_type = searchParams.resource_type;
      if (searchParams?.tag) params.tag = searchParams.tag;
      const { data } = await api.get<Resource[]>(getBasePath(slug, boardId), { params });
      return data;
    },
    placeholderData: (prev) => prev,
  });
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
