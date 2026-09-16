// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useDomainSync } from "@/hooks/useDomainSync";
import { agentKeys, teamKeys, promptKeys } from "@/lib/query-keys";

export function useConfigSync(slug: string) {
  useDomainSync("config", agentKeys.list());
  useDomainSync("config", teamKeys.list(slug));
  useDomainSync("config", promptKeys.list(slug));
}
