// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { memberKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type {
  AddMemberRequest,
  UpdateMemberRoleRequest,
  WorkspaceMember,
} from "@/types/member";

function getBasePath(slug: string) {
  return `/workspaces/${slug}/members`;
}

export function useMembers(slug: string) {
  useDomainSync("activity.member", memberKeys.list(slug));

  return useQuery({
    queryKey: memberKeys.list(slug),
    queryFn: async () => {
      const { data } = await api.get<WorkspaceMember[]>(getBasePath(slug));
      return data;
    },
  });
}

export function useAddMember(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: AddMemberRequest) => {
      const { data } = await api.post<WorkspaceMember>(getBasePath(slug), payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.list(slug) });
    },
  });
}

export function useUpdateMemberRole(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      userId,
      role,
    }: UpdateMemberRoleRequest & { userId: string }) => {
      const { data } = await api.patch<WorkspaceMember>(
        `${getBasePath(slug)}/${userId}`,
        { role },
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.list(slug) });
    },
  });
}

export function useSetTemporaryPassword(slug: string) {
  return useMutation({
    // Empty body: the server generates the password and returns it once.
    mutationFn: async (userId: string) => {
      const { data } = await api.post<{ temporary_password: string }>(
        `${getBasePath(slug)}/${userId}/temporary-password`,
        {},
      );
      return data;
    },
  });
}

export function useRemoveMember(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await api.delete(`${getBasePath(slug)}/${userId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.list(slug) });
    },
  });
}
