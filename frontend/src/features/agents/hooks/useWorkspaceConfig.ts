// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { workspaceConfigKeys } from "@/lib/query-keys";
import {
  fetchSensorCatalog,
  fetchWorkspaceConfig,
  updateWorkspaceConfig,
  type SensorManifestEntry,
  type WorkspaceConfig,
  type WorkspaceConfigUpdatePayload,
} from "../api/pipelineConfig";

export function useWorkspaceConfig(slug: string) {
  return useQuery<WorkspaceConfig>({
    queryKey: workspaceConfigKeys.byWorkspace(slug),
    queryFn: () => fetchWorkspaceConfig(slug),
    enabled: !!slug,
  });
}

export function useUpdateWorkspaceConfig(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: WorkspaceConfigUpdatePayload) =>
      updateWorkspaceConfig(slug, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: workspaceConfigKeys.byWorkspace(slug),
      });
    },
  });
}

const sensorCatalogKey = (slug: string) =>
  [...workspaceConfigKeys.byWorkspace(slug), "sensors"] as const;

export function useSensorCatalog(slug: string) {
  return useQuery<SensorManifestEntry[]>({
    queryKey: sensorCatalogKey(slug),
    queryFn: () => fetchSensorCatalog(slug),
    enabled: !!slug,
    staleTime: 5 * 60 * 1000,
  });
}
