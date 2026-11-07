// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigationType } from "react-router-dom";
import { ArrowLeft, RefreshCw, Search } from "lucide-react";
import { ContextLink } from "@/components/shared/ContextLink";
import { AccountMenu } from "@/components/layout/AccountMenu";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import { useBoards } from "@/features/kanban/api/use-boards";
import type { SessionStatus } from "@/types/agent-session";
import { useCompanionEnabled } from "../api/use-sessions";
import { listInventoryFreshness, OWNER_SESSION_LIST_READING_SLOT, ownerSessionAccessLost, ownerSessionListScope, useOwnerSessionList } from "../api/use-owner-sessions";
import { OWNER_SESSION_STATES, useOwnerSessionFilters } from "../hooks/use-owner-session-filters";
import { useOwnerSessionSnapshot } from "../hooks/use-owner-session-snapshot";
import { projectOwnerSession } from "../owner-session-authority";
import { OwnerSessionRow } from "./OwnerSessionRow";

function localDateTime(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function GlobalSessionsPage() {
  const { t } = useTranslation();
  const enabled = useCompanionEnabled();
  const location = useLocation();
  const navigationType = useNavigationType();
  const me = useCurrentUser();
  // Membership keeps refreshing even after more pages stop the list's own poll.
  const workspaces = useWorkspaces(enabled === true && me.isSuccess ? listInventoryFreshness : undefined);
  const { query, update, clear, harnessValid } = useOwnerSessionFilters();
  const selectedWorkspace = workspaces.data?.find((workspace) => workspace.id === query.workspace_id);
  const boards = useBoards(selectedWorkspace?.slug ?? "", { enabled: enabled === true && !!selectedWorkspace });
  const list = useOwnerSessionList(
    query, enabled === true && me.isSuccess && workspaces.isSuccess && harnessValid,
    navigationType === "POP" ? location.key : undefined,
  );
  const accessDenied = list.ownerScope === "denied"
    || ownerSessionAccessLost(list.error) || ownerSessionAccessLost(workspaces.error);
  const denied = accessDenied || list.data?.pages.length === 0;
  const workspaceInventory = useMemo(() => workspaces.data ? {
    ids: new Set(workspaces.data.map((workspace) => workspace.id)), updatedAt: workspaces.dataUpdatedAt,
  } : undefined, [workspaces.data, workspaces.dataUpdatedAt]);
  const metadataRequestTimes = useMemo(() => new Map(list.data?.pages.flatMap((page) =>
    page.items.map((session) => [session.id, page.authorizationRequestedAt] as const))), [list.data]);
  const loaded = useMemo(() => {
    if (denied || !enabled) return [];
    const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
    return [...new Map(rows.flatMap((session) => {
      const projected = projectOwnerSession({ session, requestedAt: metadataRequestTimes.get(session.id) ?? 0 }, workspaceInventory);
      return projected ? [[session.id, projected.session] as const] : [];
    })).values()];
  }, [denied, enabled, list.data, metadataRequestTimes, workspaceInventory]);
  const harnesses = [...new Map(loaded.map((session) => [session.harness, session.harness_display_name])).entries()];
  const selectedBoardName = loaded.find((session) => session.board_id === query.board_id)?.board_name;
  const scope = ownerSessionListScope(query, list.ownerScope);
  const snapshot = useOwnerSessionSnapshot(
    scope, loaded, list.data?.pages.length ?? 0,
    enabled === false || denied || (!!list.data?.pages.length && workspaces.data !== undefined),
    {
      ownerId: list.ownerScope,
      viewSlot: OWNER_SESSION_LIST_READING_SLOT,
      complete: !list.hasNextPage,
      denied: denied || enabled === false,
      preserveOrder: list.restorePending && !denied,
      restoredWindow: list.restoredWindow,
      workspaceInventory, metadataRequestTimes,
    },
  );
  // A first arrival staged behind Show latest does not make the list empty.
  const incoming = loaded.some((session) => !snapshot.shown.some((row) => row.id === session.id));
  const loading = enabled === undefined || (enabled && (me.isPending || (me.isSuccess && (workspaces.isPending || (workspaces.isSuccess && harnessValid && list.isPending)))));
  const failed = list.isError || me.isError || workspaces.isError;
  const retrying = list.fetchStatus !== "idle" || me.fetchStatus !== "idle" || workspaces.fetchStatus !== "idle";
  // Neutral failure UI survives reauthorization; session data remains owner-scoped.
  const retryScope = JSON.stringify(query);
  const [failure, setFailure] = useState<{ scope: string; accessDenied: boolean } | null>(null);
  const failedWithoutRows = denied || (failed && !loaded.length);
  useEffect(() => {
    if (failedWithoutRows) setFailure({ scope: retryScope, accessDenied: accessDenied || !failed });
    else if (!retrying) setFailure(null);
  }, [failedWithoutRows, retryScope, accessDenied, failed, retrying]);
  // React Query clears an initial error while retrying; retain its neutral
  // explanation and focus target until this view's request settles.
  const heldFailure = retrying && failure?.scope === retryScope ? failure : null;
  const showFailure = failedWithoutRows || !!heldFailure;
  const shownAccessDenied = heldFailure ? heldFailure.accessDenied : accessDenied || !failed;
  const heading = useRef<HTMLHeadingElement>(null);
  const retryButton = useRef<HTMLButtonElement | null>(null);
  const restoreRetryFocus = useRef<string | null>(null);
  const setRetryButton = useCallback((node: HTMLButtonElement | null) => {
    if (!node && retryButton.current === document.activeElement) restoreRetryFocus.current = retryScope;
    retryButton.current = node;
  }, [retryScope]);
  useLayoutEffect(() => {
    if (restoreRetryFocus.current === retryScope && !showFailure && !loading && enabled && harnessValid) {
      heading.current?.focus({ preventScroll: true });
    }
    restoreRetryFocus.current = null;
  });
  const activeFilters = !!(query.q || query.workspace_id || query.board_id || query.harness || query.status || query.state?.length || query.linked_only || query.since || !query.root_only);

  function retry() {
    if (!harnessValid || retrying) return;
    if (me.isError) void me.refetch();
    else if (workspaces.isError) void workspaces.refetch();
    else if (list.restorePending) list.retryRestoration();
    else void list.refetch();
  }

  return (
    <div className="relative min-h-screen px-4 py-6 md:px-6 lg:px-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <ContextLink to="/" aria-label={t("sessions.discovery.backHome")} className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><BrandLogo className="h-8 w-auto" /></ContextLink>
          <div className="flex items-center gap-2"><ThemeSwitcher /><LanguageSwitcher /><AccountMenu /></div>
        </header>
        <main className="space-y-5">
          <ContextLink to="/" className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft className="size-4" aria-hidden />{t("sessions.discovery.backHome")}</ContextLink>
          <div className="space-y-1"><h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">{t("sessions.discovery.allSessions")}</h1><p className="max-w-2xl text-sm text-muted-foreground">{t("sessions.discovery.description")}</p></div>
          {enabled ? <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden /><Input id="owner-session-search" value={query.q ?? ""} maxLength={100} onChange={(event) => update({ q: event.target.value })} aria-label={t("sessions.filters.search")} placeholder={t("sessions.filters.searchPlaceholder")} className="pl-9" /></div>
              <div className="min-w-44 space-y-1"><label htmlFor="owner-workspace-filter" className="text-xs text-muted-foreground">{t("sessions.discovery.workspace")}</label><Select value={query.workspace_id ?? ""} onValueChange={(value) => update({ workspace_id: value || undefined, board_id: undefined })}><SelectTrigger id="owner-workspace-filter"><SelectValue placeholder={t("sessions.discovery.allWorkspaces")}>{query.workspace_id ? selectedWorkspace?.name ?? t("sessions.discovery.workspaceUnavailable") : undefined}</SelectValue></SelectTrigger><SelectContent><SelectItem value="">{t("sessions.discovery.allWorkspaces")}</SelectItem>{workspaces.data?.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="min-w-36 space-y-1"><label htmlFor="owner-sort-filter" className="text-xs text-muted-foreground">{t("sessions.filters.sort")}</label><Select value={query.sort ?? "recent"} onValueChange={(value) => update({ sort: value === "started" ? "started" : "recent" })}><SelectTrigger id="owner-sort-filter"><SelectValue /></SelectTrigger><SelectContent>{(["recent", "started"] as const).map((sort) => <SelectItem key={sort} value={sort}>{t(`sessions.filters.sorts.${sort}`)}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <details open={!!(query.board_id || query.harness || query.status || query.state?.length || query.linked_only || query.since || !query.root_only)} className="rounded-[var(--radius-md)] border border-border/70 px-3 py-2">
              <summary className="cursor-pointer rounded-sm text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("sessions.filters.label")}</summary>
              <div className="mt-3 space-y-3">
                {query.board_id && !selectedWorkspace ? <p className="text-sm text-muted-foreground">{t("sessions.discovery.board")}: {selectedBoardName ?? t("sessions.discovery.boardUnavailable")}</p> : null}
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {selectedWorkspace ? <div className="space-y-1"><label htmlFor="owner-board-filter" className="text-xs text-muted-foreground">{t("sessions.discovery.board")}</label><Select value={query.board_id ?? ""} onValueChange={(value) => update({ board_id: value || undefined })}><SelectTrigger id="owner-board-filter"><SelectValue placeholder={t("sessions.discovery.allBoards")}>{query.board_id ? boards.data?.find((board) => board.id === query.board_id)?.name ?? t("sessions.discovery.boardUnavailable") : undefined}</SelectValue></SelectTrigger><SelectContent><SelectItem value="">{t("sessions.discovery.allBoards")}</SelectItem>{boards.data?.map((board) => <SelectItem key={board.id} value={board.id}>{board.name}</SelectItem>)}</SelectContent></Select></div> : null}
                  <div className="space-y-1">
                    <label htmlFor="owner-harness-filter" className="text-xs text-muted-foreground">{t("sessions.discovery.harness")}</label>
                    <Input id="owner-harness-filter" list="owner-harness-options" value={query.harness ?? ""} placeholder={t("sessions.discovery.allHarnesses")} onChange={(event) => update({ harness: event.target.value || undefined })} aria-invalid={!harnessValid || undefined} aria-describedby={!harnessValid ? "owner-harness-format" : undefined} />
                    <datalist id="owner-harness-options">{harnesses.map(([harness, name]) => <option key={harness} value={harness}>{name}</option>)}</datalist>
                    {!harnessValid ? <p id="owner-harness-format" className="text-xs text-destructive">{t("sessions.discovery.harnessFormat")}</p> : null}
                  </div>
                  <div className="space-y-1"><label htmlFor="owner-status-filter" className="text-xs text-muted-foreground">{t("sessions.discovery.status")}</label><Select value={query.status ?? ""} onValueChange={(value) => update({ status: (value || undefined) as SessionStatus | undefined })}><SelectTrigger id="owner-status-filter"><SelectValue placeholder={t("sessions.discovery.allStatuses")} /></SelectTrigger><SelectContent><SelectItem value="">{t("sessions.discovery.allStatuses")}</SelectItem>{(["active", "idle", "ended"] as const).map((status) => <SelectItem key={status} value={status}>{t(`sessions.states.${status}`)}</SelectItem>)}</SelectContent></Select></div>
                  <div className="space-y-1"><label htmlFor="owner-since-filter" className="text-xs text-muted-foreground">{t("sessions.discovery.since")}</label><Input id="owner-since-filter" type="datetime-local" value={localDateTime(query.since)} onChange={(event) => update({ since: event.target.value ? new Date(event.target.value).toISOString() : undefined })} /></div>
                </div>
                <fieldset className="space-y-2"><legend className="text-xs text-muted-foreground">{t("sessions.filters.state")}</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{OWNER_SESSION_STATES.map((state) => <label key={state} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={query.state?.includes(state) ?? false} onChange={(event) => update({ state: event.target.checked ? [...(query.state ?? []), state] : query.state?.filter((value) => value !== state) })} className="size-4 accent-primary" />{t(`sessions.states.${state}`)}</label>)}</div></fieldset>
                <div className="flex flex-wrap gap-x-4 gap-y-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!query.linked_only} onChange={(event) => update({ linked_only: event.target.checked || undefined })} className="size-4 accent-primary" />{t("sessions.filters.linkedOnly")}</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!query.root_only} onChange={(event) => update({ root_only: !event.target.checked })} className="size-4 accent-primary" />{t("sessions.filters.showSubagents")}</label></div>
              </div>
            </details>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {activeFilters ? <Button variant="ghost" size="sm" onClick={clear}>{t("sessions.discovery.clearFilters")}</Button> : <span />}
              <div className="flex items-center gap-2">{snapshot.refreshAvailable ? <span role="status" className="text-xs text-muted-foreground">{t("sessions.discovery.refreshAvailable")}</span> : null}<Button variant="outline" size="sm" disabled={list.isFetching || !harnessValid} onClick={() => snapshot.refreshAvailable ? snapshot.showLatest() : retry()}><RefreshCw aria-hidden className="size-3.5" />{t(snapshot.refreshAvailable ? "sessions.discovery.showLatest" : "sessions.discovery.refresh")}</Button></div>
            </div>
          </div> : null}
          {list.restorePending && list.isFetching && !denied ? <p role="status" className="text-sm text-muted-foreground">{t("sessions.discovery.restoringPlace")}</p> : null}
          {loading && !heldFailure ? <div className="space-y-2" aria-busy="true">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-20" />)}</div>
            : !enabled ? <p className="py-6 text-sm text-muted-foreground">{t("sessions.discovery.captureOff")}</p>
            : !harnessValid ? null
            : showFailure ? <div role="alert" aria-busy={retrying} className="space-y-3"><p className="text-sm">{t(shownAccessDenied ? "sessions.discovery.accessLost" : "sessions.discovery.loadError")}</p><Button ref={setRetryButton} variant="outline" className="aria-disabled:opacity-45" onClick={retry} aria-disabled={retrying || undefined} aria-busy={retrying || undefined}>{t("sessions.loadError.retry")}</Button></div>
            : <>
              {failed ? <p role="status" className="text-sm text-muted-foreground">{t("sessions.discovery.staleError")}</p> : null}
              {snapshot.hasRetainedMetadata ? <p role="status" className="text-sm text-muted-foreground">{t("sessions.discovery.retainedMetadata")}</p> : null}
              {snapshot.placeUnavailable ? <p role="status" className="text-sm text-muted-foreground">{t("sessions.discovery.placeUnavailable")}</p> : null}
              {snapshot.shown.length ? <ul className="divide-y divide-border/70 overflow-hidden rounded-[var(--radius-lg)] border border-border/70 bg-[color:var(--color-surface-1)]">{snapshot.shown.map((session) => <OwnerSessionRow key={session.id} session={session} />)}</ul>
                : incoming ? null : <p className="py-6 text-sm text-muted-foreground">{t(activeFilters ? "sessions.noMatch.title" : "sessions.discovery.empty")}</p>}
              {list.hasNextPage ? <div className="flex justify-center"><Button variant="outline" disabled={list.isFetching || list.restorePending} onClick={() => void list.fetchNextPage()}>{t(list.isFetchingNextPage ? "sessions.list.loadingMore" : "sessions.list.loadMore")}</Button></div> : null}
            </>}
        </main>
      </div>
    </div>
  );
}
