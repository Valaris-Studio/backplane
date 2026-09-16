// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { authKeys } from "@/lib/query-keys";
import { setLoginAvailable } from "../redirect-to-login";

export interface AuthModes {
  oidc_enabled: boolean;
  password_enabled: boolean;
  dev_mode: boolean;
  login_path: string;
  logout_path: string;
}

// The only auth endpoint a signed-out browser may read — it tells the SPA
// whether to offer a login button at all. Deployments behind IAP or an
// authenticating proxy report `oidc_enabled: false`: there the proxy handles
// sign-in upstream and the SPA never sees a logged-out state.
export function useAuthModes() {
  return useQuery<AuthModes>({
    queryKey: authKeys.modes(),
    queryFn: async () => {
      const { data } = await api.get<AuthModes>("/auth/modes");
      // Publish to the axios interceptor, which runs outside React.
      setLoginAvailable(data.oidc_enabled || data.password_enabled);
      return data;
    },
    staleTime: Infinity, // deployment config; changes only on a redeploy
    retry: false,
  });
}
