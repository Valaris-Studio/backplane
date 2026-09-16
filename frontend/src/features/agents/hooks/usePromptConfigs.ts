// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { promptKeys } from "@/lib/query-keys";
import {
  fetchPromptDefaults,
  fetchPromptConfigs,
  createPromptConfig,
  updatePromptConfig,
  deletePromptConfig,
} from "../api/prompts";
import type { PromptConfigCreate, PromptConfigUpdate } from "../api/prompts";

export function usePromptDefaults(slug: string, role?: string) {
  return useQuery({
    queryKey: promptKeys.defaults(slug, role),
    queryFn: () => fetchPromptDefaults(slug, role),
  });
}

export function usePromptConfigs(slug: string, teamRole?: string) {
  return useQuery({
    queryKey: promptKeys.list(slug, teamRole),
    queryFn: () => fetchPromptConfigs(slug, teamRole),
  });
}

export function useCreatePromptConfig(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: PromptConfigCreate) => createPromptConfig(slug, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: promptKeys.all });
    },
  });
}

export function useUpdatePromptConfig(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      configId,
      data,
    }: {
      configId: string;
      data: PromptConfigUpdate;
    }) => updatePromptConfig(slug, configId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: promptKeys.all });
    },
  });
}

export function useDeletePromptConfig(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (configId: string) => deletePromptConfig(slug, configId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: promptKeys.all });
    },
  });
}
