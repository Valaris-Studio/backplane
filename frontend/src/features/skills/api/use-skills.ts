// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { skillKeys } from "@/lib/query-keys";
import type {
  BoardSkillBinding,
  BoardSkillBindingList,
  BoardSkillBindingRowList,
  Skill,
  SkillBindingUpdate,
  SkillCatalogResponse,
  SkillDetail,
  SkillFile,
  SkillListResponse,
  SkillVersionDetail,
  SkillVersionMeta,
} from "@/types/skill";

function getBasePath(slug: string) {
  return `/workspaces/${slug}/skills`;
}

export function useSkills(
  slug: string,
  options?: { enabled?: boolean; includeArchived?: boolean },
) {
  const includeArchived = options?.includeArchived ?? false;
  return useQuery({
    // Distinct cache entries: the live-only and include-archived lists must
    // never serve each other's rows.
    queryKey: includeArchived
      ? skillKeys.archivedList(slug)
      : skillKeys.all(slug),
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const { data } = await api.get<SkillListResponse>(
        includeArchived
          ? `${getBasePath(slug)}?include_archived=true`
          : getBasePath(slug),
      );
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useArchiveSkill(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (skillSlug: string) => {
      const { data } = await api.post<SkillDetail>(
        `${getBasePath(slug)}/${skillSlug}/archive`,
      );
      return data;
    },
    onSuccess: (_data, skillSlug) => {
      queryClient.invalidateQueries({ queryKey: skillKeys.all(slug) });
      queryClient.invalidateQueries({
        queryKey: skillKeys.detail(slug, skillSlug),
      });
    },
  });
}

export function useUnarchiveSkill(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (skillSlug: string) => {
      const { data } = await api.post<SkillDetail>(
        `${getBasePath(slug)}/${skillSlug}/unarchive`,
      );
      return data;
    },
    onSuccess: (_data, skillSlug) => {
      queryClient.invalidateQueries({ queryKey: skillKeys.all(slug) });
      queryClient.invalidateQueries({
        queryKey: skillKeys.detail(slug, skillSlug),
      });
    },
  });
}

export function useSkill(slug: string, skillSlug: string | null) {
  return useQuery({
    queryKey: skillKeys.detail(slug, skillSlug ?? ""),
    enabled: Boolean(skillSlug),
    queryFn: async () => {
      const { data } = await api.get<SkillDetail>(
        `${getBasePath(slug)}/${skillSlug}`,
      );
      return data;
    },
  });
}

export function useSkillVersion(
  slug: string,
  skillSlug: string | null,
  version: number | null,
) {
  return useQuery({
    queryKey: skillKeys.version(slug, skillSlug ?? "", version ?? 0),
    enabled: Boolean(skillSlug) && version !== null,
    queryFn: async () => {
      const { data } = await api.get<SkillVersionDetail>(
        `${getBasePath(slug)}/${skillSlug}/versions/${version}`,
      );
      return data;
    },
  });
}

export function useSkillCatalog(slug: string) {
  return useQuery({
    queryKey: skillKeys.catalog(slug),
    queryFn: async () => {
      const { data } = await api.get<SkillCatalogResponse>(
        `/workspaces/${slug}/skill-catalog`,
      );
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useActivateCatalogSkill(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (catalogId: string) => {
      const { data } = await api.post<SkillDetail>(
        `/workspaces/${slug}/skill-catalog/${catalogId}/activate`,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillKeys.all(slug) });
      queryClient.invalidateQueries({ queryKey: skillKeys.catalog(slug) });
    },
  });
}

export function useCreateSkill(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { slug: string; files: SkillFile[] }) => {
      const response = await api.post<Skill>(getBasePath(slug), payload);
      // Idempotent-on-slug endpoint: 201 created a skill, 200 returned the
      // one that already owned the slug — callers must not report success.
      return { skill: response.data, created: response.status === 201 };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillKeys.all(slug) });
    },
  });
}

export function useCreateSkillVersion(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      skillSlug,
      files,
    }: {
      skillSlug: string;
      files: SkillFile[];
    }) => {
      const { data } = await api.post<SkillVersionMeta>(
        `${getBasePath(slug)}/${skillSlug}/versions`,
        { files },
      );
      return data;
    },
    onSuccess: (_data, { skillSlug }) => {
      queryClient.invalidateQueries({ queryKey: skillKeys.all(slug) });
      queryClient.invalidateQueries({
        queryKey: skillKeys.detail(slug, skillSlug),
      });
    },
  });
}

export function usePublishSkillVersion(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      skillSlug,
      version,
    }: {
      skillSlug: string;
      version: number;
    }) => {
      const { data } = await api.post<SkillVersionMeta>(
        `${getBasePath(slug)}/${skillSlug}/versions/${version}/publish`,
      );
      return data;
    },
    onSuccess: (_data, { skillSlug }) => {
      queryClient.invalidateQueries({ queryKey: skillKeys.all(slug) });
      queryClient.invalidateQueries({
        queryKey: skillKeys.detail(slug, skillSlug),
      });
    },
  });
}

function getBoardSkillsPath(slug: string, boardId: string) {
  return `/workspaces/${slug}/boards/${boardId}/skills`;
}

export function useBoardSkills(
  slug: string,
  boardId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: skillKeys.byBoard(slug, boardId),
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const { data } = await api.get<BoardSkillBindingList>(
        getBoardSkillsPath(slug, boardId),
      );
      return data;
    },
  });
}

/** RAW bindings — every row an operator configured, including disabled ones
 * and ones that resolve to nothing. `useBoardSkills` (the effective set) drops
 * both, which is right for a runner and wrong for a settings UI. */
export function useBoardSkillBindings(
  slug: string,
  boardId: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: skillKeys.bindingsByBoard(slug, boardId),
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const { data } = await api.get<BoardSkillBindingRowList>(
        `${getBoardSkillsPath(slug, boardId)}/bindings`,
      );
      return data;
    },
  });
}

export function useSetSkillBinding(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      skillSlug,
      ...payload
    }: SkillBindingUpdate & { skillSlug: string }) => {
      const { data } = await api.put<BoardSkillBinding>(
        `${getBoardSkillsPath(slug, boardId)}/${skillSlug}`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: skillKeys.byBoard(slug, boardId),
      });
      queryClient.invalidateQueries({
        queryKey: skillKeys.bindingsByBoard(slug, boardId),
      });
    },
  });
}

export function useUnbindSkill(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (skillSlug: string) => {
      await api.delete(`${getBoardSkillsPath(slug, boardId)}/${skillSlug}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: skillKeys.byBoard(slug, boardId),
      });
      queryClient.invalidateQueries({
        queryKey: skillKeys.bindingsByBoard(slug, boardId),
      });
    },
  });
}
