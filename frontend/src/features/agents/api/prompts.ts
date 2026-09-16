// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

export interface PromptStageDefault {
  slug: string;
  role: string;
  stage: string;
  description: string;
  template_variables: string[];
  default_content: string;
}

// Mirrors backend ValidationError shape; severity is "warning" for the
// non-blocking context-source ↔ prompt wiring findings.
export interface ContextSourceWarning {
  code: string;
  field: string;
  message: string;
  value?: unknown;
  params?: Record<string, unknown>;
  severity: string;
}

export interface PromptConfig {
  id: string;
  name: string;
  slug: string;
  agent_type: string | null;
  team_role: string | null;
  stage: string;
  content: string;
  is_system: boolean;
  workspace_id: string | null;
  team_id: string | null;
  version: number;
  created_by_id: string;
  created_at: string;
  updated_at: string;
  context_source_warnings?: ContextSourceWarning[];
}

export interface PromptConfigCreate {
  name: string;
  slug: string;
  team_role?: string;
  stage: string;
  content: string;
  team_id?: string;
}

export interface PromptConfigUpdate {
  content?: string;
  name?: string;
}

export async function fetchPromptDefaults(slug: string, role?: string) {
  const params = role ? { role } : undefined;
  const { data } = await api.get<PromptStageDefault[]>(
    `/workspaces/${slug}/prompt-configs/defaults`,
    { params },
  );
  return data;
}

export async function fetchPromptConfigs(slug: string, teamRole?: string) {
  const params = teamRole ? { team_role: teamRole } : undefined;
  const { data } = await api.get<PromptConfig[]>(
    `/workspaces/${slug}/prompt-configs`,
    { params },
  );
  return data;
}

export async function createPromptConfig(
  slug: string,
  payload: PromptConfigCreate,
) {
  const { data } = await api.post<PromptConfig>(
    `/workspaces/${slug}/prompt-configs`,
    payload,
  );
  return data;
}

export async function updatePromptConfig(
  slug: string,
  configId: string,
  payload: PromptConfigUpdate,
) {
  const { data } = await api.patch<PromptConfig>(
    `/workspaces/${slug}/prompt-configs/${configId}`,
    payload,
  );
  return data;
}

export async function deletePromptConfig(slug: string, configId: string) {
  await api.delete(`/workspaces/${slug}/prompt-configs/${configId}`);
}
