// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { RunnerConsoleOverview } from "@/features/agents/components/RunnerConsoleOverview";

// Runner Console → Overview tab. A thin slug-resolving wrapper around the
// curated console overview (distinct from the full legacy /agents dashboard,
// which stays mounted at WorkspaceAgentsPage).
export function RunnerOverviewTab({ slug: slugProp }: { slug?: string } = {}) {
  const params = useParams();
  const slug = slugProp ?? params.slug ?? "";
  return <RunnerConsoleOverview slug={slug} />;
}
