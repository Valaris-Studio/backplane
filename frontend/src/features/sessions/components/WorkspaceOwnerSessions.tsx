// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ownerSessionKeys, workspaceKeys } from "@/lib/query-keys";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useWorkspace } from "@/features/workspaces/api/use-workspace";
import { useCompanionEnabled } from "../api/use-sessions";
import { ownerSessionAccessLost, useOwnerSessionList, useOwnerSessionWorkspaceInventory } from "../api/use-owner-sessions";
import { useOwnerSessionSnapshot } from "../hooks/use-owner-session-snapshot";
import { projectOwnerSession } from "../owner-session-authority";
import { OwnerSessionCompactRow } from "./OwnerSessionCompactRow";
import { OwnerSessionPreview } from "./OwnerSessionPreview";

const WORKSPACE_SESSION_PAGE_SIZE = 40;

export function WorkspaceOwnerSessions({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const enabled = useCompanionEnabled();
  const workspace = useWorkspace(slug);
  const inventory = useOwnerSessionWorkspaceInventory();
  const me = useCurrentUser();
  const list = useOwnerSessionList(
    // Keep the live preview independent of the global view's retained pages.
    { workspace_id: workspace.data?.id, root_only: true, sort: "recent", limit: WORKSPACE_SESSION_PAGE_SIZE },
    enabled === true && workspace.isSuccess && me.isSuccess,
  );
  const accessDenied = list.ownerScope === "denied" || ownerSessionAccessLost(list.error)
    || ownerSessionAccessLost(workspace.error) || ownerSessionAccessLost(inventory?.error);
  const denied = accessDenied || list.data?.pages.length === 0;
  const workspaceInventory = useMemo(() => inventory?.data ? {
    ids: new Set(inventory.data.map((item) => item.id)), updatedAt: inventory.dataUpdatedAt,
  } : undefined, [inventory?.data, inventory?.dataUpdatedAt]);
  const metadataRequestedAt = list.data?.pages[0]?.authorizationRequestedAt;
  const rows = denied || !enabled ? [] : (list.data?.pages[0]?.items ?? [])
    .flatMap((session) => {
      if (session.workspace_id !== workspace.data?.id) return [];
      const projected = projectOwnerSession({ session, requestedAt: metadataRequestedAt ?? 0 }, workspaceInventory);
      return projected ? [projected.session] : [];
    });
  const snapshot = useOwnerSessionSnapshot(
    `workspace-owner-sessions:${list.ownerScope}:${workspace.data?.id ?? slug}`,
    rows,
    1,
    denied || enabled === false || !!list.data?.pages.length,
    {
      ownerId: list.ownerScope,
      complete: !list.hasNextPage,
      denied: denied || enabled === false,
      metadataRequestedAt, workspaceInventory,
    },
  );
  useEffect(() => {
    if (!ownerSessionAccessLost(workspace.error) || !workspace.data) return;
    const queryKey = [...ownerSessionKeys.list({
      workspace_id: workspace.data.id, root_only: true, sort: "recent", limit: WORKSPACE_SESSION_PAGE_SIZE,
    }), list.ownerScope];
    // The disabled list can retain a successful response after workspace loss.
    // Clear it before an outage or local refresh can adopt it again, and require
    // a fresh request when successful workspace authorization enables the list.
    void client.cancelQueries({ queryKey, exact: true });
    client.setQueryData(queryKey, { pages: [], pageParams: [] });
    void client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
  }, [client, list.ownerScope, workspace.data, workspace.error]);
  if (!enabled) return null;

  const loading = workspace.isPending || me.isPending || list.isPending;
  const failed = workspace.isError || me.isError || list.isError || inventory?.status === "error";
  const retrying = list.isFetching || workspace.isFetching || me.isFetching || inventory?.fetchStatus === "fetching";
  const retry = () => {
    if (workspace.isError) void workspace.refetch();
    else if (me.isError) void me.refetch();
    else if (inventory?.status === "error") void client.refetchQueries({ queryKey: workspaceKeys.all, exact: true });
    else void list.refetch();
  };

  return (
    <OwnerSessionPreview viewAllHref={workspace.data ? `/-/sessions?workspace_id=${encodeURIComponent(workspace.data.id)}` : undefined}>
      {denied || (failed && !rows.length) ? <div role="alert" aria-busy={retrying} className="flex flex-wrap items-center gap-3 text-sm">
        <p>{t(accessDenied || !failed ? "sessions.discovery.accessLost" : "sessions.discovery.loadError")}</p>
        <Button variant="outline" size="sm" onClick={retry} disabled={retrying}>{t(retrying ? "common.loading" : "sessions.loadError.retry")}</Button>
      </div> : loading ? <div className="space-y-1.5" aria-busy="true"><Skeleton className="h-14" /><Skeleton className="h-14" /></div> : <>
        {failed ? <p role="status" className="text-xs text-muted-foreground">{t("sessions.discovery.staleError")}</p> : null}
        {snapshot.refreshAvailable ? <div className="flex flex-wrap items-center gap-2 text-xs">
          <span role="status">{t("sessions.discovery.refreshAvailable")}</span>
          <Button variant="outline" size="sm" onClick={snapshot.showLatest}><RefreshCw className="size-3.5" aria-hidden />{t("sessions.discovery.showLatest")}</Button>
        </div> : null}
        {snapshot.shown.length ? <ul className="divide-y divide-border/70 overflow-hidden rounded-[var(--radius-lg)] border border-border/70 bg-[color:var(--color-surface-1)]">
          {snapshot.shown.slice(0, 5).map((session) => <OwnerSessionCompactRow key={session.id} session={session} />)}
        </ul> : <p className="text-xs text-muted-foreground">{t("sessions.discovery.empty")}</p>}
      </>}
    </OwnerSessionPreview>
  );
}
