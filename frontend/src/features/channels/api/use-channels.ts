// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { channelKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { Channel, ChannelType } from "@/types/channel";

interface ChannelCreate {
  name: string;
  channel_type: ChannelType;
  contact_value: string;
  description?: string;
}

interface ChannelUpdate {
  name?: string;
  channel_type?: ChannelType;
  contact_value?: string;
  description?: string;
}

function getBasePath(slug: string) {
  return `/workspaces/${slug}/channels`;
}

export function useChannels(slug: string) {
  useDomainSync("activity.channel", channelKeys.byWorkspace(slug));

  return useQuery({
    queryKey: channelKeys.byWorkspace(slug),
    queryFn: async () => {
      const { data } = await api.get<Channel[]>(getBasePath(slug));
      return data;
    },
  });
}

export function useCreateChannel(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ChannelCreate) => {
      const { data } = await api.post<Channel>(getBasePath(slug), payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: channelKeys.byWorkspace(slug) });
    },
  });
}

export function useUpdateChannel(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ channelId, ...payload }: ChannelUpdate & { channelId: string }) => {
      const { data } = await api.put<Channel>(
        `${getBasePath(slug)}/${channelId}`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: channelKeys.byWorkspace(slug) });
    },
  });
}

export function useDeleteChannel(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      await api.delete(`${getBasePath(slug)}/${channelId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: channelKeys.byWorkspace(slug) });
    },
  });
}
