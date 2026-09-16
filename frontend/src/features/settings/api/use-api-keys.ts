// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiKeyKeys } from "@/lib/query-keys";
import type { ApiKey, ApiKeyCreated } from "@/types/api-key";

export function useApiKeys() {
  return useQuery({
    queryKey: apiKeyKeys.all,
    queryFn: async () => {
      const { data } = await api.get<ApiKey[]>("/me/api-keys");
      return data;
    },
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { name: string }) => {
      const { data } = await api.post<ApiKeyCreated>("/me/api-keys", payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (keyId: string) => {
      await api.delete(`/me/api-keys/${keyId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}
