// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useResumeCostBreaker(slug: string | undefined) {
  return useMutation({
    mutationFn: async () => {
      if (!slug) throw new Error("workspace slug required");
      const { data } = await api.post<{ status: string; workspace_id: string }>(
        `/workspaces/${slug}/cost-breaker/resume`,
      );
      return data;
    },
  });
}
