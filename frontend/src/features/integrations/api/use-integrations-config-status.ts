// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { integrationsKeys } from "@/lib/query-keys";

export interface IntegrationsConfigStatus {
  github_oauth_configured: boolean;
  // PAT storage needs only the Fernet key (INTEGRATIONS_TOKEN_KEY), not an
  // OAuth app — gates "Add token" the way the flag above gates "Connect
  // GitHub".
  token_storage_configured: boolean;
}

// Used to gate the "Connect GitHub" button when the platform admin hasn't
// provisioned the OAuth env vars yet — clicking before this is configured
// 503s on the backend, which is contained but ugly. Long staleTime: this
// only changes on a backend redeploy.
export function useIntegrationsConfigStatus() {
  return useQuery({
    queryKey: integrationsKeys.configStatus,
    queryFn: async () => {
      const { data } = await api.get<IntegrationsConfigStatus>(
        "/integrations/config-status",
      );
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}
