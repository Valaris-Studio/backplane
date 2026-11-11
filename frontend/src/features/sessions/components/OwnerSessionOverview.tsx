// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import type { OwnerSession } from "@/types/owner-session";
import { useCompanionEnabled } from "../api/use-sessions";
import { overviewInventoryFreshness, ownerSessionAccessLost, useOwnerSessionOverview } from "../api/use-owner-sessions";
import { useOwnerSessionSnapshot } from "../hooks/use-owner-session-snapshot";
import { projectOwnerSession } from "../owner-session-authority";
import { OwnerSessionCompactRow } from "./OwnerSessionCompactRow";
import { OwnerSessionPreview } from "./OwnerSessionPreview";

const HOME_SESSION_LIMIT = 3;

export function OwnerSessionOverview() {
  const { t } = useTranslation();
  const enabled = useCompanionEnabled();
  const me = useCurrentUser();
  // Inventory follows discovery's own polling; capture-off Home stays quiet.
  const workspaces = useWorkspaces(enabled === true && me.isSuccess ? overviewInventoryFreshness : undefined);
  const overview = useOwnerSessionOverview(enabled === true && me.isSuccess && workspaces.isSuccess);
  const accessDenied = overview.ownerScope === "denied"
    || ownerSessionAccessLost(overview.error) || ownerSessionAccessLost(workspaces.error);
  const denied = accessDenied || overview.data === null;
  const current = denied || !enabled ? null : overview.data;
  const workspaceInventory = useMemo(() => workspaces.data ? {
    ids: new Set(workspaces.data.map((workspace) => workspace.id)), updatedAt: workspaces.dataUpdatedAt,
  } : undefined, [workspaces.data, workspaces.dataUpdatedAt]);
  const sessions = useMemo(() => {
    const authorized = (items: NonNullable<typeof current>["active"] | undefined) => (items ?? []).flatMap((session) => {
      const projected = projectOwnerSession({ session, requestedAt: current?.authorizationRequestedAt ?? 0 }, workspaceInventory);
      return projected ? [projected.session] : [];
    });
    const byId = new Map<string, OwnerSession>();
    for (const session of [...authorized(current?.active), ...authorized(current?.recent)]) {
      const known = byId.get(session.id);
      if (!known || Date.parse(session.last_event_at) > Date.parse(known.last_event_at)) byId.set(session.id, session);
    }
    const all = [...byId.values()];
    const latest = [...all].sort((left, right) => Date.parse(right.last_event_at) - Date.parse(left.last_event_at)).slice(0, HOME_SESSION_LIMIT);
    return { all, latest };
  }, [current, workspaceInventory]);
  // The null written during a denial is a purge marker, not an empty success.
  const resolved = enabled === false || denied || (overview.data != null && workspaces.data !== undefined);
  // Positions belong to the reading view; metadata from both groups lets a
  // shown capture that just ended stay in place with its honest current status.
  // A row missing from both groups is gone once the group it was last known in
  // is complete, so a Live claim never outlives a complete Active result.
  const latest = useOwnerSessionSnapshot(`owner-overview:${overview.ownerScope}:latest`, sessions.latest, 1, resolved, {
    ownerId: overview.ownerScope,
    metadata: sessions.all,
    denied: denied || enabled === false,
    workspaceInventory, metadataRequestedAt: current?.authorizationRequestedAt,
    complete: (session) => session.display_state === "active" ? !current?.active_more : !current?.recent_more,
  });
  // Rows staged behind Show latest are not shown yet, but Home is not empty.
  const incoming = sessions.latest.some((session) => !latest.shown.some((row) => row.id === session.id));
  const loading = enabled === undefined || (enabled && (me.isPending || (me.isSuccess && (workspaces.isPending || (workspaces.isSuccess && overview.isPending)))));
  const failed = overview.isError || me.isError || workspaces.isError;
  const retrying = overview.isFetching || me.isFetching || workspaces.isFetching;

  function retry() {
    if (me.isError) void me.refetch();
    else if (workspaces.isError) void workspaces.refetch();
    else void overview.refetch();
  }

  return (
    <OwnerSessionPreview viewAllHref={enabled ? "/-/sessions" : undefined}>
      {loading ? <div className="space-y-1.5" aria-busy="true"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
        : !enabled ? <p className="text-xs text-muted-foreground">{t("sessions.discovery.captureOff")}</p>
        : denied || (failed && !current) ? <div role="alert" aria-busy={retrying} className="flex flex-wrap items-center gap-3 text-sm"><p>{t(accessDenied || !failed ? "sessions.discovery.accessLost" : "sessions.discovery.loadError")}</p><Button variant="outline" size="sm" onClick={retry} disabled={retrying}>{t(retrying ? "common.loading" : "sessions.loadError.retry")}</Button></div>
        : <>
          {failed ? <p role="status" className="text-xs text-muted-foreground">{t("sessions.discovery.staleError")}</p> : null}
          {latest.refreshAvailable ? <div className="flex flex-wrap items-center gap-2 text-xs"><span role="status">{t("sessions.discovery.refreshAvailable")}</span><Button variant="outline" size="sm" onClick={latest.showLatest}><RefreshCw className="size-3.5" aria-hidden />{t("sessions.discovery.showLatest")}</Button></div> : null}
          {latest.hasRetainedMetadata ? <p role="status" className="text-xs text-muted-foreground">{t("sessions.discovery.retainedMetadata")}</p> : null}
          {latest.shown.length ? <ul className="divide-y divide-border/70 overflow-hidden rounded-[var(--radius-lg)] border border-border/70 bg-[color:var(--color-surface-1)]">{latest.shown.map((session) => <OwnerSessionCompactRow key={session.id} session={session} />)}</ul>
            : incoming ? null : <p className="text-xs text-muted-foreground">{t("sessions.discovery.empty")}</p>}
        </>}
    </OwnerSessionPreview>
  );
}
