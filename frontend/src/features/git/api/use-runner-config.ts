// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { runnerConfigKeys } from "@/lib/query-keys";

export interface RunnerConfig {
  runner_yaml: string;
  mcp_config_json: string;
  prerequisites: string[];
  prerequisite_messages?: Array<{
    code: string;
    params: Record<string, unknown>;
  }>;
}

// Fetched lazily — only when the operator opens the "Run this board" dialog,
// since it depends on the workspace pipeline_config + the board's git repos.
// `agentId`, when given, scopes the prerequisites to that existing runner: the
// backend drops the now-redundant "create an agent" / "team binding" steps the
// launch flow already performed.
export function useRunnerConfig(
  slug: string,
  boardId: string,
  enabled: boolean,
  agentId: string | null = null,
) {
  return useQuery({
    queryKey: runnerConfigKeys.byBoard(slug, boardId, agentId),
    enabled,
    queryFn: async () => {
      const { data } = await api.get<RunnerConfig>(
        `/workspaces/${slug}/boards/${boardId}/runner-config`,
        { params: agentId ? { agent_id: agentId } : undefined },
      );
      return data;
    },
  });
}
