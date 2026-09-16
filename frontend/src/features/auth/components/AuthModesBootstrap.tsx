// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthModes } from "../api/use-auth-modes";

// Mounted once at the App level so the auth-modes query runs on EVERY page,
// not just the ones that render a login/sign-out control. The axios
// interceptor's redirect-to-login flag is published from this query's fetch —
// without an app-wide mount, a signed-out visit to "/" never learns a login
// exists and strands the user on an erroring page (found by the card-9
// acceptance run).
export function AuthModesBootstrap() {
  const { data: modes } = useAuthModes();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!modes || !(modes.oidc_enabled || modes.password_enabled)) return;
    // Queries that 401/403'd before the modes answer arrived never triggered
    // the redirect (the flag was still false). Re-run them once so their
    // rejection re-enters the interceptor with the flag set.
    void queryClient.refetchQueries({
      type: "active",
      predicate: (query) => query.state.status === "error",
    });
  }, [modes, queryClient]);

  return null;
}
