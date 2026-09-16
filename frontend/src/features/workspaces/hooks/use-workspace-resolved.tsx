// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext, type ReactNode } from "react";

// WorkspaceLayout gates the PAGE on the workspace resolving, but the AppShell
// chrome renders OUTSIDE that gate (by design — the operator keeps navigation
// on the not-found screen). Its workspace-scoped badges would still fan out
// against a slug that does not exist, which is exactly the 404 noise the gate
// exists to remove, and no page-level assertion can see it.
//
// So the gate publishes its verdict and the chrome reads it. Default `false`:
// a badge rendered with no provider above it (a unit test, a future route
// outside the gate) stays quiet rather than fetching against an unverified
// slug. Fail closed — a missing badge is invisible, a 404 storm is not.
const WorkspaceResolvedContext = createContext(false);

export function WorkspaceResolvedProvider({
  resolved,
  children,
}: {
  resolved: boolean;
  children: ReactNode;
}) {
  return (
    <WorkspaceResolvedContext.Provider value={resolved}>
      {children}
    </WorkspaceResolvedContext.Provider>
  );
}

export function useWorkspaceResolved(): boolean {
  return useContext(WorkspaceResolvedContext);
}

/**
 * The slug the chrome may safely query with: the route's slug once the
 * workspace behind it resolved, `undefined` until then. Badges already treat
 * an absent slug as "nothing to show", so they need no other change.
 */
export function useResolvedWorkspaceSlug(routeSlug: string | undefined) {
  return useWorkspaceResolved() ? routeSlug : undefined;
}
