// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { platformConfigKeys } from "@/lib/query-keys";
import type { LifecycleKindName, LifecycleKindSchema } from "./pipelineConfig";

// Raw operator knowledge from the backend. Known kinds resolve localized copy
// in the UI; these fields remain the forward-compatible fallback for a kind a
// newer backend exposes before this frontend knows its catalog keys.
export interface LifecycleKindDoc {
  summary: string;
  when_to_use: string;
  gotcha?: string;
}

// Wire shape of GET /api/config/lifecycle-kinds. The backend wraps the
// closed registry in a `kinds` envelope so we can grow sibling metadata
// without breaking older clients; `docs` is that sibling metadata — the
// human explanation of each kind, keyed by the same names.
export interface LifecycleKindsResponse {
  kinds: Record<LifecycleKindName, LifecycleKindSchema>;
  docs: Record<LifecycleKindName, LifecycleKindDoc>;
}

export async function fetchLifecycleKinds(): Promise<LifecycleKindsResponse> {
  const { data } = await api.get<LifecycleKindsResponse>("/config/lifecycle-kinds");
  return data;
}

export function useLifecycleKinds() {
  return useQuery({
    queryKey: platformConfigKeys.lifecycleKinds(),
    queryFn: fetchLifecycleKinds,
    // Closed set, runner-deploy bound — cache aggressively. A new kind
    // landing while the tab is open is rare enough that a manual reload
    // is acceptable.
    staleTime: 60 * 60 * 1000,
  });
}
