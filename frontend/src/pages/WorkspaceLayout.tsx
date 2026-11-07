// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { RouteFallback } from "@/components/layout/RouteFallback";
import { useCompanionEnabled } from "@/features/sessions/api/use-sessions";
import { SessionRealtimeOwner } from "@/features/sessions/components/SessionRealtimeOwner";
import { revokeWorkspaceAccess, useWorkspace } from "@/features/workspaces/api/use-workspace";
import { WorkspaceResolvedProvider } from "@/features/workspaces/hooks/use-workspace-resolved";
import { useWebSocket, useWebSocketEvent } from "@/hooks/use-websocket";
import { meKeys, workspaceKeys } from "@/lib/query-keys";
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
  const companionEnabled = useCompanionEnabled() === true;
  const client = useQueryClient();
  const { status, onAccessRevoked } = useWebSocket();
  const previousStatus = useRef(status);
  const revoke = useCallback(() => {
    if (slug) revokeWorkspaceAccess(client, slug);
  }, [client, slug]);
  useEffect(() => onAccessRevoked?.(revoke), [onAccessRevoked, revoke]);
  useWebSocketEvent("activity.member.*", (event) => {
    const viewer = client.getQueryData<{ id: string }>(meKeys.me());
    const changes = event.payload.changes as Record<string, unknown> | undefined;
    if (viewer && (event.payload.entity_id === viewer.id || changes?.affected_user_id === viewer.id)
      && /removed|deleted|revoked/.test(event.event)) revoke();
  });
  useEffect(() => {
    if (slug && status === "connected" && previousStatus.current !== "connected" && data === null) {
      void client.invalidateQueries({ queryKey: workspaceKeys.bySlug(slug), exact: true });
    }
    previousStatus.current = status;
  }, [client, data, slug, status]);
  const unavailable = isError || data === null;

  return (
    <WorkspaceResolvedProvider resolved={Boolean(data) && !unavailable}>
      {slug && data && !isError && companionEnabled ? (
        <SessionRealtimeOwner key={slug} slug={slug} />
      ) : null}
      <AppShell>
        {unavailable ? (
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
