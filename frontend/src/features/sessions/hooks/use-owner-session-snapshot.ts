// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { meKeys, ownerSessionKeys } from "@/lib/query-keys";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { CurrentUser } from "@/features/notifications/api/use-current-user";
import type { OwnerSession } from "@/types/owner-session";
import { projectOwnerSession, type OwnerSessionEvidence, type OwnerSessionWorkspaceInventory } from "../owner-session-authority";

export interface OwnerSessionReadingOrder {
  scope: string;
  ids: string[];
  pageCount: number;
  initialized: boolean;
}

interface SnapshotOptions {
  ownerId?: string;
  viewSlot?: string;
  complete?: boolean | ((session: OwnerSession) => boolean);
  denied?: boolean;
  preserveOrder?: boolean;
  restoredWindow?: boolean;
  metadata?: OwnerSession[];
  metadataRequestedAt?: number;
  metadataRequestTimes?: ReadonlyMap<string, number>;
  workspaceInventory?: OwnerSessionWorkspaceInventory;
}

interface ReadingState {
  viewKey: string;
  order: OwnerSessionReadingOrder;
  missingIds: string[];
}

const MAX_READING_ENTRIES = 20;
const sameIds = (left: string[], right: string[]) => left.length === right.length
  && left.every((id, index) => id === right[index]);

export function useOwnerSessionSnapshot(
  scope: string, current: OwnerSession[], pageCount = 1, resolved = true, options: SnapshotOptions = {},
) {
  const navigation = useReturnNavigation();
  const { key: viewKey } = useLocation();
  const client = useQueryClient();
  const owner = options.ownerId ?? client.getQueryData<CurrentUser>(meKeys.me())?.id ?? "pending";
  const viewSlot = options.viewSlot ?? scope;
  const queryKey = useMemo(() => ownerSessionKeys.reading(viewKey, scope, owner), [viewKey, scope, owner]);
  // Only metadata stays in Query. The A01 snapshot below contains IDs and
  // counts, so cache collection cannot smuggle an old body or cursor back.
  const reading = useQuery<OwnerSessionEvidence[]>({ queryKey, queryFn: skipToken });
  const initial = (): ReadingState => {
    const saved = navigation?.readView<OwnerSessionReadingOrder>(viewSlot);
    return {
      viewKey,
      order: saved?.scope === scope ? saved : { scope, ids: [], pageCount: 0, initialized: false },
      missingIds: [],
    };
  };
  const [retained, setRetained] = useState(initial);
  let state = retained.viewKey === viewKey && retained.order.scope === scope ? retained : initial();
  const ids = current.map((session) => session.id);
  const metadata = options.metadata ?? current;
  const complete = options.complete ?? true;
  const currentEvidence = useMemo(() => metadata.map((session) => ({
    session, requestedAt: options.metadataRequestTimes?.get(session.id) ?? options.metadataRequestedAt ?? 0,
  })), [metadata, options.metadataRequestTimes, options.metadataRequestedAt]);
  const byId = new Map<string, OwnerSessionEvidence>();
  if (!options.denied) {
    const currentIds = new Set(metadata.map((session) => session.id));
    for (const evidence of [...(reading.data ?? []), ...currentEvidence]) {
      const projected = projectOwnerSession(evidence, options.workspaceInventory);
      if (!projected) continue;
      // Absence from a bounded page is not revocation. A complete result is
      // authoritative; a Home row returned in the other group is still known.
      const omissionIsFinal = typeof complete === "function" ? complete(projected.session) : complete;
      if (resolved && omissionIsFinal && !currentIds.has(projected.session.id)) continue;
      const previous = byId.get(projected.session.id);
      if (!previous || projected.requestedAt >= previous.requestedAt) byId.set(projected.session.id, projected);
    }
  }
  if (resolved && (!options.preserveOrder || options.denied)) {
    const order = state.order;
    // A denial ends this reading window. The next authorized response is a
    // fresh first result, rather than an arrival staged behind Show latest.
    const initialized = !options.denied;
    const nextPageCount = options.denied ? 0 : pageCount;
    const retainedIds = order.ids.filter((id) => byId.has(id));
    const nextIds = options.denied ? [] : !order.initialized ? ids : pageCount > order.pageCount
      ? [...retainedIds, ...ids.filter((id) => !retainedIds.includes(id))]
      : retainedIds;
    const missingIds = options.denied ? [] : [...new Set([
      ...state.missingIds,
      ...(options.restoredWindow ? order.ids.filter((id) => !byId.has(id)) : []),
    ])].filter((id) => !byId.has(id));
    if (initialized !== order.initialized || nextPageCount !== order.pageCount || !sameIds(nextIds, order.ids)
      || !sameIds(missingIds, state.missingIds)) {
      state = { viewKey, order: { scope, ids: nextIds, pageCount: nextPageCount, initialized }, missingIds };
    }
  }
  if (state !== retained) setRetained(state);
  const shownEvidence = state.order.ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const shown = shownEvidence.map(({ session }) => session);
  const refreshAvailable = resolved && !options.preserveOrder
    && !sameIds(shown.map((session) => session.id), ids);
  const hasRetainedMetadata = shown.some((session) => !ids.includes(session.id));

  useEffect(() => {
    if (resolved && (!options.preserveOrder || options.denied)) navigation?.writeView(viewSlot, state.order);
  }, [navigation, viewSlot, state.order, resolved, options.preserveOrder, options.denied]);
  useEffect(() => {
    if (!resolved) return;
    client.setQueryData<OwnerSessionEvidence[]>(queryKey, (previous) => previous?.length === shownEvidence.length
      && previous.every((evidence, index) => evidence === shownEvidence[index]) ? previous : shownEvidence);
    const entries = client.getQueryCache().findAll({
      queryKey: ownerSessionKeys.all,
      predicate: (query) => query.queryKey[1] === "reading" && query.queryKey.at(-1) === owner,
    }).sort((left, right) => left.state.dataUpdatedAt - right.state.dataUpdatedAt);
    let excess = entries.length - MAX_READING_ENTRIES;
    for (const entry of entries) {
      if (excess <= 0) break;
      if (!entry.getObserversCount()) {
        client.removeQueries({ queryKey: entry.queryKey, exact: true });
        excess -= 1;
      }
    }
  }, [client, queryKey, owner, resolved, shownEvidence]);

  function showLatest() {
    setRetained({ viewKey, order: { scope, ids, pageCount, initialized: true }, missingIds: [] });
  }
  return { shown, refreshAvailable, hasRetainedMetadata, placeUnavailable: state.missingIds.length > 0, showLatest };
}
