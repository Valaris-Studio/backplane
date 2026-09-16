// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { teamKeys } from "@/lib/query-keys";
import {
  fetchTeams,
  fetchTeam,
  createTeam,
  updateTeam,
  deactivateTeam,
  addTeamMember,
  removeTeamMember,
  type TeamCreate,
  type TeamUpdate,
  type TeamMemberAdd,
} from "../api/teams";

export function useTeams(slug: string) {
  return useQuery({
    queryKey: teamKeys.list(slug),
    queryFn: () => fetchTeams(slug),
  });
}

export function useTeam(slug: string, teamId: string) {
  return useQuery({
    queryKey: teamKeys.detail(slug, teamId),
    queryFn: () => fetchTeam(slug, teamId),
    enabled: !!teamId,
  });
}

export function useCreateTeam(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: TeamCreate) => createTeam(slug, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.list(slug) });
    },
  });
}

export function useUpdateTeam(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, data }: { teamId: string; data: TeamUpdate }) =>
      updateTeam(slug, teamId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.list(slug) });
    },
  });
}

export function useDeactivateTeam(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (teamId: string) => deactivateTeam(slug, teamId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.list(slug) });
    },
  });
}

// Callers pass memberName + teamName so the success toast can be informative
// without a second fetch. Both fields already exist in the component state
// that triggered the mutation (dialog picks them from props and selections).
export function useAddTeamMember(slug: string) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: ({
      teamId,
      data,
    }: {
      teamId: string;
      data: TeamMemberAdd;
      memberName?: string;
      teamName?: string;
    }) => addTeamMember(slug, teamId, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.list(slug) });
      if (variables.memberName && variables.teamName) {
        toast.success(
          t("agents.teamMemberAdded", {
            name: variables.memberName,
            team: variables.teamName,
          }),
        );
      }
    },
  });
}

export function useRemoveTeamMember(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, agentId }: { teamId: string; agentId: string }) =>
      removeTeamMember(slug, teamId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.list(slug) });
    },
  });
}
