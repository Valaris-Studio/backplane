// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

export type TeamRole = string;

export type RoleWarningReason = "not_in_pipeline";

export interface RoleWarning {
  role: string;
  reason: RoleWarningReason;
}

export interface TeamMemberRead {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  roles: TeamRole[];
  // Backend-computed warnings flagging roles that don't map to any
  // pipeline stage. Defaults to [] when all roles align.
  role_warnings: RoleWarning[];
  added_at: string;
}

export interface TeamRead {
  id: string;
  // Null until backfill migration runs in every environment.
  slug: string | null;
  name: string;
  description: string;
  workspace_id: string;
  board_id: string | null;
  created_by_id: string;
  is_active: boolean;
  members: TeamMemberRead[];
  created_at: string;
  updated_at: string;
}

export interface TeamCreate {
  name: string;
  description?: string;
  board_id?: string;
}

export interface TeamUpdate {
  name?: string;
  description?: string;
  board_id?: string | null;
  is_active?: boolean;
}

export interface TeamMemberAdd {
  agent_id: string;
  roles: TeamRole[];
}

export async function fetchTeams(slug: string, includeInactive = false) {
  const { data } = await api.get<TeamRead[]>(`/workspaces/${slug}/teams`, {
    params: { include_inactive: includeInactive },
  });
  return data;
}

export async function fetchTeam(slug: string, teamId: string) {
  const { data } = await api.get<TeamRead>(
    `/workspaces/${slug}/teams/${teamId}`,
  );
  return data;
}

export async function createTeam(slug: string, payload: TeamCreate) {
  const { data } = await api.post<TeamRead>(
    `/workspaces/${slug}/teams`,
    payload,
  );
  return data;
}

export async function updateTeam(
  slug: string,
  teamId: string,
  payload: TeamUpdate,
) {
  const { data } = await api.patch<TeamRead>(
    `/workspaces/${slug}/teams/${teamId}`,
    payload,
  );
  return data;
}

export async function deactivateTeam(slug: string, teamId: string) {
  const { data } = await api.delete<TeamRead>(
    `/workspaces/${slug}/teams/${teamId}`,
  );
  return data;
}

export async function addTeamMember(
  slug: string,
  teamId: string,
  payload: TeamMemberAdd,
) {
  const { data } = await api.post<TeamRead>(
    `/workspaces/${slug}/teams/${teamId}/members`,
    payload,
  );
  return data;
}

export async function removeTeamMember(
  slug: string,
  teamId: string,
  agentId: string,
) {
  const { data } = await api.delete<TeamRead>(
    `/workspaces/${slug}/teams/${teamId}/members/${agentId}`,
  );
  return data;
}
