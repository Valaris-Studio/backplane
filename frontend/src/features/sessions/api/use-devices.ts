// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { companionKeys, sessionKeys } from "@/lib/query-keys";
import type { CaptureLevel, CompanionCapturePolicy, CompanionInstallation, CompanionMapping } from "@/types/agent-session";

const DEVICES = "/me/companion/installations";

export function useDeviceMappings(installationId: string, enabled: boolean) {
  return useQuery({
    queryKey: companionKeys.mappings(installationId),
    queryFn: async () => {
      const { data } = await api.get<CompanionMapping[]>(`${DEVICES}/${installationId}/mappings`);
      return data;
    },
    enabled,
  });
}

function useInvalidateDevices() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["companion"] });
}

export function usePauseDevice(installationId: string) {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: async (paused: boolean) => {
      const { data } = await api.patch<CompanionCapturePolicy>(`${DEVICES}/${installationId}/policy`, { paused });
      return data;
    },
    onSuccess: () => void invalidate(),
  });
}

export function useRenameDevice(installationId: string) {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: async (name: string) => {
      const { data } = await api.patch<CompanionInstallation>(`${DEVICES}/${installationId}`, { name });
      return data;
    },
    onSuccess: () => void invalidate(),
  });
}

export function useSignOutDevice(installationId: string) {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.delete<CompanionInstallation>(`${DEVICES}/${installationId}`);
      return data;
    },
    onSuccess: () => void invalidate(),
  });
}

// The devices list is cached for minutes, but a device keeps uploading: refetch
// before a confirm states session_count.
export function useRefreshDeviceCounts() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: companionKeys.installations() });
}

export function useDeleteDeviceSessions(installationId: string, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.delete<{ deleted: number }>(`${DEVICES}/${installationId}/sessions`);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all(slug) });
      // Each device's session_count lives on the installations read.
      void queryClient.invalidateQueries({ queryKey: companionKeys.installations() });
    },
  });
}

export interface MappingPatch {
  content_level?: CaptureLevel;
  enabled?: boolean;
  board_id?: string | null;
}

export function useUpdateMapping(installationId: string) {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: async ({ mappingId, patch }: { mappingId: string; patch: MappingPatch }) => {
      const { data } = await api.patch<CompanionMapping>(`${DEVICES}/${installationId}/mappings/${mappingId}`, patch);
      return data;
    },
    onSuccess: () => void invalidate(),
  });
}
