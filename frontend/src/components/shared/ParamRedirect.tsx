// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * Redirect that interpolates route params into the target AND preserves the
 * query string. Plain `<Navigate to>` can't reference `:slug`/`:agentId` and
 * drops `?role=&stage=` deep-link params. Used to point retired legacy routes at
 * their console equivalents (e.g. `/:slug/agents/:agentId` →
 * `/:slug/runner/runners/:agentId`, `/:slug/agents/prompts?role=…` →
 * `/:slug/runner/prompts?role=…`).
 */
export function ParamRedirect({ to }: { to: (params: Record<string, string | undefined>) => string }) {
  const params = useParams();
  const { search } = useLocation();
  return <Navigate to={{ pathname: to(params), search }} replace />;
}
