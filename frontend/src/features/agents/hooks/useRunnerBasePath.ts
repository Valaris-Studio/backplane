// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";

interface RunnerBasePath {
  base: string;
  overview: string;
  /** Detail-route builders resolving to the runner console. */
  runnerDetail: (agentId: string) => string;
  executionDetail: (executionId: string) => string;
  pipeline: string;
  prompts: string;
  roles: string;
  runnersList: string;
  activity: string;
}

// Runner cross-link builder. The legacy /:slug/agents surface is retired (it now
// redirects into the console), so every link resolves to the /:slug/runner
// console. Roles fold into the Pipeline tab; prompts keep their standalone page
// (deep-linkable with ?role[&stage]). Kept as a hook (not bare constants) so
// call sites stay unchanged and slug comes from the route.
export function useRunnerBasePath(): RunnerBasePath {
  const { slug = "" } = useParams();
  const base = `/${slug}/runner`;
  return {
    base,
    overview: `${base}/overview`,
    runnerDetail: (agentId: string) => `${base}/runners/${agentId}`,
    executionDetail: (executionId: string) => `${base}/executions/${executionId}`,
    pipeline: `${base}/pipeline`,
    prompts: `${base}/prompts`,
    roles: `${base}/pipeline`,
    runnersList: `${base}/runners`,
    activity: `${base}/activity`,
  };
}
