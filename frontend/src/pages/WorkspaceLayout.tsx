// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Outlet, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { RouteFallback } from "@/components/layout/RouteFallback";
import { useWorkspace } from "@/features/workspaces/api/use-workspace";
import { WorkspaceResolvedProvider } from "@/features/workspaces/hooks/use-workspace-resolved";
import { WorkspaceNotFoundPage } from "./WorkspaceNotFoundPage";

// Gates every /:slug/* route on the workspace actually resolving. Without it a
// mistyped slug mounted the full dashboard, whose dozen child queries each
// 404'd (and each retried) against a workspace that does not exist — a broken-
// looking page and a console full of red, with nothing saying what was wrong.
//
// Same shape as SetupGate and BP-005's board-definition gate: resolve the
// parent, then render exactly one of pending / not-found / children.
//
// It OWNS the AppShell rather than nesting inside it, for one reason: the
// chrome must stay on screen through all three states (the operator keeps
// navigation on the not-found page) while its workspace-scoped badges must NOT
// query an unresolved slug. Owning the shell is what lets the resolution
// context cover both the chrome and the page from a single decision point.
export function WorkspaceLayout() {
  const { slug } = useParams<{ slug: string }>();
  const { data, isError } = useWorkspace(slug);

  return (
    <WorkspaceResolvedProvider resolved={Boolean(data)}>
      <AppShell>
        {isError ? (
          <WorkspaceNotFoundPage />
        ) : data ? (
          <Outlet />
        ) : (
          <RouteFallback />
        )}
      </AppShell>
    </WorkspaceResolvedProvider>
  );
}
