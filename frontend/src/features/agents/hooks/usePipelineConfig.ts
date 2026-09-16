// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { workspaceConfigKeys } from "@/lib/query-keys";
import { fetchWorkspaceConfig } from "../api/pipelineConfig";
import type { PipelineConfig, StageConfig } from "../api/pipelineConfig";

const ROLE_COLORS = [
  "border-blue-400/50 text-blue-600 dark:text-blue-400",
  "border-amber-400/50 text-amber-600 dark:text-amber-400",
  "border-purple-400/50 text-purple-600 dark:text-purple-400",
  "border-emerald-400/50 text-emerald-600 dark:text-emerald-400",
  "border-rose-400/50 text-rose-600 dark:text-rose-400",
  "border-cyan-400/50 text-cyan-600 dark:text-cyan-400",
  "border-orange-400/50 text-orange-600 dark:text-orange-400",
];

const ROLE_BG_COLORS = [
  "bg-blue-500/10",
  "bg-amber-500/10",
  "bg-purple-500/10",
  "bg-emerald-500/10",
  "bg-rose-500/10",
  "bg-cyan-500/10",
  "bg-orange-500/10",
];

// Hex mirrors of ROLE_COLORS (Tailwind *-400 shades) for consumers that need
// raw colors — e.g. recharts `fill`/`stroke` props that can't parse classes.
const ROLE_HEX_COLORS = [
  "#60a5fa", // blue-400
  "#fbbf24", // amber-400
  "#c084fc", // purple-400
  "#34d399", // emerald-400
  "#fb7185", // rose-400
  "#22d3ee", // cyan-400
  "#fb923c", // orange-400
];

export function usePipelineConfig(slug: string) {
  const query = useQuery({
    queryKey: workspaceConfigKeys.byWorkspace(slug),
    queryFn: () => fetchWorkspaceConfig(slug),
    staleTime: 5 * 60 * 1000,
    enabled: !!slug,
  });

  const pipelineConfig = query.data?.pipeline_config ?? null;

  const roles = useMemo(
    () => pipelineConfig?.stages.map((s) => s.role) ?? [],
    [pipelineConfig],
  );

  const stagesByRole = useMemo(() => {
    const map: Record<string, StageConfig> = {};
    for (const stage of pipelineConfig?.stages ?? []) {
      map[stage.role] = stage;
    }
    return map;
  }, [pipelineConfig]);

  const roleColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    roles.forEach((role, i) => {
      map[role] = ROLE_COLORS[i % ROLE_COLORS.length]!;
    });
    return map;
  }, [roles]);

  const roleBgColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    roles.forEach((role, i) => {
      map[role] = ROLE_BG_COLORS[i % ROLE_BG_COLORS.length]!;
    });
    return map;
  }, [roles]);

  const roleHexColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    roles.forEach((role, i) => {
      map[role] = ROLE_HEX_COLORS[i % ROLE_HEX_COLORS.length]!;
    });
    return map;
  }, [roles]);

  return {
    ...query,
    pipelineConfig,
    roles,
    stagesByRole,
    roleColorMap,
    roleBgColorMap,
    roleHexColorMap,
  };
}

export type { PipelineConfig, StageConfig };
